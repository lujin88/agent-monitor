const fs = require('fs'), vm = require('vm'), assert = require('assert');
process.env.TZ = 'Europe/Zurich';
const server = fs.readFileSync(__dirname + '/server.js', 'utf8');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const c = vm.createContext({ Date, Intl, Number });
function extract(text, name) {
  const a = text.indexOf('function ' + name + '(');
  assert(a >= 0);
  const b = text.indexOf('\nfunction ', a + 1);
  return text.slice(a, b);
}
vm.runInContext(extract(server, 'reviewWindow'), c);
vm.runInContext(extract(html, 'reviewSessions'), c);
const at = value => new Date(value).getTime();
for (const [now, start, end] of [
  ['2026-10-04T05:59:59+02:00','2026-10-03T06:00:00+02:00','2026-10-04T06:00:00+02:00'],
  ['2026-10-04T06:00:00+02:00','2026-10-04T06:00:00+02:00','2026-10-05T06:00:00+02:00'],
  ['2026-10-07T13:00:00+02:00','2026-10-07T06:00:00+02:00','2026-10-08T06:00:00+02:00'],
  ['2026-03-28T12:00:00+01:00','2026-03-28T06:00:00+01:00','2026-03-29T06:00:00+02:00'],
  ['2026-10-24T12:00:00+02:00','2026-10-24T06:00:00+02:00','2026-10-25T06:00:00+01:00'],
]) {
  const w = c.reviewWindow(at(now));
  assert.equal(w.start, at(start)); assert.equal(w.nextReset, at(end));
  assert.equal(w.timeZone, 'Europe/Zurich');
}
const reviewWindow = c.reviewWindow(at('2026-10-04T12:00:00+02:00'));
const records = [
  {id:'old',status:'done',updatedAt:reviewWindow.start-1},
  {id:'new',status:'done',updatedAt:reviewWindow.start},
  {id:'running',status:'running',updatedAt:reviewWindow.start-1000},
  {id:'approval',status:'needs_action',updatedAt:reviewWindow.start-1000,approval:{aid:'test'}},
];
const before = JSON.stringify(records);
assert.deepEqual(Array.from(c.reviewSessions({reviewWindow},records),s=>s.id),['new']);
assert.equal(JSON.stringify(records),before,'Filtering must not mutate tasks or approvals');
assert.equal(c.reviewSessions({},records).length,2,'Older servers remain compatible');
process.env.TZ = 'America/Los_Angeles';
assert.deepEqual(Array.from(c.reviewSessions({reviewWindow},records),s=>s.id),['new'],'iPad timezone cannot override the server cutoff');
assert(html.includes('ready=reviewSessions(d,all).sort(sort)'),'Counts and pages share the filtered list');
assert(html.includes('if(latest?.reviewWindow?.start!==d.reviewWindow?.start)pageIndex.ready=0;'));
for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
console.log('Daily review passed: 06:00 boundary, sleep catch-up, DST, client timezone, approvals preserved, pagination reset, script syntax.');
