// Security hardening regressions: loopback-only server, key only in x-key for writes,
// hook URLs limited to this Mac, and approval cards that show Edit/Write content.
// No real task data is used; the server runs from a temp copy with a fixed key.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

// 1. MONITOR_URL: the token is sent there, so only loopback http URLs are used.
for (const file of ['approve.js', 'notify.js', 'statusline.js', 'claude-watch.js']) {
  const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const start = src.indexOf('function localMonitorUrl(');
  assert(start >= 0, file + ' limits MONITOR_URL');
  const fn = vm.runInNewContext('(' + src.slice(start, src.indexOf('\n}\n', start) + 2) + ')', { URL });
  for (const ok of ['http://127.0.0.1:7777', 'http://localhost:8000/', 'http://[::1]:7777']) assert.equal(fn(ok).href, new URL(ok).href, file + ' keeps ' + ok);
  for (const bad of ['http://evil.example:7777', 'http://192.168.1.5:7777', 'https://127.0.0.1:7777', 'http://127.0.0.1.evil.example/',
    'http://localhost@evil.example/', 'not a url', 'file:///etc/passwd']) {
    assert.equal(fn(bad).href, 'http://127.0.0.1:7777/', file + ' falls back for ' + bad);
  }
}

// 2. Approval cards for Edit/Write show the content (approve.js run with a fake http).
function hook(payload, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hardening-hook-'));
  const requests = [];
  const stdin = new EventEmitter(); stdin.setEncoding = () => {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'approve.js'), 'utf8'), {
    require(name) {
      if (name === 'http') return { request(options) { const r = { options, on() {}, end(b) { r.body = JSON.parse(b); } }; requests.push(r); return r; } };
      if (name === './auto-approve') return require('./auto-approve');
      return require(name);
    },
    __dirname: dir, URL, Buffer, setTimeout: () => 0,
    process: { argv: ['node', 'approve.js', 'claude'], env, stdin, stdout: { on() {}, write(s, cb) { if (cb) cb(); } }, exit() {} },
  });
  stdin.emit('data', JSON.stringify(payload)); stdin.emit('end');
  fs.rmSync(dir, { recursive: true, force: true });
  return requests;
}
const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hardening-proj-')));
try {
  fs.writeFileSync(path.join(proj, 'existing.txt'), 'old');
  // Outside the project, so these are never auto-approved and reach /ask.
  const outside = path.join(path.dirname(proj), 'outside-file.js');
  let [r] = hook({ session_id: 's', cwd: proj, tool_name: 'Edit', tool_input: { file_path: outside, old_string: 'a = 1', new_string: 'a = 2', description: 'tidy up' } });
  assert.equal(r.options.path, '/ask');
  assert.equal(r.body.command, [outside, '--- Before ---', 'a = 1', '--- After ---', 'a = 2'].join('\n'));
  assert.equal(r.body.description, 'Agent says (unverified): tidy up');
  const long = Array.from({ length: 25 }, (_, i) => 'line ' + i).join('\n');
  [r] = hook({ session_id: 's', cwd: proj, tool_name: 'Write', tool_input: { file_path: outside, content: long } });
  const lines = r.body.command.split('\n');
  assert.equal(lines[1], '--- Content to write ---');
  assert.equal(lines[2], 'line 0'); assert.equal(lines[21], 'line 19');
  assert.equal(lines[22], '… 5 more lines not shown');
  [r] = hook({ session_id: 's', cwd: proj, tool_name: 'Write', tool_input: { file_path: path.join(proj, '.claude', 'x'), content: 'a\nb' } });
  assert(!/more line/.test(r.body.command), 'no truncation line when nothing was cut');
  [r] = hook({ session_id: 's', cwd: proj, tool_name: 'Write', tool_input: { file_path: path.join(proj, '..', path.basename(proj), 'settings.json'), content: 'x\ny' } });
  assert(r.body.command.includes('--- Content to write ---'));
  fs.writeFileSync(path.join(proj, 'settings.json'), '{}');
  [r] = hook({ session_id: 's', cwd: proj, tool_name: 'Write', tool_input: { file_path: path.join(proj, 'settings.json'), content: '{"a":1}' } });
  assert(r.body.command.includes('--- Content to write (replaces existing file) ---'), 'overwrite is called out');
  [r] = hook({ session_id: 's', cwd: proj, tool_name: 'Write', tool_input: { file_path: outside, content: long.split('\n').slice(0, 21).join('\n') } });
  assert(r.body.command.endsWith('… 1 more line not shown'), 'singular');
  [r] = hook({ session_id: 's', cwd: proj, tool_name: 'Write', tool_input: { file_path: outside, content: 'x'.repeat(4000) } });
  assert(r.body.command.endsWith('… line cut short, 2500 more characters not shown'), 'an over-long single line is cut by characters');
  [r] = hook({ session_id: 's', cwd: proj, tool_name: 'Write', tool_input: { file_path: outside, content: 'x'.repeat(1501) + '\nnext\nlast' } });
  assert(r.body.command.endsWith('… line cut short, 1 more character not shown\n… 2 more lines not shown'), 'cut line and hidden lines on separate lines');
  [r] = hook({ session_id: 's', cwd: proj, tool_name: 'MultiEdit', tool_input: { file_path: outside, edits: Array.from({ length: 7 }, (_, i) => ({ old_string: 'o' + i, new_string: 'n' + i })) } });
  assert(r.body.command.includes('n4') && !r.body.command.includes('n5') && r.body.command.endsWith('… 2 more edits not shown'));
  assert(r.body.command.includes('--- Edit 1 of 7: Before ---') && r.body.command.includes('--- Edit 5 of 7: After ---'));
  assert.equal(r.body.tool, 'MultiEdit (7 edits)', 'the total is on the Tool line');
  [r] = hook({ session_id: 's', cwd: proj, tool_name: 'MultiEdit', tool_input: { file_path: outside, edits: Array.from({ length: 6 }, (_, i) => ({ old_string: 'o' + i, new_string: 'n' + i })) } });
  assert(r.body.command.endsWith('… 1 more edit not shown'));
  // Hook requests go to loopback even when MONITOR_URL points elsewhere.
  [r] = hook({ session_id: 's', cwd: proj, tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }, { MONITOR_URL: 'http://evil.example:7777' });
  assert.equal(r.options.hostname, '127.0.0.1');
} finally { fs.rmSync(proj, { recursive: true, force: true }); }

