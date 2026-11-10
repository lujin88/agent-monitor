// "Status unknown" records expire after the same retention as completed tasks.
const assert=require('assert'),fs=require('fs'),vm=require('vm');
const source=fs.readFileSync(process.argv[2]||require('path').join(__dirname,'server.js'),'utf8');
function extract(name,next){return source.slice(source.indexOf('function '+name+'('),source.indexOf(next,source.indexOf('function '+name+'(')))}
const now=Date.now(),day=86400000,RET=7*day;let saved=0;
const context={Date,RUNNING_STALE_MS:1800000,DONE_RETENTION_MS:RET,sessions:{
 'claude:old-unknown':{status:'unobserved',updatedAt:now-8*day},
 'claude:recent-unknown':{status:'unobserved',updatedAt:now-1*day},
 'codex:old-unknown-held':{status:'unobserved',updatedAt:now-8*day},
 'codex:old-done':{status:'done',updatedAt:now-8*day},
 'codex:old-waiting':{status:'needs_action',updatedAt:now-30*day},
 'cursor:no-timestamp':{status:'unobserved'},
},save(){saved++},requestsFor(id){return id==='codex:old-unknown-held'?[{}]:[]}};
vm.createContext(context);vm.runInContext(extract('prune','// Answer a held'),context);
context.prune();
const s=context.sessions;
assert(!s['claude:old-unknown'],'Unknown record older than retention is removed');
assert(s['claude:recent-unknown'],'Recent unknown record is kept');
assert(s['codex:old-unknown-held'],'A record with a live approval request is never removed');
assert(!s['codex:old-done'],'Completed records still expire');
assert(s['codex:old-waiting'],'Waiting-for-you records are never pruned by age');
assert(s['cursor:no-timestamp'],'A record without a timestamp is kept, as before');
assert.equal(saved,1,'One save after pruning');
saved=0;context.prune();assert.equal(saved,0,'Nothing changed, nothing saved');
console.log('Unobserved retention passed: old unknown removed, recent kept, live approvals and waiting tasks protected, done still expires.');
