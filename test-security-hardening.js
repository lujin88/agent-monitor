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
// Runs the dashboard's own key-reading statement with a fake location/history/storage.
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const keyStart = html.indexOf("try{const u=new URL(location.href)");
assert(keyStart >= 0, 'index.html reads the key from the address bar');
const keyCode = html.slice(keyStart, html.indexOf('catch(_){}', keyStart) + 'catch(_){}'.length);
function dashboardKey(href, stored = null) {
  const store = new Map(stored ? [['amkey', stored]] : []), replaced = [];
  const ctx = { URL, location: { href }, localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    history: { replaceState: (_s, _t, url) => replaced.push(url) } };
  vm.runInNewContext('let key="";' + keyCode + ';globalThis.out=key;', ctx);
  return { key: ctx.out, stored: store.get('amkey'), replaced };
}
let dk = dashboardKey('http://localhost:7777/?key=abc123&tab=need#x');
assert.equal(dk.key, 'abc123'); assert.equal(dk.stored, 'abc123');
assert.deepEqual(dk.replaced, ['/?tab=need#x'], 'key removed, other parts of the URL kept');
dk = dashboardKey('http://localhost:7777/', 'saved');
assert.equal(dk.key, 'saved'); assert.deepEqual(dk.replaced, [], 'nothing to remove without ?key=');

