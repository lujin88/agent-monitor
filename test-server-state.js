#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const sourceDir = __dirname;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-monitor-test-'));
const port = 18000 + Math.floor(Math.random() * 1000);
const key = 'test-key';
const oldDoneAt = Date.now() - 13 * 3600e3;

for (const file of ['server.js', 'index.html', 'cursor-usage.js','claude-usage.js','grok-usage.js','grok-watch.js', 'codex-watch.js', 'chat-watch.js', 'notify.js']) fs.copyFileSync(path.join(sourceDir, file), path.join(tempDir, file));
fs.writeFileSync(path.join(tempDir, 'token.txt'), key);
fs.writeFileSync(path.join(tempDir, 'usage.json'), '{}');
fs.writeFileSync(path.join(tempDir, 'state.json'), JSON.stringify({
  'codex:old-done': {
    id: 'codex:old-done', source: 'codex', project: 'test', title: '昨天完成的任务',
    message: '', status: 'done', startedAt: oldDoneAt - 1000, updatedAt: oldDoneAt,
  },
}));

const child = spawn(process.execPath, [path.join(tempDir, 'server.js')], {
  env: { ...process.env, HOME: tempDir, MONITOR_NOTIFICATIONS: 'off', PORT: String(port), CODEX_USAGE: 'off', CURSOR_USAGE: 'off', GROK_WATCH:'off',GROK_USAGE:'off',CLAUDE_USAGE: 'off', CHAT_WATCH: 'off', CODEX_WATCH: 'off', RUNNING_STALE_MIN: '0.001', DONE_RETENTION_HOURS: '168' },
  stdio: 'ignore',
});

function call(method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'x-key': key };
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve(JSON.parse(raw || '{}')));
    });
    req.on('error', reject);
    if (data) req.end(data); else req.end();
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try { await call('GET', '/state'); return; } catch (_) { await delay(25); }
  }
  throw new Error('server did not start');
}

(async () => {
  try {
    await waitForServer();

    let state = await call('GET', '/state');
    assert(state.sessions.some((s) => s.id === 'codex:old-done'), 'completed tasks should remain visible for seven days');

    await call('POST', '/event', { source: 'codex', session: 'heartbeat', status: 'running', title: 'heartbeat test' });
    state = await call('GET', '/state');
    const before = state.sessions.find((s) => s.id === 'codex:heartbeat').updatedAt;
    await delay(30);
    await call('POST', '/event', { source: 'codex', session: 'heartbeat', status: 'resume' });
    state = await call('GET', '/state');
    const after = state.sessions.find((s) => s.id === 'codex:heartbeat').updatedAt;
    assert(after > before, 'resume events should refresh the running-task heartbeat');

    await call('POST', '/event', { source: 'codex', session: 'stale', status: 'running', title: 'stale test' });
    await delay(100);
    state = await call('GET', '/state');
    assert.equal(state.sessions.find((s) => s.id === 'codex:stale').status, 'unobserved', 'inactive running tasks must not be reported as complete');

    await call('POST', '/event', {source:'codex',session:'stale',status:'resume'});
    state = await call('GET', '/state');
    assert.equal(state.sessions.find(s=>s.id==='codex:stale').status,'running','new activity restores an unknown task');

    async function cursorHook(status, payload) {
      return new Promise((resolve, reject) => {
        const hook = spawn(process.execPath, [path.join(tempDir, 'notify.js'), 'cursor', status], {
          env: { ...process.env, MONITOR_URL: `http://127.0.0.1:${port}` }, stdio: ['pipe', 'pipe', 'ignore'],
        });
        let output = '';
        hook.stdout.on('data', chunk => { output += chunk; });
        hook.on('error', reject);
        hook.on('exit', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error('Cursor hook failed')));
        hook.stdin.end(JSON.stringify(payload));
      });
    }
    const cursorPayload = { conversation_id: 'cursor-regression', workspace_roots: ['/tmp/cursor-project'], prompt: 'Verify Cursor connection' };
    assert.deepEqual(await cursorHook('running', cursorPayload), { continue: true });
    state = await call('GET', '/state');
    let cursor = state.sessions.find(s => s.id === 'cursor:cursor-regression');
    assert.equal(cursor.status, 'running');
    assert.equal(cursor.title, cursorPayload.prompt);
    assert.equal(cursor.project, 'cursor-project');
    await cursorHook('done', { conversation_id: cursorPayload.conversation_id });
    state = await call('GET', '/state');
    cursor = state.sessions.find(s => s.id === 'cursor:cursor-regression');
    assert.equal(cursor.status, 'done');
    assert.equal(cursor.title, cursorPayload.prompt);

    console.log('server state regression tests passed');
  } finally {
    // The server saves on SIGTERM; wait for it before removing its directory.
    if (child.exitCode === null && !child.signalCode) { const exited = new Promise(r => child.once('exit', r)); child.kill(); await exited; }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error.message); process.exit(1); });
