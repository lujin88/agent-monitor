const assert=require('assert/strict'),crypto=require('crypto');
const {accountMatches,grokWindows,readGrokUsage,createGrokPoller}=require('./grok-usage');
(async()=>{
const token='x.'+Buffer.from(JSON.stringify({sub:'synthetic-user'})).toString('base64url')+'.x';
const scope=crypto.createHash('sha256').update('synthetic-user').digest('hex');
assert(accountMatches(token,scope));assert(!accountMatches(token,'other'));assert(!accountMatches('broken',scope));
const w=grokWindows({usagePercent:5.063879,nextResetTimestampUtc:'2026-10-05T20:28:53.979Z'});
assert.equal(w[0].resetsAt,1791232133);assert.equal(w[0].usedPercent,5.063879);
for(const d of [{},{usagePercent:null},{usagePercent:'4'},{usagePercent:4,usesPooledEnterpriseAllowance:true},{usagePercent:4,isTeamSeat:true}])assert.deepEqual(grokWindows(d),[]);
assert.equal(grokWindows({usagePercent:0})[0].usedPercent,0);assert.equal(grokWindows({usagePercent:120})[0].usedPercent,100);
let calls=0;
await assert.rejects(readGrokUsage({readToken:async()=>token,readScope:()=> 'wrong',request:async()=>{calls++;return w;}}),{status:'account_mismatch'});
assert.equal(calls,0,'Wrong account must never query endpoint');
let reads=0;
await assert.rejects(readGrokUsage({readToken:async()=>token,readScope:()=>reads++? 'changed':scope,request:async()=>w}),{status:'account_mismatch'});
assert.deepEqual(await readGrokUsage({readToken:async()=>token,readScope:()=>scope,request:async()=>w}),w);
let saved,status,release;calls=0;
const poll=createGrokPoller({onUsage:v=>saved=v,onStatus:v=>status=v,readUsage:()=>{calls++;return new Promise(r=>release=r);}});
const first=poll();await poll();assert.equal(calls,1);release(w);await first;assert.equal(status,'ok');assert.deepEqual(saved,w);
for(const errorStatus of ['missing','account_mismatch','timeout','rate_limited']){
 const failed=createGrokPoller({onUsage:v=>saved=v,onStatus:v=>status=v,readUsage:async()=>{throw Object.assign(new Error('private data'),{status:errorStatus});}});
 await failed();assert.equal(status,errorStatus);assert.deepEqual(saved,w);
}
process.env.GROK_USAGE='off';await poll();assert.equal(calls,1);delete process.env.GROK_USAGE;
console.log('Grok usage passed: weekly normalization, account verification and change, unsupported pools, failures, caching, overlap, disabled polling.');
})().catch(e=>{console.error(e);process.exitCode=1});
