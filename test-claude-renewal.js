const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
// Tests the INACTIVE renewal candidate, not the active read-only claude-usage.js.
// Every credential read, save and network request below is an injected fixture.
const {readClaudeUsage,renewCredentials,withRefreshLock,createClaudePoller}=require('./claude-usage-renewal');
const expired=()=>({other:{keep:true},claudeAiOauth:{accessToken:'old',refreshToken:'refresh-fixture',expiresAt:1,scopes:['user:profile'],subscriptionType:'max'}});
const valid=()=>({claudeAiOauth:{accessToken:'fresh',refreshToken:'rotated',expiresAt:Date.now()+3600000}});
const lock=fn=>fn();
(async()=>{
 let saved,calls=[];const original=expired();
 const next=await renewCredentials(original,{read:async()=>original,save:async d=>saved=d,lock,request:async(url,options,body)=>{
  calls.push(url);assert.equal(url,'https://platform.claude.com/v1/oauth/token');assert.equal(options.method,'POST');assert.equal(options.headers.Authorization,undefined);
  assert.deepEqual(JSON.parse(body),{grant_type:'refresh_token',refresh_token:'refresh-fixture',client_id:'9d1c250a-e61b-44d9-88ed-5944d1962f5e',scope:'user:profile'});
  return {access_token:'fresh',refresh_token:'rotated',expires_in:3600,scope:'user:profile'};
 }});
 assert.equal(saved,next);assert.deepEqual(next.other,{keep:true});assert.equal(next.claudeAiOauth.subscriptionType,'max');assert.equal(next.claudeAiOauth.refreshToken,'rotated');assert(next.claudeAiOauth.expiresAt>Date.now());assert.equal(original.claudeAiOauth.accessToken,'old');
 let renewals=0,queries=0;
 const quota=await readClaudeUsage({readCredentials:async()=>original,renew:async()=>{renewals++;return valid()},request:async(url,o)=>{queries++;assert.equal(o.headers.Authorization,'Bearer fresh');return {seven_day:{utilization:23}}}});
 assert.equal(quota[0].usedPercent,23);assert.equal(renewals,1);assert.equal(queries,1);
 queries=0;renewals=0;
 await readClaudeUsage({readCredentials:async()=>valid(),renew:async()=>{renewals++;return valid()},request:async()=>{if(!queries++)throw Object.assign(new Error(),{status:'auth_required'});return {five_hour:{utilization:0}}}});
 assert.equal(queries,2);assert.equal(renewals,1);
 queries=0;renewals=0;
 await assert.rejects(readClaudeUsage({readCredentials:async()=>original,renew:async()=>{renewals++;return valid()},request:async()=>{queries++;throw Object.assign(new Error(),{status:'auth_required'})}}));
 assert.equal(queries,1);assert.equal(renewals,1);
 let wrote=false;let readCount=0;
 const raced=await renewCredentials(original,{lock,read:async()=>++readCount===1?original:valid(),save:async()=>wrote=true,request:async()=>({access_token:'discard',expires_in:3600})});
 assert.equal(raced.claudeAiOauth.accessToken,'fresh');assert.equal(wrote,false);
 for(const bad of [{access_token:'x'}, {access_token:'x',expires_in:3600,refresh_token:null}]){
  await assert.rejects(renewCredentials(original,{lock,read:async()=>original,save:async()=>assert.fail('invalid response saved'),request:async()=>bad}));
 }
 await assert.rejects(renewCredentials(original,{lock,read:async()=>original,save:async()=>{throw Error('write failed')},request:async()=>({access_token:'x',expires_in:3600})}));
 const noRefresh=expired();delete noRefresh.claudeAiOauth.refreshToken;
 await assert.rejects(renewCredentials(noRefresh,{lock,read:async()=>noRefresh,request:async()=>assert.fail('missing credential used')}),e=>e.status==='auth_required');
 let status;const poll=createClaudePoller({onUsage:()=>assert.fail('failed renewal must preserve cached timestamp'),onStatus:s=>status=s,readUsage:async()=>{throw Object.assign(new Error(),{status:'auth_required'})}});await poll();assert.equal(status,'auth_required');
 const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),'monitor-renewal-test-'));
 try{
  await withRefreshLock(async()=>{
   assert(fs.existsSync(path.join(root,'.oauth_refresh.lock')));assert(fs.existsSync(root+'.lock'));
   await assert.rejects(withRefreshLock(async()=>assert.fail('overlapping renewal'),root));
  },root);
  assert(!fs.existsSync(root+'.lock'));assert(!fs.existsSync(path.join(root,'.oauth_refresh.lock')));
  await fs.promises.mkdir(root+'.lock');
  await assert.rejects(withRefreshLock(async()=>assert.fail('legacy lock ignored'),root));
  assert(fs.existsSync(root+'.lock'));assert(!fs.existsSync(path.join(root,'.oauth_refresh.lock')));
 }finally{await fs.promises.rm(root,{recursive:true,force:true});await fs.promises.rm(root+'.lock',{recursive:true,force:true})}
 console.log('Claude renewal tests passed: expiry, one retry, rotation, preservation, race adoption, validation, failure and shared locks.');
})().catch(e=>{console.error(e);process.exitCode=1});
