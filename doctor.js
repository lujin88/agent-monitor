#!/usr/bin/env node
// Checks the whole setup and, with --watch, tells you which app's events actually arrive.
//   node ~/agent-monitor/doctor.js            check everything
//   node ~/agent-monitor/doctor.js --watch    check, then watch 90s while you send a task in each app
// It never prints your access key.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const dir = __dirname;
const home = os.homedir();
const PORT = process.env.PORT || 7777;
const BUNDLED_CODEX_BIN = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
let TOKEN = '';
try { TOKEN = fs.readFileSync(path.join(dir, 'token.txt'), 'utf8').trim(); } catch (_) {}

let problems = 0;
let unverified = 0;
const unknown = m => {unverified++; console.log("⚪ " + m);};
const ok = (m) => console.log('✅ ' + m);
const bad = (m, fix) => { problems++; console.log('❌ ' + m); if (fix) console.log('   → ' + fix); };
const note = (m) => console.log('ℹ️  ' + m);

function call(method, p, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'x-key': TOKEN };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ hostname: '127.0.0.1', port: PORT, path: p, method, headers, timeout: 3000 }, (rs) => {
      let b = ''; rs.on('data', (c) => { b += c; });
      rs.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: rs.statusCode, json: j }); });
    });
    r.on('error', () => resolve(null));
    r.on('timeout', () => { r.destroy(); resolve(null); });
    if (data) r.write(data);
    r.end();
  });
}

