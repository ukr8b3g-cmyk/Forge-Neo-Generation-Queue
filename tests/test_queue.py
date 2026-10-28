import sys
import time
import unittest
from pathlib import Path
from threading import Event

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


if __name__ == "__main__":
    unittest.main()
