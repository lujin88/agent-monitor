#!/usr/bin/env node
// Fallback monitor for Claude Code sessions.
// It only observes JSONL file metadata and extracts newly appended user text.

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(require('os').homedir(), '.claude', 'projects');
// Claude Code names project folders after the absolute path with separators replaced by '-'.
const HOME_MARKER = require('os').homedir().replace(/[^a-zA-Z0-9]/g, '-') + '-';
const MONITOR = new URL(process.env.MONITOR_URL || 'http://127.0.0.1:7777');
const TOKEN_FILE = path.join(__dirname, 'token.txt');
const POLL_MS = 2000;
const HOOK_GRACE_MS = 3000;
const IDLE_MS = 45000;

let token = '';
try { token = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (_) {}

const files = new Map();
const owned = new Set();
const timers = new Map();
let seeded = false;

function listJsonl(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listJsonl(full, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

function sessionOf(file) { return path.basename(file, '.jsonl'); }

function projectOf(file) {
  const encoded = path.basename(path.dirname(file));
  const marker = HOME_MARKER;
  return encoded.startsWith(marker) ? encoded.slice(marker.length) || 'Claude Code' : 'Claude Code';
}

function userText(record) {
  const isUser = record && (record.type === 'user' || record.message?.role === 'user');
  if (!isUser) return '';
  const content = record.message?.content ?? record.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    return part?.type === 'text' && typeof part.text === 'string' ? part.text : '';
  }).filter(Boolean).join(' ').trim();
}

function titleFrom(chunk) {
  let latest = '';
  for (const line of chunk.split('\n')) {
    if (!line.trim()) continue;
    try {
      const text = userText(JSON.parse(line));
      if (text) latest = text;
    } catch (_) {}
  }
  return latest.replace(/\s+/g, ' ').slice(0, 140);
}

function request(method, endpoint, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({
      hostname: MONITOR.hostname,
      port: MONITOR.port,
      path: endpoint,
      method,
      timeout: 1200,
      headers: {
        'x-key': token,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (part) => { raw += part; });
      res.on('end', () => {
        try { resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, data: JSON.parse(raw || '{}') }); }
        catch (_) { resolve({ ok: false, data: {} }); }
      });
    });
    req.on('error', () => resolve({ ok: false, data: {} }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, data: {} }); });
    req.end(data);
  });
}

async function current(session) {
  const result = await request('GET', '/state');
  return result.data?.sessions?.find((item) => item.id === `claude:${session}`);
}

function post(session, project, status, title, reason) {
  return request('POST', '/event', { source: 'claude', session, project, status, title, reason });
}

function finishLater(session, project) {
  clearTimeout(timers.get(session));
  timers.set(session, setTimeout(async () => {
    if (!owned.has(session)) return;
    const rec = await current(session);
    if (rec?.status === 'done') {
      owned.delete(session);
      return;
    }
    await post(session, project, 'unobserved', '', 'watcher-idle');
    owned.delete(session);
  }, IDLE_MS));
}

async function consider(file, title, changedAt) {
  const session = sessionOf(file);
  const project = projectOf(file);
  if (owned.has(session)) {
    await post(session, project, 'resume', '');
    finishLater(session, project);
    return;
  }
  if (!title) return;
  setTimeout(async () => {
    const rec = await current(session);
    // Give normal hooks priority. The watcher claims only sessions with no fresh hook event.
    if (rec && rec.updatedAt >= changedAt - 1000) return;
    const sent = await post(session, project, 'running', title, 'watcher');
    if (sent.ok) {
      owned.add(session);
      finishLater(session, project);
    }
  }, HOOK_GRACE_MS);
}

function scan() {
  const found = listJsonl(ROOT);
  for (const file of found) {
    let stat;
    try { stat = fs.statSync(file); } catch (_) { continue; }
    const prev = files.get(file);
    if (!prev) {
      files.set(file, { size: seeded ? 0 : stat.size, carry: '', mtimeMs: stat.mtimeMs });
      if (!seeded) continue;
    }
    const state = files.get(file);
    if (stat.size < state.size) { state.size = 0; state.carry = ''; }
    if (stat.size === state.size) continue;
    let chunk = '';
    try {
      const length = stat.size - state.size;
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, state.size);
      fs.closeSync(fd);
      chunk = state.carry + buf.toString('utf8');
    } catch (_) { continue; }
    const cut = chunk.lastIndexOf('\n');
    const complete = cut >= 0 ? chunk.slice(0, cut + 1) : '';
    state.carry = cut >= 0 ? chunk.slice(cut + 1) : chunk;
    state.size = stat.size;
    state.mtimeMs = stat.mtimeMs;
    consider(file, titleFrom(complete), stat.mtimeMs);
  }
  seeded = true;
}

scan();
setInterval(scan, POLL_MS);
console.log('Claude watcher running (metadata + newly appended user input only).');