// 4. Server: this Mac only by default (MONITOR_HOST=0.0.0.0 opens the LAN), no key in output
// or LAN responses, writes need x-key, Host allowlist, no CORS, hooks stay loopback-only.
const http = require('http');
const key = 'hardening-key-31337';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function startServer(extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hardening-server-')), port = 19000 + Math.floor(Math.random() * 900);
  for (const f of ['server.js', 'approve.js', 'codex-watch.js', 'chat-watch.js', 'cursor-usage.js', 'claude-usage.js', 'grok-usage.js', 'grok-watch.js', 'index.html', 'vendor-qrcode.js']) fs.copyFileSync(path.join(__dirname, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, 'token.txt'), key);
  const s = { dir, port, output: '' };
  s.child = spawn(process.execPath, [path.join(dir, 'server.js')], { env: { ...process.env, HOME: dir, PORT: String(port), CHAT_WATCH: 'off', CODEX_WATCH: 'off', CODEX_USAGE: 'off', CURSOR_USAGE: 'off', GROK_WATCH: 'off', GROK_USAGE: 'off', CLAUDE_USAGE: 'off', MONITOR_NOTIFICATIONS: 'off', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  s.child.stdout.on('data', (d) => { s.output += d; }); s.child.stderr.on('data', (d) => { s.output += d; });
  s.stop = async () => { s.child.kill('SIGTERM'); await pause(300); fs.rmSync(dir, { recursive: true, force: true }); };
  return s;
}
// Raw request so the Host header can be set (fetch does not allow it).
function req(s, address, route, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: address.replace(/^\[|\]$/g, ''), port: s.port, path: route, method, headers: { host: `${address}:${s.port}`, ...headers }, timeout: 2000 }, (res) => {
      let data = ''; res.on('data', (c) => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('timeout', () => r.destroy(new Error('timeout'))); r.on('error', reject);
    r.end(body);
  });
}
const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
(async () => {
  const main = startServer({ MONITOR_HOST: '0.0.0.0' }), localOnly = startServer({});
  try {
    for (let i = 0; i < 120 && !(main.output.includes('running') && localOnly.output.includes('running')); i++) await pause(25);
    const k = { 'x-key': key };
    for (const s of [main, localOnly]) {
      assert.equal((await req(s, '127.0.0.1', '/state', { headers: k })).status, 200);
      assert.equal((await req(s, '[::1]', '/state', { headers: k })).status, 200, 'IPv6 loopback answers (macOS localhost)');
      assert.equal((await req(s, 'localhost', '/state', { headers: k })).status, 200);
      assert(!s.output.includes(key), 'startup output never contains the key');
      assert(!/On your iPad/.test(s.output));
    }
    assert.equal(JSON.parse((await req(main, '127.0.0.1', '/state', { headers: k })).body).local, true, 'this Mac is local');
    // Writes take the key only from x-key.
    const decideBody = JSON.stringify({ aid: '0000000000000000', decision: 'deny' }), json = { 'content-type': 'application/json' };
    assert.equal((await req(main, '127.0.0.1', '/decide?key=' + key, { method: 'POST', headers: json, body: decideBody })).status, 401, 'POST ignores ?key=');
    assert.notEqual((await req(main, '127.0.0.1', '/decide', { method: 'POST', headers: { ...json, ...k }, body: decideBody })).status, 401, 'POST with x-key is authorised');
    // DNS rebinding: unknown host names are refused, IPs / localhost / *.local are served.
    for (const host of ['evil.example', 'attacker.com', '127.0.0.1.nip.io']) {
      const r = await new Promise((resolve, reject) => { const q = http.request({ host: '127.0.0.1', port: main.port, path: '/', headers: { host: host + ':' + main.port }, timeout: 2000 }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); q.on('error', reject); q.end(); });
      assert.equal(r, 421, 'Host ' + host + ' is refused');
    }
    assert.equal((await new Promise((resolve, reject) => { const q = http.request({ host: '127.0.0.1', port: main.port, path: '/state', headers: { host: 'lus-mac.local:' + main.port, ...k }, timeout: 2000 }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); q.on('error', reject); q.end(); })), 200, '*.local is accepted');
    // A local proxy (tailscale serve and the like) is not "this Mac".
    for (const h of [{ 'x-forwarded-for': '100.64.0.2' }, { forwarded: 'for=100.64.0.2' }, { 'tailscale-user-login': 'x@y' }]) {
      assert.equal((await req(main, '127.0.0.1', '/lan-addresses', { headers: { ...k, ...h } })).status, 403, 'forwarded request is not local: ' + Object.keys(h)[0]);
      assert.equal((await req(main, '127.0.0.1', '/event', { method: 'POST', headers: { ...json, ...k, ...h }, body: '{"source":"codex","session":"x","status":"running"}' })).status, 403, 'hooks refuse forwarded requests');
      assert.equal(JSON.parse((await req(main, '127.0.0.1', '/state', { headers: { ...k, ...h } })).body).local, false);
    }
    const addrs = JSON.parse((await req(main, '127.0.0.1', '/lan-addresses', { headers: k })).body);
    assert.equal(addrs.localOnly, false); assert(!JSON.stringify(addrs).includes(key), 'the address list never carries the key');
    assert.equal(JSON.parse((await req(localOnly, '127.0.0.1', '/lan-addresses', { headers: k })).body).localOnly, true);
    // No CORS: another web page can neither read responses nor send x-key across origins.
    for (const r of [await req(main, '127.0.0.1', '/state', { headers: { ...k, origin: 'http://evil.example' } }),
      await req(main, '127.0.0.1', '/decide', { method: 'OPTIONS', headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-key' } })]) {
      assert(!Object.keys(r.headers).some((h) => h.startsWith('access-control-')), 'no Access-Control-* headers');
    }
    assert(!/Access-Control-Allow/i.test(fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8')), 'server.js never sets CORS headers');
    if (lan) {
      // MONITOR_HOST=0.0.0.0: an iPad on the same network reaches the dashboard...
      assert.equal((await req(main, lan.address, '/state', { headers: k })).status, 200, 'LAN reaches the dashboard with MONITOR_HOST=0.0.0.0');
      const page = await req(main, lan.address, '/'), st = await req(main, lan.address, '/state', { headers: k }), noKey = await req(main, lan.address, '/state');
      for (const r of [page, st, noKey]) assert(!r.body.includes(key), 'no LAN response contains the key');
      assert.equal(noKey.status, 401);
      assert.equal(JSON.parse(st.body).local, false, 'a LAN device is not local (no QR button)');
      // ...but never the hook endpoints, the address list or chat-tracking setup.
      assert.equal((await req(main, lan.address, '/lan-addresses', { headers: k })).status, 403);
      for (const route of ['/event', '/ask', '/ack', '/usage', '/chat-tracking/setup']) {
        assert.equal((await req(main, lan.address, route, { method: 'POST', headers: { ...json, ...k }, body: '{}' })).status, 403, route + ' is local only');
      }
      // Default (no MONITOR_HOST): not reachable from the network.
      await assert.rejects(req(localOnly, lan.address, '/state', { headers: k }), 'by default the dashboard is not reachable from the network');
    } else console.log('SKIP: no non-loopback IPv4 interface; the LAN reachability checks did not run.');
    console.log('Security hardening passed: this Mac only by default and LAN with MONITOR_HOST=0.0.0.0, key never printed or sent to the LAN, POST needs x-key, Host allowlist, no CORS, forwarded requests are not local, hooks local only, ?key= removed from the address bar, MONITOR_URL limited to this Mac, Edit/Write content on the approval card.');
  } catch (err) { console.error(err); process.exitCode = 1; }
  finally { await main.stop(); await localOnly.stop(); }
})();
