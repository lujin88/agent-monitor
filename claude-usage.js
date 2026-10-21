// Poll the quota endpoint used by the installed Claude Code client.
// Only read the user's existing login. Never print, persist or refresh credentials here.
const https=require('https'),fs=require('fs'),os=require('os'),path=require('path');
const {execFile}=require('child_process');
const ENDPOINT='https://api.anthropic.com/api/oauth/usage';
const failure=status=>Object.assign(new Error('Claude usage unavailable'),{status});
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
function requestUsage(url,options){
 return new Promise((resolve,reject)=>{
  let settled=false;
  const finish=(err,value)=>{if(settled)return;settled=true;clearTimeout(timer);err?reject(err):resolve(value)};
  const req=https.request(url,options,res=>{
   if(res.statusCode!==200){res.resume();return finish(failure(res.statusCode===401?'auth_required':res.statusCode===403?'access_denied':res.statusCode===429?'rate_limited':'error'))}
   let raw='';res.setEncoding('utf8');res.on('data',chunk=>{raw+=chunk;if(raw.length>1024*1024){finish(failure('error'));req.destroy()}});
   res.on('aborted',()=>finish(failure('error')));res.on('error',()=>finish(failure('error')));
   res.on('end',()=>{try{finish(null,JSON.parse(raw))}catch{finish(failure('error'))}});
  });
  const timer=setTimeout(()=>{finish(failure('timeout'));req.destroy()},10000);
  req.on('error',()=>finish(failure('error')));req.end();
  // Redirects are deliberately not followed: credentials stay on the fixed origin.
 });
}
function claudeWindows(data){
 return [['five_hour','5 hours'],['seven_day','Weekly']].flatMap(([key,label])=>{
  const w=data?.[key];if(typeof w?.utilization!=='number'||!Number.isFinite(w.utilization)||w.utilization<0||w.utilization>100)return [];
  const parsed=typeof w.resets_at==='string'?Date.parse(w.resets_at)/1000:typeof w.resets_at==='number'?w.resets_at:null;
  return [{label,usedPercent:w.utilization,resetsAt:Number.isFinite(parsed)&&parsed>0?Math.round(parsed):null}];
 });
}
async function readClaudeUsage({readCredentials:read=readCredentials,request=requestUsage}={}){
 const token=credentialToken(await read());
 const data=await request(ENDPOINT,{method:'GET',headers:{Authorization:`Bearer ${token}`,'anthropic-beta':'oauth-2025-04-20','Accept':'application/json'}});
 return claudeWindows(data);
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
module.exports={claudeWindows,credentialToken,readClaudeUsage,createClaudePoller};
