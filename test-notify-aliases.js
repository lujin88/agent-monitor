const assert=require('assert'),fs=require('fs'),vm=require('vm'),EventEmitter=require('events');
const file=process.argv[2]||require('path').join(__dirname,'notify.js');
function event(source,payload){let sent;const stdin=new EventEmitter();stdin.setEncoding=()=>{};
 vm.runInNewContext(fs.readFileSync(file,'utf8'),{require(name){if(name==='http')return {request(options,cb){return {on(){},end(body){sent=JSON.parse(body)}}}};if(name==='fs')return {readFileSync:()=> 'test-key'};return require(name)},__dirname:'/tmp/test-monitor',URL,Buffer,setTimeout:()=>0,process:{argv:['node',file,source,'running'],env:{},stdin,stdout:{write(){}},exit(){}}});
 stdin.emit('data',JSON.stringify(payload));stdin.emit('end');return sent;
}
for(const [source,key] of [['codex','thread_id'],['codex','session_id'],['cursor','conversation_id'],['claude','session_id'],['grok','sessionId']]){
 const result=event(source,{[key]:'separate-conversation',prompt:'Test'});assert.equal(result.session,'separate-conversation',source+' '+key+' must keep its identity');assert.equal(result.source,source);
}
console.log('Hook identity tests passed for Codex, Claude, Cursor and Grok.');
