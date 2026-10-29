# Testing

Standalone FIFO tests require only Python's standard library:

```sh
python -m unittest discover -s tests -p 'test_queue.py' -v
```

Fifteen tests cover ordering, copied inputs, duplicate IDs, cancellation before/during generation, cancellation while waiting for Forge's lock, pause/resume, ownership, capacity, and shutdown. Regression cases cover releasing a pause after its last owner's job is cancelled or fails, preserving a pause while that owner still has work, retaining five clients' results, acknowledgement and stale acknowledgement handling, reserved delivery slots, and abandoned-result expiry.

Completion-boundary tests deterministically pause the worker at the first lock release that exposes a terminal job, without changing production job state. Polling must see the final result and freed inputs together for both normal completion and interruption. A second test fills 31 retained-client slots, completes the 32nd client, and verifies that a 33rd client is rejected at the same boundary. Before the atomic-completion fix, both tests failed (including both terminal-state subcases); after the fix, they passed.

Client protocol checks require Node.js 18 or later and only its standard library:

```sh
node --test tests/test_client.cjs
node --check javascript/generation_queue.js
```

Nine checks execute the real client script in a minimal simulated host: HTTP-compatible ID generation without `randomUUID`, denied session storage, reconnect identity, the native OFF path, startup clicks waiting for connection with their captured inputs, timeout without retry, switching OFF during that wait, an early status check, and the final result acknowledgement after switching OFF. They do not exercise Gradio or a real browser DOM.

Development also used installed Gradio 4.40.0 and Forge's call_queue module with a fake CPU generator. Twenty-three Python checks passed (the 15 portable checks plus eight local integration/locale checks). Earlier isolated Chrome integration covered sequential submissions, cancellation, reconnect, result delivery, failure/resume, and draining after OFF. Current DOM checks cover 11 locale values, button colors, a collapsed empty queue, and a constant 22px status area for 1 and 32 jobs, including opening the details overlay. CSS checks also verify a 2px row gap and a 100%-opaque dark popup background. The revised client was additionally checked in Chrome on an insecure HTTP test origin where `randomUUID` is unavailable: initialization and 20 distinct submission IDs succeeded. This uses a mocked page, not a connection to the user's Forge server.

Machine-specific integration harnesses and local artifacts are not included in this repository. Automated and isolated-browser checks are not real Forge/GPU acceptance tests. README Settings and expanded queue screenshots are user-supplied WebUI captures. The idle/generating pair is rendered from the current client script and stylesheet with sample job data and minimal host styles in an isolated browser. Neither the illustrative pair nor the user-provided capture substitutes for independent end-to-end GPU acceptance testing.

Later UI regression checks cover three active jobs displaying exactly three rows even when terminal history is present, counts including the running job, removal of completed rows, preserved error details and resume controls, distinct submission IDs, and a navy running row with soft white text and a blue left border. Waiting rows are not highlighted. Both pending-row cancellation and running-row interruption command dispatch were checked after the styling change. With the queue ON or OFF, completing or cancelling the last job removes the count and open details entirely (0px panel height); result acknowledgement remains intact, and new jobs reappear with details collapsed. Active queues retain the fixed 22px status area.

No GPU is needed for the portable tests. For an actual Forge check, verify queue OFF behavior, multiple submissions, individual cancellation, completion, and the affected locale/theme, and report that separately from the automated results.

Startup response was also checked using real installed Gradio 4.40.0, Forge's native call_queue module, and the CPU-only generation fixture: hold the first queue-status response, click Generate, edit the prompt while connecting, and release the response. The captured inputs were submitted exactly once, the CPU result reached the gallery, and the queue drained. Isolated DOM checks verify immediate Sending feedback, a blue pre-generation button, accepted-only counts, and transition to green once a server job is running. This does not measure actual Forge/GPU startup or generation speed.
