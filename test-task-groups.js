// Needs your action / Ready to review: one card per app, every task reachable through
// measured pages, own status per task, estimates distinct, blank empty state, English only.
const assert = require('assert'), fs = require('fs'), vm = require('vm'), path = require('path');
const {JSDOM} = (() => { for (const p of [process.env.JSDOM_PATH, 'jsdom']) if (p) try { return require(p); } catch (_) {} throw Error('jsdom not found: npm install jsdom, or set JSDOM_PATH'); })();
const html = fs.readFileSync(process.argv[2] || path.join(__dirname, 'index.html'), 'utf8');
for (const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(m[1]);
const w = new JSDOM('<div id="need-list"></div><div id="ready-list"></div>').window;
// jsdom has no layout engine: give rows and headers fixed synthetic heights.
const rowHeight = e => e.classList.contains('ask-row') ? 96 : 60;
w.HTMLElement.prototype.getBoundingClientRect = function () {
  if (this.classList.contains('live-rows')) return {height: [...this.children].reduce((n, r) => n + rowHeight(r), 0)};
  if (this.classList.contains('live-group')) return {height: 46 + this.querySelector('.live-rows').getBoundingClientRect().height};
  if (this.classList.contains('live-row')) return {height: rowHeight(this)};
  return {height: 0};
};
for (const id of ['need-list', 'ready-list']) Object.defineProperty(w.document.getElementById(id), 'clientHeight', {value: 330, configurable: true});
const c = {document: w.document, getComputedStyle: w.getComputedStyle.bind(w), location: {}, Map, Set, JSON, Math, Date, Number, String, console,
  N: {claude: 'Claude', cursor: 'Cursor', codex: 'Codex'}, titleTranslations: {}, hasCJK: t => /[㐀-鿿豈-﫿]/u.test(String(t || '')),
  ago: n => Math.round(n / 60000) + 'm ago', offset: 0, pageIndex: {need: 0, ready: 0}, panelCache: {}, pages: {},
  pager: (kind, n) => { c.pages[kind] = n; }, $: id => w.document.getElementById(id), mark: s => c.el('div', 'mark', ''),
  groups: a => Object.values(a.reduce((o, s) => { (o[s.source] ??= {source: s.source, items: []}).items.push(s); return o; }, {})),
  notice: m => { c.lastNotice = m; }, dismiss: id => { c.dismissed = id; }, reviewApproval: s => { c.reviewed = s.approval.aid; }};
c.el = (t, cls, text) => { const e = w.document.createElement(t); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
c.batchMode = false; c.batchSending = false; c.batchSkip = new Set(); // batch approval off (single requests)
vm.createContext(c);
const load = name => { const a = html.indexOf('function ' + name + '('); assert(a >= 0, 'Missing ' + name); let b = html.indexOf('\nfunction ', a + 1); if (b < 0) b = html.length; vm.runInContext(html.slice(a, b), c); };
// completionVia is loaded together with drawNeed by the extractor.
['english', 'agentName', 'taskTitle', 'taskDetail', 'estimatedNotification', 'updateCountdowns', 'partition', 'sourceRank', 'orderedGroups', 'taskGroup', 'openAgentApp',
  'needRow', 'drawNeed', 'readyRow', 'drawReady', 'drawStacked', 'stackedPages', 'renderNeed', 'renderReady'].forEach(load);

const now = Date.now(), at = i => now - i * 60000;
const need = [
  {id: 'codex:a:approval:1', parentSessionId: 'codex:a', source: 'codex', title: 'Run the synthetic build', status: 'needs_action', updatedAt: at(1), message: 'Synthetic request', approval: {aid: 'aid-1', tool: 'Bash', expiresAt: now + 45000}},
  {id: 'codex:b', source: 'codex', title: 'Answer a question', status: 'needs_action', updatedAt: at(2), message: 'Please answer this question in the agent app.'},
  {id: 'claude:c:approval:2', parentSessionId: 'claude:c', source: 'claude', title: '修复登录页', project: 'web-app', status: 'needs_action', updatedAt: at(3), message: '', approval: {aid: 'aid-2', tool: 'Edit', expiresAt: now + 30000}},
  {id: 'claude:notification-g-9', source: 'claude', taskKind: 'notification', stateSource: 'macos-notification', status: 'needs_action', updatedAt: at(4), message: 'Notification estimate.'},
  {id: 'cursor:d', source: 'cursor', title: 'Cursor is waiting', status: 'needs_action', updatedAt: at(5), message: ''},
  {id: 'cursor:e', source: 'cursor', title: 'Second Cursor request', status: 'needs_action', updatedAt: at(6), message: ''},
  {id: 'codex:f', source: 'codex', title: 'Third Codex item', status: 'needs_action', updatedAt: at(7), message: ''},
];
c.latest = {now, needAll: need, readyAll: []};

// Walk every page and check grouping and reachability.
const box = w.document.getElementById('need-list'), seen = new Set();
c.renderNeed(need);
assert(c.pages.need > 1, 'Seven tall requests in 330px need several pages');
for (let p = 0; p < c.pages.need; p++) {
  c.pageIndex.need = p; c.renderNeed(need);
  const cards = [...box.querySelectorAll('.task-group')];
  assert.equal(new Set(cards.map(g => g.dataset.source)).size, cards.length, 'One card per app on a page');
  for (const card of cards) {
    assert.equal(card.querySelector('.live-count').textContent, need.filter(s => s.source === card.dataset.source).length + ' tasks', 'Header counts all of that app\'s tasks, not just this page');
    card.querySelectorAll('.live-row').forEach(r => { assert(r.dataset.taskId.startsWith(card.dataset.source + ':')); seen.add(r.dataset.taskId); });
  }
}
assert.equal(seen.size, need.length, 'Every request reachable through pages');

// Each row keeps its own status and actions.
c.pageIndex.need = 0; c.panelCache = {}; c.renderNeed(need.slice(0, 2));
const [approvalRow, waitingRow] = box.querySelectorAll('.live-row');
assert.match(approvalRow.querySelector('.live-status').textContent, /^\d+s left$/, 'Approval shows its own countdown');
approvalRow.querySelector('.action.primary').click(); assert.equal(c.reviewed, 'aid-1', 'Single click opens the exact request');
assert.equal(waitingRow.querySelector('.live-status').textContent, 'Waiting');
waitingRow.querySelector('[aria-label^="Dismiss reminder"]').click(); assert.equal(c.dismissed, 'codex:b');

// Estimated notification and CJK titles.
c.panelCache = {}; c.renderNeed(need.slice(2, 4));
const estimate = box.querySelector('.notification-estimate');
assert(estimate, 'Estimated rows are visibly distinct');
assert.equal(estimate.querySelector('.live-status').textContent, 'Estimated');
assert(estimate.querySelector('.live-title').textContent.startsWith('Estimated · '));
assert(!estimate.querySelector('.action.primary'), 'An estimate never offers approval');
assert(box.textContent.includes('web-app · Approval required'), 'A non-English prompt falls back to the project, not a generic label');
assert(!c.hasCJK(box.textContent), 'Dashboard text stays English');

// Ready to review uses the same card, its own completion evidence and a reviewed control.
const ready = [
  {id: 'codex:r1', source: 'codex', title: 'Ship the settings page', status: 'done', completionReason: 'hook', updatedAt: at(2)},
  {id: 'codex:r2', source: 'codex', title: 'Recovered from the local log', status: 'done', completionReason: 'local-lifecycle', updatedAt: at(9)},
  {id: 'claude:notification-g-3', source: 'claude', taskKind: 'notification', stateSource: 'macos-notification', status: 'done', updatedAt: at(1)},
];
c.latest = {now, needAll: [], readyAll: ready}; c.renderReady(ready);
const readyBox = w.document.getElementById('ready-list');
assert.equal(readyBox.querySelectorAll('.task-group.done-group').length, 2);
assert.equal(readyBox.querySelectorAll('.task-group.done-group.live-group').length, 2, 'Same card component as Live activity');
assert(readyBox.textContent.includes('Finished 2m ago · hook report'));
assert(readyBox.textContent.includes('Finished 9m ago · Codex local log'));
assert(readyBox.querySelector('.notification-estimate .live-status').textContent.startsWith('Estimated'));
readyBox.querySelector('[aria-label="Mark Ship the settings page reviewed"]').click(); assert.equal(c.dismissed, 'codex:r1');

// Empty panels are blank: no card, no placeholder text.
c.panelCache = {}; c.latest = {now, needAll: [], readyAll: []}; c.renderNeed([]); c.renderReady([]);
assert.equal(box.childElementCount, 0); assert.equal(readyBox.childElementCount, 0); assert.equal(readyBox.textContent, '');
console.log('Task group tests passed: one card per app, all requests reachable, per-task status and actions, estimates distinct, English titles, blank empty state.');
