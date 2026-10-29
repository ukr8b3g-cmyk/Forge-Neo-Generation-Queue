// Portable tests of the real client script; only Node's standard library is used.
const assert = require('node:assert/strict');
const {webcrypto} = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../javascript/generation_queue.js'), 'utf8');

function client({stored = null, storageDenied = false, nodes = {},
    options = {forge_generation_queue_enabled: true}, load = true} = {}) {
    let interval;
    let polls = 0;
    let timerId = 0;
    let clock = Date.now();
    let optionsAvailable;
    const timers = new Map();
    const requests = [];
    const context = {
        // Deliberately omit randomUUID, as on an HTTP LAN origin.
        crypto: {getRandomValues: values => webcrypto.getRandomValues(values)},
        sessionStorage: {
            getItem() { if (storageDenied) throw Error('denied'); return stored; },
            setItem(key, value) { stored = value; },
        },
        Date: {now: () => clock},
        opts: {...options},
        gradioApp: () => ({getElementById: id => nodes[id] || (id === 'fq_poll' ? {click() {
            polls++;
            requests.push(JSON.parse(context.forgeGenerationQueue.pollArgs()));
        }} : null)}),
        onUiLoaded() {}, onOptionsChanged() {},
        onOptionsAvailable(fn) { optionsAvailable = fn; if (Object.keys(context.opts).length) fn(); },
        setInterval(fn) { interval = fn; }, clearInterval() {},
        setTimeout(fn, delay) { timers.set(++timerId, {fn, delay}); return timerId; },
        clearTimeout(id) { timers.delete(id); },
        create_submit_args: args => [...args],
        submit: (...args) => ['native', ...args], requestProgress() {},
    };
    // Capture the normal timer without starting a service or an actual interval.
    context.onUiLoaded = fn => { context.loaded = fn; };
    context.window = context;
    vm.runInNewContext(source, context);
    context.loaded();
    const beginLoad = () => requests.push(JSON.parse(context.forgeGenerationQueue.pollArgs()));
    if (load) beginLoad();
    return {context, api: context.forgeGenerationQueue, stored: () => stored,
        tick: () => interval(), polls: () => polls,
        beginLoad, lastRequest: () => requests.at(-1),
        advance: ms => { clock += ms; },
        loadOptions: value => { context.opts = value; optionsAvailable(); },
        runTimeouts: delay => { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.fn(); } }};
}

test('HTTP origin initializes and creates distinct cryptographic IDs', () => {
    const {api, stored} = client();
    api.receive(JSON.stringify({ready: true, rows: [], busy: false}));
    const ids = Array.from({length: 100}, () => api.submit('old', 'prompt')[0]);
    assert.match(stored(), /^[a-f0-9]{32}$/);
    ids.forEach(id => assert.match(id, /^fq:[a-f0-9]{32}:[a-f0-9]{32}$/));
    assert.equal(new Set(ids).size, 100);
    assert.notEqual(JSON.parse(api.pollArgs()).poll_id, JSON.parse(api.pollArgs()).poll_id);
});

test('denied session storage still allows submission', () => {
    const {api} = client({storageDenied: true});
    api.receive(JSON.stringify({ready: true, rows: [], busy: false}));
    assert.match(api.submit('old')[0], /^fq:[a-f0-9]{32}:[a-f0-9]{32}$/);
});

test('same-tab reload reuses client identity', () => {
    const first = client();
    const next = client({stored: first.stored()});
    assert.equal(next.stored(), first.stored());
    assert.equal(JSON.parse(first.api.pollArgs()).token, JSON.parse(next.api.pollArgs()).token);
});

test('OFF uses native submission when the queue is idle', () => {
    const {context, api} = client();
    context.opts.forge_generation_queue_enabled = false;
    api.receive(JSON.stringify({ready: true, rows: [], busy: false}));
    assert.deepEqual(Array.from(api.submit('task', 'prompt')), ['native', 'task', 'prompt']);
});

