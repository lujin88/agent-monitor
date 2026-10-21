// Isolated backend hardening regression test: random port, temporary HOME and data, every
// poller, watcher and notification off. Synthetic data only; no command is ever executed.
const assert = require('assert/strict'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), vm = require('vm');
const EventEmitter = require('events');
const { spawn } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-hardening-'));
const dir = path.join(root, 'agent-monitor'), home = path.join(root, 'home');
fs.mkdirSync(dir); fs.mkdirSync(home);
for (const f of ['server.js', 'codex-watch.js', 'chat-watch.js', 'cursor-usage.js', 'claude-usage.js', 'grok-usage.js', 'grok-watch.js']) fs.copyFileSync(path.join(__dirname, f), path.join(dir, f));
const key = 'isolated-hardening';
fs.writeFileSync(path.join(dir, 'token.txt'), key);
const now = Date.now();
// Valid JSON with damaged entries, a wrongly shaped usage file and a torn reports file.
fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
  'codex:null': null,
  'codex:bad-status': { id: 'codex:bad-status', source: 'codex', status: 'exploded', updatedAt: now },
  'codex:kept': { id: 'wrong', source: 'codex', status: 'done', title: 'Kept task', startedAt: now - 1000, updatedAt: now },
}));
fs.writeFileSync(path.join(dir, 'usage.json'), 'null');
fs.writeFileSync(path.join(dir, 'reports.json'), '{"since":1,"sources":');

const port = 20300 + Math.floor(Math.random() * 600);
const env = { ...process.env, HOME: home, PORT: String(port), APPROVAL_WAIT_SEC: '30', CHAT_WATCH: 'off', CODEX_WATCH: 'off', CODEX_USAGE: 'off', CURSOR_USAGE: 'off', GROK_WATCH: 'off', GROK_USAGE: 'off', CLAUDE_USAGE: 'off', MONITOR_NOTIFICATIONS: 'off' };
const pause = ms => new Promise(r => setTimeout(r, ms));

function raw(method, route, chunks) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: { 'x-key': key, 'content-type': 'application/json' } }, res => {
      let b = ''; res.setEncoding('utf8'); res.on('data', c => { b += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject);
    (async () => { for (const c of [].concat(chunks ?? [])) { req.write(c); await pause(20); } req.end(); })();
  });
}
const post = (route, body) => raw('POST', route, JSON.stringify(body));
const state = async () => (await raw('GET', '/state')).json;
const files = () => fs.readdirSync(dir);

