// Isolated server test: random port, temporary HOME and data, all pollers and observers off.
// Synthetic data only. No real approval is made; no command is executed.
const assert = require('assert/strict'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn } = require('child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-state-'));
const dir = path.join(root, 'agent-monitor'), home = path.join(root, 'home');
fs.mkdirSync(dir); fs.mkdirSync(path.join(home, '.claude'), { recursive: true }); fs.mkdirSync(path.join(home, '.cursor'));
for (const f of ['server.js', 'codex-watch.js', 'chat-watch.js', 'cursor-usage.js', 'claude-usage.js','grok-usage.js','grok-watch.js']) fs.copyFileSync(path.join(__dirname, f), path.join(dir, f));
fs.writeFileSync(path.join(dir, 'token.txt'), 'isolated');
// Claude Code configured (with an unrelated secret that must never be echoed); Cursor file without our hooks; no Codex file.
fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: { SECRET_TOKEN: 'do-not-leak' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: `"node" "${dir}/notify.js" claude done` }] }] } }));
fs.writeFileSync(path.join(home, '.cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: { stop: [{ command: 'echo other-tool' }] } }));
fs.writeFileSync(path.join(dir, 'notification-reader-status.json'), JSON.stringify({ status: 'full_disk_access_required', checkedAt: Date.now(), mode: 'watch', openErrno: 1, launchedBy: 'launchd', title: 'PRIVATE TITLE', body: 'PRIVATE BODY', databasePath: '/private/path' }));
const port = 19900 + Math.floor(Math.random() * 300), base = `http://127.0.0.1:${port}`;
const env = { ...process.env, HOME: home, PORT: String(port), APPROVAL_WAIT_SEC: '30', CODEX_WATCH: 'off', CODEX_USAGE: 'off', CURSOR_USAGE: 'off', GROK_WATCH:'off',GROK_USAGE:'off',CLAUDE_USAGE: 'off', MONITOR_NOTIFICATIONS: 'off' };
delete env.CHAT_WATCH;
const pause = ms => new Promise(r => setTimeout(r, ms));
const call = (route, body) => fetch(base + route, { method: body ? 'POST' : 'GET', headers: { 'x-key': 'isolated', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const state = async () => (await call('/state')).json();
let child;
async function start() { child = spawn(process.execPath, [path.join(dir, 'server.js')], { env, stdio: 'ignore' }); for (let i = 0; i < 80; i++) { try { return await state(); } catch { await pause(25); } } throw Error('server did not start'); }
async function stop() { const exited = new Promise(r => child.once('exit', r)); child.kill(); await exited; }
(async () => {
  try {
    let s = await start();
    assert.equal(s.chatTracking.status, 'disabled', 'The window observer is off unless CHAT_WATCH=on');
    assert.deepEqual([s.hookConfig.claude, s.hookConfig.codex, s.hookConfig.cursor], ['configured', 'absent', 'missing']);
    const raw = JSON.stringify(s);
    for (const secret of ['do-not-leak', 'PRIVATE TITLE', 'PRIVATE BODY', '/private/path']) assert(!raw.includes(secret), 'state must not expose ' + secret);
    assert.deepEqual(s.notificationReader, { present: true, status: 'full_disk_access_required', checkedAt: s.notificationReader.checkedAt, mode: 'watch', openErrno: 1, launchedBy: 'launchd' });
    assert.deepEqual(s.reports.sources, {}, 'No report is invented before one arrives');

    await call('/event', { source: 'claude', session: 'code-1', status: 'running', title: 'Synthetic Code task' });
    await call('/event', { source: 'claude', session: 'notification-x-1', status: 'done', taskKind: 'notification', stateSource: 'macos-notification', title: 'Claude reported completion' });
    s = await state();
    assert(s.reports.sources.claude?.at, 'Hook report recorded');
    assert(s.reports.sources['claude:notification']?.at, 'Notification estimates are recorded separately from hooks');
    await call('/dismiss', { id: 'claude:code-1' });
    s = await state();
    assert(!s.sessions.some(x => x.id === 'claude:code-1'));
    assert(s.reports.sources.claude?.at, 'Dismissing a task does not erase the evidence that the hook reported');

    // A decision can only be confirmed if the waiting hook is still connected.
    const ask = http.request({ hostname: '127.0.0.1', port, path: '/ask', method: 'POST', headers: { 'x-key': 'isolated', 'content-type': 'application/json' } });
    ask.on('error', () => {});
    ask.end(JSON.stringify({ source: 'codex', session: 'gone', tool: 'Test', command: 'synthetic, never executed' }));
    let aid;
    for (let i = 0; i < 60 && !aid; i++) { aid = (await state()).sessions.find(x => x.approval)?.approval.aid; if (!aid) await pause(20); }
    assert(aid, 'synthetic request visible');
    ask.destroy();
    await pause(100);
    const late = await call('/decide', { aid, decision: 'deny' });
    assert.equal(late.status, 410, 'A request whose hook went away is reported as expired, never as sent');

    await pause(700); // reports.json is written with a short debounce
    await stop();
    s = await start();
    assert(s.reports.sources.claude?.at, 'Report times survive a restart of the isolated test server');
    console.log('Coverage state tests passed: observer off by default, hook config checked not assumed, no secrets or notification text exposed, report evidence kept after dismiss and restart, undeliverable approvals return 410.');
  } finally { if (child && child.exitCode === null && !child.signalCode) await stop(); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
