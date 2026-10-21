const assert=require('assert'),fs=require('fs'),vm=require('vm'),path=require('path');
const file=process.argv[2]||path.join(__dirname,'index.html'),html=fs.readFileSync(file,'utf8');
for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
const extract=name=>{const start=html.indexOf('function '+name+'(');assert(start>=0);const end=html.indexOf('\nfunction ',start+1);return html.slice(start,end)};
const c={ago:ms=>Math.round(ms/60000)+' min ago',windowLabel:x=>x};vm.createContext(c);for(const name of ['usageSelection','usageProblem','usageFreshness','trackedSessions','sourceReport','hookLabel','readerLabel','connectionRows'])vm.runInContext(extract(name),c);
const now=Date.now(),fresh={updatedAt:now-30000,windows:[{label:'Weekly',usedPercent:4}]},old={...fresh,updatedAt:now-7*3600000};
assert.equal(c.usageFreshness({now},'claude',old),'cached');
assert.equal(c.usageFreshness({now,usageStatus:{cursor:'error'}},'cursor',fresh),'cached');
assert.equal(c.usageFreshness({now},'codex',fresh),'fresh');
assert.equal(c.usageFreshness({now},'grok',null),'missing');
for(const n of [97.99,98,100]){const windows=[{label:'Cursor models',usedPercent:n},{label:'Other models',usedPercent:27}];assert.equal(c.usageSelection('cursor',windows).window.label,n>=98?'Other models':'Cursor models')}
const rows=c.connectionRows({now,sessions:[],chatTracking:{status:'permission_required'},usage:{claude:old}},'denied',false);
assert(rows.find(r=>r[0]==='Claude Chat')[1].includes('Untracked'));assert(rows.find(r=>r[0]==='Claude Cowork')[1].includes('Untracked'));
assert(rows.find(r=>r[0]==='Claude usage')[1].includes('Cached'));
assert.equal(rows.find(r=>r[0]==='Cursor tasks')[1],'Hook config not checked · No report in current records','Without server evidence nothing is claimed');
// With server evidence: configured is separate from delivery; dismissed tasks do not erase the last report.
const since=new Date(2026,9,1).getTime(),ev={now,sessions:[],reports:{since,sources:{codex:{at:now-120000},'claude:notification':{at:now-60000}}},hookConfig:{codex:'configured',claude:'configured',cursor:'missing'},notificationReader:{present:true,status:'full_disk_access_required',mode:'watch',checkedAt:now-2000,openErrno:1}};
const evRows=c.connectionRows(ev,'granted',true);
assert.equal(evRows.find(r=>r[0]==='Codex tasks')[1],'Hooks configured · Last report 2 min ago');
assert.equal(evRows.find(r=>r[0]==='Cursor tasks')[1],'Hooks not found in config · No report since Oct 1');
assert.equal(evRows.find(r=>r[0]==='Claude Code tasks')[1],'Hooks configured · No report since Oct 1','A notification estimate is not a Claude Code report');
const note=evRows.find(r=>r[0]==='Claude notifications')[1];assert(note.startsWith('Estimated only · Database access denied (errno 1) · Last report 1 min ago'),note);
assert.equal(c.readerLabel({now,notificationReader:{present:false}}),'Reader not running');
assert.equal(c.readerLabel({now}),'Reader status not reported','An older server that sends no reader health is not described as a stopped reader');
assert.equal(c.readerLabel({now,notificationReader:{present:true,status:'ready',mode:'watch',checkedAt:now-600000}}),'Reader stopped · last check 10 min ago','A stale health file is not a live reader');
assert.equal(c.readerLabel({now,notificationReader:{present:true,status:'database_open_failed',mode:'watch',checkedAt:now,openError:'No such file or directory'}}),'Database could not be opened · No such file or directory');
assert(rows.find(r=>r[0]==='Browser alerts')[1].includes('denied'));
assert(c.connectionRows({now},'granted',false).find(r=>r[0]==='Browser alerts')[1].includes('Paused'));
console.log('Connection status tests passed: blocked chat access, unobserved events, stale/error usage, browser alerts, and Cursor 98% switch.');

assert.equal(c.usageProblem({usageStatus:{claude:'auth_required'}},'claude'),'Sign in to Claude Code');
assert(c.connectionRows({now,usageStatus:{claude:'auth_required'},usage:{claude:old}},'denied',false).find(r=>r[0]==='Claude usage')[1].includes('Sign in'));

assert.equal(c.readerLabel({now,notificationReader:{present:true,status:'full_disk_access_required',mode:'watch',checkedAt:now}}),'Database unavailable · diagnostic update needed');

// Reader readiness must not be confused with notification delivery or task tracking.
const healthy={present:true,status:'ready',mode:'watch',checkedAt:now,observedSinceLaunch:0,completedSinceLaunch:0,waitingSinceLaunch:0,ignoredSinceLaunch:0};
assert.equal(c.readerLabel({now,notificationReader:healthy}),'Readable · 0 detected · 0 sent to Dashboard');
assert.equal(c.readerLabel({now,notificationReader:{...healthy,observedSinceLaunch:2,completedSinceLaunch:1,ignoredSinceLaunch:1}}),'Readable · 2 detected · 1 sent to Dashboard · 1 unrecognized');
assert.equal(c.readerLabel({now,notificationReader:{present:true,status:'ready',checkedAt:now}}),'Readable · notification counts unavailable');