test('startup submits three distinct jobs before the first status reply', () => {
    const c = client();
    const args = ['old', 'original prompt'];
    const submitted = Array.from({length: 3}, () => c.api.submit(...args));
    args[1] = 'later prompt';
    assert.ok(submitted.every(values => Array.isArray(values) && values[1] === 'original prompt'));
    assert.equal(new Set(submitted.map(values => values[0])).size, 3);
    submitted.forEach(values => assert.match(values[0], /^fq:[a-f0-9]{32}:[a-f0-9]{32}$/));
    c.runTimeouts(10000); // A slow status response no longer expires a Generate click.
    c.runTimeouts(100);
    assert.equal(c.polls(), 0, 'Do not overlap the load request');
    c.api.receive(JSON.stringify({ready: true, rows: [], busy: false}));
    assert.equal(submitted.length, 3);
});

test('UI hooks do not click the poll button before Gradio load', () => {
    const c = client({load: false});
    c.tick();
    assert.equal(c.polls(), 0);
    assert.match(c.api.submit('old', 'prompt')[0], /^fq:/);
    c.runTimeouts(100);
    assert.equal(c.polls(), 0);
    c.beginLoad();
    c.api.receive(JSON.stringify({ready: true, rows: [], busy: false}));
    c.tick();
    assert.equal(c.polls(), 1);
});

test('only missing local settings delay submission and clicked inputs are preserved', async () => {
    const c = client({options: {}});
    const args = ['old', 'original prompt'];
    const submitted = c.api.submit(...args);
    assert.equal(typeof submitted.then, 'function');
    args[1] = 'later prompt';
    c.loadOptions({forge_generation_queue_enabled: true});
    const values = await submitted;
    assert.match(values[0], /^fq:/);
    assert.equal(values[1], 'original prompt');
    assert.equal(c.polls(), 0, 'No status response is needed to submit');
});

test('settings timeout rejects without submitting when settings arrive late', async () => {
    const c = client({options: {}});
    const submitted = c.api.submit('old', 'prompt');
    const rejected = assert.rejects(submitted, /settings did not finish loading/);
    c.runTimeouts(10000);
    await rejected;
    c.loadOptions({forge_generation_queue_enabled: true});
    c.runTimeouts(100);
    assert.equal(c.polls(), 0, 'The expired click must not schedule a delayed submission');
    assert.match(c.api.submit('new', 'manual retry')[0], /^fq:/);
});

test('initial OFF settings choose native generation once options are known', async () => {
    const c = client({options: {}});
    const submitted = c.api.submit('old', 'prompt');
    c.loadOptions({forge_generation_queue_enabled: false});
    assert.deepEqual(Array.from(await submitted), ['native', 'old', 'prompt']);
});

test('known OFF is native even before the first status reply', () => {
    const c = client({options: {forge_generation_queue_enabled: false}});
    assert.deepEqual(Array.from(c.api.submit('old', 'prompt')), ['native', 'old', 'prompt']);
});

test('OFF while accepted jobs remain never falls back to native generation', () => {
    const c = client({options: {forge_generation_queue_enabled: false}});
    c.api.receive(JSON.stringify({ready: true, rows: [], busy: true}));
    assert.throws(() => c.api.submit('old', 'prompt'), /switched OFF/);
});

test('stale empty status cannot stop polling after a startup submission and OFF', () => {
    const c = client();
    c.api.submit('old', 'prompt');
    c.context.opts.forge_generation_queue_enabled = false;
    c.api.receive(JSON.stringify({ready: true, enabled: false, rows: [], busy: false}));
    c.tick();
    assert.equal(c.polls(), 1, 'A status request after the click is still required');
    c.api.receive(JSON.stringify({ready: true, enabled: false, rows: [], busy: false, result_seq: 3}));
    c.tick();
    assert.equal(c.lastRequest().ack, 3);
    c.api.receive(JSON.stringify({ready: true, enabled: false, rows: [], busy: false, result_seq: 0}));
    c.tick();
    assert.equal(c.polls(), 2);
});

