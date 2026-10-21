// Recover missed Codex hooks from local lifecycle records. No messages or tool
// arguments are persisted or forwarded; progress uses only tool types and counts; subagents are not separate dashboard tasks.
const fs = require('fs');
const path = require('path');
const os = require('os');
const RECENT_MS = 30 * 60 * 1000;
const RECORD_TYPE = /"type"\s*:\s*"(session_meta|event_msg)"/;

function consume(record, state) {
  const p = record.payload || {};
  if (record.type === 'session_meta') {
    state.id = p.id;
    state.project = path.basename(p.cwd || '');
    state.excluded = typeof p.source !== 'string';
    return;
  }
  if (record.type !== 'event_msg') return;
  const at = Date.parse(record.timestamp);
  if (!Number.isFinite(at)) return;
  if (p.type === 'task_started') {
    state.turn = p.turn_id;
    state.status = 'running';
    state.startedAt = at;
    state.observedAt = at;
    state.completedItems = new Set();
    state.progress = {turnId:p.turn_id,startedAt:at,observedAt:at,completedActions:0,lastActivity:'Started',source:'local-events'};
  } else if (['task_complete', 'turn_aborted'].includes(p.type)) {
    if (p.turn_id && state.turn && p.turn_id !== state.turn) return;
    state.status = 'done';
    state.observedAt = at;
  } else if (state.status === 'running' && p.type === 'item_completed') {
    if (p.turn_id && state.turn && p.turn_id !== state.turn) return;
    state.observedAt = at;
    // Do not read messages, reasoning, commands, arguments or tool results.
    const item=p.item||{},labels={CommandExecution:'Command finished',FileChange:'Files updated',McpToolCall:'Tool step finished',WebSearch:'Search finished',ImageView:'Image reviewed'};
    if(labels[item.type] && item.id && state.progress && !state.completedItems.has(item.id)) {
      state.completedItems.add(item.id);
      state.progress={...state.progress,observedAt:at,completedActions:state.progress.completedActions+1,lastActivity:labels[item.type]};
    }
  }
}

function reconciliation(snapshot, previous, now = Date.now()) {
  if (!snapshot.id || snapshot.excluded || !snapshot.status) return null;
  if (snapshot.status === 'running') {
    if (now - snapshot.observedAt > RECENT_MS) return null;
    // A real pending approval takes priority over activity observed before it.
    if (previous?.approval) return null;
  } else if (!previous) return null; // Never import a backlog of completed chats.
  if (previous && snapshot.observedAt <= previous.updatedAt) return null;
  return {
    source: 'codex', session: snapshot.id, project: snapshot.project,
    status: snapshot.status, reason: 'local-lifecycle',
    observedAt: snapshot.observedAt, startedAt: snapshot.startedAt, progress:snapshot.progress,
  };
}

function createCodexWatcher({ onSnapshot, root = path.join(os.homedir(), '.codex', 'sessions') }) {
  const files = new Map();
  let busy = false;
  async function paths(dir, out = []) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { return out; }
    for (const e of entries) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) await paths(file, out);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(file);
    }
    return out;
  }
  return async function scan() {
    if (busy || process.env.CODEX_WATCH === 'off') return;
    busy = true;
    try {
      for (const file of await paths(root)) {
        try {
          const stat = await fs.promises.stat(file);
          let state = files.get(file);
          // Inspect old chat files too when they receive new activity.
          if (!state && Date.now() - stat.mtimeMs > 24 * 3600e3) continue;
          if (!state || stat.size < state.offset || stat.ino !== state.ino) {
            state = { offset: 0, carry: '', ino: stat.ino }; files.set(file, state);
          }
          if (state.excluded || stat.size === state.offset) continue;
          const stream = fs.createReadStream(file, { start: state.offset, end: stat.size - 1, encoding: 'utf8' });
          for await (const chunk of stream) {
            state.carry += chunk;
            // Walk the buffer by index and trim once per chunk (slicing per line copies the rest each time).
            let start = 0, end;
            while ((end = state.carry.indexOf('\n', start)) !== -1) {
              const line = state.carry.slice(start, end); start = end + 1;
              if (state.dropping) { state.dropping = false; continue; }
              if (!RECORD_TYPE.test(line.slice(0, 160))) continue;
              try { consume(JSON.parse(line), state); } catch (_) {}
            }
            state.carry = state.carry.slice(start);
            if (state.excluded) break;
            // Large tool-output records are irrelevant; cap the tail held in memory.
            if (state.carry.length > 2 * 1024 * 1024) { state.carry = ''; state.dropping = true; }
          }
          state.offset = stat.size;
          if (!state.excluded && state.id) onSnapshot(state);
        } catch (_) { /* A rotated, partial or inaccessible log must not stop polling. */ }
      }
    } finally { busy = false; }
  };
}
module.exports = { consume, reconciliation, createCodexWatcher };
