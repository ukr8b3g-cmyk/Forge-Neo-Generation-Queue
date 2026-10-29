// Portable tests of the real client script; only Node's standard library is used.
const assert = require('node:assert/strict');
const {webcrypto} = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../javascript/generation_queue.js'), 'utf8');

function client({stored = null, storageDenied = false} = {}) {
    let interval;
    let polls = 0;
    let timerId = 0;
    const timers = new Map();
    const context = {
        // Deliberately omit randomUUID, as on an HTTP LAN origin.
        crypto: {getRandomValues: values => webcrypto.getRandomValues(values)},
        sessionStorage: {
            getItem() { if (storageDenied) throw Error('denied'); return stored; },
            setItem(key, value) { stored = value; },
        },
        opts: {forge_generation_queue_enabled: true},
        gradioApp: () => ({getElementById: id => id === 'fq_poll' ? {click() { polls++; }} : null}),
        onUiLoaded() {}, onOptionsChanged() {},
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
    return {context, api: context.forgeGenerationQueue, stored: () => stored,
        tick: () => interval(), polls: () => polls,
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

test('startup submission waits for connection and preserves clicked inputs', async () => {
    const c = client();
    const args = ['old', 'original prompt'];
    const submitted = c.api.submit(...args);
    assert.equal(typeof submitted.then, 'function');
    args[1] = 'later prompt';
    c.api.receive(JSON.stringify({ready: true, rows: [], busy: false}));
    const values = await submitted;
    assert.match(values[0], /^fq:[a-f0-9]{32}:[a-f0-9]{32}$/);
    assert.equal(values[1], 'original prompt');
});

test('startup timeout rejects without automatically resubmitting', async () => {
    const c = client();
    const submitted = c.api.submit('old', 'prompt');
    const rejected = assert.rejects(submitted, /connection timed out/);
    c.runTimeouts(10000);
    await rejected;
    c.api.receive(JSON.stringify({ready: true, rows: [], busy: false}));
    c.runTimeouts(100);
    assert.equal(c.polls(), 1); // Only the initial handshake, no delayed submission poll.
});

test('switching OFF during startup never silently starts native generation', async () => {
    const c = client();
    const submitted = c.api.submit('old', 'prompt');
    c.context.opts.forge_generation_queue_enabled = false;
    c.api.receive(JSON.stringify({ready: true, rows: [], busy: false}));
    await assert.rejects(submitted, /switched OFF/);
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
    assert.equal(JSON.parse(c.api.pollArgs()).ack, 5);
    const before = c.polls();
    c.tick();
    assert.equal(c.polls(), before + 1);
    c.api.receive(JSON.stringify({ready: true, rows: [], busy: false, result_seq: 0}));
    c.tick();
    assert.equal(c.polls(), before + 1);
});
