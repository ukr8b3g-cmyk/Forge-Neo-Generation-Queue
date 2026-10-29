# Testing

Standalone FIFO tests require only Python's standard library:

```sh
python -m unittest discover -s tests -p 'test_queue.py' -v
```

Thirteen tests cover ordering, copied inputs, duplicate IDs, cancellation before/during generation, cancellation while waiting for Forge's lock, pause/resume, ownership, capacity, and shutdown. Regression cases cover releasing a pause after its last owner's job is cancelled or fails, preserving a pause while that owner still has work, retaining five clients' results, acknowledgement and stale acknowledgement handling, reserved delivery slots, and abandoned-result expiry.

Client protocol checks require Node.js 18 or later and only its standard library:

```sh
node --test tests/test_client.cjs
node --check javascript/generation_queue.js
```

Six checks execute the real client script in a minimal simulated host: HTTP-compatible ID generation without `randomUUID`, denied session storage, reconnect identity, the native OFF path, refusal before connection, and the final result acknowledgement after switching OFF. They do not exercise Gradio or a real browser DOM.

Development also used installed Gradio 4.40.0 and Forge's call_queue module with a fake CPU generator. Twenty-one Python checks passed (the 13 portable checks plus eight local integration/locale checks). Earlier isolated Chrome integration covered sequential submissions, cancellation, reconnect, result delivery, failure/resume, and draining after OFF. Current DOM checks cover 11 locale values, button colors, and a constant 22px status area for 0, 1, and 32 jobs, including opening the details overlay. CSS checks also verify a 2px row gap and an 80%-opaque dark popup background. The revised client was additionally checked in Chrome on an insecure HTTP test origin where `randomUUID` is unavailable: initialization and 20 distinct submission IDs succeeded. This uses a mocked page, not a connection to the user's Forge server.

Machine-specific integration harnesses and local artifacts are not included in this repository. Automated and isolated-browser checks are not real Forge/GPU acceptance tests. The README screenshots are user-supplied WebUI captures.

Later UI regression checks cover three active jobs displaying exactly three rows even when terminal history is present, counts including the running job, removal of completed rows, preserved error details and resume controls, distinct submission IDs, and a green running row with white text. Waiting rows are not highlighted.

No GPU is needed for the portable tests. For an actual Forge check, verify queue OFF behavior, multiple submissions, individual cancellation, completion, and the affected locale/theme, and report that separately from the automated results.
