// Approval receipts, graceful shutdown and the Claude usage refresh gate.
// Isolated: random unused ports, temporary HOME and data, every collector and notification
// off (Claude usage is a stub module written into the temp copy). Synthetic requests only;
// approve.js only prints a decision, nothing is ever executed.
const assert = require('assert/strict'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), vm = require('vm');
const EventEmitter = require('events');
const { spawn } = require('child_process');

const KEY = 'isolated-completion';
const MODULES = ['server.js', 'approve.js', 'auto-approve.js', 'codex-watch.js', 'chat-watch.js', 'cursor-usage.js', 'claude-usage.js', 'grok-usage.js', 'grok-watch.js'];
const OFF = { CHAT_WATCH: 'off', CODEX_WATCH: 'off', CODEX_USAGE: 'off', CURSOR_USAGE: 'off', GROK_WATCH: 'off', GROK_USAGE: 'off', CLAUDE_USAGE: 'off', MONITOR_NOTIFICATIONS: 'off' };
const pause = ms => new Promise(r => setTimeout(r, ms));
const roots = [], servers = [];
let nextPort = 21000 + Math.floor(Math.random() * 800);

function call(s, method, route, body, key = KEY) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: s.port, path: route, method, agent: false, headers: { 'x-key': key, 'content-type': 'application/json' } }, res => {
      let b = ''; res.setEncoding('utf8'); res.on('data', c => { b += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, headers: res.headers, json, text: b }); });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

