const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const storage = new Map();
const base = { sessions: [], terminals: [], subagents: [], hosted: [], host: 'test', build: 1 };

function page(snapshot) {
  const elements = new Map(), opened = [], live = new Set();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      innerHTML: '', textContent: '', hidden: false, value: '', dataset: {}, handlers: {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      style: { setProperty() {}, removeProperty() {} },
      addEventListener(type, fn) { this.handlers[type] = fn; },
      querySelector() { return null; }, focus() {}, replaceChildren() {},
    });
    return elements.get(id);
  };
  const local = { getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) };
  const context = vm.createContext({
    document: { getElementById: element }, console, crypto: { randomUUID: () => 'test-id' },
    sessionStorage: local, localStorage: local, innerWidth: 1400,
    addEventListener() {}, setInterval() {}, setTimeout() {}, clearTimeout() {},
    fetch: async () => ({ json: async () => snapshot }),
    location: { reload() { throw new Error('unexpected reload'); } },
    AgentsCanvas: { init() {}, onChange() {}, transform: () => ({ k: 1 }) },
    AgentsTerms: {
      ids: () => [...live], has: id => live.has(id),
      open(host, session) { opened.push(session); live.add(session.id); return session.id; },
      refit() {},
    },
  });
  context.window = context;
  vm.runInContext(fs.readFileSync('cards.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('app.js', 'utf8'), context);
  return { element, opened };
}

(async () => {
  const fresh = page(base);
  await new Promise(setImmediate);
  fresh.element('newAgent').value = 'shell';
  fresh.element('newDir').value = '/tmp';
  fresh.element('newForm').handlers.submit({ preventDefault() {} });
  assert.match(fresh.element('layer').innerHTML, /data-id="new-test-id"/);
  assert.match(fresh.element('layer').innerHTML, />Shell</);
  assert.equal(fresh.opened.length, 1);
  const resumed = page({ ...base, hosted: [{ id: 't-server' }], sessions: [{
    id: 'new-test-id', terminalId: 't-server', agent: 'shell', project: 'tmp',
    cwd: '/tmp', title: 'shell in tmp', mtime: 1, age: 0, status: 'idle',
  }] });
  await new Promise(setImmediate);
  assert.match(resumed.element('layer').innerHTML, /data-id="new-test-id"/);
  assert.equal(resumed.opened.length, 1);
  assert.equal(resumed.opened[0].terminalId, 't-server');
  assert.equal(resumed.opened[0].newIn, undefined);
  console.log('UI: immediate shell card and reload reattachment passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
