#!/usr/bin/env node
// Claude Code status line command. Claude Code pipes session JSON to stdin after each turn.
// For Pro/Max subscribers that JSON includes rate_limits.five_hour / seven_day (percent used).
// This prints a short status line for Claude Code AND forwards the percentages to the monitor.
//
// ~/.claude/settings.json:  "statusLine": { "type": "command", "command": "node ~/agent-monitor/statusline.js" }

const http = require('http');
const fs = require('fs');
const path = require('path');

const SERVER = new URL(process.env.MONITOR_URL || 'http://127.0.0.1:7777');
let TOKEN = '';
try { TOKEN = fs.readFileSync(path.join(__dirname, 'token.txt'), 'utf8').trim(); } catch (_) {}

let raw = '';
let ran = false;

function toEpochSeconds(v) {
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return isFinite(t) ? Math.round(t / 1000) : null;
}

function run() {
  if (ran) return;
  ran = true;

  let p = {};
  try { p = JSON.parse(raw || '{}'); } catch (_) {}

  const rl = p.rate_limits || {};
  const wins = [];
  const parts = [(p.model && (p.model.display_name || p.model.id)) || 'Claude'];
  for (const [key, label, short] of [['five_hour', '5 小时', '5h'], ['seven_day', '每周', '7d']]) {
    const w = rl[key];
    if (w && typeof w.used_percentage === 'number') {
      wins.push({ label, usedPercent: w.used_percentage, resetsAt: toEpochSeconds(w.resets_at) });
      parts.push(`${short} ${Math.round(w.used_percentage)}%`);
    }
  }
  process.stdout.write(parts.join(' · '));

  if (!wins.length) return process.exit(0);

  const body = JSON.stringify({ source: 'claude', windows: wins });
  const req = http.request(
    {
      hostname: SERVER.hostname, port: SERVER.port, path: '/usage', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'x-key': TOKEN },
      timeout: 800,
    },
    (res) => { res.resume(); res.on('end', () => process.exit(0)); }
  );
  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.end(body);
}

if (process.stdin.isTTY) {
  run();
} else {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', run);
  setTimeout(run, 1000);
}
