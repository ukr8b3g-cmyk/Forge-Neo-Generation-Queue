/* Standard Generate stays in place. Only its registered txt2img event calls submit(). */
(() => {
    "use strict";
    let token;
    // getRandomValues also works on HTTP LAN origins; randomUUID requires HTTPS.
    const uuid = () => Array.from(crypto.getRandomValues(new Uint8Array(16)),
        byte => byte.toString(16).padStart(2, "0")).join("");
    try {
        token = sessionStorage.getItem("forge_generation_queue_client");
        if (!/^[a-f0-9]{32}$/.test(token || "")) {
            token = uuid();
            sessionStorage.setItem("forge_generation_queue_client", token);
        }
    } catch (_) { token = uuid(); }
    let state = {rows: [], busy: false, ready: false};
    let ack = 0;
    let inFlight = 0;
    let pollStarted = false;
    let statusDirty = false;
    let earlyRefreshPending = false;
    let optionsReady = Object.keys(opts).length > 0;
    let monitored = null;
    let progressValue = null;
    let lastView = "";
    let error = "";
    let connectionError = "";
    let pollId = null;
    let retryAt = 0;
    let failures = 0;
    let sendingUntil = 0;
    let sendingAfter = 0;
    const optionsWaiters = new Set();
    const commands = [];
    const el = id => gradioApp().getElementById(id);
    const enabled = () => !!opts.forge_generation_queue_enabled;
    // Do not fall back to navigator.language: an unset WebUI locale means English.
    const japanese = () => /^(?:ja(?:$|[-_ (])|japanese(?:$|[-_ (])|日本語)/i.test(String(opts.localization || "").trim());
    const t = (en, ja) => japanese() ? ja : en;
    const labels = {pending: ["Pending", "待機"], waiting: ["Waiting to start", "実行待ち"], running: ["Generating", "生成中"], done: ["Done", "完了"], cancelled: ["Cancelled", "取消"], failed: ["Failed", "失敗"]};

    function command(value) {
        commands.push({command: value, command_id: uuid()});
        tick();
    }
    function paintProgress() {
        const content = el("fq_content");
        const heading = content?.querySelector(".fq-heading-running");
        if (heading?.dataset.taskId === monitored) {
            heading.style.setProperty("--fq-heading-progress", `${(progressValue ?? 0) * 100}%`);
        }
        const bar = content?.querySelector(".fq-progress");
        if (!bar || bar.dataset.taskId !== monitored) return;
        bar.style.width = `${(progressValue ?? 0) * 100}%`;
        if (progressValue === null) bar.removeAttribute("aria-valuenow");
        else bar.setAttribute("aria-valuenow", Math.round(progressValue * 100));
    }
    function paint() {
        const panel = el("forge_generation_queue_panel");
        const box = el("txt2img_generate_box");
        if (!panel || !box) return;
        // Keep Gradio components in their original DOM tree (delegated events).
        // Server history is retained for result delivery and diagnostics, not queue rows.
        const active = (state.rows || []).filter(row => ["pending", "waiting", "running"].includes(row.state));
        const ownBusy = active.length > 0;
        const sending = Date.now() < sendingUntil;
        const mode = (state.ready || sending) && (enabled() || ownBusy);
        box.classList.toggle("fq-mode", mode);
        // Status polling also marks result outputs pending, even when they are skipped.
        el("html_info_txt2img")?.classList.toggle("fq-stable-info", enabled() || state.busy || state.result_seq > 0);
        const running = active.find(row => row.state === "running");
        const newest = (state.rows || []).reduce((last, row) => !last || row.number > last.number ? row : last, null);
        const latestFailure = newest?.state === "failed" ? newest.error : "";
        box.classList.toggle("fq-generating", !!running);
        const loadingOptions = optionsWaiters.size > 0;
        const connecting = !state.ready && enabled() && !sending;
        box.classList.toggle("fq-submitting", !running && (sending || connecting || loadingOptions));
        el("txt2img_generate")?.setAttribute("aria-busy", running || sending || connecting || loadingOptions ? "true" : "false");
        const visible = ownBusy || sending || state.paused || state.can_resume || error || connectionError || latestFailure || connecting || loadingOptions;
        panel.style.setProperty("display", visible ? "flex" : "none", "important");
        const content = el("fq_content");
        const view = JSON.stringify([state.rows, state.paused, state.can_resume, state.ready, enabled(), error, connectionError, japanese(), sending, connecting, loadingOptions]);
        if (!content || lastView === view) return;
        lastView = view;
        const expanded = ownBusy && (content.querySelector("details")?.open || false);
        content.replaceChildren();
        if (!visible) return;
        const details = document.createElement("details");
        details.open = expanded;
        const heading = document.createElement("summary");
        heading.className = "fq-heading";
        if (running && !state.paused) {
            heading.classList.add("fq-heading-running");
            heading.dataset.taskId = running.id;
        }
        const status = state.paused ? t("Paused", "停止中") : running ?
            running.cancelling ? t("Interrupting", "中断中") : t("Generating", "生成中") :
            sending ? t("Sending…", "送信中…") : loadingOptions ? t("Loading settings…", "設定読込中…") :
                connecting ? t("Connecting…", "接続中…") : "";
        heading.textContent = [status, ownBusy ? t(`Remaining: ${active.length}`, `残り ${active.length}件`) : "",
            ownBusy && sending && running ? t("Sending…", "送信中…") : ""].filter(Boolean).join(" · ");
        heading.title = t("Click to view or cancel individual jobs", "クリックで予約の詳細・個別取消");
        details.append(heading);
        content.append(details);
        if (error || connectionError || state.paused || latestFailure) {
            const notice = document.createElement("div");
            notice.className = "fq-notice";
            notice.textContent = connectionError ? t("Reconnecting…", "再接続中…") : t("Check queue", "要確認");
            const failed = (state.rows || []).filter(row => row.state === "failed").at(-1);
            notice.title = [connectionError, error || state.paused, latestFailure || (state.paused && failed?.error)].filter(Boolean).join("\n");
            content.append(notice);
            if (state.can_resume) {
                const resume = document.createElement("button");
                resume.type = "button";
                resume.className = "fq-resume";
                resume.textContent = t("Resume", "再開");
                resume.onclick = () => command("resume");
                content.append(resume);
            }
        }
        const list = document.createElement("div");
        list.className = "fq-list";
        for (const row of active) {
            const line = document.createElement("div");
            line.className = row.state === "running" ? "fq-row fq-running" : "fq-row";
            if (row.state === "running") {
                const bar = document.createElement("div");
                bar.className = "fq-progress";
                bar.dataset.taskId = row.id;
                bar.setAttribute("role", "progressbar");
                bar.setAttribute("aria-label", t("Generation progress", "生成の進捗"));
                bar.setAttribute("aria-valuemin", "0");
                bar.setAttribute("aria-valuemax", "100");
                line.append(bar);
            }
            const label = document.createElement("span");
            label.textContent = `${row.cancelling ? t("Interrupt requested", "中断要求中") : labels[row.state] ? t(...labels[row.state]) : row.state} #${row.number}  ${row.label}`;
            label.title = row.error || row.label;
            line.append(label);
            if (["pending", "waiting", "running"].includes(row.state)) {
                const cancel = document.createElement("button");
                cancel.type = "button";
                cancel.textContent = "×";
                cancel.setAttribute("aria-label", row.state === "running" ? t(`Interrupt job #${row.number}`, `予約 #${row.number} を中断`) : t(`Cancel job #${row.number}`, `予約 #${row.number} を取り消し`));
                cancel.title = row.state === "running" ? t("Interrupt this generation and continue to the next job", "現在の生成を中断し、次の予約へ進む") : t("Cancel this pending job", "この予約を取り消す");
                cancel.disabled = row.cancelling;
                cancel.onclick = () => { cancel.disabled = true; command("cancel:" + row.id); };
                line.append(cancel);
            }
            list.append(line);
        }
        details.append(list);
        paintProgress();
    }
    function stopRepeat() {
        // Native Generate forever tests Interrupt visibility. It cannot share queue mode.
        if (typeof regen_txt2img !== "undefined" && regen_txt2img !== null) {
            clearInterval(regen_txt2img);
            regen_txt2img = null;
        }
    }
    function waitForOptions() {
        return new Promise((resolve, reject) => {
            const waiter = {resolve, timer: null};
            waiter.timer = setTimeout(() => {
                optionsWaiters.delete(waiter);
                error = t("WebUI settings did not finish loading. Check the Forge log, then try Generate again.", "WebUI設定の読み込みが完了しませんでした。Forgeのログを確認し、再度Generateを押してください。");
                paint();
                reject(new Error(error));
            }, 10000);
            optionsWaiters.add(waiter);
            paint();
        });
    }
    function send(values) {
        if (!enabled()) {
            error = t("The queue was switched OFF before submission. Click Generate again to use normal generation.", "送信前にキューがOFFになりました。通常生成する場合はGenerateを押し直してください。");
            paint();
            throw new Error(error);
        }
        if (error) throw new Error(error);
        values[0] = `fq:${token}:${uuid()}`;
        // Keep monitoring after OFF until a status request made after this click.
        statusDirty = true;
        // Immediate feedback is not an accepted job and never changes the count.
        sendingAfter = Math.max(0, ...(state.rows || []).map(row => row.number));
        sendingUntil = Date.now() + 5000;
        paint();
        // Coalesce early checks while a request is in flight; leave idle polling alone.
        setTimeout(() => { earlyRefreshPending = true; tick(); }, 100);
        return values;
    }
    function tick() {
        paint();
        if (enabled()) stopRepeat();
        // Gradio's load event starts the first request after its event system is ready.
        if (!pollStarted) return;
        if (state.ready && !enabled() && state.enabled !== true && !state.busy && !commands.length && !state.result_seq && !statusDirty && !earlyRefreshPending) return;
        if (inFlight) {
            if (Date.now() - inFlight < 15000) return;
            connectionError = t("Queue status is delayed. Waiting for the connection; generation requests are not replayed.", "状態確認が遅れています。通信の復旧を待っています。生成要求は自動再送しません。");
            paint();
            return;
        }
        if (Date.now() < retryAt) return;
        const poll = el("fq_poll");
        if (poll) { inFlight = Date.now(); poll.click(); }
    }
    window.forgeGenerationQueue = {
        submit(...args) {
            // The installed Generate event already routes to the queue server.
            // Only local options may need to finish loading; status is independent.
            const values = create_submit_args(args);
            const dispatch = () => {
                if (!enabled() && !state.busy) return submit(...args);
                stopRepeat();
                return send(values);
            };
            return optionsReady ? dispatch() : waitForOptions().then(dispatch);
        },
        pollArgs() {
            pollStarted = true;
            inFlight = Date.now();
            statusDirty = false;
            earlyRefreshPending = false;
            pollId = uuid();
            return JSON.stringify({token, ack, poll_id: pollId, ...(commands[0] || {})});
        },
        pollFinished(value) {
            // On failure Gradio leaves the previous textbox value intact. Its
            // request ID prevents an old snapshot from masquerading as recovery.
            let reply;
            try { reply = JSON.parse(value); } catch (_) {}
            if (reply && reply.poll_id === pollId && pollId !== null) {
                pollId = null;
                this.receive(value);
                return;
            }
            if (!pollId) return;
            pollId = null;
            inFlight = 0;
            statusDirty = true;
            failures = Math.min(failures + 1, 5);
            retryAt = Date.now() + Math.min(15000, 750 * 2 ** failures);
            connectionError = t("Queue status connection failed. Retrying automatically; generation requests are not replayed.", "状態確認の通信が失敗しました。自動で再接続します。生成要求は自動再送しません。");
            paint();
        },
        receive(value) {
            try { state = JSON.parse(value); } catch (_) { return; }
            inFlight = 0;
            connectionError = "";
            failures = 0;
            retryAt = 0;
            error = state.message || "";
            if ((state.rows || []).some(row => row.number > sendingAfter)) sendingUntil = 0;
            if (commands[0] && state.command_id === commands[0].command_id) commands.shift();
            ack = state.result_seq || ack;
            const running = (state.rows || []).find(row => row.state === "running");
            const taskId = running?.id || null;
            if (taskId !== monitored) {
                monitored = taskId;
                progressValue = null;
                if (taskId) {
                    // Reuse the native monitor; late replies must not update the next job.
                    requestProgress(taskId, el("txt2img_gallery_container"), el("txt2img_gallery"), () => {}, res => {
                        if (taskId !== monitored || !res.active || !Number.isFinite(res.progress)) return;
                        progressValue = Math.max(0, Math.min(1, res.progress));
                        paintProgress();
                    });
                }
            }
            paint();
            if (earlyRefreshPending) tick();
        },
    };
    onOptionsAvailable(() => {
        optionsReady = true;
        for (const waiter of optionsWaiters) {
            clearTimeout(waiter.timer);
            waiter.resolve();
        }
        optionsWaiters.clear();
        error = state.message || "";
        tick();
    });
    onUiLoaded(() => {
        el("txt2img_generate")?.addEventListener("contextmenu", event => {
            if (enabled()) { event.preventDefault(); event.stopImmediatePropagation(); }
        }, true);
        tick();
        setInterval(tick, 750);
    });
    onOptionsChanged(tick);
})();
