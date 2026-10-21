const fs=require('fs'),vm=require('vm'),assert=require('assert'),path=require('path');
const source=fs.readFileSync(process.argv[2]||path.join(__dirname,'server.js'),'utf8');
const start=source.indexOf('function applyEvent(e)'),end=source.indexOf('\nconst server =',start);
const notices=[],context={sessions:{},clip:(x,n)=>String(x).slice(0,n),requestsFor:()=>[],resolvePending(){},STATUSES:['running','done','needs_action','unobserved'],save(){},notifyAttention:(source,approval)=>notices.push({source,approval})};
vm.createContext(context);vm.runInContext(source.slice(start,end),context);
const event=status=>context.applyEvent({source:'claude',session:'normal-question',status});
event('running');assert.equal(notices.length,0);event('needs_action');assert.equal(notices.length,1,'An ordinary attention request must trigger a native notification');assert.equal(notices[0].approval,false);
event('needs_action');assert.equal(notices.length,1,'Repeated status should not spam');event('resume');event('needs_action');assert.equal(notices.length,2,'A new waiting episode must notify again');event('done');assert.equal(notices.length,2);
console.log('Attention notification tests passed: new request, deduplication, resumed request and completion.');
