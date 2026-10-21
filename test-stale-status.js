const assert=require('assert'),fs=require('fs'),vm=require('vm');
const source=fs.readFileSync(process.argv[2]||require('path').join(__dirname,'server.js'),'utf8');
function extract(name,next){return source.slice(source.indexOf('function '+name+'('),source.indexOf(next,source.indexOf('function '+name+'(')))}
const now=Date.now(),old=now-3600000;
const context={Date,STATUSES:['running','needs_action','done','unobserved'],RUNNING_STALE_MS:1800000,DONE_RETENTION_MS:604800000,sessions:{
 'codex:stale':{id:'codex:stale',status:'running',updatedAt:old},
 'codex:ready':{id:'codex:ready',status:'done',updatedAt:old},
 'claude:visible':{status:'running',stateSource:'chat-observer',updatedAt:old},
 'codex:waiting':{status:'needs_action',updatedAt:old}
},save(){},requestsFor(){return[]},clip:s=>String(s||''),resolvePending(){throw Error('No approval should be resolved')},notifyAttention(){}};
vm.createContext(context);vm.runInContext(extract('prune','// Answer a held'),context);vm.runInContext(extract('applyEvent','const server ='),context);
context.prune();
assert.equal(context.sessions['codex:stale'].status,'unobserved','Silence must not mark a task completed');
assert.equal(context.sessions['codex:stale'].updatedAt,old,'Keep last observed timestamp');
assert.equal(context.sessions['codex:ready'].status,'done');
assert.equal(context.sessions['claude:visible'].status,'running');
assert.equal(context.sessions['codex:waiting'].status,'needs_action');
context.applyEvent({source:'codex',session:'stale',status:'resume'});
assert.equal(context.sessions['codex:stale'].status,'running','New tool activity restores unknown task');
context.sessions['codex:stale'].status='unobserved';context.applyEvent({source:'codex',session:'stale',status:'done'});
assert.equal(context.sessions['codex:stale'].status,'done','Only an actual completion event finishes it');
console.log('Stale-state checks passed: silence is unknown, activity recovers, explicit completion works.');
