// Poll the quota endpoint used by the installed Claude Code client.
// Reuse the existing Claude Code login; renewal stays in the macOS Keychain.
// Never log credentials or send them anywhere except the fixed Anthropic origins.
const https=require('https'),fs=require('fs'),os=require('os'),path=require('path');
const {execFile}=require('child_process');
const ENDPOINT='https://api.anthropic.com/api/oauth/usage';
const TOKEN_ENDPOINT='https://platform.claude.com/v1/oauth/token';
const CLIENT_ID='9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const failure=(status,reason)=>Object.assign(new Error('Claude usage unavailable'),{status,reason});
function credentialToken(data,now=Date.now()) {
 const c=data?.claudeAiOauth;
 if(!c||typeof c.accessToken!=='string'||!c.accessToken|| (Number.isFinite(c.expiresAt)&&c.expiresAt<=now))throw failure('auth_required');
 return c.accessToken;
}
async function readCredentials(){
 // The service name is from Claude Code's standard macOS secure-storage provider.
 if(process.platform==='darwin')return new Promise((resolve,reject)=>{
  execFile('/usr/bin/security',['find-generic-password','-a',os.userInfo().username,'-w','-s','Claude Code-credentials'],{timeout:5000,maxBuffer:65536},(err,stdout)=>{
   if(err)return reject(failure(err.killed?'timeout':'auth_required'));
   try{resolve(JSON.parse(stdout))}catch{reject(failure('auth_required'))}
  });
 });
 try{return JSON.parse(await fs.promises.readFile(path.join(os.homedir(),'.claude','.credentials.json'),'utf8'))}catch{throw failure('auth_required')}
}
function requestUsage(url,options,body){
 if(url!==ENDPOINT&&url!==TOKEN_ENDPOINT)return Promise.reject(failure('error'));
 return new Promise((resolve,reject)=>{
  let settled=false;
  const finish=(err,value)=>{if(settled)return;settled=true;clearTimeout(timer);err?reject(err):resolve(value)};
  const req=https.request(url,options,res=>{
   if(res.statusCode!==200){res.resume();return finish(failure(res.statusCode===401||(url===TOKEN_ENDPOINT&&res.statusCode===400)?'auth_required':res.statusCode===403?'access_denied':res.statusCode===429?'rate_limited':'error','http_'+res.statusCode))}
   let raw='';res.setEncoding('utf8');res.on('data',chunk=>{raw+=chunk;if(raw.length>1024*1024){finish(failure('error'));req.destroy()}});
   res.on('aborted',()=>finish(failure('error')));res.on('error',()=>finish(failure('error')));
   res.on('end',()=>{try{finish(null,JSON.parse(raw))}catch{finish(failure('error'))}});
  });
  const timer=setTimeout(()=>{finish(failure('timeout'));req.destroy()},10000);
  req.on('error',e=>finish(failure('error',/^[A-Z0-9_]+$/.test(e.code||'')?e.code:'network')));req.end(body);
  // Redirects are deliberately not followed: credentials stay on the fixed origin.
 });
}
// Match both refresh locks used by the installed Claude Code client. Never steal
// an existing lock: a later poll can retry. No credentials are written here.
async function withRefreshLock(run,root=path.join(os.homedir(),'.claude')){
 const realRoot=await fs.promises.realpath(root);
 const held=[];let compromised=false;
 const check=async()=>{for(const [file,ino] of held){const st=await fs.promises.stat(file);if(st.ino!==ino)throw failure('error')}};
 let heartbeat;
 try{
  for(const file of [path.join(realRoot,'.oauth_refresh.lock'),realRoot+'.lock']){
   try{await fs.promises.mkdir(file,{mode:0o700})}catch{throw failure('error','refresh_lock')}
   held.push([file,(await fs.promises.stat(file)).ino]);
  }
  heartbeat=setInterval(async()=>{try{await check();const now=new Date();for(const [file] of held)await fs.promises.utimes(file,now,now)}catch{compromised=true}},5000);
  heartbeat.unref();
  return await run(async()=>{if(compromised)throw failure('error');await check()});
 }finally{
  clearInterval(heartbeat);
  for(const [file,ino] of held.reverse()){
   try{if((await fs.promises.stat(file)).ino===ino)await fs.promises.rmdir(file)}catch{}
  }
 }
}
async function saveCredentials(data,expected){
 if(process.platform!=='darwin')throw failure('auth_required');
 const raw=await new Promise((resolve,reject)=>execFile('/usr/bin/security',['find-generic-password','-a',os.userInfo().username,'-w','-s','Claude Code-credentials'],{timeout:5000,maxBuffer:65536},(err,stdout)=>err?reject(failure('error')):resolve(stdout.replace(/\n$/,''))));
 let current;try{current=JSON.parse(raw)}catch{throw failure('auth_required')}
 if(current?.claudeAiOauth?.accessToken===data.claudeAiOauth.accessToken&&current?.claudeAiOauth?.refreshToken===data.claudeAiOauth.refreshToken&&current?.claudeAiOauth?.expiresAt===data.claudeAiOauth.expiresAt&&expected?.claudeAiOauth?.accessToken!==data.claudeAiOauth.accessToken)return;
 if(current?.claudeAiOauth?.accessToken!==expected?.claudeAiOauth?.accessToken||current?.claudeAiOauth?.refreshToken!==expected?.claudeAiOauth?.refreshToken)throw failure('error','credentials_changed');
 // SecItemUpdate via stdin has no security -i line-length limit. The helper
 // verifies the previous bytes before writing and reads back the complete value.
 // No secret in process arguments, environment, stdout or a plaintext file.
 const input=JSON.stringify({expectedHash:require('crypto').createHash('sha256').update(raw).digest('hex'),value:{...current,claudeAiOauth:data.claudeAiOauth}});
 await new Promise((resolve,reject)=>{
  const child=execFile(path.join(__dirname,'claude-keychain'),[],{timeout:15000,maxBuffer:65536},err=>err?reject(failure('error','keychain_write')):resolve());
  child.stdin.on('error',()=>{});child.stdin.end(input);
 });
 // Verify through the same reader the Monitor uses, not just helper exit status.
 const saved=await readCredentials();
 if(saved?.claudeAiOauth?.accessToken!==data.claudeAiOauth.accessToken||saved?.claudeAiOauth?.refreshToken!==data.claudeAiOauth.refreshToken)throw failure('error','keychain_verify');
}
async function renewCredentials(previous,{read=readCredentials,save=saveCredentials,request=requestUsage,lock=withRefreshLock}={}){
 return lock(async(check=async()=>{})=>{
  const current=await read(),c=current?.claudeAiOauth;
  // Another process/login won the race; use it without overwriting its account.
  if(c?.accessToken!==previous?.claudeAiOauth?.accessToken){credentialToken(current);return current}
  if(!c?.refreshToken||typeof c.refreshToken!=='string'||!Array.isArray(c.scopes)||!c.scopes.length)throw failure('auth_required');
  if(c.clientId&&c.clientId!==CLIENT_ID)throw failure('auth_required');
  if(Number.isFinite(c.refreshTokenExpiresAt)&&c.refreshTokenExpiresAt<=Date.now())throw failure('auth_required');
  if(save===saveCredentials){
   if(process.platform!=='darwin')throw failure('auth_required');
   try{await fs.promises.access(path.join(__dirname,'claude-keychain'),fs.constants.X_OK)}catch{throw failure('error','keychain_helper_missing')}
   // Confirm Keychain access and a full round trip BEFORE rotating a token.
   // A denied Keychain prompt must leave the existing login untouched.
   await save(current,current);
  }
  await check();
  const response=await request(TOKEN_ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'}},JSON.stringify({grant_type:'refresh_token',refresh_token:c.refreshToken,client_id:CLIENT_ID,scope:c.scopes.join(' ')}));
  if(typeof response.access_token!=='string'||!response.access_token||!Number.isFinite(response.expires_in)||response.expires_in<=0)throw failure('error');
  if(response.refresh_token!==undefined&&(typeof response.refresh_token!=='string'||!response.refresh_token))throw failure('error');
  const refreshed={...c,accessToken:response.access_token,refreshToken:response.refresh_token||c.refreshToken,expiresAt:Date.now()+response.expires_in*1000};
  if(typeof response.scope==='string')refreshed.scopes=response.scope.split(/\s+/).filter(Boolean);
  if(Number.isFinite(response.refresh_token_expires_in))refreshed.refreshTokenExpiresAt=Date.now()+response.refresh_token_expires_in*1000;
  await check();
  const latest=await read();
  if(latest?.claudeAiOauth?.accessToken!==c.accessToken||latest?.claudeAiOauth?.refreshToken!==c.refreshToken){credentialToken(latest);return latest}
  const next={...latest,claudeAiOauth:{...latest.claudeAiOauth,...refreshed}};
  let saveError;
  for(let attempt=0;attempt<3;attempt++){
   try{await save(next,latest);return next}catch(e){saveError=e;if(attempt<2)await new Promise(resolve=>setTimeout(resolve,200*(attempt+1)))}
  }
  throw saveError;
 });
}
function claudeWindows(data){
 return [['five_hour','5 hours'],['seven_day','Weekly']].flatMap(([key,label])=>{
  const w=data?.[key];if(typeof w?.utilization!=='number'||!Number.isFinite(w.utilization)||w.utilization<0||w.utilization>100)return [];
  const parsed=typeof w.resets_at==='string'?Date.parse(w.resets_at)/1000:typeof w.resets_at==='number'?w.resets_at:null;
  return [{label,usedPercent:w.utilization,resetsAt:Number.isFinite(parsed)&&parsed>0?Math.round(parsed):null}];
 });
}
async function readClaudeUsage({readCredentials:read=readCredentials,request=requestUsage,renew=renewCredentials}={}){
 let credentials=await read(),renewed=false;
 if(Number.isFinite(credentials?.claudeAiOauth?.expiresAt)&&credentials.claudeAiOauth.expiresAt<=Date.now()+60000){credentials=await renew(credentials,{read,request});renewed=true}
 const query=()=>request(ENDPOINT,{method:'GET',headers:{Authorization:`Bearer ${credentialToken(credentials)}`,'anthropic-beta':'oauth-2025-04-20','Accept':'application/json'}});
 try{return claudeWindows(await query())}catch(e){
  if(e.status!=='auth_required'||renewed)throw e;
  credentials=await renew(credentials,{read,request});
  return claudeWindows(await query());
 }
}
function createClaudePoller({onUsage,onStatus,readUsage=readClaudeUsage}){
 let busy=false;
 return async function pollClaude(){
  if(busy||process.env.CLAUDE_USAGE==='off')return;busy=true;
  try{const windows=await readUsage();if(windows.length){onUsage(windows);onStatus('ok')}else onStatus('nodata')}
  catch(e){onStatus(['auth_required','access_denied','timeout','rate_limited'].includes(e.status)?e.status:'error')}
  finally{busy=false}
 };
}
module.exports={claudeWindows,credentialToken,readClaudeUsage,createClaudePoller,renewCredentials,withRefreshLock};
