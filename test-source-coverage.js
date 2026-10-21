const fs=require('fs'),vm=require('vm'),assert=require('assert');
const {JSDOM}=(()=>{for(const p of [process.env.JSDOM_PATH,'jsdom'])if(p)try{return require(p)}catch(_){}throw Error('jsdom not found: npm install jsdom, or set JSDOM_PATH')})();
const html=fs.readFileSync(process.argv[2]||__dirname+'/index.html','utf8');
for(const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(m[1]);
const w=new JSDOM('<div id="source-coverage"></div>').window;
const c={Date,Math,document:w.document,$:id=>w.document.getElementById(id),ago:n=>Math.round(n/60000)+'m ago'};
c.el=(tag,cls,text)=>{const e=w.document.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e};vm.createContext(c);
for(const name of ['trackedSessions','sourceReport','hookLabel','readerLabel','renderCoverage','estimatedNotification']){const a=html.indexOf('function '+name+'(');const b=html.indexOf('\nfunction ',a+1);assert(a>=0);vm.runInContext(html.slice(a,b),c)}
const now=Date.now();const d={now,sessions:[{id:'claude:code',source:'claude',updatedAt:now-120000,status:'done'},{id:'claude:old',source:'claude',taskKind:'chat',stateSource:'chat-observer',updatedAt:now,status:'running'},{id:'claude:n',source:'claude',taskKind:'notification',stateSource:'macos-notification',updatedAt:now,status:'needs_action'}]};
assert.deepEqual(Array.from(c.trackedSessions(d),s=>s.id),['claude:code','claude:n']);
assert.equal(c.sourceReport(d,'claude'),'Last report 2m ago');assert.equal(c.sourceReport(d,'cursor'),'No report in current records');
d.hookConfig={claude:'configured',codex:'absent',cursor:'configured'};d.notificationReader={present:true,status:'no_claude_notifications',mode:'watch',checkedAt:now};
c.renderCoverage(d);const text=w.document.body.textContent;
assert(text.includes('Chat · Untracked'));assert(text.includes('Cowork · Untracked'));assert(text.includes('Code · Hooks configured'));assert(text.includes('No hook config file'));assert(text.includes('Notifications · Estimated only · Readable · no Claude notifications yet'));assert(!text.includes('No tasks'));
delete d.hookConfig;c.renderCoverage(d);assert(w.document.body.textContent.includes('Code · Hook config not checked'),'Configured is never assumed');
assert.equal(c.estimatedNotification(d.sessions[2]),true);
assert(html.includes('Notifications may be suppressed while viewing a conversation.'));
assert(html.includes('notification-estimate'));assert(html.includes('const all=trackedSessions(d)'));
console.log('Source coverage: observer records excluded, Code report timestamp separate, Chat/Cowork explicitly untracked, notification estimates distinct.');
