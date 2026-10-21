const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const code=fs.readFileSync(__dirname+'/cursor-usage.js','utf8');
async function trial({wal=false,changes=false,normal=false}){
 let calls=[],stats=0;
 const fakeFs={existsSync:()=>wal,statSync:()=>({size:10,mtimeMs:changes?stats++:1})};
 const fakeExec=(bin,args,opts,cb)=>{calls.push(args[1]);cb(normal||calls.length===2?null:Error('cannot create sidecar'),'synthetic-token');};
 const context={Buffer,URL,Promise,setTimeout,clearTimeout,process,module:{exports:{}},require:n=>n==='fs'?fakeFs:n==='child_process'?{execFile:fakeExec}:require(n)};
 vm.runInNewContext(code,context);
 let token,error;try{token=await context.module.exports.readAccessToken()}catch(e){error=e}
 return {calls,token,error};
}
(async()=>{
 let r=await trial({normal:true});assert.equal(r.calls.length,1);assert.equal(r.token,'synthetic-token');
 r=await trial({});assert.equal(r.calls.length,2);assert(r.calls[1].endsWith('?mode=ro&immutable=1'));assert.equal(r.token,'synthetic-token');
 r=await trial({wal:true});assert.equal(r.calls.length,1);assert.equal(r.error.status,'missing');
 r=await trial({changes:true});assert.equal(r.error.status,'missing');
 console.log('Usage login passed: normal read, read-only fallback, existing journal refused, concurrent change refused.');
})().catch(e=>{console.error(e);process.exitCode=1});
