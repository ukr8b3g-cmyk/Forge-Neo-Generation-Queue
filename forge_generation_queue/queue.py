"""Small in-memory FIFO. No Forge, Gradio or GPU imports."""

from collections import OrderedDict
from copy import deepcopy
from dataclasses import dataclass
from threading import Condition, Thread
from time import monotonic

ACTIVE = ("pending", "waiting", "running")
RESULT_TTL = 30 * 60


class HoldQueue(Exception):
    """Keep the reservation and wait for an explicit resume."""


@dataclass
class Job:
    id: str
    owner: tuple
    number: int
    args: tuple
    context: object
    fingerprint: str
    label: str
    state: str = "pending"
    cancel_requested: bool = False
    error: str = ""


class GenerationQueue:
    def __init__(self, execute, interrupt, limit=32):
        self.execute = execute
        self.interrupt = interrupt
        self.limit = limit
        self.cv = Condition()
        self.jobs = OrderedDict()
        self.latest = OrderedDict()
        self.serial = 0
        self.paused = ""
        self.paused_owner = None
        self.closed = False
        self.worker = None

    def enqueue(self, job_id, owner, args, context, fingerprint):
        with self.cv:
            if self.closed:
                raise ValueError("The UI is reloading. Reload the page.")
            if job_id in self.jobs:
                if self.jobs[job_id].owner != owner:
                    raise ValueError("Duplicate job ID.")
                return self.jobs[job_id]
            self._release_orphaned_pause()
            self._expire_results()
            if self._active_count() >= self.limit:
                raise ValueError(f"Generation queue limit is {self.limit} jobs.")
            # Reserve delivery space before accepting work. Never evict another
            # client's unacknowledged result just because a fifth client finishes.
            owners = set(self.latest) | {j.owner for j in self.jobs.values() if j.state in ACTIVE}
            if owner not in owners and len(owners) >= self.limit:
                raise ValueError("Too many clients have pending results. Reconnect those tabs or wait 30 minutes.")
            self.serial += 1
            job = Job(job_id, owner, self.serial, deepcopy(tuple(args)), context,
                      fingerprint, str(args[0])[:100] if args else "")
            self.jobs[job_id] = job
            self._trim()
            if self.worker is None or not self.worker.is_alive():
                self.worker = Thread(target=self._run, name="forge-generation-queue", daemon=True)
                self.worker.start()
            self.cv.notify_all()
            return job

    def _active_count(self):
        return sum(j.state in ACTIVE for j in self.jobs.values())

    def _release_orphaned_pause(self):
        if self.paused_owner is not None and not any(
                j.owner == self.paused_owner and j.state in ACTIVE for j in self.jobs.values()):
            self.paused = ""
            self.paused_owner = None

    def _expire_results(self):
        active_owners = {j.owner for j in self.jobs.values() if j.state in ACTIVE}
        now = monotonic()
        for owner, (_, _, expires) in list(self.latest.items()):
            if expires <= now and owner not in active_owners:
                del self.latest[owner]

    def has_work(self):
        with self.cv:
            return bool(self._active_count())

    def _trim(self):
        terminal = [k for k, j in self.jobs.items() if j.state in ("done", "cancelled", "failed")]
        for key in terminal[:-32]:
            del self.jobs[key]

    def claim(self, job, begin):
        # Called only after obtaining Forge's GPU lock. Cancellation and start are atomic.
        with self.cv:
            if job.state == "cancelled" or self.closed:
                return False
            begin()
            job.state = "running"
            return True

    def cancel(self, owner, job_id):
        with self.cv:
            job = self.jobs.get(job_id)
            if job is None or job.owner != owner:
                return False
            if job.state == "running":
                if not job.cancel_requested:
                    job.cancel_requested = True
                    self.interrupt(job)
            elif job.state in ("pending", "waiting"):
                job.state = "cancelled"
                job.args = ()
                job.context = None
            self._release_orphaned_pause()
            self.cv.notify_all()
            return True

    def resume(self, owner):
        with self.cv:
            if self.paused_owner not in (None, owner):
                raise ValueError("Resume the queue from the client that paused it.")
            self.paused = ""
            self.paused_owner = None
            self.cv.notify_all()

    def snapshot(self, owner, acknowledged=0):
        with self.cv:
            own = [j for j in self.jobs.values() if j.owner == owner]
            active = [j for j in own if j.state in ("pending", "waiting", "running")]
            history = [j for j in own if j.state not in ("pending", "waiting", "running")][-4:]
            rows = [dict(id=j.id, number=j.number, label=j.label, state=j.state,
                         cancelling=j.cancel_requested, error=j.error) for j in active + history]
            self._expire_results()
            seq, result, _ = self.latest.get(owner, (0, None, 0))
            if seq and acknowledged >= seq:
                del self.latest[owner]
                seq, result = 0, None
            # Gradio mutates update dictionaries during postprocessing; don't expose originals.
            result = deepcopy(result) if result is not None and seq > acknowledged else None
            return dict(rows=rows, paused=self.paused if self.paused_owner == owner else
                        ("Another client's queue is paused." if self.paused else ""),
                        can_resume=self.paused_owner == owner,
                        busy=bool(self._active_count()), result_seq=seq), result

    def close(self):
        with self.cv:
            self.closed = True
            for job in self.jobs.values():
                if job.state in ("pending", "waiting"):
                    job.state = "cancelled"
                    job.args = ()
                    job.context = None
            self.cv.notify_all()

    def _run(self):
        while True:
            with self.cv:
                while True:
                    if self.closed:
                        return
                    job = next((j for j in self.jobs.values() if j.state == "pending"), None)
                    if job is not None and not self.paused:
                        job.state = "waiting"
                        break
                    self.cv.wait()
            result = None
            failure = None
            try:
                result = self.execute(job, self)
            except HoldQueue as exc:
                with self.cv:
                    if job.state != "cancelled":
                        job.state = "pending"
                        self.paused = str(exc)
                        self.paused_owner = job.owner
                continue
            except Exception as exc:
                failure = str(exc)[:500]
            # Publish terminal state, result, freed inputs and client accounting
            # together. OFF clients may stop polling as soon as busy becomes false.
            with self.cv:
                if failure is not None:
                    job.state = "failed"
                    job.error = failure
                    self.paused = "Generation failed. Check the settings and resume."
                    self.paused_owner = job.owner
                elif job.state != "cancelled":
                    job.state = "cancelled" if job.cancel_requested else "done"
                job.args = ()
                job.context = None
                if result is not None:
                    self.latest[job.owner] = (job.number, result, monotonic() + RESULT_TTL)
                    self.latest.move_to_end(job.owner)
                self._release_orphaned_pause()
                self._expire_results()
                self._trim()
                self.cv.notify_all()
