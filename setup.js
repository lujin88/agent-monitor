#!/usr/bin/env node
// One-command hook setup for Codex and Cursor (Claude Code has its own: setup-claude.js).
//   node ~/agent-monitor/setup.js codex
//   node ~/agent-monitor/setup.js cursor
// Backs the file up first, keeps everything you already have, safe to run twice,
// and refuses to touch a file that isn't plain JSON.

const fs = require('fs');
const os = require('os');
const path = require('path');

const target = process.argv[2];
const dir = __dirname;
// Desktop apps launched from the Dock often can't find a bare `node`, so use its absolute path.
const q = (p) => `"${p}"`;
// Prefer a stable symlink over the versioned Cellar path, so `brew upgrade node` doesn't break the hooks.
const NODE = ['/opt/homebrew/bin/node', '/usr/local/bin/node']
  .find((p) => { try { return fs.realpathSync(p) === process.execPath; } catch (_) { return false; } }) || process.execPath;
const node = (f, args) => `${q(NODE)} ${q(path.join(dir, f))} ${args}`.trim();
const isOurs = (x) => /(notify|approve|statusline)\.js/.test(JSON.stringify(x)) && JSON.stringify(x).includes(path.basename(dir));

const TARGETS = {
  codex: {
    file: path.join(os.homedir(), '.codex', 'hooks.json'),
    build: () => ({
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: node('notify.js', 'codex running'), timeout: 5 }] }],
      PermissionRequest: [{ hooks: [{ type: 'command', command: node('approve.js', 'codex'), timeout: 90 }] }],
      PostToolUse: [{ hooks: [{ type: 'command', command: node('notify.js', 'codex resume'), timeout: 5 }] }],
      Stop: [{ hooks: [{ type: 'command', command: node('notify.js', 'codex done'), timeout: 5 }] }],
      SessionEnd: [{ hooks: [{ type: 'command', command: node('notify.js', 'codex done'), timeout: 3 }] }],
      Interrupt: [{ hooks: [{ type: 'command', command: node('notify.js', 'codex done'), timeout: 3 }] }],
    }),
    after: '完全退出并重新打开 ChatGPT/Codex 桌面端，然后在 Codex 里运行 /hooks，审核并信任 agent-monitor 的所有 hooks；没信任之前它们会被静默跳过。最后运行 node ~/agent-monitor/doctor.js，确认出现“已启用并信任”。',
  },
  cursor: {
    file: path.join(os.homedir(), '.cursor', 'hooks.json'),
    build: () => ({
      beforeSubmitPrompt: [{ command: node('notify.js', 'cursor running') }],
      stop: [{ command: node('notify.js', 'cursor done') }],
    }),
    top: { version: 1 },
    after: '完全退出并重新打开 Cursor。Cursor 的 hooks 格式随版本会变，不生效的话把你的 Cursor 版本号发给我。',
  },
};

const t = TARGETS[target];
if (!t) {
  console.error('用法: node setup.js codex   或   node setup.js cursor');
  process.exit(1);
}

let data = {};
if (fs.existsSync(t.file)) {
  const raw = fs.readFileSync(t.file, 'utf8');
  try {
    data = raw.trim() ? JSON.parse(raw) : {};
  } catch (e) {
    console.error(`没有改动任何东西：${t.file} 不是标准 JSON，我不想弄坏它。把它的内容发给我，我帮你合并。`);
    process.exit(1);
  }
  fs.writeFileSync(t.file + '.bak-monitor', raw);
  console.log(`已备份原文件：${t.file}.bak-monitor`);
} else {
  fs.mkdirSync(path.dirname(t.file), { recursive: true });
}

if (t.top) for (const [k, v] of Object.entries(t.top)) if (data[k] === undefined) data[k] = v;
data.hooks = data.hooks && typeof data.hooks === 'object' ? data.hooks : {};

let added = 0;
for (const [event, entries] of Object.entries(t.build())) {
  const list = (Array.isArray(data.hooks[event]) ? data.hooks[event] : []).filter((e) => !isOurs(e));
  for (const e of entries) { list.push(e); added++; }
  data.hooks[event] = list;
}

fs.writeFileSync(t.file, JSON.stringify(data, null, 2) + '\n');
console.log(`已写入 ${added} 个 hooks 到 ${t.file}（旧的监控 hooks 已替换，你自己的不会动）。`);
console.log(`node 路径: ${NODE}`);
console.log('\n下一步：' + t.after);