test('server ON status prevents stopping before an OFF change is confirmed', () => {
    const c = client({options: {forge_generation_queue_enabled: false}});
    c.api.receive(JSON.stringify({ready: true, enabled: true, rows: [], busy: false}));
    c.tick();
    assert.equal(c.polls(), 1);
});

test('stalled status requests report timeout without overlapping or automatic resubmission', () => {
    const c = client();
    c.advance(16000);
    c.tick();
    c.tick();
    assert.equal(c.polls(), 0);
    assert.throws(() => c.api.submit('old', 'prompt'), /Queue status timed out/);
    c.api.receive(JSON.stringify({ready: true, rows: [], busy: false}));
    assert.match(c.api.submit('old', 'manual retry')[0], /^fq:/);
});

test('ready submission schedules one early status check', () => {
    const c = client();
    c.api.receive(JSON.stringify({ready: true, rows: [], busy: false}));
    const before = c.polls();
    c.api.submit('old', 'prompt');
    c.runTimeouts(100);
    assert.equal(c.polls(), before + 1);
});

test('OFF sends the final acknowledgement then stops idle polling', () => {
    const c = client();
    c.context.opts.forge_generation_queue_enabled = false;
    c.api.receive(JSON.stringify({ready: true, rows: [], busy: false, result_seq: 5}));
    const before = c.polls();
    c.tick();
    assert.equal(c.polls(), before + 1);
    assert.equal(c.lastRequest().ack, 5);
    c.api.receive(JSON.stringify({ready: true, rows: [], busy: false, result_seq: 0}));
    c.tick();
    assert.equal(c.polls(), before + 1);
});

test('native progress updates the heading and current row without another monitor or poll', () => {
    const attrs = new Map();
    const bar = {dataset: {taskId: 'a'}, style: {},
        setAttribute: (name, value) => attrs.set(name, String(value)),
        removeAttribute: name => attrs.delete(name)};
    let headingWidth;
    const heading = {dataset: {taskId: 'a'}, style: {
        setProperty: (name, value) => { assert.equal(name, '--fq-heading-progress'); headingWidth = value; }
    }};
    const c = client({nodes: {fq_content: {querySelector: selector => selector === '.fq-heading-running' ? heading : bar}}});
    const monitors = [];
    c.context.requestProgress = (id, container, gallery, atEnd, onProgress) => monitors.push({id, onProgress});
    const update = id => c.api.receive(JSON.stringify({ready: true, busy: true,
        rows: [{id, number: 1, state: 'running', label: 'Prompt'}]}));
    update('a');
    update('a');
    assert.equal(monitors.length, 1);
    const polls = c.polls();
    const progress = monitors[0].onProgress;
    progress({active: true, progress: 0.4});
    assert.equal(bar.style.width, '40%');
    assert.equal(headingWidth, '40%');
    assert.equal(attrs.get('aria-valuenow'), '40');
    for (const value of [null, undefined, NaN, Infinity, '0.8']) progress({active: true, progress: value});
    progress({active: false, progress: 0.9});
    assert.equal(bar.style.width, '40%');
    assert.equal(headingWidth, '40%');
    progress({active: true, progress: 2});
    assert.equal(bar.style.width, '100%');
    assert.equal(headingWidth, '100%');
    progress({active: true, progress: -1});
    assert.equal(bar.style.width, '0%');
    assert.equal(headingWidth, '0%');
    assert.equal(c.polls(), polls);

    bar.dataset.taskId = 'b';
    heading.dataset.taskId = 'b';
    update('b');
    progress({active: true, progress: 0.9});
    assert.equal(bar.style.width, '0%');
    assert.equal(headingWidth, '0%');
    monitors[1].onProgress({active: true, progress: 0.25});
    assert.equal(bar.style.width, '25%');
    assert.equal(headingWidth, '25%');
    c.api.receive(JSON.stringify({ready: true, busy: false, rows: []}));
    monitors[1].onProgress({active: true, progress: 1});
    assert.equal(bar.style.width, '25%');
    assert.equal(headingWidth, '25%');
});
