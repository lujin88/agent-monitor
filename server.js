#!/usr/bin/env node
// Agent Monitor server — zero dependencies, needs Node 16+.
//  - hooks report status:            POST /event   (local only)
//  - hooks ask for an approval:      POST /ask     (local only, held open until you answer)
//  - hooks / statusline report usage: POST /usage (local only)
//  - Codex plan usage is polled from `codex app-server` every few minutes
//  - iPad reads / answers:           GET /state, POST /decide, POST /dismiss
// Everything except the page itself needs the access key in token.txt.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const PORT = Number(process.env.PORT) || 7777;
const WAIT_SEC = Number(process.env.APPROVAL_WAIT_SEC) || 60; // how long an approval waits for the iPad
const RUNNING_STALE_MS = (Number(process.env.RUNNING_STALE_MIN) || 30) * 60e3;
const DONE_RETENTION_MS = (Number(process.env.DONE_RETENTION_HOURS) || 24 * 7) * 3600e3;
const DATA_FILE = path.join(__dirname, 'state.json');
const TOKEN_FILE = path.join(__dirname, 'token.txt');
const STATUSES = ['running', 'needs_action', 'done', 'unobserved'];
// How long a sent decision waits for the hook's receipt (kept below the Dashboard's 8 s request limit).
const ACK_WAIT_MS = Math.max(1, Math.min(7000, Number(process.env.APPROVAL_ACK_MS) || 4000));
const SHUTDOWN_MS = Math.max(1, Math.min(10000, Number(process.env.SHUTDOWN_TIMEOUT_MS) || 3000)); // hard limit for a graceful stop
const CLAUDE_REFRESH_MIN_MS = 60 * 1000; // one Claude usage attempt per minute, scheduled or manual
let closing = false; // set once on SIGTERM/SIGINT

let TOKEN = '';
try { TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (_) {}
if (!TOKEN) {
  TOKEN = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 });
}

// Durable JSON state. A damaged or wrongly shaped file is set aside (never silently
// overwritten by the next save), and writes go to a temp file that is renamed into place,
// one write per file at a time, so a crash or overlapping save cannot leave a torn file.
const isRecord = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
function loadJson(file, valid = isRecord) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return undefined; }
  let data;
  try { data = JSON.parse(raw); } catch (_) {}
  if (valid(data)) return data;
  try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch (_) {}
  console.error(`Ignored unreadable ${path.basename(file)}; kept a copy next to it.`);
  return undefined;
}
// Null-prototype maps: keys come from clients ("constructor", "__proto__", ...).
function recordMap(x) {
  const out = Object.create(null);
  if (isRecord(x)) for (const [k, v] of Object.entries(x)) if (isRecord(v)) out[k] = v;
  return out;
}
const writers = Object.create(null);
function writeJson(file, data) {
  // ok: result of the last completed write; idle: callbacks waiting for the queue to empty.
  const w = writers[file] || (writers[file] = { busy: false, next: null, ok: null, idle: [] });
  if (w.busy) { w.next = data; return; }
  w.busy = true;
  const tmp = `${file}.${process.pid}.tmp`;
  const next = () => {
    w.busy = false;
    if (w.next !== null) { const d = w.next; w.next = null; writeJson(file, d); }
    else for (const cb of w.idle.splice(0)) cb();
  };
  const failed = (err) => {
    // Only metadata, never payloads. Finish cleanup before reusing the temp path;
    // otherwise this unlink could delete a newer queued write.
    console.error(`Could not save ${path.basename(file)} (${err.code || 'I/O error'}).`);
    w.ok = false;
    fs.unlink(tmp, () => next());
  };
  fs.writeFile(tmp, data, { mode: 0o600 }, (err) => {
    if (err) return failed(err);
    fs.rename(tmp, file, (e) => { if (e) return failed(e); w.ok = true; next(); });
  });
}
// Resolves once every queued write has finished, with the names of files whose
// latest write failed. Uses the same queues, so the newest snapshot is the one on disk.
function drainWrites() {
  return Promise.all(Object.entries(writers).map(([file, w]) => new Promise((resolve) => {
    const done = () => resolve(w.ok === false ? path.basename(file) : null);
    if (w.busy) w.idle.push(done); else done();
  }))).then((failed) => failed.filter(Boolean));
}

let sessions = recordMap(loadJson(DATA_FILE));
for (const [k, s] of Object.entries(sessions)) {
  if (!STATUSES.includes(s.status)) { delete sessions[k]; continue; }
  s.id = k;
  if (typeof s.source !== 'string') s.source = k.split(':')[0];
}
for (const s of Object.values(sessions)) { if (s.approval) s.message = 'Dashboard restarted. Confirm this request in the agent app.'; delete s.approval; } // pending approvals don't survive a restart
for (const s of Object.values(sessions)) { // nor does a wait for a hook's receipt
  if (isRecord(s.delivery) && s.delivery.state === 'awaiting') {
    s.delivery = { ...s.delivery, state: 'unconfirmed' };
    s.message = 'Dashboard decision sent · the hook did not confirm receipt. Check the agent app.';
  }
}