// prepare(box) may write fixtures and return extra environment variables.
async function startServer(name, extra = {}, prepare) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-completion-' + name + '-'));
  roots.push(root);
  const box = { root, dir: path.join(root, 'agent-monitor'), home: path.join(root, 'home') };
  fs.mkdirSync(box.dir); fs.mkdirSync(box.home);
  for (const f of MODULES) fs.copyFileSync(path.join(__dirname, f), path.join(box.dir, f));
  fs.writeFileSync(path.join(box.dir, 'token.txt'), KEY);
  const more = prepare ? prepare(box) || {} : {};
  const port = nextPort++;
  const child = spawn(process.execPath, [path.join(box.dir, 'server.js')], { env: { ...process.env, ...OFF, HOME: box.home, PORT: String(port), ...extra, ...more }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', c => { stderr += c; });
  const s = { ...box, port, base: `http://127.0.0.1:${port}`, child, stderr: () => stderr };
  s.exited = new Promise(r => child.once('exit', (code, signal) => r({ code, signal })));
  servers.push(s);
  for (let i = 0; i < 120; i++) { try { if ((await call(s, 'GET', '/state')).status === 200) return s; } catch (_) {} await pause(25); }
  throw Error('server did not start');
}
function stop(s) { if (s.child.exitCode === null && !s.child.signalCode) s.child.kill('SIGTERM'); return s.exited; }
async function waitCards(s, session, n = 1) {
  for (let i = 0; i < 100; i++) {
    const cards = (await call(s, 'GET', '/state')).json.sessions.filter(x => x.parentSessionId === 'codex:' + session);
    if (cards.length === n) return cards;
    await pause(20);
  }
  throw Error('approval not visible: ' + session);
}
const waitCard = async (s, session) => (await waitCards(s, session))[0];
const record = async (s, id) => (await call(s, 'GET', '/state')).json.sessions.find(x => x.id === id);
const ask = (s, session, extra = {}) => call(s, 'POST', '/ask', { source: 'codex', session, tool: 'Bash', command: 'echo synthetic', ...extra });
const ack = (s, r, overrides = {}, key) => call(s, 'POST', '/ack', { aid: r.aid, receipt: r.receipt, decision: r.decision, ...overrides }, key);
const files = dir => fs.readdirSync(dir);

// ---------- 1. approve.js: once-only handling, validation, flush before receipt ----------
function hookHarness() {
  const requests = [], writes = []; let exits = 0;
  const stdin = new EventEmitter(); stdin.setEncoding = () => {};
  const httpMock = { request(options, cb) {
    const req = new EventEmitter(); req.options = options; req.cb = cb; req.destroy = () => { req.destroyed = true; };
    req.end = b => { req.body = JSON.parse(b); }; requests.push(req); return req;
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'approve.js'), 'utf8'), {
    require: n => n === 'http' ? httpMock : n === 'fs' ? { readFileSync: () => 'test-key' } : require(n),
    __dirname: '/tmp/synthetic-monitor', URL, Buffer, setTimeout: () => 0,
    process: { argv: ['node', 'approve.js', 'codex'], env: {}, stdin, stdout: { write(s, cb) { writes.push({ s, cb }); return true; } }, exit() { exits++; } },
  });
  stdin.emit('data', JSON.stringify({ session_id: 's', cwd: '/tmp/synthetic', tool_name: 'Bash', tool_input: { command: 'rm synthetic' } }));
  stdin.emit('end');
  const respond = (req, status, body) => { const res = new EventEmitter(); res.statusCode = status; res.setEncoding = () => {}; req.cb(res); if (body !== undefined) res.emit('data', body); res.emit('end'); };
  return { requests, writes, respond, exits: () => exits };
}
function checkHook() {
  const aid = '0123456789abcdef', receipt = 'ab'.repeat(16);
  let h = hookHarness();
  assert.equal(h.requests[0].options.path, '/ask'); assert.equal(h.requests[0].body.ack, 1, 'hook announces receipt support');
  h.respond(h.requests[0], 200, JSON.stringify({ decision: 'allow', aid, receipt }));
  h.requests[0].emit('error', new Error('late duplicate')); h.requests[0].emit('timeout');
  assert.equal(h.writes.length, 1, 'decision printed once despite duplicate callbacks');
  assert.equal(JSON.parse(h.writes[0].s).hookSpecificOutput.decision.behavior, 'allow');
  assert.equal(h.requests.length, 1, 'no receipt before stdout is flushed'); assert.equal(h.exits(), 0, 'no exit before flush');
  h.writes[0].cb();
  assert.equal(h.requests.length, 2); assert.equal(h.requests[1].options.path, '/ack');
  assert.deepEqual({ ...h.requests[1].body }, { aid, receipt, decision: 'allow' });
  assert.equal(h.requests[1].options.headers['x-key'], 'test-key'); assert(h.requests[1].options.timeout <= 2000, 'receipt wait is bounded');
  assert.equal(h.exits(), 0);
  h.respond(h.requests[1], 410, '{}'); h.requests[1].emit('error', new Error('duplicate'));
  assert.equal(h.exits(), 1, 'exit exactly once, whatever the receipt result');

  // Non-200, oversized, malformed and unreachable responses print nothing.
  for (const [status, body] of [[500, '{"decision":"allow"}'], [200, '{"decision":"allow","pad":"' + 'x'.repeat(20000) + '"}'], [200, '{"decision":'], [200, '["allow"]'], [200, '{"decision":"maybe"}']]) {
    h = hookHarness(); h.respond(h.requests[0], status, body);
    assert.equal(h.writes.length, 0, status + ' ' + body.slice(0, 30)); assert.equal(h.exits(), 1);
  }
  h = hookHarness(); h.requests[0].emit('error', new Error('ECONNREFUSED'));
  assert.equal(h.writes.length, 0); assert.equal(h.exits(), 1);

  // Legacy reply (no receipt) or malformed receipt: print, flush, exit, never acknowledge.
  for (const reply of [{ decision: 'deny' }, { decision: 'deny', aid, receipt: 'not-hex' }, { decision: 'deny', aid: 'x', receipt }]) {
    h = hookHarness(); h.respond(h.requests[0], 200, JSON.stringify(reply));
    assert.equal(JSON.parse(h.writes[0].s).hookSpecificOutput.decision.behavior, 'deny');
    assert.equal(h.exits(), 0); h.writes[0].cb();
    assert.equal(h.requests.length, 1, 'no receipt without a valid secret'); assert.equal(h.exits(), 1);
  }
  // Output that could not be written is not acknowledged.
  h = hookHarness(); h.respond(h.requests[0], 200, JSON.stringify({ decision: 'allow', aid, receipt }));
  h.writes[0].cb(new Error('EPIPE'));
  assert.equal(h.requests.length, 1); assert.equal(h.exits(), 1);
}