// 3. Dashboard: a ?key= in the address bar is stored, then removed from the URL.
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
assert(/searchParams\.delete\('key'\);history\.replaceState\(/.test(html), 'index.html removes ?key= from the address bar');

// 4. Server: loopback only, no key in the startup output, writes need the x-key header.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hardening-server-')), port = 19900 + Math.floor(Math.random() * 90), key = 'hardening-key-31337';
for (const f of ['server.js', 'approve.js', 'codex-watch.js', 'chat-watch.js', 'cursor-usage.js', 'claude-usage.js', 'grok-usage.js', 'grok-watch.js']) fs.copyFileSync(path.join(__dirname, f), path.join(dir, f));
fs.writeFileSync(path.join(dir, 'token.txt'), key);
let output = '';
const child = spawn(process.execPath, [path.join(dir, 'server.js')], { env: { ...process.env, HOME: dir, PORT: String(port), CHAT_WATCH: 'off', CODEX_WATCH: 'off', CODEX_USAGE: 'off', CURSOR_USAGE: 'off', GROK_WATCH: 'off', GROK_USAGE: 'off', CLAUDE_USAGE: 'off', MONITOR_NOTIFICATIONS: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (d) => { output += d; }); child.stderr.on('data', (d) => { output += d; });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (host, route, headers = {}) => fetch(`http://${host}:${port}${route}`, { headers, signal: AbortSignal.timeout(2000) });
(async () => {
  try {
    for (let i = 0; i < 80 && !output.includes('running'); i++) await pause(25);
    assert.equal((await get('127.0.0.1', '/state', { 'x-key': key })).status, 200);
    assert.equal((await get('[::1]', '/state', { 'x-key': key })).status, 200, 'IPv6 loopback answers (macOS localhost)');
    assert.equal((await get('localhost', '/state', { 'x-key': key })).status, 200);
    assert.equal((await get('127.0.0.1', '/state?key=' + key)).status, 200, 'GET still accepts ?key= (first visit)');
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    if (lan) await assert.rejects(get(lan.address, '/state', { 'x-key': key }), 'not reachable from the network');
    const post = (route, headers) => fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ aid: '0000000000000000', decision: 'deny' }) });
    assert.equal((await post('/decide?key=' + key, {})).status, 401, 'POST ignores ?key=');
    assert.notEqual((await post('/decide', { 'x-key': key })).status, 401, 'POST with x-key is authorised');
    assert(!output.includes(key), 'startup output never contains the key');
    assert(!/On your iPad/.test(output));
    console.log('Security hardening passed: loopback only (127.0.0.1, ::1, localhost), key not printed, POST needs x-key, ?key= removed from the address bar, MONITOR_URL limited to this Mac, Edit/Write content on the approval card.');
  } catch (err) { console.error(err); process.exitCode = 1; }
  finally { child.kill('SIGTERM'); await pause(300); fs.rmSync(dir, { recursive: true, force: true }); }
})();
