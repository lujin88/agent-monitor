// Batch approval on the real page: with 2+ approval requests each gets a checkbox (checked by
// default) and one button approves every checked request, each sent and confirmed separately.
// Synthetic state only; no command is executed.
const assert = require('assert'), fs = require('fs'), path = require('path');
const {JSDOM} = (() => { for (const p of [process.env.JSDOM_PATH, 'jsdom']) if (p) try { return require(p); } catch (_) {} throw Error('jsdom not found: npm install jsdom, or set JSDOM_PATH'); })();
const html = fs.readFileSync(process.argv[2] || path.join(__dirname, 'index.html'), 'utf8');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function page(state, onDecide) {
  const decides = [];
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost/?key=test', pretendToBeVisual: true,
    beforeParse(w) {
      w.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
      Object.defineProperty(w.HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 2000; } });
      Object.defineProperty(w.HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 900; } });
      w.HTMLElement.prototype.getBoundingClientRect = function () { return { height: this.classList.contains('live-row') ? 100 : 40, width: 900, top: 0, left: 0 }; };
      w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
      w.HTMLDialogElement.prototype.close = function () { this.open = false; };
      w.fetch = async (url, opts = {}) => {
        const route = new URL(url, 'http://localhost').pathname;
        if (route === '/state') { const now = Date.now(); return { ok: true, status: 200, json: async () => ({ ...state(), now }) }; }
        if (route === '/decide') { const body = JSON.parse(opts.body); decides.push(body); return onDecide(body); }
        return { ok: false, status: 404, json: async () => ({}) };
      };
    } });
  return { w: dom.window, decides };
}
const approval = (id, aid, source = 'codex', command = 'rm -rf build') => ({ id: source + ':' + id + ':approval:' + aid, parentSessionId: source + ':' + id, source, project: 'demo',
  title: 'Task ' + id, message: 'Synthetic', status: 'needs_action', startedAt: Date.now() - 1000, updatedAt: Date.now(),
  approval: { aid, tool: 'Bash', command, expiresAt: Date.now() + 60000 } });
const base = (sessions) => ({ waitSec: 60, sessions, usage: {}, usageStatus: {}, reports: { sources: {} }, chatTracking: { status: 'disabled' }, notificationStatus: {}, hookConfig: {}, grokActivity: {}, reviewWindow: { start: 0, nextReset: Date.now() + 1e7 } });
const confirmed = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, delivery: 'confirmed' }) });

(async () => {
  // Three approvals and one plain "waiting for input" reminder.
  let sessions = [approval('a', 'aid0000000000001'), approval('b', 'aid0000000000002', 'codex', 'git push origin main'),
    approval('c', 'aid0000000000003', 'claude', 'npm install'), { id: 'claude:q', source: 'claude', title: 'Question', status: 'needs_action', updatedAt: Date.now(), startedAt: Date.now() }];
  let release;
  const { w, decides } = page(() => base(sessions), (body) => new Promise((r) => { release = release || []; release.push(() => r({ ok: true, status: 200, json: async () => ({ ok: true, delivery: 'confirmed' }) })); }));
  await tick(50);
  const bar = w.document.getElementById('batch-bar');
  assert(!bar.hidden, 'bar shown for 3 approvals');
  assert.match(bar.textContent, /3 of 3 requests selected/);
  const boxes = [...w.document.querySelectorAll('.batch-pick input')];
  assert.equal(boxes.length, 3, 'one checkbox per approval, none for the plain reminder');
  assert(boxes.every((b) => b.checked), 'checked by default');
  const commands = [...w.document.querySelectorAll('.live-command')].map((n) => n.textContent);
  assert(commands.some((c) => c.includes('git push origin main')), 'the exact command is visible in batch mode');
  // Untick one: it is left out.
  boxes[1].checked = false; boxes[1].dispatchEvent(new w.Event('change'));
  assert.match(bar.textContent, /2 of 3 requests selected/);
  const button = bar.querySelector('button');
  assert.equal(button.textContent, 'Approve selected (2)');
  // Unticked state survives a re-render from the next poll.
  await tick(1600);
  assert.equal([...w.document.querySelectorAll('.batch-pick input')].filter((b) => !b.checked).length, 1, 'unticked box stays unticked after refresh');
  const skipped = w.document.querySelectorAll('.batch-pick input')[1].closest('li').dataset.taskId;
  bar.querySelector('button').click(); bar.querySelector('button').click();
  await tick(10);
  assert.equal(decides.length, 2, 'two decisions, double click does not duplicate');
  assert(decides.every((d) => d.decision === 'allow'));
  assert(!decides.some((d) => skipped.endsWith(d.aid)), 'unticked request not approved');
  assert.match(bar.textContent, /Sending approvals/); assert(bar.querySelector('button').disabled);
  sessions = sessions.filter((s) => !decides.some((d) => s.approval?.aid === d.aid));
  release.forEach((f) => f()); await tick(30);
  assert.match(w.document.getElementById('notice').textContent, /^2 approved$/);
  await tick(1600);
  assert(bar.hidden, 'one approval left: no batch bar');
  assert.equal(w.document.querySelectorAll('.batch-pick').length, 0, 'single approval: no checkboxes');
  w.close();

  // Mixed outcome: one confirmed, one expired, one unconfirmed. The summary says so.
  const s2 = [approval('x', 'aid00000000000x1'), approval('y', 'aid00000000000y2'), approval('z', 'aid00000000000z3')];
  const p2 = page(() => base(s2), async (body) => body.aid.endsWith('1') ? confirmed() : body.aid.endsWith('2')
    ? { ok: false, status: 410, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ ok: false, delivery: 'unconfirmed' }) });
  await tick(50);
  p2.w.document.querySelector('#batch-bar button').click(); await tick(30);
  const msg = p2.w.document.getElementById('notice').textContent;
  assert.equal(p2.decides.length, 3);
  assert(msg.includes('1 approved') && msg.includes('1 expired') && msg.includes('1 sent without confirmation'), msg);
  assert(p2.w.document.getElementById('notice').className.includes('error'));
  p2.w.close();

  // Expired requests are never part of a batch.
  const old = approval('o', 'aid00000000000o1'); old.approval.expiresAt = Date.now() - 1;
  const p3 = page(() => base([old, approval('n', 'aid00000000000n1')]), confirmed);
  await tick(50);
  assert(p3.w.document.getElementById('batch-bar').hidden, 'one live + one expired: no batch');
  p3.w.close();

  console.log('Batch approve passed: checkbox per request (checked by default), commands visible, untick survives refresh, only ticked sent, no duplicates, mixed-result summary, expired excluded, hidden below two.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
