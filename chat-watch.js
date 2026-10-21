// Observe explicit chat UI signals, never infer completion from a quiet log.
const crypto = require('crypto');
const path = require('path');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const keyFor = identity => crypto.createHash('sha256').update(identity).digest('hex').slice(0,24);
function createTracker(seed = []) {
  const tracked = new Map(seed.filter(s => s.stateSource === 'chat-observer').map(s => [s.observationKey,{source:s.source,title:s.title,status:s.status,misses:0,idle:0}]));
  return function reduce(snapshot) {
    const events=[],seen=new Set();
    if(snapshot.health==='ok') for(const w of snapshot.windows || []) {
      if(!['claude','gpt','grok'].includes(w.source)||!w.identity)continue;
      const key=keyFor(w.identity);seen.add(key);let t=tracked.get(key);
      // Opening an old idle chat must not import it as a new completed task.
      if(!t && !['running','needs_action'].includes(w.state))continue;
      if(!t){t={source:w.source,title:w.title,status:null,idle:0,misses:0};tracked.set(key,t)}
      t.misses=0;t.title=w.title || t.title;
      let status=w.state;
      if(status==='idle') {
        if(!w.completeScan){t.idle=0;continue}
        t.idle++;
        if(t.idle<2)continue;
        if(t.status==='done')continue;
        status=w.identityReliable===false?'unobserved':'done';
      }else{t.idle=0}
      if(!['running','needs_action','done','unobserved'].includes(status))continue;
      if(t.status===status && status!=='running')continue;
      t.status=status;
      events.push({source:t.source,session:'chat-'+key,observationKey:key,stateSource:'chat-observer',taskKind:'chat',title:t.title,status,
        reason:status==='done'?'observed-ready':'observed-ui',message:status==='needs_action'?'This chat needs your input in the app.':status==='unobserved'?'Chat identity unavailable · status unknown':''});
    }
    for(const [key,t] of tracked){
      if(seen.has(key)||!['running','needs_action'].includes(t.status))continue;
      if(++t.misses<3 && snapshot.health==='ok')continue;
      t.status='unobserved';t.idle=0;
      events.push({source:t.source,session:'chat-'+key,observationKey:key,stateSource:'chat-observer',taskKind:'chat',title:t.title,status:'unobserved',
        message:snapshot.health==='locked'?'Mac locked · status unavailable':snapshot.health==='permission_required'?'Enable chat tracking on your Mac':'Chat is not visible · status unavailable'});
    }
    return events;
  };
}
function createChatWatcher({onEvent,onHealth,seed=[]}) {
  const reduce=createTracker(seed);let busy=false;
  const app=path.join(__dirname,'ChatObserver.app');
  return function scan(){
    if(busy||process.env.CHAT_WATCH==='off')return;
    busy=true;
    // LaunchServices keeps Accessibility attached to the app the user enabled.
    // Spawning its executable directly instead inherits the Node host identity.
    let directory;
    const finish = snapshot => {
      busy=false;
      onHealth({status:snapshot.health,accessGranted:snapshot.accessGranted??(snapshot.health==='ok'),checkedAt:Date.now(),observedWindows:(snapshot.windows||[]).length});
      for(const event of reduce(snapshot))onEvent(event);
    };
    try {
      directory=fs.mkdtempSync(path.join(os.tmpdir(),'agent-monitor-chat-'));
      const output=path.join(directory,'snapshot.json');
      fs.writeFileSync(output,'',{mode:0o600});
      execFile('/usr/bin/open',['-g','-n','-W','--stdout',output,'--stderr','/dev/null',app],{timeout:10000},error=>{
        let snapshot;
        // A fast-exiting app can make open -W report a PID error after writing a valid snapshot.
        try { snapshot=JSON.parse(fs.readFileSync(output,'utf8')); }
        catch {snapshot={health:fs.existsSync(app)?'unavailable':'not_installed',windows:[]};}
        finally {fs.rmSync(directory,{recursive:true,force:true});}
        finish(snapshot);
      });
    } catch {if(directory)fs.rmSync(directory,{recursive:true,force:true});finish({health:'unavailable',windows:[]});}
  };
}
module.exports={createTracker,createChatWatcher,keyFor};
