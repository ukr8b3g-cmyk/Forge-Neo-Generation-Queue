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
        create_submit_args: args => [...args],
        submit: (...args) => ['native', ...args], requestProgress() {},
    };
    // Capture the normal timer without starting a service or an actual interval.
    context.onUiLoaded = fn => { context.loaded = fn; };
    context.window = context;
    vm.runInNewContext(source, context);
    context.loaded();
    return {context, api: context.forgeGenerationQueue, stored: () => stored,
        tick: () => interval(), polls: () => polls};
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

test('ON refuses submission until connected', () => {
    assert.throws(() => client().api.submit('old'), /not connected/);
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