// ---------- 2. Receipt protocol against an isolated server ----------
async function checkReceipts() {
  const s = await startServer('receipt', { APPROVAL_WAIT_SEC: '30', APPROVAL_ACK_MS: '1500' });

  // The real hook end to end, synthetic payload: confirmed only by its receipt.
  const hook = spawn(process.execPath, [path.join(s.dir, 'approve.js'), 'codex'], { env: { ...process.env, ...OFF, HOME: s.home, MONITOR_URL: s.base }, stdio: ['pipe', 'pipe', 'ignore'] });
  let out = ''; hook.stdout.setEncoding('utf8'); hook.stdout.on('data', c => { out += c; });
  const hookExit = new Promise(r => hook.once('exit', r));
  hook.stdin.end(JSON.stringify({ session_id: 'e2e', cwd: '/tmp/synthetic', tool_name: 'Bash', tool_input: { command: 'rm synthetic-never-run' } }));
  let card = await waitCard(s, 'e2e');
  assert.equal(card.approval.command, 'rm synthetic-never-run');
  let d = await call(s, 'POST', '/decide', { aid: card.approval.aid, decision: 'allow' });
  assert.deepEqual(d.json, { ok: true, delivery: 'confirmed' });
  assert.equal(await hookExit, 0);
  assert.equal(JSON.parse(out).hookSpecificOutput.decision.behavior, 'allow');
  let rec = await record(s, 'codex:e2e');
  assert.equal(rec.status, 'running'); assert.equal(rec.delivery.state, 'confirmed');

  // The secret goes only to the requesting hook; never to /state, disk or logs.
  let held = ask(s, 'raw', { ack: 1 });
  card = await waitCard(s, 'raw');
  assert.equal(card.approval.receipt, undefined);
  let decided = call(s, 'POST', '/decide', { aid: card.approval.aid, decision: 'allow' });
  const reply = (await held).json;
  assert.equal(reply.decision, 'allow'); assert.equal(reply.aid, card.approval.aid); assert.match(reply.receipt, /^[0-9a-f]{32}$/);
  assert(!(await call(s, 'GET', '/state')).text.includes(reply.receipt), 'secret never in /state');
  assert.equal((await record(s, 'codex:raw')).status, 'unobserved', 'a socket write alone is not confirmation');
  assert.equal((await ack(s, reply, {}, 'wrong-key')).status, 401, 'receipt endpoint is authenticated');
  assert.equal((await ack(s, reply, { receipt: '0'.repeat(32) })).status, 403, 'wrong secret');
  assert.equal((await ack(s, reply, { decision: 'deny' })).status, 403, 'a different decision is never confirmed');
  assert.equal((await ack(s, reply)).status, 200);
  assert.equal((await ack(s, reply)).status, 410, 'duplicate receipt');
  assert.equal((await decided).json.delivery, 'confirmed', 'a wrong secret did not consume the real receipt');
  assert.equal((await record(s, 'codex:raw')).status, 'running');
  await pause(400);
  assert(!fs.readFileSync(path.join(s.dir, 'state.json'), 'utf8').includes(reply.receipt), 'secret never persisted');
  assert(!s.stderr().includes(reply.receipt), 'secret never logged');

  // No receipt: unconfirmed (not "not approved"); a late receipt and a second decision change nothing.
  held = ask(s, 'late', { ack: 1 });
  card = await waitCard(s, 'late');
  decided = call(s, 'POST', '/decide', { aid: card.approval.aid, decision: 'deny' });
  const lateReply = (await held).json;
  assert.deepEqual((await decided).json, { ok: false, delivery: 'unconfirmed' });
  rec = await record(s, 'codex:late');
  assert.equal(rec.status, 'unobserved'); assert.equal(rec.delivery.state, 'unconfirmed'); assert.match(rec.message, /did not confirm receipt/);
  assert.equal((await ack(s, lateReply)).status, 410, 'late receipt');
  assert.equal((await record(s, 'codex:late')).status, 'unobserved', 'a late receipt never marks the task running');
  assert.equal((await call(s, 'POST', '/decide', { aid: card.approval.aid, decision: 'allow' })).status, 410, 'exactly one decision per request');

  // A delayed receipt never overwrites a newer event.
  held = ask(s, 'newer', { ack: 1 });
  card = await waitCard(s, 'newer');
  decided = call(s, 'POST', '/decide', { aid: card.approval.aid, decision: 'allow' });
  const newerReply = (await held).json;
  assert.equal((await call(s, 'POST', '/event', { source: 'codex', session: 'newer', status: 'done' })).status, 200);
  assert.equal((await ack(s, newerReply)).status, 200);
  assert.equal((await decided).json.delivery, 'confirmed');
  assert.equal((await record(s, 'codex:newer')).status, 'done');

  // Legacy hook: sent, receipt unsupported, never shown as running/confirmed.
  held = ask(s, 'legacy');
  card = await waitCard(s, 'legacy');
  assert.deepEqual((await call(s, 'POST', '/decide', { aid: card.approval.aid, decision: 'allow' })).json, { ok: false, delivery: 'unsupported' });
  assert.deepEqual((await held).json, { decision: 'allow' });
  rec = await record(s, 'codex:legacy');
  assert.equal(rec.status, 'unobserved'); assert.equal(rec.delivery.state, 'unsupported');

  // Handle in app: released to the agent app, no receipt involved.
  held = ask(s, 'mac', { ack: 1 });
  card = await waitCard(s, 'mac');
  assert.deepEqual((await call(s, 'POST', '/decide', { aid: card.approval.aid, decision: 'mac' })).json, { ok: true, delivery: 'released' });
  assert.deepEqual((await held).json, { decision: 'none' });
  assert.equal((await record(s, 'codex:mac')).status, 'needs_action');

  // Hook gone before the decision: nothing is sent or confirmed.
  const gone = http.request({ hostname: '127.0.0.1', port: s.port, path: '/ask', method: 'POST', headers: { 'x-key': KEY, 'content-type': 'application/json' } });
  gone.on('error', () => {});
  gone.end(JSON.stringify({ source: 'codex', session: 'gone', tool: 'Bash', command: 'echo synthetic', ack: 1 }));
  card = await waitCard(s, 'gone');
  gone.destroy(); await pause(150);
  assert.equal((await call(s, 'POST', '/decide', { aid: card.approval.aid, decision: 'allow' })).status, 410);

  // Concurrent approvals in one session keep separate secrets and outcomes.
  const asks = [ask(s, 'pair', { ack: 1 }), ask(s, 'pair', { ack: 1 })];
  const [c1, c2] = await waitCards(s, 'pair', 2);
  const d1 = call(s, 'POST', '/decide', { aid: c1.approval.aid, decision: 'allow' });
  await waitCards(s, 'pair', 1); // the first decision is applied before the second is sent
  const d2 = call(s, 'POST', '/decide', { aid: c2.approval.aid, decision: 'deny' });
  const replies = (await Promise.all(asks)).map(r => r.json);
  const r1 = replies.find(r => r.aid === c1.approval.aid), r2 = replies.find(r => r.aid === c2.approval.aid);
  assert.equal(r1.decision, 'allow'); assert.equal(r2.decision, 'deny'); assert.notEqual(r1.receipt, r2.receipt);
  assert.equal((await ack(s, r1, { receipt: r2.receipt })).status, 403, 'one request\'s secret cannot confirm another');
  assert.equal((await ack(s, r2)).status, 200);
  assert.equal((await ack(s, r1)).status, 200);
  assert.deepEqual([(await d1).json.delivery, (await d2).json.delivery], ['confirmed', 'confirmed']);
  assert.equal((await record(s, 'codex:pair')).delivery.aid, c2.approval.aid, 'the earlier receipt did not overwrite the later decision');

  assert.equal((await stop(s)).code, 0);
}

