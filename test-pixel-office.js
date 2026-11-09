// Pixel Office: exact-path static assets, no directory listing, no path join from the URL,
// 768×656 contain (never a 512 crop), thirteen named seats, no fake status on the office.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = __dirname;
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const seats = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'pixel-office', 'seats.json'), 'utf8'));
const png = fs.readFileSync(path.join(root, 'assets', 'pixel-office', 'ROOM_EMPTY_V4_R2_768.png'));

assert.equal(seats.width, 768);
assert.equal(seats.height, 656);
assert.equal(seats.seats.length, 13, 'thirteen official seats');
assert.deepEqual(seats.seats.map((s) => s.handle), [
  'harness', 'dev', 'qa', 'webdev',
  'visual', 'visualqa', 'motion', 'copy',
  'research', 'video', 'help',
  'pm', 'ops',
]);
for (const seat of seats.seats) {
  assert(Array.isArray(seat.chair) && seat.chair.length === 2);
  assert(!('status' in seat), 'seats.json has names, not status');
}

assert.equal(png.readUInt32BE(16), 768);
assert.equal(png.readUInt32BE(20), 656);

assert(/aspect-ratio:\s*768\/656/.test(html), 'office keeps the 768×656 frame');
assert(/object-fit:\s*contain/.test(html), 'office image uses contain');
const officeCss = html.slice(html.indexOf('.pixel-office-stage img'), html.indexOf('.seat-label'));
assert(!/object-fit:\s*cover/.test(officeCss), 'office image is not cropped with cover');
assert(!/height:\s*512/.test(html), 'no 512-tall crop');
assert(html.includes('width="768" height="656"'));
assert(html.includes('id="view-office"'));
assert(!/pixel-office[\s\S]{0,800}(busy|idle|stuck|needs_action)/i.test(html), 'office markup has no fake status');

assert(!/path\.join\(__dirname,\s*(url|req\.url)/.test(serverSrc), 'server never joins the request path onto disk');

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-'));
const port = 19000 + Math.floor(Math.random() * 900);
const key = 'pixel-office-test-key';
fs.mkdirSync(path.join(dir, 'assets', 'pixel-office'), { recursive: true });
for (const f of ['server.js', 'approve.js', 'codex-watch.js', 'chat-watch.js', 'cursor-usage.js', 'claude-usage.js', 'grok-usage.js', 'grok-watch.js', 'index.html', 'vendor-qrcode.js']) {
  fs.copyFileSync(path.join(root, f), path.join(dir, f));
}
fs.copyFileSync(path.join(root, 'assets', 'pixel-office', 'ROOM_EMPTY_V4_R2_768.png'), path.join(dir, 'assets', 'pixel-office', 'ROOM_EMPTY_V4_R2_768.png'));
fs.copyFileSync(path.join(root, 'assets', 'pixel-office', 'seats.json'), path.join(dir, 'assets', 'pixel-office', 'seats.json'));
fs.writeFileSync(path.join(dir, 'token.txt'), key);

const child = spawn(process.execPath, [path.join(dir, 'server.js')], {
  env: { ...process.env, HOME: dir, PORT: String(port), CHAT_WATCH: 'off', CODEX_WATCH: 'off', CODEX_USAGE: 'off', CURSOR_USAGE: 'off', GROK_WATCH: 'off', GROK_USAGE: 'off', CLAUDE_USAGE: 'off', MONITOR_NOTIFICATIONS: 'off' },
  stdio: 'ignore',
});

function req(route, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: '127.0.0.1', port, path: route, method: 'GET', headers, timeout: 2000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    r.end();
  });
}

(async () => {
  try {
    let ready = false;
    for (let i = 0; i < 80 && !ready; i++) {
      try { await req('/'); ready = true; } catch (_) { await pause(25); }
    }
    if (!ready) throw new Error('server did not start');

    const room = await req('/assets/pixel-office/ROOM_EMPTY_V4_R2_768.png');
    assert.equal(room.status, 200);
    assert.match(room.headers['content-type'], /image\/png/);
    assert.equal(room.body.readUInt32BE(16), 768);
    assert.equal(room.body.readUInt32BE(20), 656);

    const json = await req('/assets/pixel-office/seats.json');
    assert.equal(json.status, 200);
    assert.equal(JSON.parse(json.body.toString()).seats.length, 13);

    const blocked = [
      '/assets/pixel-office/../server.js',
      '/assets/pixel-office/../../token.txt',
      '/assets/../server.js',
      '/assets/pixel-office/%2e%2e/server.js',
      '/assets/pixel-office/',
      '/assets/pixel-office/other.png',
      '/assets/',
    ];
    for (const route of blocked) {
      const r = await req(route);
      assert.equal(r.status, 404, route + ' must be 404, got ' + r.status);
      assert(!r.body.includes(key), route + ' must not leak the key');
    }

    console.log('Pixel Office tests passed: 768×656 contain, 13 seats, exact-path assets, ../ returns 404.');
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    await pause(300);
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
