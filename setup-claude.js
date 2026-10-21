#!/usr/bin/env node
// One-command setup for Claude Code: adds the status line (usage %) and the monitor hooks
// to ~/.claude/settings.json. It backs the file up first, keeps everything you already have,
// and never overwrites an existing status line.
//
//   node ~/agent-monitor/setup-claude.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = __dirname;
const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');

let settings = {};
if (fs.existsSync(settingsPath)) {
  const raw = fs.readFileSync(settingsPath, 'utf8');
  try {
    settings = raw.trim() ? JSON.parse(raw) : {};
  } catch (e) {
    console.error(`没有改动任何东西：${settingsPath} 不是标准 JSON（可能有注释或多余的逗号），我不想弄坏它。`);
    console.error('请把这个文件的内容发给我，我帮你合并。');
    process.exit(1);
  }
  const backup = settingsPath + '.bak-monitor';
  fs.writeFileSync(backup, raw);
  console.log(`已备份原文件：${backup}`);
} else {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
}

// Desktop apps launched from the Dock often can't find a bare `node`, so use its absolute path.
const q = (p) => `"${p}"`;
// Prefer a stable symlink over the versioned Cellar path, so `brew upgrade node` doesn't break the hooks.
const NODE = ['/opt/homebrew/bin/node', '/usr/local/bin/node']
  .find((p) => { try { return fs.realpathSync(p) === process.execPath; } catch (_) { return false; } }) || process.execPath;
const node = (f, args) => `${q(NODE)} ${q(path.join(dir, f))} ${args}`.trim();
const OURS = /agent-monitor[\\/](notify|approve|statusline)\.js|(notify|approve|statusline)\.js/;
const isOurs = (x) => OURS.test(JSON.stringify(x)) && JSON.stringify(x).includes(path.basename(dir));
const wanted = {
  UserPromptSubmit: [{ hooks: [{ type: 'command', command: node('notify.js', 'claude running') }] }],
  PermissionRequest: [{ hooks: [{ type: 'command', command: node('approve.js', 'claude'), timeout: 90 }] }],
  Notification: [{ hooks: [{ type: 'command', command: node('notify.js', 'claude needs_action') }] }],
  PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: node('notify.js', 'claude resume') }] }],
  Stop: [{ hooks: [{ type: 'command', command: node('notify.js', 'claude done') }] }],
  SessionEnd: [{ hooks: [{ type: 'command', command: node('notify.js', 'claude done'), timeout: 3 }] }],
};

settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
let added = 0;
for (const [event, groups] of Object.entries(wanted)) {
  // drop older monitor entries (e.g. ones that used a bare `node`), keep everything else
  const list = (Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []).filter((g) => !isOurs(g));
  for (const g of groups) { list.push(g); added++; }
  settings.hooks[event] = list;
}
console.log(`已写入 ${added} 个 hooks（旧的监控 hooks 已替换，你自己的不会动）。`);
console.log(`node 路径: ${NODE}`);

const statusCmd = node('statusline.js', '');
if (!settings.statusLine || isOurs(settings.statusLine)) {
  settings.statusLine = { type: 'command', command: statusCmd };
  console.log('已设置状态栏（用量百分比会从这里来）。');
} else {
  console.log('你已经有自己的状态栏，我没有覆盖它：');
  console.log('  ' + JSON.stringify(settings.statusLine));
  console.log('所以 Claude 的用量百分比暂时不会出现。想合并的话把上面这行发给我。');
}

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.log('\n完成。请完全退出并重新打开 Claude Code，然后随便发一条消息，等它回复完。');
