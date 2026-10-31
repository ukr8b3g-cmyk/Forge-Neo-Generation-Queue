"""Narrow adapter for Forge Neo's txt2img events (Gradio 4.40)."""

import hashlib
import inspect
import json
import re
import sys
from functools import wraps
from pathlib import Path

import gradio as gr
from modules import script_callbacks, shared

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from forge_generation_queue.queue import GenerationQueue, HoldQueue
from forge_generation_queue.i18n import translate

OPTION = "forge_generation_queue_enabled"
TOKEN = re.compile(r"^[a-f0-9]{32}$")
ui = {}
manager = None


def settings():
    shared.opts.add_option(OPTION, shared.OptionInfo(
        False, translate("Enable generation queue (txt2img)"),
        section=("forge_generation_queue", translate("Generation Queue")),
    ).info(translate("Queue one job per Generate click. Add to Quicksettings manually.")))


def reset_ui():
    global manager
    if manager is not None:
        manager.close()
    manager = None
    ui.clear()


def poll_pending(payload, request: gr.Request):
    return json.dumps(dict(ready=False, message=translate("Could not connect the generation queue. Check the Forge startup log.")))


def build_panel():
    with gr.Column(elem_id="forge_generation_queue_panel"):
        gr.HTML('<div id="fq_content" aria-live="polite"></div>')
        ui["request"] = gr.Textbox(value="", elem_classes=["fq-bridge"], show_label=False)
        ui["status"] = gr.Textbox(value="", elem_classes=["fq-bridge"], show_label=False)
        ui["poll"] = gr.Button("Queue status", elem_id="fq_poll", elem_classes=["fq-bridge"])
        # Register events during UI construction. Re-entering `with demo` after
        # launch would recreate Gradio's app object and its authentication state.
        # One status handler for Gradio's reliable initial load and later polls.
        status_event = gr.on(triggers=[gr.context.Context.root_block.load, ui["poll"].click],
              fn=poll_pending, inputs=[ui["request"]], outputs=[ui["status"]],
              js="() => [window.forgeGenerationQueue.pollArgs()]",
              queue=False, trigger_mode="multiple", show_progress="hidden", api_name=False)
        # .then runs after both success and transport/backend failure. A textbox
        # change alone never reports failed requests, leaving the client locked.
        status_event.then(fn=None, inputs=[ui["status"]],
                             js="value => {window.forgeGenerationQueue.pollFinished(value); return [];}",
                             queue=False, show_progress="hidden")


def after_component(component, **kwargs):
    if kwargs.get("elem_id") == "txt2img_generate" and "poll" not in ui:
        build_panel()


