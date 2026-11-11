"""Small in-memory FIFO. No Forge, Gradio or GPU imports."""

from collections import OrderedDict
from copy import deepcopy
from dataclasses import dataclass
from threading import Condition, Thread
from time import monotonic

ACTIVE = ("pending", "waiting", "running")
RESULT_TTL = 30 * 60


@dataclass
class Job:
    id: str
    owner: tuple
    number: int
    args: tuple
    context: object
    label: str
    settings: object = None
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
        self.closed = False
        self.worker = None

    def enqueue(self, job_id, owner, args, context, settings=None):
        with self.cv:
            if self.closed:
                raise ValueError("The UI is reloading. Reload the page.")
            if job_id in self.jobs:
                if self.jobs[job_id].owner != owner:
                    raise ValueError("Duplicate job ID.")
                return self.jobs[job_id]
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
                      str(args[0])[:100] if args else "", deepcopy(settings))
            self.jobs[job_id] = job
            self._trim()
            if self.worker is None or not self.worker.is_alive():
                self.worker = Thread(target=self._run, name="forge-generation-queue", daemon=True)
                self.worker.start()
            self.cv.notify_all()
            return job

    def _active_count(self):
        return sum(j.state in ACTIVE for j in self.jobs.values())

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
                job.settings = None
            self.cv.notify_all()
            return True

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
            return dict(rows=rows, busy=bool(self._active_count()), result_seq=seq), result

    def close(self):
        with self.cv:
            self.closed = True
            for job in self.jobs.values():
                if job.state in ("pending", "waiting"):
                    job.state = "cancelled"
                    job.args = ()
                    job.context = None
                    job.settings = None
            self.cv.notify_all()

    def _run(self):
        while True:
            with self.cv:
                while True:
                    if self.closed:
                        return
                    job = next((j for j in self.jobs.values() if j.state == "pending"), None)
                    if job is not None:
                        job.state = "waiting"
                        break
                    self.cv.wait()
            result = None
            failure = None
            try:
                result = self.execute(job, self)
            except Exception as exc:
                failure = (str(exc) or type(exc).__name__)[:500]
            # Publish terminal state, result, freed inputs and client accounting
            # together. OFF clients may stop polling as soon as busy becomes false.
            with self.cv:
                if job.cancel_requested or job.state == "cancelled":
                    job.state = "cancelled"
                elif failure is not None:
                    job.state = "failed"
                    job.error = failure
                else:
                    job.state = "done"
                job.args = ()
                job.context = None
                job.settings = None
                if result is not None:
                    self.latest[job.owner] = (job.number, result, monotonic() + RESULT_TTL)
                    self.latest.move_to_end(job.owner)
                self._expire_results()
                self._trim()
                self.cv.notify_all()
