const assert=require('assert/strict');
const {claudeWindows,credentialToken,createClaudePoller,readClaudeUsage}=require('./claude-usage');
(async()=>{
 const windows=claudeWindows({five_hour:{utilization:18,resets_at:'2026-10-01T14:00:00Z'},seven_day:{utilization:64,resets_at:null}});
 assert.deepEqual(windows.map(w=>w.usedPercent),[18,64]);assert.equal(windows[0].resetsAt,1790863200);
 assert.deepEqual(claudeWindows({five_hour:{utilization:null},seven_day:{utilization:'9'}}),[]);
 assert.equal(claudeWindows({five_hour:{utilization:0}})[0].usedPercent,0);
 assert.throws(()=>credentialToken({}),e=>e.status==='auth_required');
 assert.throws(()=>credentialToken({claudeAiOauth:{accessToken:'test',expiresAt:1}}),e=>e.status==='auth_required');
 assert.equal(credentialToken({claudeAiOauth:{accessToken:'test',expiresAt:Date.now()+60000}}),'test');
 const calls=[];let credentials=0;
 const result=await readClaudeUsage({readCredentials:async()=>{credentials++;return {claudeAiOauth:{accessToken:'fixture'}}},request:async(url,options)=>{assert.equal(url,'https://api.anthropic.com/api/oauth/usage');assert.equal(options.headers.Authorization,'Bearer fixture');return {five_hour:{utilization:18}}}});
 assert.equal(result[0].usedPercent,18);assert.equal(credentials,1);
 let saved,status,release,count=0;
 const poll=createClaudePoller({onUsage:w=>saved=w,onStatus:s=>status=s,readUsage:()=>{count++;return new Promise(r=>release=r)}});
 const pending=poll();await poll();assert.equal(count,1);release(windows);await pending;assert.equal(status,'ok');assert.deepEqual(saved,windows);
 for(const expected of ['auth_required','rate_limited','timeout','error']){const fail=createClaudePoller({onUsage:w=>saved=w,onStatus:s=>status=s,readUsage:async()=>{throw Object.assign(new Error('private response'),{status:expected})}});await fail();assert.equal(status,expected);assert.deepEqual(saved,windows)}
 await createClaudePoller({onUsage:()=>assert.fail('empty data must not refresh timestamp'),onStatus:s=>status=s,readUsage:async()=>[]})();assert.equal(status,'nodata');
 // The active module stays read-only: no renewal, token endpoint or Keychain writer.
 const active=require('./claude-usage'),text=require('fs').readFileSync(require('path').join(__dirname,'claude-usage.js'),'utf8');
 assert.equal(active.renewCredentials,undefined);assert.equal(active.withRefreshLock,undefined);
 for(const banned of ['oauth/token','refresh_token','claude-keychain','add-generic-password','claude-usage-renewal'])assert(!text.includes(banned),'active module must not reference '+banned);
 assert(!require('fs').readFileSync(require('path').join(__dirname,'server.js'),'utf8').includes('claude-usage-renewal'),'server must load the read-only module');
 console.log('Claude usage tests passed: fresh quota, zero/missing, auth expiry, fixed destination, no overlapping polls, honest failure states and preserved cache.');
})().catch(e=>{console.error(e);process.exitCode=1});
