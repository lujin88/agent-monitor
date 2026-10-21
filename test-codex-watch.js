const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { consume, reconciliation, createCodexWatcher } = require('./codex-watch');
const now = Date.now();
const event = (type, at, turn = 'turn-1') => ({ type: 'event_msg', timestamp: new Date(at).toISOString(), payload: { type, turn_id: turn } });
const meta = (id, source = 'vscode') => ({ type: 'session_meta', payload: { id, source, cwd: '/tmp/project' } });
(async () => {
  const s = {}; consume(meta('real-task'), s);
  consume(event('task_started', now - 5000), s);
  consume(event('item_completed', now - 100), s);
  const previous = { status: 'done', updatedAt: now - 10000, title: 'Existing task' };
  assert.equal(reconciliation(s, previous, now).status, 'running', 'recover a missing start hook');
  assert.equal(reconciliation(s, {status:'needs_action', updatedAt:now-1000, approval:{aid:'pending'}}, now), null);
  assert.equal(reconciliation(s, {status:'needs_action', updatedAt:now}, now), null, 'old activity cannot clear a newer prompt');
  assert.equal(reconciliation(s, {status:'needs_action', updatedAt:now-1000}, now).status, 'running', 'fresh activity clears a stale prompt');
  consume(event('task_complete', now, 'old-turn'), s); assert.equal(s.status, 'running');
  consume(event('task_complete', now), s); assert.equal(reconciliation(s, previous, now).status, 'done');
  assert.equal(reconciliation(s, undefined, now), null, 'do not import old completed chats');
  const child = {}; consume(meta('guardian', {subagent:{other:'guardian'}}), child);
  consume(event('task_started', now), child); assert.equal(reconciliation(child, undefined, now), null);
  consume(event('task_started', now-3600000), s); assert.equal(reconciliation(s, previous, now), null, 'do not revive abandoned runs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-watch-test-'));
  try {
    const file = path.join(root, 'rollout.jsonl'), snapshots = [];
    const lines = [meta('file-task'), event('task_started', now)];
    fs.writeFileSync(file, lines.map(JSON.stringify).join('\n')+'\n');
    const scan = createCodexWatcher({ root, onSnapshot: s => snapshots.push({...s}) });
    await scan(); assert.equal(snapshots.at(-1).status, 'running', 'startup recovers existing running tasks');
    const count = snapshots.length; await scan(); assert.equal(snapshots.length, count, 'unchanged logs do not create synthetic activity');
    const end = JSON.stringify(event('task_complete', now+1000));
    fs.appendFileSync(file, end.slice(0,30)); await scan(); assert.equal(snapshots.at(-1).status, 'running');
    fs.appendFileSync(file, end.slice(30)+'\n'); await scan(); assert.equal(snapshots.at(-1).status, 'done', 'partial lines survive across polls');
    fs.writeFileSync(file, [meta('file-task'),event('task_started',now+2000,'turn-2')].map(JSON.stringify).join('\n')+'\n');
    await scan(); assert.equal(snapshots.at(-1).status, 'running', 'truncated files restart cleanly');
    console.log('Codex lifecycle recovery tests passed');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
})().catch(e => { console.error(e); process.exitCode=1; });
