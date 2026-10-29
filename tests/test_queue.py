import sys
import time
import unittest
from pathlib import Path
from threading import Event, current_thread
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from forge_generation_queue.queue import GenerationQueue, HoldQueue


def until(predicate, seconds=3):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if predicate():
            return
        time.sleep(.005)
    raise AssertionError("timed out")


class QueueTests(unittest.TestCase):
    def make(self, execute, interrupt=lambda job: None, limit=32):
        queue = GenerationQueue(execute, interrupt, limit)
        self.addCleanup(queue.close)
        return queue

    def test_fifo_snapshot_duplicate_and_delete_pending(self):
        gate = Event()
        seen = []

        def execute(job, queue):
            if not queue.claim(job, lambda: None):
                return
            gate.wait(2)
            seen.append(job.args)
            return ({"value": job.args[0]},)

        q = self.make(execute)
        source = ["A", [1]]
        q.enqueue("a", (None, "owner"), source, None, "fp")
        until(lambda: q.jobs["a"].state == "running")
        source[1][0] = 99
        q.enqueue("a", (None, "owner"), ["duplicate"], None, "fp")
        q.enqueue("b", (None, "owner"), ["B"], None, "fp")
        q.enqueue("c", (None, "owner"), ["C"], None, "fp")
        self.assertFalse(q.cancel((None, "other"), "b"))
        self.assertTrue(q.cancel((None, "owner"), "b"))
        gate.set()
        until(lambda: not q.has_work())
        self.assertEqual(seen, [("A", [1]), ("C",)])
        self.assertEqual(q.jobs["b"].state, "cancelled")
        snapshot, result = q.snapshot((None, "owner"))
        result[0]["value"] = "mutated"
        self.assertEqual(q.snapshot((None, "owner"))[1][0]["value"], "C")
        self.assertIsNone(q.snapshot((None, "owner"), snapshot["result_seq"])[1])

    def test_cancel_during_lock_wait_never_starts(self):
        gate = Event()
        started = []

        def execute(job, queue):
            gate.wait(2)
            queue.claim(job, lambda: started.append(job.id))

        q = self.make(execute)
        q.enqueue("a", (None, "owner"), ["A"], None, "fp")
        until(lambda: q.jobs["a"].state == "waiting")
        q.cancel((None, "owner"), "a")
        gate.set()
        time.sleep(.03)
        self.assertEqual(started, [])

    def test_cancel_running_interrupts_once_then_next(self):
        stopped = Event()
        interrupted = []

        def execute(job, queue):
            queue.claim(job, lambda: None)
            if job.id == "a":
                stopped.wait(2)

        def interrupt(job):
            interrupted.append(job.id)

        q = self.make(execute, interrupt)
        q.enqueue("a", (None, "owner"), ["A"], None, "fp")
        q.enqueue("b", (None, "owner"), ["B"], None, "fp")
        until(lambda: q.jobs["a"].state == "running")
        q.cancel((None, "owner"), "a")
        q.cancel((None, "owner"), "a")
        stopped.set()
        until(lambda: q.jobs["b"].state == "done")
        self.assertEqual(interrupted, ["a"])
        self.assertEqual(q.jobs["a"].state, "cancelled")

    def test_guard_holds_reservation_and_requires_owner_resume(self):
        valid = Event()

        def execute(job, queue):
            if not valid.is_set():
                raise HoldQueue("settings changed")
            queue.claim(job, lambda: None)

        q = self.make(execute)
        q.enqueue("a", ("user", "owner"), ["A"], None, "fp")
        until(lambda: q.paused)
        self.assertEqual(q.jobs["a"].state, "pending")
        with self.assertRaises(ValueError):
            q.resume(("user", "other"))
        valid.set()
        q.resume(("user", "owner"))
        until(lambda: q.jobs["a"].state == "done")

    def test_failure_stops_and_preserves_following_reservation(self):
        gate = Event()

        def execute(job, queue):
            queue.claim(job, lambda: None)
            gate.wait(2)
            if job.id == "a":
                raise RuntimeError("test error")

        q = self.make(execute)
        q.enqueue("a", (None, "owner"), ["A"], None, "fp")
        q.enqueue("b", (None, "owner"), ["B"], None, "fp")
        gate.set()
        until(lambda: q.paused)
        self.assertEqual(q.jobs["a"].state, "failed")
        self.assertEqual(q.jobs["b"].state, "pending")
        q.resume((None, "owner"))
        until(lambda: q.jobs["b"].state == "done")

    def test_limit_close_and_owner_isolation(self):
        gate = Event()

        def execute(job, queue):
            queue.claim(job, lambda: None)
            gate.wait(2)

        q = self.make(execute, limit=2)
        q.enqueue("a", (None, "owner"), ["private"], None, "fp")
        q.enqueue("b", (None, "owner"), ["B"], None, "fp")
        with self.assertRaises(ValueError):
            q.enqueue("c", (None, "owner"), ["C"], None, "fp")
        self.assertEqual(q.snapshot((None, "other"))[0]["rows"], [])
        q.close()
        gate.set()
        q.worker.join(2)
        self.assertFalse(q.worker.is_alive())
        with self.assertRaises(ValueError):
            q.enqueue("d", (None, "owner"), ["D"], None, "fp")

    def test_cancel_last_held_owner_releases_other_client(self):
        def execute(job, queue):
            if job.owner == "A":
                raise HoldQueue("settings changed")
            queue.claim(job, lambda: None)

        q = self.make(execute)
        q.enqueue("a", "A", ["A"], None, "fp")
        until(lambda: q.paused)
        q.enqueue("b", "B", ["B"], None, "fp")
        q.cancel("A", "a")
        until(lambda: q.jobs["b"].state == "done")
        self.assertFalse(q.paused)
        self.assertIsNone(q.paused_owner)

    def test_failure_without_same_owner_jobs_does_not_block_other_client(self):
        def execute(job, queue):
            queue.claim(job, lambda: None)
            if job.owner == "A":
                raise RuntimeError("test error")

        q = self.make(execute)
        q.enqueue("a", "A", ["A"], None, "fp")
        until(lambda: q.jobs["a"].state == "failed")
        q.enqueue("b", "B", ["B"], None, "fp")
        until(lambda: q.jobs["b"].state == "done")
        self.assertFalse(q.paused)
        self.assertEqual(q.snapshot("A")[0]["rows"][0]["error"], "test error")

    def test_cancel_owner_must_not_release_its_other_held_job(self):
        def execute(job, queue):
            raise HoldQueue("settings changed")

        q = self.make(execute)
        q.enqueue("a", "A", ["A"], None, "fp")
        until(lambda: q.paused)
        q.enqueue("a2", "A", ["A2"], None, "fp")
        q.enqueue("b", "B", ["B"], None, "fp")
        q.cancel("A", "a")
        self.assertEqual(q.paused_owner, "A")
        with self.assertRaises(ValueError):
            q.resume("B")
        q.cancel("A", "a2")
        # B must still pass its own settings guard, rather than bypassing it.
        until(lambda: q.paused_owner == "B")
        self.assertEqual(q.jobs["b"].state, "pending")

    def test_five_clients_keep_results_until_acknowledged(self):
        def execute(job, queue):
            queue.claim(job, lambda: None)
            return ({"value": job.owner},)

        q = self.make(execute)
        for owner in range(5):
            q.enqueue(str(owner), owner, [owner], None, "fp")
        until(lambda: not q.has_work())
        for owner in range(5):
            state, result = q.snapshot(owner)
            self.assertEqual(result, ({"value": owner},))
            self.assertEqual(q.snapshot(owner)[1], result)  # Lost poll response: redeliver.
            self.assertIsNone(q.snapshot(owner, state["result_seq"])[1])
            self.assertNotIn(owner, q.latest)

    def test_result_capacity_reserves_active_clients_and_ack_frees_space(self):
        gate = Event()
        self.addCleanup(gate.set)

        def execute(job, queue):
            queue.claim(job, lambda: None)
            gate.wait(2)
            return (job.owner,)

        q = self.make(execute, limit=2)
        q.enqueue("a", "A", ["A"], None, "fp")
        gate.set()
        until(lambda: not q.has_work())
        state, _ = q.snapshot("A")
        gate.clear()
        q.enqueue("b", "B", ["B"], None, "fp")
        until(lambda: q.jobs["b"].state == "running")
        with self.assertRaisesRegex(ValueError, "pending results"):
            q.enqueue("c", "C", ["C"], None, "fp")
        q.snapshot("B", state["result_seq"])  # B cannot release A's delivery slot.
        self.assertIn("A", q.latest)
        q.snapshot("A", state["result_seq"])
        q.enqueue("c", "C", ["C"], None, "fp")
        gate.set()
        until(lambda: not q.has_work())
        self.assertEqual(q.snapshot("B")[1], ("B",))
        self.assertEqual(q.snapshot("C")[1], ("C",))

    def test_result_expiry_releases_abandoned_client_capacity(self):
        def execute(job, queue):
            queue.claim(job, lambda: None)
            return (job.owner,)

        q = self.make(execute, limit=1)
        with patch("forge_generation_queue.queue.monotonic", return_value=100):
            q.enqueue("a", "A", ["A"], None, "fp")
            until(lambda: not q.has_work())
        with patch("forge_generation_queue.queue.monotonic", return_value=1901):
            q.enqueue("b", "B", ["B"], None, "fp")
            until(lambda: not q.has_work())
            self.assertIsNone(q.snapshot("A")[1])
            self.assertEqual(q.snapshot("B")[1], ("B",))

    def test_old_ack_never_discards_newer_result_from_same_client(self):
        def execute(job, queue):
            queue.claim(job, lambda: None)
            return (job.id,)

        q = self.make(execute)
        q.enqueue("a", "A", ["A"], None, "fp")
        until(lambda: not q.has_work())
        first, _ = q.snapshot("A")
        q.enqueue("b", "A", ["B"], None, "fp")
        until(lambda: not q.has_work())
        self.assertEqual(q.snapshot("A", first["result_seq"])[1], ("b",))

    def completion_boundary(self, queue, job_id):
        """Pause the worker after its first lock release publishing a terminal job.

        Only scheduling is controlled; the production state and methods are intact.
        A competing poll/enqueue can now inspect that externally visible boundary.
        """
        arrived, release = Event(), Event()
        condition = queue.cv

        class Boundary:
            stopped = False

            def __getattr__(self, name):
                return getattr(condition, name)

            def __enter__(self):
                return condition.__enter__()

            def __exit__(self, *args):
                job = queue.jobs.get(job_id)
                stop = (not self.stopped and current_thread() is queue.worker and
                        job is not None and job.state in ("done", "cancelled", "failed"))
                if stop:
                    self.stopped = True
                result = condition.__exit__(*args)
                if stop:
                    arrived.set()
                    release.wait(5)
                return result

        queue.cv = Boundary()
        self.addCleanup(release.set)
        return arrived, release

    def test_completion_publishes_result_and_cleanup_before_idle_snapshot(self):
        for interrupted in (False, True):
            with self.subTest(interrupted=interrupted):
                def execute(job, queue):
                    queue.claim(job, lambda: None)
                    if interrupted:
                        queue.cancel("owner", job.id)
                    return ({"value": "final image"},)

                q = self.make(execute)
                arrived, release = self.completion_boundary(q, "last-job")
                q.enqueue("last-job", "owner", ["prompt"], object(), "fp")
                try:
                    self.assertTrue(arrived.wait(3), "completion boundary not reached")
                    state, result = q.snapshot("owner")
                    self.assertFalse(state["busy"])
                    self.assertEqual(state["rows"][0]["state"], "cancelled" if interrupted else "done")
                    self.assertGreater(state["result_seq"], 0)
                    self.assertEqual(result, ({"value": "final image"},))
                    self.assertEqual(q.jobs["last-job"].args, ())
                    self.assertIsNone(q.jobs["last-job"].context)
                    # Even an OFF client sees pending delivery and will poll to ACK.
                    self.assertIsNone(q.snapshot("owner", state["result_seq"])[1])
                finally:
                    release.set()
                    q.close()
                    q.worker.join(3)
                self.assertFalse(q.worker.is_alive())

    def test_completion_keeps_the_32nd_client_slot_reserved(self):
        def execute(job, queue):
            queue.claim(job, lambda: None)
            return (job.owner,)

        q = self.make(execute)
        arrived, release = self.completion_boundary(q, "last-job")
        for n in range(31):
            q.enqueue("prefill-" + str(n), n, ["prompt"], None, "fp")
        with q.cv:
            self.assertTrue(q.cv.wait_for(lambda: len(q.latest) == 31, timeout=3))
        q.enqueue("last-job", "last-owner", ["prompt"], None, "fp")
        try:
            self.assertTrue(arrived.wait(3), "completion boundary not reached")
            self.assertFalse(q.has_work())
            with self.assertRaisesRegex(ValueError, "pending results"):
                q.enqueue("extra", "33rd-owner", ["prompt"], None, "fp")
            self.assertEqual(len(q.latest), 32)
            self.assertEqual(q.snapshot("last-owner")[1], ("last-owner",))
        finally:
            release.set()
            q.close()
            q.worker.join(3)
        self.assertFalse(q.worker.is_alive())


if __name__ == "__main__":
    unittest.main()