let child;
async function start() {
  child = spawn(process.execPath, [path.join(dir, 'server.js')], { env, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) { try { const r = await raw('GET', '/state'); if (r.status === 200) return r.json; } catch (_) {} await pause(25); }
  throw Error('server did not start');
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const exited = new Promise(r => child.once('exit', r)); child.kill(); await exited;
}
async function waitApproval(session) {
  for (let i = 0; i < 60; i++) { const s = (await state()).sessions.find(x => x.parentSessionId === 'codex:' + session); if (s) return s; await pause(20); }
  throw Error('approval not visible');
}

// Deterministic checks of the approval decision path, extracted from server.js.
function decisionHarness() {
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const slice = (a, b) => { const i = src.indexOf(a); assert(i >= 0, a); return src.slice(i, src.indexOf(b, i)); };
  const timers = [];
  const ctx = { pending: Object.create(null), receipts: Object.create(null), sessions: Object.create(null), save() {}, clearTimeout() {}, setTimeout(fn) { timers.push(fn); return timers.length; },
    ACK_WAIT_MS: 4000, isRecord: (x) => !!x && typeof x === 'object' && !Array.isArray(x), Buffer, crypto: require('crypto'), timers };
  vm.createContext(ctx);
  vm.runInContext(slice('function resolvePending(', '\nfunction publicSessions'), ctx);
  vm.runInContext(slice('const RECEIPT_MESSAGES', '\nfunction applyEvent'), ctx);
  return ctx;
}
function fakeRes(gone = false) {
  return { writableEnded: false, destroyed: false, socket: { destroyed: gone }, sent: null, reply: null, writeHead() {}, end(b) { this.reply = JSON.parse(b); this.sent = this.reply.decision; this.writableEnded = true; } };
}
function checkDecisions() {
  const ctx = decisionHarness();
  const hold = (aid, res, expiresAt, secret = null) => { ctx.sessions['codex:t'] = { id: 'codex:t', status: 'needs_action' }; ctx.pending[aid] = { res, id: 'codex:t', secret, approval: { aid, expiresAt }, description: '' }; };
  let res = fakeRes(); hold('late', res, Date.now() - 1);
  assert.equal(ctx.decide('late', 'allow'), false, 'An expired request is never confirmed as approved');
  assert.equal(res.sent, 'none', 'An expired request is released to the agent app, not approved');
  assert.equal(ctx.sessions['codex:t'].status, 'needs_action');
  res = fakeRes(true); hold('gone', res, Date.now() + 60000);
  assert.equal(ctx.decide('gone', 'allow'), false, 'No success without a connected requester');
  assert.equal(res.sent, null);
  assert.equal(ctx.sessions['codex:t'].status, 'needs_action', 'An undelivered approval must not mark the task running');
  // Legacy hook: written to the socket, but that alone is not confirmation.
  res = fakeRes(); hold('live', res, Date.now() + 60000);
  assert.equal(ctx.decide('live', 'allow'), 'unsupported'); assert.equal(res.sent, 'allow'); assert.equal(res.reply.receipt, undefined);
  assert.equal(ctx.sessions['codex:t'].status, 'unobserved', 'A socket write alone must not mark the task running');
  assert.equal(ctx.sessions['codex:t'].delivery.state, 'unsupported');
  // Receipt-capable hook: running only after the matching receipt.
  const secret = 'ab'.repeat(16);
  res = fakeRes(); hold('rcpt', res, Date.now() + 60000, secret);
  assert.equal(ctx.decide('rcpt', 'allow'), 'awaiting'); assert.deepEqual({ ...res.reply }, { decision: 'allow', aid: 'rcpt', receipt: secret });
  assert.equal(ctx.sessions['codex:t'].status, 'unobserved');
  assert.equal(ctx.acknowledge('rcpt', 'cd'.repeat(16), 'allow'), 403, 'wrong secret');
  assert.equal(ctx.acknowledge('rcpt', secret, 'deny'), 403, 'a different decision is never confirmed');
  assert.equal(ctx.sessions['codex:t'].status, 'unobserved');
  assert.equal(ctx.acknowledge('rcpt', secret, 'allow'), 200);
  assert.equal(ctx.sessions['codex:t'].status, 'running'); assert.equal(ctx.sessions['codex:t'].delivery.state, 'confirmed');
  assert.equal(ctx.acknowledge('rcpt', secret, 'allow'), 410, 'duplicate receipt');
  // "Handle in app" carries no receipt secret.
  res = fakeRes(); hold('mac', res, Date.now() + 60000, secret);
  assert.equal(ctx.decide('mac', 'none'), 'released'); assert.deepEqual({ ...res.reply }, { decision: 'none' });
  assert.equal(ctx.sessions['codex:t'].status, 'needs_action');
  for (const aid of ['constructor', '__proto__', 'toString', 5, null]) { assert.equal(ctx.decide(aid, 'allow'), false); assert.equal(ctx.acknowledge(aid, secret, 'allow'), 410); }
}

// approve.js must never turn an unreadable hook payload into an approval card.
function runApprove(stdinText) {
  const requests = []; let printed = '', exited = false;
  const stdin = new EventEmitter(); stdin.setEncoding = () => {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'approve.js'), 'utf8'), {
    require(name) {
      if (name === 'http') return { request(options) { const r = { options, body: null, on() {}, end(b) { r.body = JSON.parse(b); } }; requests.push(r); return r; } };
      if (name === 'fs') return { readFileSync: () => 'test-key' };
      return require(name);
    },
    __dirname: '/tmp/test-monitor', URL, Buffer, setTimeout: () => 0,
    process: { argv: ['node', 'approve.js', 'claude'], env: {}, stdin, stdout: { write(s) { printed += s; } }, exit() { exited = true; } },
  });
  stdin.emit('data', stdinText); stdin.emit('end');
  return { requests, printed, exited };
}
function checkApproveHook() {
  for (const bad of ['', 'null', '[]', '{"session_id":"s","tool_name":"Bash","tool_input":{"command":"echo par']) {
    const r = runApprove(bad);
    assert.equal(r.requests.length, 0, 'no approval request for payload ' + JSON.stringify(bad));
    assert.equal(r.printed, ''); assert(r.exited);
  }
  const ok = runApprove(JSON.stringify({ session_id: 's1', cwd: '/tmp/demo', tool_name: 'Bash', tool_input: { command: 'echo synthetic' } }));
  assert.equal(ok.requests.length, 1); assert.equal(ok.requests[0].options.path, '/ask');
  assert.equal(ok.requests[0].body.command, 'echo synthetic'); assert.equal(ok.requests[0].body.tool, 'Bash');
}