const pending = Object.create(null); // approval id -> { res, id, timer, secret }
const receipts = Object.create(null); // approval id -> decision sent, awaiting the hook's receipt

// Plan usage (percent of the 5-hour / weekly limits), per source.
const USAGE_FILE = path.join(__dirname, 'usage.json');
const usage = recordMap(loadJson(USAGE_FILE));
// The Accessibility window observer depends on chats being visible on screen, so it is
// no longer a status source. It runs only when explicitly enabled with CHAT_WATCH=on.
const CHAT_WATCH_ON = process.env.CHAT_WATCH === 'on';
const chatTracking = { status: CHAT_WATCH_ON ? 'starting' : 'disabled', checkedAt: null, observedWindows: 0 };

// When each source last actually reported (hook, local log or notification estimate).
// Kept separately from tasks so dismissing a task never turns into "never reported".
const REPORTS_FILE = path.join(__dirname, 'reports.json');
let reports = { since: Date.now(), sources: Object.create(null) };
{ const r = loadJson(REPORTS_FILE, (x) => isRecord(x) && isRecord(x.sources)); if (r) reports = { ...r, sources: recordMap(r.sources) }; }
let reportsTimer = null;
function writeReports() { reportsTimer = null; writeJson(REPORTS_FILE, JSON.stringify(reports)); }
function noteReport(source, channel) {
  if (closing) return;
  const key = clip(source || 'unknown', 30) + (channel === 'hook' ? '' : ':' + channel);
  reports.sources[key] = { at: Date.now() };
  clearTimeout(reportsTimer);
  reportsTimer = setTimeout(writeReports, 500);
}

// Background timers are collected so a graceful shutdown can stop them all.
const background = [];
const every = (fn, ms) => background.push(setInterval(fn, ms));
const after = (fn, ms) => background.push(setTimeout(fn, ms));

// Hook configuration is checked, not assumed. Only a per-app state leaves this function;
// the settings files themselves (which may hold other secrets) are never sent anywhere.
function hookConfigStatus() {
  const mine = /(notify|approve)\.js/, folder = path.basename(__dirname);
  const check = (file) => {
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { return e.code === 'ENOENT' ? 'absent' : 'unreadable'; }
    const commands = [];
    (function walk(x) {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === 'object') { if (typeof x.command === 'string') commands.push(x.command); Object.values(x).forEach(walk); }
    })(data && data.hooks);
    return commands.some((c) => mine.test(c) && c.includes(folder)) ? 'configured' : 'missing';
  };
  const home = os.homedir();
  return {
    checkedAt: Date.now(),
    claude: check(path.join(home, '.claude', 'settings.json')),
    codex: check(path.join(home, '.codex', 'hooks.json')),
    cursor: check(path.join(home, '.cursor', 'hooks.json')),
  };
}
let hookConfig = hookConfigStatus();
every(() => { hookConfig = hookConfigStatus(); }, 60 * 1000);

// Health of the separate macOS notification reader. Only whitelisted health fields are
// passed on; the file never contains notification titles or bodies, and anything else
// that might appear in it is dropped here.
const READER_FIELDS = ['status', 'checkedAt', 'mode', 'observedSinceLaunch', 'waitingSinceLaunch', 'completedSinceLaunch', 'ignoredSinceLaunch', 'lastNotificationAt', 'openErrno', 'openError', 'launchedBy'];
function notificationReaderStatus() {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(__dirname, 'notification-reader-status.json'), 'utf8'));
    const out = { present: true };
    for (const k of READER_FIELDS) {
      if (typeof r[k] === 'number' || typeof r[k] === 'boolean') out[k] = r[k];
      else if (typeof r[k] === 'string') out[k] = clip(r[k], 60);
    }
    return out;
  } catch (_) { return { present: false }; }
}
const notificationStatus = {status:process.env.MONITOR_NOTIFICATIONS === 'off' ? 'disabled' : 'not_attempted', delivery:'unverified'};
const grokActivity = { status: 'starting' };
const usageStatus = {}; // per source: 'ok' | 'missing' | 'nodata' | 'error' | 'timeout'

function setUsage(source, windows) {
  const list = (Array.isArray(windows) ? windows : [])
    .filter(isRecord)
    .map((w) => {
      let r = Number(w.resetsAt);
      if (!isFinite(r) || r <= 0) r = null;
      else if (r > 1e12) r = Math.round(r / 1000); // tolerate milliseconds
      // A missing percentage is "no data", not 0 % used (Number(null) === 0).
      const used = typeof w.usedPercent === 'number' || (typeof w.usedPercent === 'string' && w.usedPercent.trim()) ? Number(w.usedPercent) : NaN;
      return { label: clip(w.label, 20), usedPercent: used, resetsAt: r };
    })
    .filter((w) => isFinite(w.usedPercent))
    .map((w) => ({ ...w, usedPercent: Math.max(0, Math.min(100, w.usedPercent)) }))
    .slice(0, 8);
  if (!list.length || closing) return false;
  usage[source] = { windows: list, updatedAt: Date.now() };
  writeJson(USAGE_FILE, JSON.stringify(usage));
  return true;
}

