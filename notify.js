#!/usr/bin/env node
// Called by Claude Code / Cursor hooks.
// Usage: node notify.js <source> <status>
//   source: claude | cursor | grok | codex | anything you like
//   status: running | needs_action | done | resume
// The hook payload (JSON) arrives on stdin.

const http = require('http');
const fs = require('fs');
const path = require('path');

const argSource = process.argv[2] || 'unknown';
const status = process.argv[3] || 'running';
const SERVER = new URL(process.env.MONITOR_URL || 'http://127.0.0.1:7777');

let TOKEN = '';
try { TOKEN = fs.readFileSync(path.join(__dirname, 'token.txt'), 'utf8').trim(); } catch (_) {}

let raw = '';
let sent = false;

function finish() {
  // Cursor's prompt hook expects a JSON reply on stdout.
  // Claude Code would treat stdout as extra context, so print nothing for it.
  if (argSource === 'cursor') process.stdout.write('{"continue":true}');
  process.exit(0);
}

function post(payload) {
  if (sent) return;
  sent = true;

  let p = {};
  try { p = JSON.parse(raw || '{}'); } catch (_) {}
  if (!p || typeof p !== 'object') p = {}; // e.g. "null" must not crash the hook

  // Grok Build sends camelCase keys (sessionId, hookEventName, workspaceRoot) and also
  // reads Claude Code / Cursor hook files, so label by payload shape, not by the argument.
  const isGrok = p.sessionId !== undefined || p.hookEventName !== undefined;
  const source = isGrok ? 'grok' : argSource;
  const cwd = p.cwd || p.workspaceRoot || (Array.isArray(p.workspace_roots) && p.workspace_roots[0]) || '';
  const body = JSON.stringify({
    source,
    status,
    session: p.session_id || p.thread_id || p.sessionId || p.conversation_id || 'default',
    project: cwd ? path.basename(cwd) : '',
    title: status === 'running' ? p.prompt : undefined,
    message: p.message || (p.tool_input && (p.tool_input.description || p.tool_input.command)),
  });

  const req = http.request(
    {
      hostname: SERVER.hostname,
      port: SERVER.port,
      path: '/event',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'x-key': TOKEN },
      timeout: 800,
    },
    (res) => { res.resume(); res.on('end', finish); }
  );
  req.on('error', finish);   // never block or break the tool if the monitor is down
  req.on('timeout', () => { req.destroy(); finish(); });
  req.end(body);
}

if (process.stdin.isTTY) {
  post();
} else {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', post);
  setTimeout(post, 1000); // safety net if stdin never closes
}
