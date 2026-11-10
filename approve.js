#!/usr/bin/env node
// PermissionRequest hook for Claude Code and Codex.
// Shows the request on the iPad, waits for Approve / Deny, and prints the decision.
// Usage: node approve.js <source>        (source: claude | codex)
//
// Requests that auto-approve.js classifies as safe (read-only, edits inside the project, common
// development commands) are approved here without asking; see that file for the exact rules,
// and set AUTO_APPROVE=off to turn this off. Everything else goes to the iPad. If the monitor is
// unreachable, the wait runs out, or you choose "Handle in app" in the Dashboard, it prints
// nothing and the normal approval prompt appears on the Mac.
//
// Receipt: after an Approve / Deny has been written and flushed to stdout, the hook sends
// the request's one-time receipt back (POST /ack). That confirms the hook received and
// output the decision; it does not mean the agent ran anything.

const http = require('http');
const fs = require('fs');
const path = require('path');

const source = process.argv[2] || 'unknown';
const SERVER = new URL(process.env.MONITOR_URL || 'http://127.0.0.1:7777');
const MAX_WAIT_MS = 5 * 60 * 1000; // hard ceiling; the server's own wait ends sooner
const ACK_TIMEOUT_MS = 1500;       // the server waits longer than this for the receipt
const MAX_RESPONSE = 16 * 1024;    // a decision is tiny; anything larger is not trusted

let TOKEN = '';
try { TOKEN = fs.readFileSync(path.join(__dirname, 'token.txt'), 'utf8').trim(); } catch (_) {}

// These tools need a real answer from you, not a yes/no. Report them, but never decide for you.
const NEVER_DECIDE = new Set(['AskUserQuestion', 'ExitPlanMode']);

// A missing or broken rules file must never block approvals: everything then goes to the iPad.
let classify = () => ({ allow: false });
try { ({ classify } = require('./auto-approve')); } catch (_) {}

// One line per automatic approval, without the command itself (it can contain secrets).
function logAuto(entry) {
  try { fs.appendFileSync(path.join(__dirname, 'auto-approve.log'), JSON.stringify(entry) + '\n', { mode: 0o600 }); } catch (_) {}
}

let raw = '';
let started = false;
let finished = false;

function exit() {
  if (finished) return;
  finished = true;
  process.exit(0);
}

// r is the server's /ask reply. Anything but a well-formed allow/deny prints nothing.
let answered = false;
function out(r, message) {
  if (answered) return;
  answered = true;
  const decision = r && r.decision;
  if (decision !== 'allow' && decision !== 'deny') return exit();
  const d = decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: message || 'Denied from the iPad monitor' };
  const receipt = typeof r.aid === 'string' && /^[0-9a-f]{16}$/.test(r.aid) &&
    typeof r.receipt === 'string' && /^[0-9a-f]{32}$/.test(r.receipt);
  // Exit only after stdout is flushed (pipes are asynchronous on macOS), and acknowledge
  // only a decision that was actually written.
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: d } }), (err) => {
    if (err || !receipt) return exit();
    post('/ack', { aid: r.aid, receipt: r.receipt, decision }, exit, ACK_TIMEOUT_MS);
  });
}

// onDone runs exactly once, with the parsed object from a 200 response, or {} otherwise.
function post(pathname, payload, onDone, timeoutMs) {
  let done = false;
  const finish = (r) => { if (done) return; done = true; onDone(r); };
  const body = JSON.stringify(payload);
  const req = http.request(
    {
      hostname: SERVER.hostname, port: SERVER.port, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'x-key': TOKEN },
      timeout: timeoutMs,
    },
    (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        b += c;
        if (b.length > MAX_RESPONSE) { finish({}); req.destroy(); }
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return finish({});
        let r = null;
        try { r = JSON.parse(b || '{}'); } catch (_) {}
        finish(r && typeof r === 'object' && !Array.isArray(r) ? r : {});
      });
      res.on('aborted', () => finish({}));
      res.on('error', () => finish({}));
    }
  );
  req.on('error', () => finish({}));
  req.on('timeout', () => { finish({}); req.destroy(); });
  req.end(body);
}

function run() {
  if (started) return;
  started = true;

  // A missing, partial (stdin still open at the 1 s safety timer) or malformed payload
  // must not become an approval card: it would show "{}" while the real request differs.
  let p = null;
  try { p = JSON.parse(raw); } catch (_) {}
  if (!p || typeof p !== 'object' || Array.isArray(p)) return out(null);

  const input = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {};
  const cwd = p.cwd || '';
  const base = {
    source,
    session: p.session_id || p.thread_id || p.conversation_id || 'default',
    project: cwd ? path.basename(cwd) : '',
  };

  if (NEVER_DECIDE.has(p.tool_name)) {
    return post('/event', { ...base, status: 'needs_action', message: 'Please answer this question in the agent app.' }, () => out(null), 800);
  }

  const auto = classify(p);
  if (auto && auto.allow === true) {
    logAuto({ at: new Date().toISOString(), source, tool: String(p.tool_name || '').slice(0, 60), rule: auto.rule, project: base.project });
    return out({ decision: 'allow' });
  }

  const command =
    typeof input.command === 'string' ? input.command :
    typeof input.cmd === 'string' ? input.cmd :
    input.file_path ? `${input.file_path}` :
    input.url ? `${input.url}` :
    JSON.stringify(input);

  post('/ask', {
    ...base,
    tool: typeof p.tool_name === 'string' ? p.tool_name : '',
    command,
    description: typeof input.description === 'string' ? input.description : typeof input.justification === 'string' ? input.justification : '',
    ack: 1, // this hook confirms receipt of a decision
  }, out, MAX_WAIT_MS);
}

// An agent that stopped reading must not crash the hook with an unhandled EPIPE.
if (typeof process.stdout.on === 'function') process.stdout.on('error', () => {});

if (process.stdin.isTTY) {
  run();
} else {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', run);
  setTimeout(run, 1000);
}
