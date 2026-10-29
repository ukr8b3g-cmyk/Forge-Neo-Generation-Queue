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
    let monitored = null;
    let progressValue = null;
    let lastView = "";
    let error = "";
    let sendingUntil = 0;
    let sendingAfter = 0;
    const connectionWaiters = new Set();
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
        const bar = el("fq_content")?.querySelector(".fq-progress");
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
        const mode = state.ready && (enabled() || ownBusy);
        box.classList.toggle("fq-mode", mode);
        const running = active.find(row => row.state === "running");
        const newest = (state.rows || []).reduce((last, row) => !last || row.number > last.number ? row : last, null);
        const latestFailure = newest?.state === "failed" ? newest.error : "";
        box.classList.toggle("fq-generating", !!running);
        const connecting = !state.ready && (enabled() || connectionWaiters.size > 0);
        box.classList.toggle("fq-submitting", !running && (sending || connecting));
        el("txt2img_generate")?.setAttribute("aria-busy", running || sending || connecting ? "true" : "false");
        const visible = ownBusy || sending || state.paused || state.can_resume || error || latestFailure || connecting;
        panel.style.setProperty("display", visible ? "flex" : "none", "important");
        const content = el("fq_content");
        const view = JSON.stringify([state.rows, state.paused, state.can_resume, state.ready, enabled(), error, japanese(), sending, connecting]);
        if (!content || lastView === view) return;
        lastView = view;
        const expanded = ownBusy && (content.querySelector("details")?.open || false);
        content.replaceChildren();
        if (!visible) return;
        const details = document.createElement("details");
        details.open = expanded;
        const heading = document.createElement("summary");
        heading.className = "fq-heading";
        const status = connecting ? t("Connecting…", "接続中…") :
            state.paused ? t("Paused", "停止中") : running ?
                running.cancelling ? t("Interrupting", "中断中") : t("Generating", "生成中") : sending ? t("Sending…", "送信中…") : "";
        heading.textContent = [status, ownBusy ? t(`Remaining: ${active.length}`, `残り ${active.length}件`) : "",
            ownBusy && sending && running ? t("Sending…", "送信中…") : ""].filter(Boolean).join(" · ");
        heading.title = t("Click to view or cancel individual jobs", "クリックで予約の詳細・個別取消");
        details.append(heading);
        content.append(details);
        if (error || state.paused || latestFailure) {
            const notice = document.createElement("div");
            notice.className = "fq-notice";
            notice.textContent = t("Check queue", "要確認");
            const failed = (state.rows || []).filter(row => row.state === "failed").at(-1);
            notice.title = [error || state.paused, latestFailure || (state.paused && failed?.error)].filter(Boolean).join("\n");
            content.append(notice);
            if (state.can_resume) {
                const resume = document.createElement("button");
                resume.type = "button";
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
    function waitForConnection() {
        return new Promise((resolve, reject) => {
            const waiter = {resolve, timer: null};
            waiter.timer = setTimeout(() => {
                connectionWaiters.delete(waiter);
                error = t("Queue connection timed out. Check the Forge log, then try Generate again.", "キューへの接続がタイムアウトしました。Forgeのログを確認し、再度Generateを押してください。");
                paint();
                reject(new Error(error));
            }, 10000);
            connectionWaiters.add(waiter);
            tick();
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
        // Immediate feedback is not an accepted job and never changes the count.
        sendingAfter = Math.max(0, ...(state.rows || []).map(row => row.number));
        sendingUntil = Date.now() + 5000;
        paint();
        // One early status check; keep the normal idle polling interval unchanged.
        setTimeout(tick, 100);
        return values;
    }
    function tick() {
        paint();
        if (enabled()) stopRepeat();
        if (state.ready && !enabled() && !state.busy && !commands.length && !state.result_seq) return;
        if (inFlight && Date.now() - inFlight < 15000) return;
        if (inFlight) {
            error = t("Checking the queue connection. Wait before clicking Generate again.", "キューとの通信を確認中です。Generateを連打せず、接続をお待ちください。");
            paint();
        }
        const poll = el("fq_poll");
        if (poll) { inFlight = Date.now(); poll.click(); }
    }
    window.forgeGenerationQueue = {
        submit(...args) {
            if (!enabled() && !state.busy) return submit(...args);
            stopRepeat();
            // Capture the click's inputs before waiting for the initial handshake.
            const values = create_submit_args(args);
            if (!state.ready) return waitForConnection().then(() => send(values));
            return send(values);
        },
        pollArgs() {
            return JSON.stringify({token, ack, poll_id: uuid(), ...(commands[0] || {})});
        },
        receive(value) {
            inFlight = 0;
            try { state = JSON.parse(value); } catch (_) { return; }
            error = state.message || "";
            if ((state.rows || []).some(row => row.number > sendingAfter)) sendingUntil = 0;
            if (state.ready) {
                for (const waiter of connectionWaiters) {
                    clearTimeout(waiter.timer);
                    waiter.resolve();
                }
                connectionWaiters.clear();
            }
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
        },
    };
    onUiLoaded(() => {
        el("txt2img_generate")?.addEventListener("contextmenu", event => {
            if (enabled()) { event.preventDefault(); event.stopImmediatePropagation(); }
        }, true);
        tick();
        setInterval(tick, 750);
    });
    onOptionsChanged(tick);
})();
