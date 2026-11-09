// "Status unknown" records expire after the same retention as completed tasks.
const assert=require('assert'),fs=require('fs'),vm=require('vm');
const source=fs.readFileSync(process.argv[2]||require('path').join(__dirname,'server.js'),'utf8');
function extract(name,next){return source.slice(source.indexOf('function '+name+'('),source.indexOf(next,source.indexOf('function '+name+'(')))}
const now=Date.now(),day=86400000,RET=7*day;let saved=0;
const context={Date,reviewWindow(n){const d=new Date(n);d.setHours(6,0,0,0);if(d.getTime()>n)d.setDate(d.getDate()-1);return{start:d.getTime()}},RUNNING_STALE_MS:1800000,DONE_RETENTION_MS:RET,sessions:{
 'claude:old-unknown':{status:'unobserved',updatedAt:now-8*day},
 'claude:recent-unknown':{status:'unobserved',updatedAt:now-1*day},
 'codex:old-unknown-held':{status:'unobserved',updatedAt:now-8*day},
 'codex:old-done':{status:'done',updatedAt:now-8*day},
 'codex:old-waiting':{status:'needs_action',updatedAt:now-30*day,approval:{aid:'x'}},
 'claude:yesterday-waiting':{status:'needs_action',updatedAt:now-day-1000},
 'claude:waiting-held':{status:'needs_action',updatedAt:now-3*day},
 'grok:just-now':{status:'needs_action',updatedAt:now},
 'cursor:no-timestamp':{status:'unobserved'},
},save(){saved++},requestsFor(id){return ['codex:old-unknown-held','claude:waiting-held'].includes(id)?[{}]:[]}};
vm.createContext(context);vm.runInContext(extract('prune','// Answer a held'),context);
context.prune();
const s=context.sessions;
assert(!s['claude:old-unknown'],'Unknown record older than retention is removed');
assert(s['claude:recent-unknown'],'Recent unknown record is kept');
assert(s['codex:old-unknown-held'],'A record with a live approval request is never removed');
assert(!s['codex:old-done'],'Completed records still expire');
assert.equal(s['codex:old-waiting'].status,'unobserved','A waiting card with no live request is cleared at the daily reset');
assert(!s['codex:old-waiting'].approval,'Cleared card no longer carries an approval');
assert.equal(s['claude:yesterday-waiting'].status,'unobserved','Yesterday\'s waiting card is cleared');
assert.equal(s['claude:waiting-held'].status,'needs_action','A card with a live approval request stays');
assert.equal(s['grok:just-now'].status,'needs_action','A card from after the last reset stays');
assert(s['cursor:no-timestamp'],'A record without a timestamp is kept, as before');
assert.equal(saved,1,'One save after pruning');
context.prune();assert(!s['codex:old-waiting'],'A cleared card older than retention then expires like other unknown records');
saved=0;context.prune();assert.equal(saved,0,'Nothing changed, nothing saved');
console.log('Unobserved retention passed: old unknown removed, recent kept, live approvals protected, stale waiting cards cleared at the daily reset, done still expires.');
