# Testing

Standalone FIFO tests require only Python's standard library:

```sh
python -m unittest discover -s tests -p 'test_queue.py' -v
```

Six tests cover ordering, copied inputs, duplicate IDs, cancellation before/during generation, cancellation while waiting for Forge's lock, pause/resume, ownership, capacity, and shutdown.

Development also used installed Gradio 4.40.0 and Forge's call_queue module with a fake CPU generator. Fourteen Python checks passed. Isolated Chrome integration covered sequential submissions, cancellation, reconnect, result delivery, failure/resume, and draining after OFF. DOM checks covered 11 locale values, button colors, and a constant 22px status area for 0, 1, and 32 jobs, including opening the details overlay. The latest CSS checks also verify a 2px row gap and an 80%-opaque dark popup background.

Machine-specific integration harnesses and local artifacts are not included in this repository. Automated and isolated-browser checks are not real Forge/GPU acceptance tests. The README screenshots are user-supplied WebUI captures.
