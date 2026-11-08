// Before/after screenshots for agent-monitor PR #2. Fake key, isolated HOME, own ports.
// usage: node shoot.cjs <repo> <outdir>
const { chromium } = require('playwright-core');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');
const repo = process.argv[2], outRoot = process.argv[3];
const KEY = 'demo-key-not-real-0000';
const OFF = { CHAT_WATCH: 'off', CODEX_WATCH: 'off', CODEX_USAGE: 'off', CURSOR_USAGE: 'off', GROK_WATCH: 'off', GROK_USAGE: 'off', CLAUDE_USAGE: 'off', MONITOR_NOTIFICATIONS: 'off' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kids = [];

function exportTree(rev) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'am-shot-')));
  execFileSync('sh', ['-c', `git -C "${repo}" archive ${rev} | tar -x -C "${dir}"`]);
  fs.writeFileSync(path.join(dir, 'token.txt'), KEY, { mode: 0o600 });
  return dir;
}
function hook(dir, port, payload) {
  const c = spawn(process.execPath, [path.join(dir, 'approve.js'), 'claude'], { env: { ...process.env, ...OFF, HOME: dir, MONITOR_URL: `http://127.0.0.1:${port}` }, stdio: ['pipe', 'ignore', 'ignore'] });
  c.stdin.end(JSON.stringify(payload)); kids.push(c);
}

async function run(label, rev, port, b) {
  const dir = exportTree(rev), out = path.join(outRoot, label); fs.mkdirSync(out, { recursive: true });
  const env = { ...process.env, ...OFF, HOME: dir, PORT: String(port), MONITOR_HOST: '' };
  if (label === 'after') env.MONITOR_HOST = '0.0.0.0'; // as deployed for the iPad; shows the QR entry
  const srv = spawn(process.execPath, [path.join(dir, 'server.js')], { env, stdio: 'ignore' }); kids.push(srv);
  await sleep(1500);
  const proj = path.join(dir, 'demo-project'); fs.mkdirSync(proj);
  const outside = path.join(dir, 'shared-config.js'); fs.writeFileSync(outside, 'export const retries = 1;\n');
  const EDIT = { session_id: 'demo-edit', cwd: proj, tool_name: 'Edit', tool_input: { file_path: outside, old_string: 'export const retries = 1;', new_string: 'export const retries = 3;', description: 'raise retries for flaky uploads' } };
  const WRITE = { session_id: 'demo-write', cwd: proj, tool_name: 'Write', tool_input: { file_path: outside, content: Array.from({ length: 24 }, (_, i) => `// demo line ${i + 1}`).join('\n') } };
  const MULTI = { session_id: 'demo-multi', cwd: proj, tool_name: 'MultiEdit', tool_input: { file_path: outside, edits: [{ old_string: 'retries = 1', new_string: 'retries = 2' }, { old_string: 'timeout = 5', new_string: 'timeout = 10' }, { old_string: 'debug = true', new_string: 'debug = false' }] } };
  const page = async (w, h, theme) => {
    const p = await b.newPage({ viewport: { width: w, height: h } });
    await p.goto(`http://localhost:${port}/?key=${KEY}`); await p.waitForTimeout(1200);
    if (theme) { await p.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme); await p.waitForTimeout(200); }
    return p;
  };
  const openCard = async (p) => { await p.locator('button:has-text("Review & approve")').first().click({ timeout: 8000 }); await p.waitForTimeout(400); };
  const shot = (p, name) => p.screenshot({ path: path.join(out, name + '.png') });
  const decide = async (p, label) => { await p.locator(`.approval-dialog footer button:text-is("${label}")`).click(); await p.waitForTimeout(1500); };

  hook(dir, port, EDIT); await sleep(1000);
  let p = await page(1280, 860);
  await shot(p, '1-waiting-list');
  await p.screenshot({ path: path.join(out, '0-header.png'), clip: { x: 0, y: 0, width: 1280, height: 170 } });
  await openCard(p); await shot(p, '2-expanded-edit'); await decide(p, 'Approve'); await shot(p, '5-approved'); await p.close();

  hook(dir, port, WRITE); await sleep(1000);
  p = await page(1280, 860); await openCard(p); await shot(p, '3-expanded-write'); await decide(p, 'Deny'); await shot(p, '6-denied'); await p.close();

  hook(dir, port, MULTI); await sleep(1000);
  p = await page(1280, 860); await openCard(p); await shot(p, '4-expanded-multiedit'); await p.close();
  p = await page(390, 760); await openCard(p); await shot(p, '7-narrow-multiedit'); await p.close();
  p = await page(1280, 860, 'dark'); await openCard(p); await shot(p, '8-dark-multiedit'); await p.close();
  if (label === 'after') {
    p = await page(1280, 860); await p.click('#open-device'); await p.waitForTimeout(500); await shot(p, '9-qr-masked'); await p.close();
    p = await page(390, 760); await p.screenshot({ path: path.join(out, '0-header-narrow.png'), clip: { x: 0, y: 0, width: 390, height: 200 } }); await p.close();
  }
  return dir;
}

(async () => {
  const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const dirs = [];
  try {
    dirs.push(await run('before', 'origin/main', 19971, b));
    dirs.push(await run('after', '163c98dcf20c2aa711647c27e46e96630726839e', 19972, b));
  } finally {
    await b.close(); kids.forEach((k) => { try { k.kill('SIGTERM'); } catch (_) {} });
    await sleep(300); dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
})().catch((e) => { console.error(e); process.exit(1); });
