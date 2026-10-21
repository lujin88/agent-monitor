// Independent review regressions. Source slices only: no server, credentials or network.
const assert = require('assert/strict'), fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
function slice(a,b){const i=src.indexOf(a),j=src.indexOf(b,i);assert(i>=0&&j>i,a);return src.slice(i,j)}
(async()=>{
  // Timers can be delayed after sleep. Wall-clock expiry must reject a stale receipt.
  let now=100000;
  const ctx=vm.createContext({pending:Object.create(null),receipts:Object.create(null),sessions:Object.create(null),
    Date:{now:()=>now},save(){},clearTimeout(){},setTimeout(){return 1},ACK_WAIT_MS:4000,
    isRecord:x=>!!x&&typeof x==='object'&&!Array.isArray(x),Buffer,crypto:require('crypto')});
  vm.runInContext(slice('function resolvePending(', '\nfunction publicSessions'),ctx);
  vm.runInContext(slice('const RECEIPT_MESSAGES', '\nfunction applyEvent'),ctx);
  ctx.sessions.test={id:'test',status:'needs_action'};
  ctx.pending.request={id:'test',secret:'ab'.repeat(16),approval:{expiresAt:now+60000},res:{socket:{destroyed:false},writeHead(){},end(){}}};
  assert.equal(ctx.decide('request','allow'),'awaiting');
  now+=4000;
  assert.equal(ctx.acknowledge('request','ab'.repeat(16),'allow'),410,'receipt deadline applies even before timer callback');
  assert.equal(ctx.sessions.test.status,'unobserved');
  assert.equal(ctx.sessions.test.delivery.state,'unconfirmed');

  // Epoch zero is a valid fake clock; failed attempts also start the cooldown.
  const gateCtx=vm.createContext({});
  vm.runInContext(slice('function createRefreshGate(', '\nconst { createClaudePoller }'),gateCtx);
  let clock=0,calls=0;
  const gate=gateCtx.createRefreshGate(()=>{calls++;return 'error'},60000,()=>clock);
  assert.equal((await gate()).status,'error'); clock=1;
  assert.equal((await gate()).status,'too_soon');assert.equal(calls,1);

  // An already-running asynchronous scan may callback during shutdown's final write.
  // It must not change the in-memory snapshot or enqueue work after drainWrites starts.
  const scanBlock=slice('  onSnapshot: snapshot => {','\n});');
  const snapshotFn=scanBlock.slice(scanBlock.indexOf('snapshot =>'),scanBlock.lastIndexOf(','));
  let events=0;
  const lateCtx=vm.createContext({closing:true,reconciliation(){events++;throw Error('late reconciliation')},sessions:{},applyEvent(){events++}});
  const onSnapshot=vm.runInContext('('+snapshotFn+')',lateCtx);
  onSnapshot({id:'synthetic'});assert.equal(events,0);
  for(const match of src.matchAll(/onEvent: (event => [^\n]+),\n/g)){
    const callback=vm.runInContext('('+match[1]+')',lateCtx);callback({});
  }
  assert.equal(events,0,'late chat or Grok callbacks are ignored while closing');
  // Requests whose body began arriving before SIGTERM must not mutate after it.
  const routes=['/event','/ask','/usage','/ack','/decide','/dismiss'];
  for(const route of routes){
    let finishBody, result, mutations=0;
    const httpCtx=vm.createContext({URL,closing:false,keyOk:()=>true,isLoopback:()=>true,
      readJson:()=>new Promise(r=>{finishBody=r}),send:(res,code,body)=>{result={code,body}},
      applyEvent(){mutations++},acknowledge(){mutations++},decide(){mutations++},setUsage(){mutations++},save(){mutations++}});
    vm.runInContext(slice('async function handleRequest(', '\n// Hooks are fast'),httpCtx);
    const pending=httpCtx.handleRequest({method:'POST',url:route,headers:{'x-key':'synthetic'}},{});
    assert.equal(typeof finishBody,'function');httpCtx.closing=true;
    finishBody({body:{source:'codex',status:'running',aid:'x',decision:'allow'}});await pending;
    assert.equal(result.code,503,route);assert.equal(mutations,0,route);
  }
  console.log('Independent review edges passed: delayed receipt expiry, zero-clock refresh cooldown, shutdown freezes late collector callbacks.');
})().catch(e=>{console.error(e);process.exitCode=1});
