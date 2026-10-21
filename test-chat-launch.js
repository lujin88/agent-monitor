const assert=require('assert'),vm=require('vm'),fs=require('fs'),path=require('path');
const source=fs.readFileSync(path.join(__dirname,'chat-watch.js'),'utf8');
const fixtureDir=fs.mkdtempSync(path.join(require('os').tmpdir(),'chat-launch-'));fs.mkdirSync(path.join(fixtureDir,'ChatObserver.app'));process.on('exit',()=>fs.rmSync(fixtureDir,{recursive:true,force:true}));
function harness(kind){
 let calls=0,health,events=[],output;
 const context={module:{exports:{}},__dirname:fixtureDir,process:{env:{}},require(name){
  if(name==='child_process')return {execFile(binary,args,options,done){
   calls++;assert.equal(binary,'/usr/bin/open');assert.deepEqual(Array.from(args.slice(0,3)),['-g','-n','-W']);
   assert(args.at(-1).endsWith('ChatObserver.app'));
   output=args[args.indexOf('--stdout')+1];assert.equal(fs.statSync(output).mode&0o777,0o600);
   if(kind==='good')fs.writeFileSync(output,JSON.stringify({health:'ok',windows:[{source:'claude',identity:'claude.ai/chat/test',title:'Test chat',state:'running',completeScan:true}]}));
   if(kind==='denied')fs.writeFileSync(output,JSON.stringify({health:'permission_required',windows:[]}));
   done(['timeout','denied'].includes(kind)?Object.assign(new Error('timeout'),{code:'ETIMEDOUT'}):null);
  }};
  return require(name);
 }};
 vm.runInNewContext(source,context);
 context.module.exports.createChatWatcher({onHealth:h=>health=h,onEvent:e=>events.push(e)})();
 assert.equal(calls,1);assert(!fs.existsSync(path.dirname(output)),'Temporary metadata removed');
 return {health,events};
}
assert.equal(harness('good').events[0].status,'running');
assert.equal(harness('denied').health.status,'permission_required');
assert.equal(harness('timeout').events.length,0);
assert.equal(harness('empty').health.status,'unavailable');
console.log('App launch tests passed: correct app identity, protected temporary snapshot, cleanup, denied access, timeout and empty output.');
