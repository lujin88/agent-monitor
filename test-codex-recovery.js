const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-recovery-'));
const source = process.argv[2] || __dirname;
for (const file of ['server.js','cursor-usage.js','claude-usage.js','grok-usage.js','grok-watch.js','codex-watch.js','chat-watch.js']) fs.copyFileSync(path.join(source,file),path.join(root,file));
const port = 19500 + Math.floor(Math.random()*400);
fs.writeFileSync(path.join(root,'token.txt'),'isolated-test');
fs.writeFileSync(path.join(root,'state.json'),JSON.stringify({'codex:recovery':{id:'codex:recovery',source:'codex',status:'done',title:'Existing task',updatedAt:Date.now()-60000}}));
const logs = path.join(root,'logs');fs.mkdirSync(logs);
const file = path.join(logs,'rollout.jsonl');
fs.writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id:'recovery',source:'vscode',cwd:'/tmp/example'}})+'\n');
function append(type,turn='one',item) { fs.appendFileSync(file,JSON.stringify({type:'event_msg',timestamp:new Date().toISOString(),payload:{type,turn_id:turn,item}})+'\n'); }
append('task_started');
const child=spawn(process.execPath,[path.join(root,'server.js')],{env:{...process.env,HOME:root,MONITOR_NOTIFICATIONS:'off',PORT:String(port),CODEX_USAGE:'off',CURSOR_USAGE:'off',GROK_WATCH:'off',GROK_USAGE:'off',CLAUDE_USAGE:'off',CHAT_WATCH:'off',CODEX_WATCH:'on',CODEX_SESSIONS_DIR:logs},stdio:'ignore'});
async function api(route,body) {const r=await fetch(`http://127.0.0.1:${port}${route}`,{method:body?'POST':'GET',headers:{'x-key':'isolated-test','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return r.json();}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(predicate) {for(let i=0;i<70;i++){try{const d=await api('/state');const s=d.sessions.find(s=>s.id==='codex:recovery'||s.parentSessionId==='codex:recovery');if(predicate(s))return s;}catch{}await pause(100);}throw Error('Timed out waiting for recovered state');}
(async()=>{try{
 let s=await until(s=>s?.status==='running');assert.equal(s.title,'Existing task');assert.equal(s.stateSource,'local-lifecycle');
 append('item_completed','one',{type:'CommandExecution',id:'step-1',command:'PRIVATE'});
 await api('/event',{source:'codex',session:'recovery',status:'resume'});
 s=await until(s=>s?.progress?.completedActions===1);assert(!JSON.stringify(s.progress).includes('PRIVATE'));
 append('task_complete');await until(s=>s?.status==='done');
 append('task_started','two');await until(s=>s?.status==='running');
 const pending=api('/ask',{source:'codex',session:'recovery',tool:'test',description:'Isolated approval test'});
 s=await until(s=>s?.approval);const aid=s.approval.aid;
 append('item_completed','two');await pause(2300);
 s=(await api('/state')).sessions.find(s=>s.id==='codex:recovery'||s.parentSessionId==='codex:recovery');assert.equal(s.status,'needs_action');assert.equal(s.approval.aid,aid);
 await api('/decide',{aid,decision:'mac'});await pending;
 // Log timestamps have millisecond resolution; an entry in the same millisecond as the
 // decision is correctly treated as not newer. Leave a gap so the next entry is newer.
 await pause(20);
 append('item_completed','two');await until(s=>s?.status==='running');
 append('task_complete','two');await until(s=>s?.status==='done');
 console.log('Live server recovery, completion, and approval-priority tests passed');
}finally{if(child.exitCode===null&&!child.signalCode){const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;}fs.rmSync(root,{recursive:true,force:true});}})().catch(e=>{console.error(e.message);process.exitCode=1});
