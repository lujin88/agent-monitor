// Native Node regression: no commands are executed and no real task data is used.
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path');
const {spawn}=require('child_process');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'approval-state-')),port=19600+Math.floor(Math.random()*300),base='http://127.0.0.1:'+port,key='isolated';
for(const f of ['server.js','approve.js','codex-watch.js', 'chat-watch.js','cursor-usage.js','claude-usage.js','grok-usage.js','grok-watch.js'])fs.copyFileSync(path.join(__dirname,f),path.join(dir,f));fs.writeFileSync(path.join(dir,'token.txt'),key);
const child=spawn(process.execPath,[path.join(dir,'server.js')],{env:{...process.env,PORT:String(port),APPROVAL_WAIT_SEC:'1',CHAT_WATCH:'off',CODEX_WATCH:'off',CODEX_USAGE:'off',CURSOR_USAGE:'off',GROK_WATCH:'off',GROK_USAGE:'off',CLAUDE_USAGE:'off',MONITOR_NOTIFICATIONS:'off'},stdio:'ignore'});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const call=(route,body,token=key)=>fetch(base+route,{method:body?'POST':'GET',headers:{'x-key':token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
const state=async()=>await(await call('/state')).json();
async function pending(n){for(let i=0;i<60;i++){const s=(await state()).sessions.filter(s=>s.approval);if(s.length===n)return s;await pause(15)}throw Error('Pending count mismatch');}
(async()=>{try{for(let i=0;i<60;i++){try{await state();break}catch{await pause(25)}}
const payload={source:'codex',session:'parallel',tool:'Bash',command:'echo synthetic'};
const first=call('/ask',payload).then(r=>r.json()),second=call('/ask',payload).then(r=>r.json());let requests=await pending(2);assert.equal(new Set(requests.map(s=>s.id)).size,2);
await call('/event',{...payload,status:'resume'});await call('/event',{...payload,status:'running'});await pending(2);
const aid=requests[0].approval.aid;assert.equal((await call('/decide',{aid,decision:'allow'},'bad')).status,401);await pending(2);
await call('/decide',{aid,decision:'allow'});requests=await pending(1);await call('/decide',{aid:requests[0].approval.aid,decision:'deny'});
assert.deepEqual((await Promise.all([first,second])).map(x=>x.decision).sort(),['allow','deny']);assert.equal((await call('/decide',{aid,decision:'allow'})).status,410);
const expiry=call('/ask',payload).then(r=>r.json());await pending(1);assert.equal((await expiry).decision,'none');assert.equal((await state()).sessions[0].status,'needs_action');
const stopped=call('/ask',payload).then(r=>r.json());await pending(1);await call('/event',{...payload,status:'done'});assert.equal((await stopped).decision,'none');await pending(0);
console.log('Approval state regression tests passed.');
}finally{if(child.exitCode===null&&!child.signalCode){const exited=new Promise(r=>child.once('exit',r));child.kill();await exited}fs.rmSync(dir,{recursive:true,force:true})}})().catch(e=>{console.error(e);process.exitCode=1});
