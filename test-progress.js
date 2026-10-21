const assert=require('assert'),{consume,reconciliation}=require('./codex-watch');
const now=Date.now(),a={},b={};
const record=(type,at,turn='one',item)=>({type:'event_msg',timestamp:new Date(at).toISOString(),payload:{type,turn_id:turn,item}});
for(const [id,s] of [['a',a],['b',b]]){consume({type:'session_meta',payload:{id,source:'vscode',cwd:'/tmp/test'}},s);consume(record('task_started',now),s)}
consume(record('item_completed',now+1,'one',{type:'CommandExecution',id:'command-1',command:'PRIVATE',stdout:'PRIVATE'}),a);
consume(record('item_completed',now+2,'one',{type:'Reasoning',id:'reason',raw_content:'PRIVATE'}),a);
consume(record('item_completed',now+3,'one',{type:'AgentMessage',id:'message',content:'PRIVATE'}),a);
consume(record('item_completed',now+4,'one',{type:'CommandExecution',id:'command-1'}),a);
assert.equal(a.progress.completedActions,1);assert.equal(b.progress.completedActions,0);
consume(record('item_completed',now+5,'old',{type:'McpToolCall',id:'old'}),a);assert.equal(a.progress.completedActions,1);
assert(!JSON.stringify(a.progress).includes('PRIVATE'));
assert.equal(reconciliation(a,undefined,now+10).progress.completedActions,1);
assert.equal(reconciliation(a,{approval:{aid:'real'},updatedAt:now},now+10),null);
consume(record('task_started',now+20,'two'),a);assert.equal(a.progress.completedActions,0);
consume(record('item_completed',now+21,'two',{type:'ImageView',id:'image'}),a);assert.equal(a.progress.lastActivity,'Image reviewed');
console.log('Local progress verified: independent counters inside groups, deduplication, turn reset, stale-turn rejection, approval priority, no message/command/reasoning content.');