// Codex: ask the local app-server for the account's rate-limit windows.
// The desktop app bundles Codex without necessarily adding it to the shell PATH.
// Prefer an explicit override, then the bundled macOS binary, and finally PATH.
const BUNDLED_CODEX_BIN = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const CODEX_BIN = process.env.CODEX_BIN || (fs.existsSync(BUNDLED_CODEX_BIN) ? BUNDLED_CODEX_BIN : 'codex');
const CODEX_POLL_MS = 5 * 60 * 1000;
let codexBusy = false;
let stopCodex = null; // ends the running app-server poll (used on shutdown)

function codexWindows(r) {
  const out = [];
  if (!r || typeof r !== 'object') return out;
  for (const k of ['primary', 'secondary']) {
    const w = r[k];
    if (!w) continue;
    const pct = w.usedPercent ?? w.used_percent;
    let mins = w.windowDurationMins ?? w.window_minutes ?? (w.limit_window_seconds ? w.limit_window_seconds / 60 : null);
    mins = mins == null ? null : Number(mins);
    const label = mins == null ? k : Math.abs(mins - 300) < 30 ? '5 小时' : Math.abs(mins - 10080) < 60 ? '每周' : Math.round(mins / 60) + ' 小时';
    out.push({ label, usedPercent: pct, resetsAt: w.resetsAt ?? w.resets_at ?? w.reset_at });
  }
  return out;
}

function pollCodex() {
  if (codexBusy || closing || process.env.CODEX_USAGE === 'off') return;
  codexBusy = true;
  let child = null, buf = '', done = false, step = 0;
  const finish = (status) => {
    if (done) return;
    done = true; clearTimeout(timer); codexBusy = false; stopCodex = null;
    try { child && child.kill(); } catch (_) {}
    if (status) usageStatus.codex = status;
  };
  const timer = setTimeout(() => finish('timeout'), 15000);
  stopCodex = () => finish(null);
  try { child = spawn(CODEX_BIN, ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'ignore'] }); }
  catch (_) { return finish('missing'); }
  child.on('error', () => finish('missing'));
  child.on('exit', () => finish(step < 2 ? 'error' : null));
  // An app-server that exits early makes stdin emit EPIPE asynchronously; unhandled, that
  // 'error' event would terminate the whole monitor.
  child.stdin.on('error', () => {});
  const write = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch (_) {} };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    if (done) return;
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch (_) { continue; }
      if (!isRecord(m)) continue;
      if (m.id === 0 && step === 0) {
        step = 1;
        write({ method: 'initialized' });
        write({ method: 'account/rateLimits/read', id: 1 });
      } else if (m.id === 1) {
        step = 2;
        if (m.error) return finish('error');
        const r = m.result && (m.result.rateLimits || m.result);
        if (setUsage('codex', codexWindows(r))) finish('ok'); else finish('nodata');
      }
    }
    if (buf.length > 1024 * 1024) finish('error'); // unterminated output; don't grow without bound
  });
  write({ method: 'initialize', id: 0, params: { clientInfo: { name: 'agent-monitor', title: 'Agent Monitor', version: '1.0' } } });
}

let saveTimer = null, stateDirty = false;
function writeState() {
  clearTimeout(saveTimer); saveTimer = null; stateDirty = false;
  // Approvals never survive a restart, so the requested command (which can contain
  // secrets) is not written to disk; the marker is kept for the restart message.
  writeJson(DATA_FILE, JSON.stringify(sessions,
    (k, v) => k === 'approval' && isRecord(v) ? { aid: v.aid, tool: v.tool, expiresAt: v.expiresAt } : v));
}
function save() {
  stateDirty = true;
  clearTimeout(saveTimer);
  // While shutting down, the final flush writes the latest state once.
  saveTimer = closing ? null : setTimeout(writeState, 200);
}

function clip(s, n = 160) {
  s = String(s || '').replace(/[ \t]+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Resolves to a plain object, or to an { error } marker for an oversized, malformed or
// non-object body (null, arrays, strings...). An empty body is an empty object.
const MAX_BODY = 1e6;
function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { resolve({ error: 413 }); req.pause(); return; }
      chunks.push(c);
    });
    // Decode once at the end so multi-byte characters split across chunks stay intact.
    req.on('end', () => {
      if (size > MAX_BODY) return;
      const text = Buffer.concat(chunks).toString('utf8');
      let body;
      try { body = text.trim() ? JSON.parse(text) : {}; } catch (_) { return resolve({ error: 400 }); }
      resolve(isRecord(body) ? { body } : { error: 400 });
    });
    req.on('error', () => resolve({ error: 400 }));
    req.on('close', () => resolve({ error: 400 })); // no-op if already resolved
  });
}

