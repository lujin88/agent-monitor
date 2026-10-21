// Read-only Grok server state. No messages sent, decisions made, or UI observation.
const https=require('https'),crypto=require('crypto');
const {readAccessToken}=require('./cursor-usage');
const {activeScope,accountMatches}=require('./grok-usage');
const ORIGIN='https://api2.cursor.sh/aiserver.v1.GrokBotService/';
function framedParser(onFrame){
 let buffer=Buffer.alloc(0);
 return chunk=>{
  buffer=Buffer.concat([buffer,chunk]);
  while(buffer.length>=5){
   const size=buffer.readUInt32BE(1),flags=buffer[0];
   if(size>2e6||(flags&1))throw Error('Unsupported frame');
   if(buffer.length<5+size)return;
   const frame=JSON.parse(buffer.subarray(5,5+size).toString('utf8'));buffer=buffer.subarray(5+size);
   if(flags&2)throw Error('Stream ended');
   onFrame(frame);
  }
 };
}
function stateTracker({seed=[],onEvent,now=Date.now,names=new Map()}){
 const records=new Map(seed.filter(s=>s.source==='grok'&&s.stateSource==='grok-stream').map(s=>[s.id.replace(/^grok:/,''),{status:s.status,title:s.title,seenActive:s.status!=='done'}]));
 const keyFor=x=>'stream-'+crypto.createHash('sha256').update(String(x.agentId)+'\0'+String(x.sessionId||'')).digest('hex').slice(0,32);
 function emit(key,r,status,activity){
  r.status=status;
  onEvent({source:'grok',session:key,title:r.title||'Grok Bot',status,stateSource:'grok-stream',taskKind:'chat',reason:'grok-state',
   message:status==='needs_action'?'Grok Bot is waiting for your input. Continue in Grok Bot.':status==='unobserved'?'Background status unavailable. Reconnecting automatically.':'',
   progress:{source:'grok-stream',lastActivity:activity||'Working'}});
 }
 function unknown(){for(const [k,r]of records)if(['running','needs_action'].includes(r.status))emit(k,r,'unobserved');}
 function tick(){for(const [k,r]of records)if(['running','needs_action'].includes(r.status)&&r.expiresAt&&now()>r.expiresAt)emit(k,r,'unobserved');}
 function frame(f){
  if(f.turnFailed){const k=keyFor(f.turnFailed),r=records.get(k);if(r){r.seenActive=false;emit(k,r,'unobserved','Turn stopped');}return;}
  if(!f.agentState)return;
  const present=new Set();
  for(const x of f.agentState.live||[]){
   if(typeof x.agentId!=='string'||!x.agentId)continue;
   const key=keyFor(x);present.add(key);
   let r=records.get(key)||{status:'idle',seenActive:false};
   r.title=names.get(x.agentId)||r.title||'Grok Bot';
   const stamp=Number(x.updatedAtMs),ttl=Number(x.staleAfterMs);
   r.expiresAt=Number.isFinite(stamp)&&stamp>0&&Number.isFinite(ttl)&&ttl>0?stamp+ttl:now()+90000;
   const active=x.isRunning===true||x.isComposingMessage===true||x.isRetrying===true||x.hasRunningSubagents===true;
   if(x.awaiting||active){
    r.seenActive=true;
    const status=now()>r.expiresAt?'unobserved':x.awaiting?'needs_action':'running';
    emit(key,r,status,x.isRetrying?'Retrying':x.isComposingMessage?'Writing a response':x.hasRunningSubagents?'Subtasks running':'Working');
   }else if(r.seenActive){r.seenActive=false;emit(key,r,'done','Activity ended');}
   records.set(key,r);
  }
  if(f.agentState.snapshot)for(const[k,r]of records)if(!present.has(k)&&['running','needs_action'].includes(r.status))emit(k,r,'unobserved');
 }
 return{frame,tick,unknown};
}
async function roster(token){
 return new Promise(resolve=>{
  let req,settled=false;
  const finish=(names=new Map())=>{if(settled)return;settled=true;clearTimeout(timer);resolve(names);};
  // A socket idle timeout does not cover DNS/TLS connection setup. Bound the whole
  // request, including a peer that trickles bytes forever.
  const timer=setTimeout(()=>{finish();req?.destroy();},8000);
  try{
   req=https.request(ORIGIN+'ListGrokBotAgents',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Connect-Protocol-Version':'1'}},res=>{
    if(res.statusCode!==200){res.resume();return finish();}
    let raw='';res.setEncoding('utf8');res.on('data',x=>{raw+=x;if(raw.length>2e6){finish();req.destroy();}});
    res.on('end',()=>{try{finish(new Map((JSON.parse(raw).agents||[]).map(a=>[a.agentId,String(a.name||a.title||'Grok Bot').slice(0,140)])));}catch(_){finish();}});
    res.on('error',()=>finish());res.on('close',()=>finish());
   });
   req.on('error',()=>finish());req.on('close',()=>finish());req.end('{}');
  }catch(_){finish();req?.destroy();}
 });
}
function createGrokWatcher({seed=[],onEvent,onHealth}){
 const names=new Map();let offset=0,request=null,retry=null,check=null,stopped=false,generation=0,lastFrame=0,failures=0,scope=null,connectedAt=0;
 const tracker=stateTracker({seed,onEvent,names,now:()=>Date.now()+offset});
 const health=(status,extra={})=>onHealth({status,checkedAt:Date.now(),lastFrameAt:lastFrame||null,...extra});
 const close=()=>{const r=request;request=null;r?.destroy();};
 function fail(status,epoch){
  if(stopped||epoch!==generation)return;
  generation++;close();tracker.unknown();health(status);
  clearTimeout(retry);retry=setTimeout(connect,Math.min(60000,5000*2**Math.min(failures++,4)));
 }
 async function connect(){
  if(stopped)return;const epoch=++generation;health('connecting');
  try{
   const token=await readAccessToken();scope=activeScope();
   if(!accountMatches(token,scope))return fail('account_mismatch',epoch);
   const labels=await roster(token);
   if(stopped||epoch!==generation)return;
   if(activeScope()!==scope)return fail('account_mismatch',epoch);
   names.clear();for(const[k,v]of labels)names.set(k,v);
   const json=Buffer.from(JSON.stringify({cursors:[],includeUnlistedAgents:false,inlineBodyMaxBytes:0}));
   const body=Buffer.alloc(json.length+5);body.writeUInt32BE(json.length,1);json.copy(body,5);
   connectedAt=lastFrame=Date.now();
   const parse=framedParser(f=>{
    if(stopped||epoch!==generation)return;
    lastFrame=Date.now();
    const stamp=Number(f.connected?.serverTimeMs||f.heartbeat?.serverTimeMs);if(stamp>0)offset=stamp-Date.now();
    // Drop transcript rows, client previews, tool arguments and all message bodies.
    if(f.agentState||f.turnFailed)tracker.frame(f);
    if(f.agentState){failures=0;health('connected',{lastReportAt:Date.now()});}
    else if(f.heartbeat)health('connected');
   });
   request=https.request(ORIGIN+'WatchGrokBotTranscripts',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/connect+json','Connect-Protocol-Version':'1','Content-Length':body.length}},res=>{
    if(res.statusCode!==200){res.resume();return fail([401,403].includes(res.statusCode)?'auth_required':'unavailable',epoch);}
    res.on('data',chunk=>{try{parse(chunk);}catch(_){fail('disconnected',epoch);}});
    res.on('end',()=>fail('disconnected',epoch));res.on('error',()=>fail('disconnected',epoch));
   });
   request.on('error',()=>fail('disconnected',epoch));request.end(body);
  }catch(e){fail(e.status==='missing'?'auth_required':'unavailable',epoch);}
 }
 if(process.env.GROK_WATCH==='off'){health('disabled');return()=>{};}
 connect();
 check=setInterval(()=>{
  tracker.tick();
  if(!request)return;
  try{if(activeScope()!==scope)return fail('account_mismatch',generation);}catch(_){return fail('auth_required',generation);}
  if(Date.now()-lastFrame>45000)return fail('disconnected',generation);
  if(Date.now()-connectedAt>240000){generation++;close();connect();}
 },5000);
 return()=>{stopped=true;generation++;clearInterval(check);clearTimeout(retry);close();};
}
module.exports={framedParser,stateTracker,createGrokWatcher};
