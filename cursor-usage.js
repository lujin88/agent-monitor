// Read the same usage endpoint as Cursor's Plan & Usage screen.
// Credentials stay in memory and are sent only to Cursor's fixed HTTPS endpoint.
const https = require('https');
const fs = require('fs');
const { pathToFileURL } = require('url');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

async function readAccessToken() {
  const db = path.join(os.homedir(), 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
  const unavailable = () => Object.assign(new Error('Cursor login unavailable'), { status: 'missing' });
  const query = target => new Promise((resolve, reject) => {
    execFile('/usr/bin/sqlite3', ['-readonly', target,
      "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken' LIMIT 1;"],
    { timeout: 3000, maxBuffer: 16384 }, (error, stdout) => {
      if (error || !stdout.trim()) return reject(unavailable());
      resolve(stdout.trim());
    });
  });
  try { return await query(db); } catch (_) {}
  // A closed WAL-mode DB can require creating sidecars even for a read-only query.
  // Never ignore an existing WAL/journal or use a database changing during the read.
  const hasJournal = () => ['-wal', '-journal'].some(s => fs.existsSync(db + s));
  try {
    if (hasJournal()) throw unavailable();
    const before = fs.statSync(db);
    const uri = pathToFileURL(db); uri.search = 'mode=ro&immutable=1';
    const token = await query(uri.href);
    const after = fs.statSync(db);
    if (hasJournal() || before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw unavailable();
    return token;
  } catch (_) { throw unavailable(); }
}

async function readCursorUsage() {
  // Reread for each poll so Cursor's token refresh and account changes are respected.
  const token = await readAccessToken();
  return new Promise((resolve, reject) => {
    const fail = (status) => reject(Object.assign(new Error('Cursor usage unavailable'), { status }));
    const req = https.request('https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage', {
      method: 'POST', headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1', 'Content-Length': 2,
      },
    }, (res) => {
      // Do not follow redirects with credentials or log response bodies.
      if (res.statusCode !== 200) {
        res.resume();
        return fail([401, 403].includes(res.statusCode) ? 'missing' : 'error');
      }
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (part) => {
        raw += part;
        if (raw.length > 1e6) req.destroy(new Error('Response too large'));
      });
      res.on('error', () => fail('error'));
      res.on('end', () => {
        try { resolve(cursorWindows(JSON.parse(raw))); } catch (_) { fail('error'); }
      });
    });
    const timer = setTimeout(() => { fail('timeout'); req.destroy(); }, 15000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', () => fail('error'));
    req.end('{}');
  });
}

function cursorWindows(data) {
  const p = data?.planUsage;
  if (!p || data.enabled === false) return [];
  let resetsAt = Number(data.billingCycleEnd);
  if (!Number.isFinite(resetsAt) || resetsAt <= 0) resetsAt = null;
  else if (resetsAt > 1e12) resetsAt = Math.round(resetsAt / 1000);
  const valid = (n) => typeof n === 'number' && Number.isFinite(n);
  const window = (label, n) => ({ label, usedPercent: Math.min(100, Math.max(0, n)), resetsAt });
  const split = [['Cursor models', p.autoPercentUsed], ['Other models', p.apiPercentUsed]]
    .filter(([, n]) => valid(n)).map(([label, n]) => window(label, n));
  if (split.length) return split;
  // Older accounts can expose only a single included-spend allowance.
  const total = p.limit > 0 && valid(p.includedSpend) ? p.includedSpend / p.limit * 100 : p.totalPercentUsed;
  return valid(total) ? [window('Monthly', total)] : [];
}

function createCursorPoller({ onUsage, onStatus, readUsage = readCursorUsage }) {
  let busy = false;
  return async function pollCursor() {
    if (busy || process.env.CURSOR_USAGE === 'off') return;
    busy = true;
    try {
      const windows = await readUsage();
      if (windows.length) { onUsage(windows); onStatus('ok'); }
      else onStatus('nodata');
    } catch (error) {
      onStatus(['missing', 'timeout'].includes(error.status) ? error.status : 'error');
    } finally { busy = false; }
  };
}

module.exports = { readAccessToken, cursorWindows, readCursorUsage, createCursorPoller };