def fingerprint():
    # Conservative guard: common Settings changes pause the next reservation, never
    # restore the entire global configuration behind the user's back.
    ignored = {OPTION, "sd_checkpoint_hash", "quicksettings_list"}
    config_path = getattr(shared, "config_filename", None)
    # Native per-job Override settings temporarily alter opts.data. Compare the
    # saved user configuration so another job cannot capture those temporary values.
    data = json.loads(Path(config_path).read_text(encoding="utf-8")) if config_path else shared.opts.data.copy()
    values = {k: v for k, v in data.items() if k not in ignored}
    styles = getattr(getattr(shared, "prompt_styles", None), "styles", {})
    raw = json.dumps([values, styles], ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def owner_for(token, request):
    if not isinstance(token, str) or not TOKEN.fullmatch(token):
        raise ValueError("Invalid client ID. Reload the page.")
    return (getattr(request, "username", None), token)


def execute(job, engine):
    from modules import call_queue, progress, txt2img
    from modules_forge import main_thread

    # Reuse the native GPU lock and native txt2img entry point. Keep ALL state
    # cleanup inside the lock so a following img2img/API job cannot be reset.
    with call_queue.queue_lock:
        if job.state == "cancelled":
            return None
        try:
            current_fingerprint = fingerprint()
        except (OSError, ValueError):
            raise HoldQueue("Cannot read shared settings. Resume after settings have finished saving.") from None
        if current_fingerprint != job.fingerprint:
            raise HoldQueue("Model or shared settings have changed since this job was queued. Restore them and resume, or cancel the job with ×.")

        def begin():
            shared.state.begin(job=job.id)
            progress.start_task(job.id)

        if not engine.claim(job, begin):
            return None
        failure = []

        def generate():
            try:
                result = txt2img.txt2img(job.id, job.context, *job.args)
                if result is None:
                    raise RuntimeError(main_thread.last_exception or "Could not retrieve the generation result.")
                return result
            except Exception as exc:
                failure.append(exc)
                raise

        try:
            result = call_queue.wrap_gradio_call_no_job(
                generate, extra_outputs=[None, None, "", ""], add_stats=True,
            )()
            if failure:
                raise RuntimeError(str(failure[0]))
            # External Interrupt follows the same cancellation state as the row's ×.
            if shared.state.interrupted or shared.state.stopping_generation:
                job.cancel_requested = True
            progress.record_results(job.id, result)
            return result
        finally:
            progress.finish_task(job.id)
            shared.state.end()
            shared.state.skipped = False
            shared.state.interrupted = False
            shared.state.stopping_generation = False
            from modules.ui import cleanup
            cleanup()


def interrupt(job):
    from modules import progress
    # Never interrupt a different tab's or API client's job.
    if progress.current_task == job.id:
        shared.state.interrupt()


def install(demo, app):
    global manager
    if demo is None or "poll" not in ui or getattr(demo, "_forge_queue_installed", False):
        return
    from modules import txt2img

    candidates = [fn for fn in demo.fns.values() if fn.fn is not None
                  and inspect.unwrap(fn.fn) is txt2img.txt2img]
    poll_events = [fn for fn in demo.fns.values() if fn.fn is poll_pending]
    # Fail closed if Forge changes the event contract. Do not guess input offsets
    # or replace unrelated functions (upscale/img2img/extensions remain untouched).
    if not candidates or len(poll_events) != 1 or any(len(fn.outputs) != 5 or fn.js != "submit" for fn in candidates):
        print("[Generation Queue] Unsupported txt2img event contract; native Generate unchanged.")
        return
    manager = GenerationQueue(execute, interrupt)
    engine = manager

    def route(original):
        @wraps(original)
        def routed(id_task, request: gr.Request, *args):
            if not isinstance(id_task, str) or not id_task.startswith("fq:"):
                if engine.has_work():
                    gr.Warning(translate("Wait for the accepted queue jobs to finish."))
                    return tuple(gr.skip() for _ in range(5))
                return original(id_task, request, *args)
            try:
                if not getattr(shared.opts, OPTION, False):
                    raise ValueError("Generation queue is OFF.")
                _, token, nonce = id_task.split(":")
                owner = owner_for(token, request)
                if not TOKEN.fullmatch(nonce):
                    raise ValueError("Invalid job ID.")
                if engine.has_work() and engine.paused:
                    raise ValueError("The queue is paused. Resume it or cancel pending jobs.")
                engine.enqueue(f"task(fq-{nonce})", owner, args, request, fingerprint())
            except (ValueError, TypeError, OSError) as exc:
                gr.Warning(translate(str(exc)))
            return tuple(gr.skip() for _ in range(5))
        return routed

    def poll(payload, request: gr.Request):
        try:
            data = json.loads(payload)
            owner = owner_for(data.get("token"), request)
            command = data.get("command", "")
            message = ""
            try:
                if command == "resume":
                    engine.resume(owner)
                elif command.startswith("cancel:"):
                    if not engine.cancel(owner, command[7:]):
                        message = "Job not found."
            except ValueError as exc:
                message = str(exc)
            state, result = engine.snapshot(owner, int(data.get("ack", 0)))
            state["paused"] = translate(state["paused"])
            for row in state["rows"]:
                row["error"] = translate(row["error"])
            state.update(enabled=bool(getattr(shared.opts, OPTION, False)),
                         command_id=data.get("command_id"), poll_id=data.get("poll_id"), message=translate(message), ready=True)
            return (json.dumps(state, ensure_ascii=False), *(result if result is not None else
                    [gr.skip() for _ in range(5)]))
        except (ValueError, TypeError, AttributeError) as exc:
            return (json.dumps(dict(ready=True, message=translate(str(exc)))), *[gr.skip() for _ in range(5)])

    poll_events[0].fn = poll
    poll_events[0].outputs = [ui["status"], *candidates[0].outputs]
    for fn in candidates:
        fn.fn = route(fn.fn)
        fn.js = "(...args) => window.forgeGenerationQueue.submit(...args)"
        fn.trigger_mode = "multiple"
        fn.concurrency_limit = 1
        fn.concurrency_id = "forge_generation_queue_submit"
    # Native .then(cleanup) must not unload a previous OOM's model while an
    # accepted reservation is starting. The worker runs cleanup under the lock.
    from modules.ui import cleanup
    candidate_ids = {fn._id for fn in candidates}
    for fn in demo.fns.values():
        if fn.trigger_after in candidate_ids and fn.fn is cleanup:
            def after_submit():
                if not engine.has_work():
                    cleanup()
            fn.fn = after_submit
    demo._forge_queue_installed = True
    demo.config = demo.get_config_file()
    print("[Generation Queue] txt2img connected; enable in Settings / Generation Queue.")


script_callbacks.on_ui_settings(settings)
script_callbacks.on_before_ui(reset_ui)
script_callbacks.on_after_component(after_component)
script_callbacks.on_app_started(install)
script_callbacks.on_before_reload(reset_ui)