// ---------- 3. Graceful shutdown ----------
async function checkShutdown() {
  // Stop inside the 200/500 ms debounce windows with many queued saves.
  let s = await startServer('debounce');
  await Promise.all(Array.from({ length: 30 }, (_, i) => call(s, 'POST', '/event', { source: 'codex', session: 'burst-' + i, status: 'running', title: 'Burst ' + i })));
  let t0 = Date.now();
  s.child.kill('SIGTERM');
  let r = await s.exited;
  assert.equal(r.code, 0); assert(Date.now() - t0 < 3500, 'bounded shutdown');
  const saved = JSON.parse(fs.readFileSync(path.join(s.dir, 'state.json'), 'utf8'));
  assert.equal(Object.keys(saved).filter(k => k.startsWith('codex:burst-')).length, 30, 'debounced state flushed');
  assert(JSON.parse(fs.readFileSync(path.join(s.dir, 'reports.json'), 'utf8')).sources.codex, 'debounced report flushed');
  assert.equal(fs.statSync(path.join(s.dir, 'state.json')).mode & 0o777, 0o600);
  assert(!files(s.dir).some(f => f.endsWith('.tmp')));

  // Held approvals are released (never approved); a sent decision stays unconfirmed.
  s = await startServer('held', { APPROVAL_WAIT_SEC: '30', APPROVAL_ACK_MS: '5000' });
  const held = ask(s, 'held', { ack: 1, command: 'echo synthetic-secret-4411' });
  await waitCard(s, 'held');
  const sent = ask(s, 'sent', { ack: 1 });
  const sentCard = await waitCard(s, 'sent');
  const waiting = call(s, 'POST', '/decide', { aid: sentCard.approval.aid, decision: 'allow' });
  assert.equal((await sent).json.decision, 'allow'); // reached the hook; its receipt never comes
  s.child.kill('SIGTERM');
  assert.deepEqual((await held).json, { decision: 'none' }, 'released to the agent app, never approved');
  assert.deepEqual((await waiting).json, { ok: false, delivery: 'unconfirmed' });
  r = await s.exited;
  assert.equal(r.code, 0);
  const disk = fs.readFileSync(path.join(s.dir, 'state.json'), 'utf8');
  assert(!disk.includes('synthetic-secret-4411'), 'approval command not persisted');
  const st = JSON.parse(disk);
  assert.equal(st['codex:sent'].delivery.state, 'unconfirmed');
  assert(st['codex:held'].approval.aid, 'marker kept so the next start says "Dashboard restarted"');

  // A failed final save is reported and still ends in bounded time with a failure code.
  s = await startServer('failed', {}, box => { fs.mkdirSync(path.join(box.dir, 'state.json')); });
  await call(s, 'POST', '/event', { source: 'codex', session: 'unsaved', status: 'running' });
  t0 = Date.now();
  s.child.kill('SIGTERM');
  r = await s.exited;
  assert.equal(r.code, 1, 'persistence failure is not reported as success');
  assert(Date.now() - t0 < 3500);
  assert.match(s.stderr(), /could not save state\.json/i);
  assert(fs.statSync(path.join(s.dir, 'state.json')).isDirectory());
  assert(!files(s.dir).some(f => f.endsWith('.tmp')));

  // No abandoned child: a synthetic stand-in for the Codex app-server is stopped.
  let pid = 0;
  s = await startServer('child', {}, box => {
    const fake = path.join(box.root, 'fake-codex.sh'), pidFile = path.join(box.root, 'fake-codex.pid');
    fs.writeFileSync(fake, '#!/bin/sh\necho $$ > "$FAKE_PID_FILE"\nexec sleep 30\n', { mode: 0o755 });
    return { CODEX_USAGE: 'on', CODEX_BIN: fake, FAKE_PID_FILE: pidFile };
  });
  const pidFile = path.join(s.root, 'fake-codex.pid');
  try {
    for (let i = 0; i < 100 && !pid; i++) { try { pid = Number(fs.readFileSync(pidFile, 'utf8')); } catch (_) {} if (!pid) await pause(50); }
    assert(pid > 0, 'fake app-server started');
    process.kill(pid, 0);
    s.child.kill('SIGTERM');
    assert.equal((await s.exited).code, 0);
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) { try { process.kill(pid, 0); await pause(50); } catch (_) { alive = false; } }
    assert(!alive, 'the poll child was stopped');
  } finally { if (pid) try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
}

