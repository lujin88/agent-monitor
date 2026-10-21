#!/usr/bin/env node
// Adds an automatic light/dark theme to index.html: it follows the device's appearance,
// so it switches by itself when the iPad/Mac switches between day and night.
// Edits index.html in place (keeps a backup), so any changes you already made to it stay.
//
//   node ~/agent-monitor/apply-theme.js

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'index.html');
if (!fs.existsSync(file)) { console.error('找不到 index.html：' + file); process.exit(1); }

let html = fs.readFileSync(file, 'utf8');
if (html.includes('/* auto-theme */')) { console.log('已经加过自动日夜模式了，没有改动。'); process.exit(0); }
// Legacy script for the first dashboard layout. The current index.html already switches
// themes by time (data-theme); injecting this CSS would force color-scheme:dark on it.
if (html.includes('data-theme')) { console.log('当前 index.html 已内置按时间切换的日夜模式；这个旧脚本不再适用，没有改动。'); process.exit(0); }
if (!html.includes('</style>')) { console.error('index.html 里找不到样式块，没有改动。把文件发给我看看。'); process.exit(1); }

const css = `
  /* auto-theme */
  :root { color-scheme: dark; }
  @media (prefers-color-scheme: light) {
    :root {
      color-scheme: light;
      --bg: #f4f1ea; --panel: #ffffff; --line: #d8d2c4; --text: #1d2433; --muted: #5a6479;
      --need: #d63a25; --need-ink: #ffffff; --done: #1c8f66; --run: #2f62c9;
    }
    .card { box-shadow: 0 1px 2px rgba(29, 36, 51, .06); }
    .card.done .title { color: var(--text); opacity: .85; }
    .card.need .age, .card.need .proj { opacity: .92; }
    .card.need button { border-color: rgba(255, 255, 255, .75); }
    .approve { background: #1d2433; color: #fff; border-color: #1d2433; }
    .approve::after { background: rgba(255, 255, 255, .3); }
    .cmd { background: rgba(0, 0, 0, .2); }
    .usage .bar { background: rgba(29, 36, 51, .12); }
    .usage .bar i.warn { background: #d99a1c; }
  }
`;

fs.writeFileSync(file + '.bak-theme', html);
html = html.replace('</style>', css + '</style>');
html = html.replace(
  /<meta name="theme-color" content="[^"]*">/,
  '<meta name="theme-color" content="#f4f1ea" media="(prefers-color-scheme: light)">\n<meta name="theme-color" content="#1a2230" media="(prefers-color-scheme: dark)">'
);
fs.writeFileSync(file, html);
console.log('已加上自动日夜模式。刷新看板页面即可（iPad 上如果是主屏幕图标，关掉再打开）。');
console.log('备份：' + file + '.bak-theme');