function sendBodyError(res, code) {
  // Oversized bodies are not drained; close the connection after answering.
  if (code === 413) res.setHeader('Connection', 'close');
  send(res, code, { ok: false, error: code === 413 ? 'body too large' : 'invalid JSON object' });
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function isLoopback(req) {
  const a = req.socket.remoteAddress;
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function keyOk(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Review is a daily display window, not deletion or an approval decision.
// Calendar arithmetic keeps 06:00 in Mac local time across daylight-saving changes.
function reviewWindow(now = Date.now()) {
  const start = new Date(now);
  start.setHours(6, 0, 0, 0);
  if (start.getTime() > now) start.setDate(start.getDate() - 1);
  const next = new Date(start);
  next.setDate(next.getDate() + 1);
  return { start: start.getTime(), nextReset: next.getTime(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

function prune() {
  const now = Date.now();
  let changed = false;
  for (const [id, s] of Object.entries(sessions)) {
    const age = now - s.updatedAt;
    if (s.status === 'done' && age > DONE_RETENTION_MS) {
      delete sessions[id];
      changed = true;
    } else if (s.status === 'running' && s.stateSource !== 'chat-observer' && age > RUNNING_STALE_MS) {
      s.status = 'unobserved';
      s.message = 'No recent activity · status unknown';
      delete s.completionReason;
      changed = true;
    }
  }
  if (changed) save();
}

// Answer a held /ask request. decision: allow | deny | none (= let the Mac prompt handle it)
function resolvePending(aid, decision) {
  const p = pending[aid];
  if (!p) return null;
  clearTimeout(p.timer);
  delete pending[aid];
  p.delivered = false; // the hook may already have gone away (timed out or killed)
  if (!p.res.writableEnded && !p.res.destroyed && p.res.socket && !p.res.socket.destroyed) {
    // An approve/deny carries this request's private receipt secret, only ever sent to
    // the hook connection that asked. "none" needs no receipt: the hook prints nothing.
    const reply = p.secret && decision !== 'none' ? { decision, aid, receipt: p.secret } : { decision };
    try {
      p.res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      p.res.end(JSON.stringify(reply));
      p.delivered = true;
    } catch (_) {}
  }
  return p;
}

function requestsFor(id) { return Object.values(pending).filter(p => p.id === id); }
function publicSessions() {
  return Object.values(sessions).flatMap(s => {
    const queue = requestsFor(s.id);
    return queue.length ? queue.map(p => ({ ...s, id: s.id + ':approval:' + p.approval.aid,
      parentSessionId: s.id, approval: p.approval, message: p.description, updatedAt: p.createdAt })) : [s];
  });
}
function notifyAttention(source, approval = false) {
  if (process.platform !== 'darwin' || process.env.MONITOR_NOTIFICATIONS === 'off') return;
  const name = {codex:'Codex',claude:'Claude',cursor:'Cursor',grok:'Grok',doctor:'Notification test'}[source] || 'Agent';
  notificationStatus.status = 'sending';
  notificationStatus.lastAttemptAt = Date.now();
  // Fixed AppleScript, arguments as data. Never expose commands or access keys in notifications.
  execFile('/usr/bin/osascript', ['-e', 'on run argv\ndisplay notification (item 1 of argv) with title "Agent Monitor" subtitle (item 2 of argv) sound name "Glass"\nend run',
    approval ? `Review the request in your Dashboard within ${WAIT_SEC} seconds.` : 'Open your Dashboard to see what needs your attention.', name + (approval ? ' needs approval' : ' needs your attention')],
    {timeout:3000}, error => {notificationStatus.status = error ? 'error' : 'submitted';});
}
// Returns false when nothing was delivered, otherwise how the decision was delivered:
//   'released'    "none" reached the hook; the agent app's own prompt takes over
//   'awaiting'    approve/deny written to a hook that will confirm receipt (see settleReceipt)
//   'unsupported' approve/deny written to a legacy hook that cannot confirm receipt
// Writing to the socket alone never counts as confirmed, and nothing here can prove
// that the agent actually ran the tool.
const RECEIPT_MESSAGES = {
  awaiting: 'Dashboard decision sent · waiting for the hook to confirm receipt.',
  unconfirmed: 'Dashboard decision sent · the hook did not confirm receipt. Check the agent app.',
  unsupported: 'Dashboard decision sent · this hook cannot confirm receipt. Check the agent app.',
};
function decide(aid, decision) {
  if (typeof aid !== 'string' || !pending[aid]) return false;
  // A request past its deadline is released to the agent app, never approved late
  // (timers can fire late after the Mac sleeps or the event loop is busy).
  const expired = decision !== 'none' && Date.now() >= pending[aid].approval.expiresAt;
  const p = resolvePending(aid, expired ? 'none' : decision);
  if (expired) decision = 'none';
  // An answer nobody received did not unblock the agent.
  else if (!p.delivered) decision = 'none';
  const delivery = decision === 'none' ? 'released' : p.secret ? 'awaiting' : 'unsupported';
  if (delivery === 'awaiting') {
    receipts[aid] = { secret: p.secret, id: p.id, decision, expiresAt: Date.now() + ACK_WAIT_MS, waiters: [], timer: setTimeout(() => settleReceipt(aid, false), ACK_WAIT_MS) };
  }
  const s = sessions[p.id];
  if (s) {
    const next = requestsFor(p.id)[0];
    delete s.delivery;
    if (next) { s.approval = next.approval; s.status = 'needs_action'; s.message = next.description; }
    else if (decision === 'none') {
      delete s.approval;
      s.status = 'needs_action';
      s.message = 'Dashboard approval ended. Confirm this request in the agent app.';
    } else {
      // Sent but not confirmed: the outcome is unknown until the hook's receipt arrives.
      delete s.approval;
      s.status = 'unobserved';
      s.message = RECEIPT_MESSAGES[delivery];
      s.delivery = { aid, decision, state: delivery };
    }
    s.updatedAt = Date.now();
    save();
  }
  // Only report success to the Dashboard when the decision really reached the waiting hook.
  return !expired && p.delivered ? delivery : false;
}

// Ends the wait for a hook's receipt exactly once: confirmed by a matching /ack, or
// unconfirmed when the wait runs out. A newer event (which replaces the record and its
// delivery marker) or another queued request is never overwritten by a late receipt.
function settleReceipt(aid, confirmed) {
  const r = receipts[aid];
  if (!r) return false;
  clearTimeout(r.timer);
  delete receipts[aid];
  const s = sessions[r.id];
  if (s && isRecord(s.delivery) && s.delivery.aid === aid && s.delivery.state === 'awaiting' && !requestsFor(r.id).length) {
    s.delivery = { ...s.delivery, state: confirmed ? 'confirmed' : 'unconfirmed' };
    if (confirmed) { s.status = 'running'; s.message = ''; }
    else s.message = RECEIPT_MESSAGES.unconfirmed;
    s.updatedAt = Date.now();
    save();
  }
  for (const resolve of r.waiters) resolve(confirmed ? 'confirmed' : 'unconfirmed');
  return true;
}
function receiptOutcome(aid) {
  const r = receipts[aid];
  return r ? new Promise((resolve) => r.waiters.push(resolve)) : Promise.resolve('unconfirmed');
}
// 200 confirmed; 403 wrong secret or decision (the receipt stays open for the real hook);
// 410 unknown, already confirmed or expired.
function acknowledge(aid, secret, decision) {
  const r = typeof aid === 'string' ? receipts[aid] : undefined;
  if (!r) return 410;
  if (Date.now() >= r.expiresAt) { settleReceipt(aid, false); return 410; }
  const a = Buffer.from(typeof secret === 'string' ? secret : ''), b = Buffer.from(r.secret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b) || decision !== r.decision) return 403;
  settleReceipt(aid, true);
  return 200;
}

function applyEvent(e) {
  const source = clip(e.source || 'unknown', 30);
  const session = clip(e.session || 'default', 100);
  const id = `${source}:${session}`;
  const prev = sessions[id];
  const now = Date.now();
  let status = e.status;

  // Parallel tools can finish while another tool is waiting for the user.
  // Activity is not an approval decision; keep every live request until answered or expired.
  if (requestsFor(id).length && (status === 'resume' || status === 'running')) return id;

  if (status === 'resume') {
    if (prev && ['needs_action', 'unobserved'].includes(prev.status)) status = 'running';
    else if (prev && prev.status === 'running') {
      prev.updatedAt = now;
      prev.message = '';
      save();
      return id;
    } else return id;
  }
  if (!STATUSES.includes(status)) return null;

  if (status === 'needs_action' && prev && prev.status === 'done' &&
      /waiting for your input/i.test(e.message || '')) return id;

  // The agent moved on (answered on the Mac, finished, ...): release any held approval.
  if (status === 'done') for (const p of requestsFor(id)) resolvePending(p.approval.aid, 'none');

  const startsNewTask = status === 'running' && (!prev || prev.status === 'done');
  const rec = {
    id,
    source,
    project: clip(e.project || (prev && prev.project) || '', 60),
    title: e.title ? clip(e.title, 140) : (prev && prev.title) || '',
    message: ['needs_action','unobserved'].includes(status) ? clip(e.message || '', 200) : '',
    status,
    startedAt: startsNewTask ? now : (prev && prev.startedAt) || now,
    updatedAt: now,
  };
  if(e.progress) rec.progress=e.progress;
  else if(prev?.progress && !startsNewTask) rec.progress=prev.progress;
  for (const field of ['stateSource','taskKind','observationKey']) if(e[field] || prev?.[field]) rec[field] = clip(e[field] || prev[field], 80);
  if (status === 'done') rec.completionReason = clip(e.reason || 'hook', 40);
  if (status === 'needs_action' && prev && prev.approval) rec.approval = prev.approval;
  sessions[id] = rec;
  if (status === 'needs_action' && prev?.status !== 'needs_action') notifyAttention(source, false);
  save();
  return id;
}

// A failure while handling one request must never take down the monitor (and with it
// every held approval): answer 500 instead of leaving an unhandled rejection.
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(() => {
    if (!res.headersSent) { try { send(res, 500, { ok: false, error: 'internal error' }); } catch (_) {} }
    else res.destroy();
  });
});

async function handleRequest(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const url = u.pathname;

  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    fs.readFile(path.join(__dirname, 'index.html'), (err, buf) => {
      if (err) { res.writeHead(500); return res.end('index.html missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
    return;
  }

  if (req.method === 'GET' && url === '/favicon.png') {
    fs.readFile(path.join(__dirname, 'favicon.png'), (err, buf) => {
      if (err) { res.writeHead(404); return res.end('favicon missing'); }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      res.end(buf);
    });
    return;
  }

  if (!keyOk(req.headers['x-key'] || u.searchParams.get('key'))) return send(res, 401, { error: 'unauthorized' });

  if (req.method === 'GET' && url === '/state') {
    if (!closing) prune();
    return send(res, 200, { now: Date.now(), waitSec: WAIT_SEC, sessions: publicSessions(), usage, usageStatus, chatTracking, notificationStatus,
      reports, hookConfig, notificationReader: notificationReaderStatus(), grokActivity, reviewWindow: reviewWindow() });
  }

  // Shutting down: no new mutations. Held approvals have already been released.
  if (closing && req.method === 'POST') {
    res.setHeader('Connection', 'close');
    return send(res, 503, { ok: false, error: 'shutting down' });
  }

  if (req.method === 'POST' && url === '/usage/claude/refresh') {
    if (process.env.CLAUDE_USAGE === 'off') return send(res, 409, { ok: false, status: 'disabled', error: 'Claude usage is turned off' });
    const r = await refreshClaude();
    if (r.status === 'too_soon') {
      const retryAfterSec = Math.ceil(r.retryAfterMs / 1000);
      res.setHeader('Retry-After', String(retryAfterSec));
      return send(res, 429, { ok: false, status: 'too_soon', retryAfterSec, lastAttemptAt: r.lastAttemptAt });
    }
    // The result of this attempt (possibly shared with concurrent callers), never an older one.
    return send(res, 200, { ok: r.status === 'ok', status: r.status, attemptedAt: r.attemptedAt });
  }

  if (req.method === 'POST' && url === '/chat-tracking/setup') {
    if (!isLoopback(req)) return send(res, 403, {error:'Enable chat tracking from this Dashboard on your Mac.'});
    const app = path.join(__dirname, 'ChatObserver.app');
    if (!fs.existsSync(app)) return send(res, 503, {error:'Chat observer is not installed.'});
    execFile('/usr/bin/open', [app, '--args', '--request-access'], {timeout:5000}, error => {
      send(res, error ? 500 : 200, {ok:!error});
    });
    return;
  }

  if (req.method === 'POST' && (url === '/event' || url === '/ask' || url === '/usage' || url === '/ack')) {
    if (!isLoopback(req)) return send(res, 403, { error: 'local only' });
    const { body: e, error } = await readJson(req);
    if (error) return sendBodyError(res, error);
    if (closing) return send(res, 503, { ok: false, error: 'shutting down' }); // began while reading

    // The hook confirms it received a decision and flushed it to the agent. This is
    // receipt only: it does not prove that the agent ran the tool.
    if (url === '/ack') {
      const code = acknowledge(e.aid, e.receipt, e.decision);
      return send(res, code, code === 200 ? { ok: true } : { ok: false, error: code === 403 ? 'receipt mismatch' : 'unknown or expired receipt' });
    }

    if (url === '/usage') {
      const source = e.source == null || e.source === '' ? 'claude' : e.source;
      if (typeof source !== 'string' || !/^[a-z0-9_-]{1,30}$/i.test(source)) return send(res, 400, { ok: false, error: 'bad source' });
      return setUsage(source, e.windows) ? send(res, 200, { ok: true }) : send(res, 400, { ok: false });
    }

    if (url === '/event') {
      delete e.progress;
      const id = applyEvent(e);
      if (id) noteReport(e.source, e.stateSource === 'macos-notification' ? 'notification' : e.reason === 'watcher' ? 'log' : 'hook');
      return id ? send(res, 200, { ok: true, id }) : send(res, 400, { ok: false, error: 'bad status' });
    }

    // /ask: hold the request open until the iPad answers, the wait runs out, or the agent goes away.
    // The Dashboard must show exactly what would be approved: no coerced "[object Object]".
    for (const k of ['command', 'tool', 'description']) {
      if (e[k] !== undefined && e[k] !== null && typeof e[k] !== 'string') return send(res, 400, { ok: false, error: 'bad ' + k });
    }
    const source = clip(e.source || 'unknown', 30);
    const session = clip(e.session || 'default', 100);
    const id = `${source}:${session}`;
    const prev = sessions[id];
    const now = Date.now();
    const aid = crypto.randomBytes(8).toString('hex');
    noteReport(source, 'hook');
    sessions[id] = {
      id, source,
      project: clip(e.project || (prev && prev.project) || '', 60),
      title: (prev && prev.title) || '',
      message: clip(e.description || '', 200),
      status: 'needs_action',
      startedAt: (prev && prev.startedAt) || now,
      updatedAt: now,
      approval: { aid, tool: clip(e.tool || '', 100), command: String(e.command || ''), expiresAt: now + WAIT_SEC * 1000 },
    };
    const timer = setTimeout(() => decide(aid, 'none'), WAIT_SEC * 1000);
    // Hooks that can confirm receipt say so with ack: 1. The secret binds that receipt to
    // this request; it lives only here (never in /state, state.json or logs).
    const secret = e.ack === 1 ? crypto.randomBytes(16).toString('hex') : null;
    pending[aid] = { res, id, timer, secret, approval: sessions[id].approval, description: sessions[id].message, createdAt: now };
    res.on('close', () => { if (pending[aid]) decide(aid, 'none'); });
    // The hook may have gone away while its body was being read; 'close' has then already
    // fired and would never release this request.
    if (res.destroyed || req.socket.destroyed) { decide(aid, 'none'); return; }
    notifyAttention(source, true);
    save();
    return;
  }

  if (req.method === 'POST' && url === '/decide') {
    const { body, error } = await readJson(req);
    if (error) return sendBodyError(res, error);
    if (closing) return send(res, 503, { ok: false, error: 'shutting down' });
    const { aid, decision } = body;
    const d = decision === 'mac' ? 'none' : decision;
    if (typeof aid !== 'string' || !['allow', 'deny', 'none'].includes(d)) return send(res, 400, { ok: false });
    const delivery = decide(aid, d);
    if (!delivery) return send(res, 410, { ok: false, error: 'expired' });
    // delivery: confirmed | unconfirmed | unsupported | released. Only "confirmed" means
    // the hook acknowledged receipt; the others must never be shown as confirmed.
    const outcome = delivery === 'awaiting' ? await receiptOutcome(aid) : delivery;
    // Older open dashboards inspect only ok. Never let them claim an unconfirmed
    // decision succeeded; the new page uses delivery to show the terminal warning.
    return send(res, 200, { ok: outcome === 'confirmed' || outcome === 'released', delivery: outcome });
  }

  if (req.method === 'POST' && url === '/dismiss') {
    const { body, error } = await readJson(req);
    if (error) return sendBodyError(res, error);
    if (closing) return send(res, 503, { ok: false, error: 'shutting down' });
    const { id, allDone } = body;
    if ((id !== undefined && typeof id !== 'string') || (allDone !== undefined && typeof allDone !== 'boolean')) return send(res, 400, { ok: false });
    if (allDone) {
      for (const [k, s] of Object.entries(sessions)) if (s.status === 'done') delete sessions[k];
    } else if (id) {
      const s = sessions[id];
      for (const p of requestsFor(id)) resolvePending(p.approval.aid, 'none');
      delete sessions[id];
    }
    save();
    return send(res, 200, { ok: true });
  }

  res.writeHead(404); res.end('not found');
}

// Hooks are fast but can be absent in an already-open desktop session.
// Reconcile lifecycle records without changing pending approval decisions.
const { createCodexWatcher, reconciliation } = require('./codex-watch');
const scanCodex = createCodexWatcher({
  root: process.env.CODEX_SESSIONS_DIR,
  onSnapshot: snapshot => {
    if (closing) return; // an asynchronous scan may finish during the final save
    const event = reconciliation(snapshot, sessions[`codex:${snapshot.id}`]);
    if(event){
      const id=applyEvent(event);
      if(id) noteReport('codex','local-log');
      if(id && !requestsFor(id).length){
        sessions[id].updatedAt=event.observedAt;
        if(event.startedAt)sessions[id].startedAt=event.startedAt;
        sessions[id].stateSource='local-lifecycle';save();
      }
    }
    const rec=sessions[`codex:${snapshot.id}`],progress=snapshot.progress;
    // Hooks can arrive after the corresponding local record. Merge progress without
    // overwriting a newer status, timestamp or pending approval.
    if(rec && !snapshot.excluded && progress && snapshot.startedAt >= (rec.startedAt||0)-5000 &&
       (!rec.progress || progress.observedAt>rec.progress.observedAt)) {rec.progress={...progress};save();}
  },
});
after(scanCodex, 500);
every(scanCodex, 2000);

const { createChatWatcher } = require('./chat-watch');
const scanChats = createChatWatcher({
  seed: Object.values(sessions),
  onEvent: event => { if (!closing) applyEvent(event); },
  onHealth: health => Object.assign(chatTracking, health),
});
if (CHAT_WATCH_ON) {
  after(scanChats, 750);
  every(scanChats, 4000);
}

const { createCursorPoller } = require('./cursor-usage');
const pollCursor = createCursorPoller({
  onUsage: windows => setUsage('cursor', windows),
  onStatus: status => { usageStatus.cursor = status; },
});
after(pollCursor, 1000);
every(pollCursor, 5 * 60 * 1000);

const { createGrokWatcher } = require('./grok-watch');
const stopGrokWatch = createGrokWatcher({
  seed: Object.values(sessions),
  onEvent: event => { if (!closing) applyEvent(event); },
  onHealth: health => {
    Object.assign(grokActivity, health);
    if (health.status === 'connected' && health.lastReportAt) noteReport('grok', 'stream');
  },
});

const { createGrokPoller } = require('./grok-usage');
const pollGrok = createGrokPoller({
  onUsage: windows => setUsage('grok', windows),
  onStatus: status => { usageStatus.grok = status; },
});
after(pollGrok, 2500);
every(pollGrok, 5 * 60 * 1000);

// One Claude usage attempt at a time, and at most one attempt per minimum interval
// (failed attempts count). Concurrent callers share the in-flight attempt and get its
// own result; callers inside the interval get { status: 'too_soon', retryAfterMs }
// without any credential or network work.
function createRefreshGate(run, minIntervalMs, now = Date.now) {
  let inFlight = null, lastAttemptAt = null;
  return function refresh() {
    if (inFlight) return inFlight;
    const wait = lastAttemptAt + minIntervalMs - now();
    if (lastAttemptAt !== null && wait > 0) return Promise.resolve({ status: 'too_soon', retryAfterMs: wait, lastAttemptAt });
    const attemptedAt = lastAttemptAt = now();
    inFlight = Promise.resolve().then(run)
      .then((status) => ({ status: status || 'error', attemptedAt }), () => ({ status: 'error', attemptedAt }))
      .finally(() => { inFlight = null; });
    return inFlight;
  };
}

const { createClaudePoller } = require('./claude-usage');
let claudeAttemptStatus = null; // status reported by the current attempt only
const pollClaude = createClaudePoller({
  onUsage: windows => setUsage('claude', windows),
  onStatus: status => { usageStatus.claude = status; claudeAttemptStatus = status; },
});
const refreshClaude = createRefreshGate(async () => {
  claudeAttemptStatus = null;
  await pollClaude();
  return claudeAttemptStatus;
}, CLAUDE_REFRESH_MIN_MS);
// Scheduled polls go through the same gate; a recent manual refresh simply skips one.
const scheduledClaude = () => { if (process.env.CLAUDE_USAGE !== 'off' && !closing) refreshClaude(); };
after(scheduledClaude, 2000);
every(scheduledClaude, 5 * 60 * 1000);

after(pollCodex, 1500);
every(pollCodex, CODEX_POLL_MS);

// Graceful stop on SIGTERM/SIGINT: refuse new mutations, release held approvals to the
// agent app (never approve them), stop background work, then write the latest state
// through the normal per-file queues and exit within SHUTDOWN_MS. This does not protect
// against SIGKILL, crashes or power loss.
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n${signal} received; saving and stopping.`);
  const deadline = setTimeout(() => {
    console.error('Shutdown timed out before saving finished; latest changes may be lost.');
    process.exit(1);
  }, SHUTDOWN_MS);
  for (const t of background) clearInterval(t);
  try { stopGrokWatch(); } catch (_) {}
  if (stopCodex) stopCodex();
  server.close();
  if (server.closeIdleConnections) server.closeIdleConnections();

  // Held hooks get "none" (the normal prompt appears on the Mac). Their sessions keep the
  // approval marker, so the next start shows "Dashboard restarted. Confirm ... in the agent app."
  const replies = [];
  for (const aid of Object.keys(pending)) {
    const p = resolvePending(aid, 'none');
    if (p && p.delivered && !p.res.writableFinished) replies.push(new Promise((r) => { p.res.once('finish', r); p.res.once('close', r); }));
  }
  // Decisions already sent stay unconfirmed: their receipt can no longer arrive.
  for (const aid of Object.keys(receipts)) settleReceipt(aid, false);

  if (stateDirty || saveTimer) writeState();
  if (reportsTimer) { clearTimeout(reportsTimer); writeReports(); }
  Promise.all([drainWrites(), ...replies]).then(([failed]) => {
    clearTimeout(deadline);
    if (failed.length) console.error(`Stopped, but could not save ${failed.join(', ')}; the previous copy is kept.`);
    process.exit(failed.length ? 1 : 0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, '0.0.0.0', () => {
  console.log('\nAgent Monitor is running.\n');
  console.log(`  On this Mac:  http://localhost:${PORT}/?key=${TOKEN}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) console.log(`  On your iPad: http://${i.address}:${PORT}/?key=${TOKEN}`);
    }
  }
  console.log('\nOpen the iPad link once; the key is remembered. Keep the key private: it can approve commands.');
  console.log(`Approvals wait ${WAIT_SEC}s for the iPad, then fall back to the normal prompt on the Mac.\n`);
});
