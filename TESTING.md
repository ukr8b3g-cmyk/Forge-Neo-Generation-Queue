# Testing

Standalone FIFO tests require only Python's standard library:

```sh
python -m unittest discover -s tests -p 'test_queue.py' -v
```

Six tests cover ordering, copied inputs, duplicate IDs, cancellation before/during generation, cancellation while waiting for Forge's lock, pause/resume, ownership, capacity, and shutdown.

Development also used installed Gradio 4.40.0 and Forge's call_queue module with a fake CPU generator. Fourteen Python checks passed. Isolated Chrome integration covered sequential submissions, cancellation, reconnect, result delivery, failure/resume, and draining after OFF. DOM checks covered 11 locale values, button colors, and a constant 22px status area for 0, 1, and 32 jobs, including opening the details overlay. The latest CSS checks also verify a 2px row gap and an 80%-opaque dark popup background.

Machine-specific integration harnesses and local artifacts are not included in this repository. Automated and isolated-browser checks are not real Forge/GPU acceptance tests. The README screenshots are user-supplied WebUI captures.

Later UI regression checks cover three active jobs displaying exactly three rows even when terminal history is present, counts including the running job, removal of completed rows, preserved error details and resume controls, distinct submission IDs, and a green running row with white text. Waiting rows are not highlighted.

No GPU is needed for the portable tests. For an actual Forge check, verify queue OFF behavior, multiple submissions, individual cancellation, completion, and the affected locale/theme, and report that separately from the automated results.