// ---------- 4. Claude refresh gate ----------
async function checkGate() {
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const a = src.indexOf('function createRefreshGate('), b = src.indexOf('\nconst { createClaudePoller }', a);
  assert(a >= 0 && b > a);
  const ctx = vm.createContext({}); vm.runInContext(src.slice(a, b), ctx);
  let clock = 1e6, runs = 0, release, status = 'ok';
  const gate = ctx.createRefreshGate(() => { runs++; return new Promise(r => { release = () => r(status); }); }, 60000, () => clock);
  const p1 = gate(), p2 = gate();
  assert.equal(p1, p2, 'concurrent callers share the in-flight attempt');
  await pause(0); assert.equal(runs, 1);
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.status, 'ok'); assert.equal(r2.attemptedAt, r1.attemptedAt);
  clock += 1000;
  let r = await gate();
  assert.equal(r.status, 'too_soon'); assert.equal(r.retryAfterMs, 59000); assert.equal(runs, 1, 'no work inside the interval');
  clock += 59000;
  status = null; // the attempt reported nothing: never the previous "ok"
  const p3 = gate(); await pause(0); release();
  r = await p3;
  assert.equal(r.status, 'error'); assert.equal(runs, 2);
  // A failed attempt counts toward the interval.
  let failing = 0;
  const failGate = ctx.createRefreshGate(() => { failing++; throw Error('synthetic'); }, 60000, () => clock);
  assert.equal((await failGate()).status, 'error');
  clock += 30000;
  r = await failGate();
  assert.equal(r.status, 'too_soon'); assert.equal(r.retryAfterMs, 30000); assert.equal(failing, 1);
}