(async () => {
  try {
    checkDecisions();
    checkApproveHook();

    // 1. Damaged state files do not stop startup and are kept, not overwritten.
    let s = await start();
    assert.deepEqual(s.sessions.map(x => x.id), ['codex:kept'], 'invalid entries dropped, valid ones kept with their key as id');
    assert.deepEqual(s.usage, {}); assert.deepEqual(s.reports.sources, {});
    const tornReports = files().find(f => f.startsWith('reports.json.corrupt-'));
    assert(tornReports, 'torn reports.json set aside');
    assert.equal(fs.readFileSync(path.join(dir, tornReports), 'utf8'), '{"since":1,"sources":');
    assert(files().some(f => f.startsWith('usage.json.corrupt-')), 'wrongly shaped usage.json set aside');

    // 2. Request validation: null, arrays, strings and malformed JSON are 400, never a crash.
    for (const [route, body] of [['/event', 'null'], ['/event', '[]'], ['/event', '"running"'], ['/event', '{"source":'], ['/ask', 'null'], ['/ask', '[]'], ['/usage', '[1]'], ['/decide', 'null'], ['/decide', '[]'], ['/dismiss', 'null']]) {
      assert.equal((await raw('POST', route, body)).status, 400, route + ' ' + body);
    }
    assert(!(await state()).sessions.some(x => x.approval), 'a rejected /ask must not create an approval');
    assert.equal((await post('/decide', { aid: 5, decision: 'allow' })).status, 400);
    for (const aid of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) assert.equal((await post('/decide', { aid, decision: 'allow' })).status, 410, aid);
    assert.equal((await post('/dismiss', { id: {} })).status, 400);
    assert.equal((await post('/dismiss', { allDone: 'false' })).status, 400);
    assert((await state()).sessions.some(x => x.id === 'codex:kept'), 'the string "false" must not clear completed tasks');
    assert.equal((await post('/ask', { source: 'codex', session: 'typed', tool: 'Bash', command: { rm: '-rf' } })).status, 400, 'non-string command is rejected, not shown as [object Object]');

    let r = await post('/usage', { source: 'claude', windows: [null, 7, { label: '5 hours', usedPercent: null }, { label: 'Weekly', usedPercent: 42, resetsAt: 1790863200 }] });
    assert.equal(r.status, 200);
    assert.deepEqual((await state()).usage.claude.windows.map(w => [w.label, w.usedPercent]), [['Weekly', 42]], 'null entries ignored; missing percent is not 0 %');
    for (const source of ['bad source', 'x'.repeat(31), 7]) assert.equal((await post('/usage', { source, windows: [{ label: 'x', usedPercent: 1 }] })).status, 400, String(source));

    // Multi-byte characters split across body chunks stay intact.
    const title = '修复看板 — Grok ✓';
    const body = Buffer.from(JSON.stringify({ source: 'codex', session: 'utf8', status: 'running', title }));
    const cut = body.indexOf(Buffer.from('看')) + 1;
    assert.equal((await raw('POST', '/event', [body.subarray(0, cut), body.subarray(cut)])).status, 200);
    assert.equal((await state()).sessions.find(x => x.id === 'codex:utf8').title, title);

    r = await raw('POST', '/event', '{"title":"' + 'x'.repeat(1.2e6) + '"}').catch(() => ({ status: 'reset' }));
    assert([413, 'reset'].includes(r.status), 'oversized body refused');
    assert.equal((await raw('GET', '/state')).status, 200, 'server still running after bad input');

    // 3. Approvals: a requester that vanished mid-request never leaves a live approval.
    const ask = http.request({ hostname: '127.0.0.1', port, path: '/ask', method: 'POST', headers: { 'x-key': key, 'content-type': 'application/json' } });
    ask.on('error', () => {});
    ask.write('{"source":"codex","session":"vanished","tool":"Test",');
    await pause(50);
    ask.end('"command":"synthetic, never executed"}'); ask.destroy();
    await pause(300);
    assert(!(await state()).sessions.some(x => x.approval), 'a disconnected request is not approvable');

    // The command is shown to the Dashboard but never written to disk.
    const held = post('/ask', { source: 'codex', session: 'secret', tool: 'Bash', command: 'echo synthetic-secret-7731' });
    const card = await waitApproval('secret');
    assert.equal(card.approval.command, 'echo synthetic-secret-7731');
    await pause(400);
    const saved = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
    assert(!saved.includes('synthetic-secret-7731'), 'approval command not persisted');
    assert.equal(JSON.parse(saved)['codex:secret'].approval.aid, card.approval.aid);
    assert.equal(fs.statSync(path.join(dir, 'state.json')).mode & 0o777, 0o600, 'state file is private');
    assert.equal((await post('/decide', { aid: card.approval.aid, decision: 'deny' })).status, 200);
    assert.equal((await held).json.decision, 'deny');

    // 4. Overlapping writes stay valid JSON and leave no temp files behind.
    await Promise.all(Array.from({ length: 40 }, (_, i) => i % 2
      ? post('/event', { source: 'codex', session: 'burst-' + i, status: 'running', title: 'Burst ' + i })
      : post('/usage', { source: 'codex', windows: [{ label: 'Weekly', usedPercent: i }] })));
    await pause(800);
    for (const f of ['state.json', 'usage.json', 'reports.json']) JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'))).filter(k => k.startsWith('codex:burst-')).length, 20);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'usage.json'), 'utf8')).codex, (await state()).usage.codex, 'the last write on disk matches memory');
    assert(!files().some(f => f.endsWith('.tmp')), 'no temp files left');

    // 5. A request pending at restart comes back as "confirm in the app", never approvable.
    const orphan = post('/ask', { source: 'codex', session: 'restart', tool: 'Bash', command: 'echo synthetic' }).catch(() => null);
    const orphanCard = await waitApproval('restart');
    await pause(400);
    await stop(); await orphan;
    s = await start();
    const back = s.sessions.find(x => x.id === 'codex:restart');
    assert.equal(back.status, 'needs_action'); assert.equal(back.approval, undefined);
    assert.match(back.message, /^Dashboard restarted/);
    assert.equal((await post('/decide', { aid: orphanCard.approval.aid, decision: 'allow' })).status, 410);

    // 6. A torn state.json does not prevent startup and is preserved.
    await stop();
    fs.writeFileSync(path.join(dir, 'state.json'), '{"codex:kept":{"status":"do');
    s = await start();
    assert.deepEqual(s.sessions, []);
    assert(files().some(f => f.startsWith('state.json.corrupt-')), 'torn state.json set aside');

    console.log('Backend hardening tests passed: damaged state startup, request validation, prototype keys, UTF-8 bodies, body limit, disconnected/expired/undelivered approvals, private and atomic state writes, restart safety, approve.js payload checks.');
  } finally {
    await stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
