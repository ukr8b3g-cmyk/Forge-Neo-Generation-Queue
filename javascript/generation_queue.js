/* Standard Generate stays in place. Only its registered txt2img event calls submit(). */
(() => {
    "use strict";
    let token;
    const uuid = () => crypto.randomUUID().replaceAll("-", "");
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
    let lastView = "";
    let error = "";
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
    function paint() {
        const panel = el("forge_generation_queue_panel");
        const box = el("txt2img_generate_box");
        if (!panel || !box) return;
        // Keep Gradio components in their original DOM tree (delegated events).
        const ownBusy = (state.rows || []).some(row => ["pending", "waiting", "running"].includes(row.state));
        const mode = state.ready && (enabled() || ownBusy);
        box.classList.toggle("fq-mode", mode);
        const running = (state.rows || []).find(row => row.state === "running");
        box.classList.toggle("fq-generating", !!running);
        panel.style.setProperty("display", enabled() || ownBusy || state.can_resume || error ? "flex" : "none", "important");
        const content = el("fq_content");
        const view = JSON.stringify([state.rows, state.paused, state.can_resume, state.ready, enabled(), error, japanese()]);
        if (!content || lastView === view) return;
        lastView = view;
        const expanded = content.querySelector("details")?.open || false;
        content.replaceChildren();
        const details = document.createElement("details");
        details.open = expanded;
        const heading = document.createElement("summary");
        heading.className = "fq-heading";
        const pending = (state.rows || []).filter(row => ["pending", "waiting"].includes(row.state)).length;
        const status = !state.ready ? t("Connecting…", "接続中…") :
            state.paused ? t("Paused", "停止中") : running ?
                running.cancelling ? t("Interrupting", "中断中") : t("Generating", "生成中") : "";
        heading.textContent = `${status ? status + " · " : ""}${t(`Queued: ${pending}`, `待機 ${pending}件`)}`;
        heading.title = t("Click to view or cancel individual jobs", "クリックで予約の詳細・個別取消");
        details.append(heading);
        content.append(details);
        if (error || state.paused) {
            const notice = document.createElement("div");
            notice.className = "fq-notice";
            notice.textContent = t("Check queue", "要確認");
            notice.title = error || state.paused;
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
        for (const row of state.rows || []) {
            const line = document.createElement("div");
            line.className = "fq-row";
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
    }
    function stopRepeat() {
        // Native Generate forever tests Interrupt visibility. It cannot share queue mode.
        if (typeof regen_txt2img !== "undefined" && regen_txt2img !== null) {
            clearInterval(regen_txt2img);
            regen_txt2img = null;
        }
    }
    function tick() {
        paint();
        if (enabled()) stopRepeat();
        if (state.ready && !enabled() && !state.busy && !commands.length) return;
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
            if (!state.ready || error) throw new Error(t("Generation queue is not connected. Reload the page.", "生成キューに接続できていません。ページを再読み込みしてください。"));
            const values = create_submit_args(args);
            values[0] = `fq:${token}:${uuid()}`;
            return values;
        },
        pollArgs() {
            return JSON.stringify({token, ack, poll_id: uuid(), ...(commands[0] || {})});
        },
        receive(value) {
            inFlight = 0;
            try { state = JSON.parse(value); } catch (_) { return; }
            error = state.message || "";
            if (commands[0] && state.command_id === commands[0].command_id) commands.shift();
            ack = state.result_seq || ack;
            const running = (state.rows || []).find(row => row.state === "running");
            if (running && running.id !== monitored) {
                monitored = running.id;
                requestProgress(running.id, el("txt2img_gallery_container"), el("txt2img_gallery"), () => {});
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