const CLAUDE_STUB = `// Test stub: no credentials, no network.
const fs = require('fs');
module.exports = { createClaudePoller({ onUsage, onStatus }) {
  let busy = false;
  return async function pollClaude() {
    if (process.env.CLAUDE_USAGE === 'off') return;
    fs.appendFileSync(process.env.STUB_CALLS, busy ? 'overlap' : 'x');
    busy = true;
    await new Promise(r => setTimeout(r, 300));
    busy = false;
    onUsage([{ label: '5 hours', usedPercent: 12, resetsAt: null }]);
    onStatus('ok');
  };
} };
`;
async function checkRefreshServer() {
  const stub = mode => box => { fs.writeFileSync(path.join(box.dir, 'claude-usage.js'), CLAUDE_STUB); return { CLAUDE_USAGE: mode, STUB_CALLS: path.join(box.root, 'calls') }; };
  let s = await startServer('refresh', {}, stub('stub'));
  const calls = () => { try { return fs.readFileSync(path.join(s.root, 'calls'), 'utf8'); } catch (_) { return ''; } };
  const results = await Promise.all([1, 2, 3].map(() => call(s, 'POST', '/usage/claude/refresh', {})));
  for (const x of results) { assert.equal(x.status, 200); assert.equal(x.json.ok, true); assert.equal(x.json.status, 'ok'); }
  assert.equal(new Set(results.map(x => x.json.attemptedAt)).size, 1, 'one shared attempt');
  assert.equal(calls(), 'x');
  const updatedAt = (await call(s, 'GET', '/state')).json.usage.claude.updatedAt;
  await pause(2300); // the scheduled 2 s poll falls inside the interval
  assert.equal(calls(), 'x', 'scheduled polls use the same gate');
  const again = await call(s, 'POST', '/usage/claude/refresh', {});
  assert.equal(again.status, 429); assert.equal(again.json.status, 'too_soon');
  assert(again.json.retryAfterSec > 0 && again.json.retryAfterSec <= 60);
  assert.equal(again.headers['retry-after'], String(again.json.retryAfterSec));
  assert.equal(calls(), 'x', 'no extra credential or network work');
  assert.equal((await call(s, 'GET', '/state')).json.usage.claude.updatedAt, updatedAt, 'cached timestamp unchanged');
  assert.equal((await stop(s)).code, 0);

  s = await startServer('refresh-off', {}, stub('off'));
  const off = await call(s, 'POST', '/usage/claude/refresh', {});
  assert.equal(off.status, 409); assert.equal(off.json.status, 'disabled');
  assert.equal(calls(), '', 'CLAUDE_USAGE=off is respected');
  assert.equal((await stop(s)).code, 0);
}

(async () => {
  try {
    checkHook();
    await checkGate();
    await checkReceipts();
    await checkShutdown();
    await checkRefreshServer();
    console.log('Backend completion tests passed: hook flush/receipt/once-only/response limits, request-bound receipts (wrong, late, duplicate, legacy, handle-in-app, disconnected, concurrent, newer event), graceful shutdown (debounce flush, held approvals released, unconfirmed receipts, failed save, no abandoned child), Claude refresh gate (shared attempt, 60 s interval, 429 retry, disabled).');
  } finally {
    for (const s of servers) { if (s.child.exitCode === null && !s.child.signalCode) { s.child.kill('SIGKILL'); await s.exited; } }
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