function readJson(file) {
  if (!fs.existsSync(file)) return { exists: false };
  try { return { exists: true, data: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch (e) { return { exists: true, err: e.message }; }
}

function commandsIn(x, out = []) {
  if (Array.isArray(x)) x.forEach((v) => commandsIn(v, out));
  else if (x && typeof x === 'object') {
    if (typeof x.command === 'string') out.push(x.command);
    Object.values(x).forEach((v) => commandsIn(v, out));
  }
  return out;
}

function checkHookFile(label, file, fixCmd, extra) {
  const r = readJson(file);
  if (!r.exists) return bad(`${label}：没有配置文件（${file}）`, `运行 ${fixCmd}`);
  if (r.err) return bad(`${label}：${file} 不是标准 JSON，读不出来`, '把这个文件的内容发给我');
  const mine = commandsIn(r.data).filter((c) => /(notify|approve|statusline)\.js/.test(c) && c.includes(path.basename(dir)));
  if (!mine.length) return bad(`${label}：文件在，但里面没有监控的 hooks`, `运行 ${fixCmd}`);
  const bare = mine.filter((c) => /^\s*node\s/.test(c));
  const missing = mine.filter((c) => {
    const m = c.match(/["']?([^"'\s]*(?:notify|approve|statusline)\.js)/);
    return m && !fs.existsSync(m[1].replace(/^~/, home));
  });
  if (missing.length) return bad(`${label}：hooks 指向的脚本不存在（文件夹被移动过？）`, `重新运行 ${fixCmd}`);
  if (bare.length) return bad(`${label}：hooks 里用的是 "node"，桌面 App 可能找不到这个命令，会悄悄失败`, `重新运行 ${fixCmd}（新版会写入 node 的完整路径）`);
  ok(`${label}：已配置 ${mine.length} 条监控 hooks，node 用的是完整路径`);
  if (extra) extra(r.data);
}

function checkCodexHookTrust() {
  return new Promise((resolve) => {
    const bin = fs.existsSync(BUNDLED_CODEX_BIN) ? BUNDLED_CODEX_BIN : 'codex';
    let child;
    try { child = spawn(bin, ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch (_) { note('Codex hook 信任状态无法读取；请在 Codex 里运行 /hooks 检查'); return resolve(); }

    let buf = '';
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { child.kill(); } catch (_) {}
      resolve();
    };
    const send = (obj) => { try { child.stdin.write(JSON.stringify(obj) + '\n'); } catch (_) {} };
    const timer = setTimeout(() => {
      note('Codex hook 信任状态读取超时；请在 Codex 里运行 /hooks 检查');
      finish();
    }, 5000);

    child.on('error', () => {
      note('Codex hook 信任状态无法读取；请在 Codex 里运行 /hooks 检查');
      finish();
    });
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let newline;
      while ((newline = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, newline).trim();
        buf = buf.slice(newline + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg.id === 0) {
          send({ method: 'initialized' });
          send({ method: 'hooks/list', id: 1, params: { cwds: [dir] } });
        } else if (msg.id === 1) {
          const hooks = (msg.result && msg.result.data || [])
            .flatMap((entry) => entry.hooks || [])
            .filter((hook) => hook.sourcePath === path.join(home, '.codex', 'hooks.json'));
          if (!hooks.length) {
            bad('Codex：运行时没有加载监控 hooks', '完全退出并重新打开 ChatGPT/Codex 桌面端，再运行 doctor.js');
          } else {
            const blocked = hooks.filter((hook) => !hook.enabled || hook.trustStatus !== 'trusted');
            if (blocked.length) bad(`Codex：${blocked.length} 条 hooks 尚未被信任，运行时会静默跳过`, '在 Codex 里运行 /hooks，审核并信任 agent-monitor 的 hooks');
            else ok(`Codex：${hooks.length} 条 hooks 已启用并信任`);
          }
          finish();
        }
      }
    });
    child.on('exit', () => {
      if (!finished) note('Codex hook 信任状态无法读取；请在 Codex 里运行 /hooks 检查');
      finish();
    });
    send({ method: 'initialize', id: 0, params: { clientInfo: { name: 'agent-monitor-doctor', title: 'Agent Monitor Doctor', version: '1.0' } } });
  });
}

const STATUS = { running: '运行中', needs_action: '需要你', done: '已完成' };

async function main() {
  console.log('\n=== Agent Monitor 诊断 ===\n');
  note(`node ${process.version}，路径 ${process.execPath}`);

  // 1. server
  const page = await call('GET', '/');
  if (!page) {
    bad(`服务没在运行（连不上 127.0.0.1:${PORT}）`, `在另一个终端运行: cd ${dir} && node server.js，然后再运行这个诊断`);
    return finish(false);
  }
  ok('服务在运行');

  // 2. key + round trip
  if (!TOKEN) bad('找不到 token.txt', '重启一次 server.js 会自动生成');
  const st = await call('GET', '/state');
  if (!st || st.status !== 200) {
    bad(`服务拒绝了访问密钥（HTTP ${st ? st.status : '无响应'}）`, 'token.txt 和服务正在用的不一致：停掉服务，重新运行 node server.js');
    return finish(false);
  }
  ok('访问密钥正确');

  const ev = await call('POST', '/event', { source: 'doctor', session: 'doctor-test', status: 'running', title: '诊断测试' });
  const st2 = await call('GET', '/state');
  const seen = st2 && st2.json && st2.json.sessions.some((s) => s.id === 'doctor:doctor-test');
  await call('POST', '/dismiss', { id: 'doctor:doctor-test' });
  if (ev && ev.status === 200 && seen) ok('服务能收到事件并显示（看板本身没问题）');
  else bad(`服务收不到事件（POST /event 返回 ${ev ? ev.status : '无响应'}）`, '把这一行发给我');

  // 3. each tool's hook config
  console.log('');
  checkHookFile('Claude Code', path.join(home, '.claude', 'settings.json'), `node ${path.join(dir, 'setup-claude.js')}`);
  checkHookFile('Codex', path.join(home, '.codex', 'hooks.json'), `node ${path.join(dir, 'setup.js')} codex`, () => {
    try {
      const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
      const n = (toml.match(/trusted_hash/g) || []).length;
      if (n) note(`Codex 的 config.toml 里有 ${n} 条 hooks 信任记录（说明至少信任过一些 hooks）`);
      else note('Codex 要求先“审核并信任” hooks 才会运行。重开 ChatGPT/Codex 桌面端，留意有没有信任提示');
    } catch (_) { note('Codex 要求先“审核并信任” hooks 才会运行。重开桌面端时留意信任提示'); }
  });
  await checkCodexHookTrust();
  checkHookFile('Cursor', path.join(home, '.cursor', 'hooks.json'), `node ${path.join(dir, 'setup.js')} cursor`);

  // Configuration is not proof of live delivery.
  console.log('');
  // Ordinary Chat/Cowork are untracked by design: the old window observer depended on the
  // chat being visible on screen and is now off unless CHAT_WATCH=on.
  const health = st2.json.chatTracking;
  if (health?.status === 'disabled') note('Claude Chat / Cowork：未追踪（窗口观察已停用，不读取聊天界面）；没有数据不代表没有任务');
  else if (health?.status === 'ok') note(`窗口观察仍在运行（CHAT_WATCH=on），只作参考，不计入看板任务：${health.observedWindows || 0} 个窗口`);
  else note(`窗口观察状态：${health?.status || 'unknown'}；新版服务默认停用，重启服务后生效`);
  const reader = st2.json.notificationReader;
  if (!reader) unknown('Claude 通知读取：当前服务版本未报告；需要按 README 重启服务后才显示');
  else if (!reader.present) unknown('Claude 通知读取：Reader 没有运行（没有 notification-reader-status.json）');
  else if (reader.status === 'full_disk_access_required') bad(`Claude 通知读取：数据库被 macOS 隐私保护拒绝${reader.openErrno ? `（errno ${reader.openErrno}）` : '（旧版 Reader，未记录 errno）'}，启动方式：${reader.launchedBy || '未知'}`, `运行 bash ${path.join(dir, 'diagnose-notification-reader.sh')} 查看原因；不要给 Terminal 或 node 开权限`);
  else if (['ready', 'readable', 'no_claude_notifications'].includes(reader.status)) unknown(`Claude 通知读取：可读（${reader.status}）。Chat/Cowork 实测尚未通过，通知结果仍只是 Estimated`);
  else bad(`Claude 通知读取：${reader.status}${reader.openError ? ' · ' + reader.openError : ''}`, `运行 bash ${path.join(dir, 'diagnose-notification-reader.sh')}`);
  for (const source of ['codex','claude','cursor']) {
    const rec = st2.json.usage?.[source], age = rec ? Date.now()-rec.updatedAt : Infinity;
    const status = st2.json.usageStatus?.[source];
    if (!rec?.windows?.length) bad(`${source} 用量：没有数据`);
    else if (age>15*60*1000 || (status && status!=='ok')) bad(`${source} 用量：缓存 ${Math.round(age/60000)} 分钟前的数据，不能当作实时用量`,source==='claude'?'当前来自 Claude Code 的状态栏；普通 Claude 聊天不会更新这份数据':'检查账号连接和用量查询状态');
    else ok(`${source} 用量：${Math.round(age/60000)} 分钟内已刷新`);
    const events = st2.json.sessions.filter(x=>x.source===source && x.taskKind!=='chat' && x.taskKind!=='notification');
    const last = st2.json.reports?.sources?.[source]?.at;
    if (last) note(`${source} 任务：最后一次上报在 ${Math.round((Date.now()-last)/60000)} 分钟前（这是唯一的实际送达证据）`);
    else if (!events.length) unknown(`${source} 任务：hooks 已检查，但没有实际事件证据；需要在原应用触发一次任务验证`);
    else note(`${source} 任务：已收到 ${events.length} 个任务的状态；配置和实际事件分别验证`);
  }
  if (!fs.existsSync(path.join(home,'.grok','hooks','agent-monitor.json'))) note('未配置 Grok Build CLI hooks；已安装的 Grok Bot 桌面应用使用普通聊天监听，两者不能混同');
  unknown('Grok 独立用量：没有接入；Cursor 的 Other models 用量不代表 Grok 的独立套餐');
  unknown('通知：发送请求不等于设备已展示通知；浏览器权限和提示音状态请在 Dashboard 的 Connections 中检查');
  note('授权：仅接入 PermissionRequest hook 的请求能从 Dashboard 决定；普通聊天授权仍在原应用处理');

  // 4. what the board has seen so far
  const now = st2 && st2.json ? st2.json.sessions.filter((s) => s.source !== 'doctor') : [];
  console.log('');
  if (now.length) { note(`看板目前有 ${now.length} 个任务：`); now.forEach((s) => console.log(`     ${s.source}  ${STATUS[s.status] || s.status}  ${(s.title || '').slice(0, 30)}`)); }
  else note('看板目前没有收到过任何任务（如果你刚配置完，这是正常的，需要新发一条任务）');

  await finish(true);
}

async function finish(serverUp) {
  if (serverUp && process.argv.includes('--watch')) await watch();
  console.log(`\n${problems} 个故障，${unverified} 项尚未完成真实链路验证。配置存在不代表所有通道已接通。\n`);
  process.exit(problems ? 1 : 0);
}

async function watch() {
  console.log('\n--- 观察 90 秒 ---');
  console.log('现在请在 Cursor、ChatGPT(Codex)、Claude(Code) 里各新发一条任务。已经在跑的旧任务不会被记录。\n');
  const known = {};
  const got = new Set();
  const end = Date.now() + 90000;
  while (Date.now() < end) {
    const r = await call('GET', '/state');
    if (r && r.json) {
      for (const s of r.json.sessions) {
        if (s.source === 'doctor') continue;
        const k = s.id;
        const sig = s.status + ':' + s.updatedAt;
        if (known[k] !== sig) {
          known[k] = sig; got.add(s.source);
          const t = new Date().toTimeString().slice(0, 8);
          console.log(`[${t}] ${s.source}  ${STATUS[s.status] || s.status}  ${(s.title || s.project || '').slice(0, 30)}`);
        }
      }
    }
    await new Promise((r2) => setTimeout(r2, 1000));
  }
  console.log('');
  for (const [src, name] of [['cursor', 'Cursor'], ['codex', 'Codex'], ['claude', 'Claude Code']]) {
    if (got.has(src)) ok(`${name}：收到了事件`);
    else bad(`${name}：90 秒内没收到任何事件`, '这个 App 的 hooks 没触发：确认它已完全退出重开、新发了任务；Codex 还要确认信任了 hooks');
  }
}

main();
