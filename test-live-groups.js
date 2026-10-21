const assert=require('assert'),fs=require('fs'),vm=require('vm');
const {JSDOM}=(()=>{for(const p of [process.env.JSDOM_PATH,'jsdom','/Users/lu/node_modules/jsdom'])if(p)try{return require(p)}catch(_){}throw Error('jsdom not found: npm install jsdom, or set JSDOM_PATH')})();
const html=fs.readFileSync(process.argv[2]||__dirname+'/index.html','utf8');
for(const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(m[1]);
const dom=new JSDOM('<div id="running-list"></div><div id="running-pill"></div>'),w=dom.window;
const box=w.document.getElementById('running-list');Object.defineProperties(box,{clientHeight:{value:216,configurable:true},clientWidth:{value:1200,configurable:true}});
w.HTMLElement.prototype.getBoundingClientRect=function(){return {height:this.classList.contains('live-group-head')?44:this.classList.contains('live-row')?60:0}};
const c={document:w.document,Map,JSON,Math,Date,console,groups:a=>Object.values(a.reduce((o,s)=>{(o[s.source]??={source:s.source,items:[]}).items.push(s);return o},{})),agentName:s=>s.source,taskTitle:s=>s.title,english:(s,f)=>s||f,ago:n=>Math.floor(n/60000)+'m ago',pageIndex:{run:0},panelCache:{},pager:(kind,n)=>c.pages=n,$:id=>w.document.getElementById(id)};
c.el=(t,cls,text)=>{const e=w.document.createElement(t);if(cls)e.className=cls;if(text)e.textContent=text;return e};c.mark=s=>c.el('div','mark',s);vm.createContext(c);
function load(name){const start=html.indexOf('function '+name+'(');assert(start>=0,'Missing '+name);let end=html.indexOf('\nfunction ',start+1);if(end<0)end=html.length;vm.runInContext(html.slice(start,end),c)}
vm.runInContext('const runGroupPage=new Map()',c);['activityCopy','liveGroups','liveRow','drawRun','partition','renderRun'].forEach(load);
const now=Date.now(),tasks=Array.from({length:20},(_,i)=>({id:'codex:'+i,source:'codex',title:'Task '+i,startedAt:now-i,updatedAt:now,status:i===5?'unobserved':'running'}));
c.renderRun(tasks,now);assert.equal(box.querySelectorAll('.live-group').length,1);assert.equal(box.querySelectorAll('.live-count')[0].textContent,'20 tasks');assert(!box.querySelector('[role="button"]'));assert(!box.querySelector('.run-card'));assert(!box.querySelector('.task-dialog'));
const seen=new Set();for(let i=0;i<25;i++){box.querySelectorAll('.live-row').forEach(r=>{seen.add(r.dataset.taskId);assert(!r.onclick)});const next=box.querySelector('[aria-label="Next codex tasks"]');if(next.disabled)break;next.click()}
assert.equal(seen.size,20,'Every task must remain reachable');assert(box.textContent.includes('19–20 of 20'));
const original=box.firstChild;c.renderRun(tasks.map(s=>({...s,updatedAt:now+1000})),now+1000);assert.equal(box.firstChild,original,'Heartbeat must not replace the focused group');
c.renderRun(tasks.slice(0,2),now);assert.equal(box.querySelectorAll('.live-row').length,2);assert(!box.querySelector('.live-pager'),'No pagination for two visible tasks');
const long='A complete title that must remain available directly in the list without another detail dialog '.repeat(2);
c.renderRun([{...tasks[0],title:long},{...tasks[1],source:'claude',status:'unobserved'},{...tasks[2],source:'cursor'}],now);
assert.equal(box.querySelectorAll('.live-group').length,3);assert.equal(box.querySelector('.live-title').textContent,long);assert(box.textContent.includes('Status unknown'));
Object.defineProperty(box,'clientWidth',{value:350,configurable:true});c.renderRun([{...tasks[0]},{...tasks[1],source:'claude'},{...tasks[2],source:'cursor'}],now);assert.equal(c.pages,3);assert.equal(box.querySelectorAll('.live-group').length,1);
// Three agents, six tasks each: each group's controls must only change its own tasks.
Object.defineProperty(box,'clientWidth',{value:1200,configurable:true});
const multi=['codex','claude','cursor'].flatMap(source=>Array.from({length:6},(_,i)=>({...tasks[i],source,id:source+':'+i,title:source+' task '+i,progress:source==='codex'?{source:'local-events',completedActions:i+1,lastActivity:'Files updated',startedAt:now-60000}:undefined})));
c.renderRun(multi,now);assert.equal(box.querySelectorAll('.live-group').length,3);assert.equal(c.pages,1);
assert.equal(box.querySelectorAll('.live-group-head>.live-pager').length,3);
const groupRows=source=>[...box.querySelectorAll('[data-source="'+source+'"] .live-row')].map(r=>r.dataset.taskId).join(',');
const beforeClaude=groupRows('claude'),beforeCursor=groupRows('cursor');
box.querySelector('[aria-label="Next codex tasks"]').click();assert.equal(groupRows('claude'),beforeClaude);assert.equal(groupRows('cursor'),beforeCursor);
for(const source of ['codex','claude','cursor']){const ids=new Set();const group=box.querySelector('[data-source="'+source+'"]');const previous=group.querySelector('[aria-label^="Previous"]');while(!previous.disabled)previous.click();for(let i=0;i<10;i++){group.querySelectorAll('.live-row').forEach(r=>ids.add(r.dataset.taskId));const next=group.querySelector('[aria-label^="Next"]');if(next.disabled)break;next.click()}assert.equal(ids.size,6,source+' all tasks reachable');}
assert(box.textContent.includes('Working · step details not reported'),'Active tasks must not look disconnected or imply details are coming');
for(const width of [1120,1200,1440,1760])for(const height of [180,216,300]){Object.defineProperty(box,'clientWidth',{value:width,configurable:true});Object.defineProperty(box,'clientHeight',{value:height,configurable:true});c.renderRun(multi,now);assert.equal(box.querySelectorAll('.live-group').length,3,width+' by '+height+' panel shows three agents');}
c.renderRun([],now);assert.equal(box.childElementCount,0,'An empty activity panel must stay blank');
assert.equal(box.querySelectorAll('dialog').length,0);
c.renderRun([{...tasks[0],progress:{source:'local-events',startedAt:now-60000,completedActions:4,lastActivity:'Files updated'}}],now);
assert(box.textContent.includes('4 actions completed · Files updated'));
assert(box.querySelector('[role=progressbar]'));assert(!box.querySelector('[aria-valuenow]'),'Do not invent a percentage');
assert(html.includes('width:100vw'));assert(html.includes('html body .empty'));
assert(!html.includes('function showTask('),'Remove duplicate task detail modal');
console.log('Grouped activity checks passed: 20 tasks reachable, one header per agent, full text, unknown state, stable updates, pagination clamping, narrow group pages, empty state; scripts parse.');

// Match the actual lost-observation path: explain the reason, never show fake progress.
const chat={id:'claude:chat-lost',source:'claude',title:'Chat',taskKind:'chat',stateSource:'chat-observer',status:'unobserved',message:'Chat is not visible · status unavailable',updatedAt:now-600000,startedAt:now-1200000};
c.renderRun([chat],now);
assert(box.textContent.includes('Open this chat in claude to resume tracking'));
assert(!box.querySelector('[role=progressbar]'),'An unobserved chat has no progress');
assert(box.textContent.includes('Last observed'));
let dismissed;c.dismiss=id=>dismissed=id;
box.querySelector('[aria-label="Dismiss untracked task Chat"]').click();assert.equal(dismissed,chat.id);
assert.equal(c.activityCopy({...chat,message:'Mac locked · status unavailable'}),'Unlock your Mac to resume tracking');
assert.equal(c.activityCopy({...chat,message:'Enable chat tracking on your Mac'}),'Enable ChatObserver in Accessibility');
c.renderRun([{...chat,status:'running',message:''}],now);
assert(box.textContent.includes('Responding · live chat'));
assert(box.querySelector('[role=progressbar]'));
assert(!box.querySelector('[aria-label^="Dismiss untracked"]'));
assert(!box.textContent.includes('unavailable'));
console.log('Chat activity copy and recovery controls passed.');

const fourSources=['codex','claude','cursor','grok'].map((source,i)=>({...tasks[i],source,id:source+':layout'}));
for(const [width,visible,pages] of [[1760,4,1],[1440,3,2],[800,2,2],[350,1,4]]){
 Object.defineProperty(box,'clientWidth',{value:width,configurable:true});c.pageIndex.run=0;c.renderRun(fourSources,now);
 assert.equal(box.querySelectorAll('.live-group').length,visible);
 assert.equal(c.pages,pages);
 const reached=new Set();for(let page=0;page<pages;page++){c.pageIndex.run=page;c.renderRun(fourSources,now);box.querySelectorAll('.live-group').forEach(card=>reached.add(card.dataset.source));}
 assert.equal(reached.size,4,'All four programs remain reachable at '+width+'px');
}
console.log('Four-program layout passed at wide, medium, tablet and phone widths.');
