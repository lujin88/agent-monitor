const assert=require('assert');const {createTracker}=require('./chat-watch');
const w=(state,extra={})=>({source:'claude',identity:'native:claude:conversation-1',title:'A normal conversation',state,completeScan:true,...extra});
const frame=(...windows)=>({health:'ok',windows});
const reduce=createTracker();
assert.deepEqual(reduce(frame(w('idle'))),[],'Old chats are not imported as completions');
assert.equal(reduce(frame(w('running')))[0].status,'running');
assert.deepEqual(reduce(frame()),[]);assert.deepEqual(reduce(frame()),[]);
assert.equal(reduce(frame())[0].status,'unobserved','Missing UI is not task completion');
assert.equal(reduce(frame(w('running')))[0].status,'running');
assert.deepEqual(reduce(frame(w('idle',{completeScan:false}))),[]);
assert.deepEqual(reduce(frame(w('idle'))),[]);
assert.equal(reduce(frame(w('idle')))[0].status,'done','Two complete idle observations confirm the end of a response');
assert.deepEqual(reduce(frame(w('idle'))),[]);
assert.equal(reduce(frame(w('needs_action')))[0].status,'needs_action');
assert.equal(reduce({health:'locked',windows:[]})[0].status,'unobserved');
assert.equal(reduce(frame(w('running')))[0].status,'running');
assert.equal(reduce({health:'permission_required',windows:[]})[0].status,'unobserved');
const multi=createTracker();assert.equal(multi(frame(w('running'),w('running',{source:'gpt',identity:'chatgpt:second'}))).length,2);
console.log('Chat observer state tests passed (start, confirmed end, parallel chats, partial scan, lock, and missing permission).');

const ambiguous=createTracker();ambiguous(frame(w('running',{identityReliable:false})));ambiguous(frame(w('idle',{identityReliable:false})));assert.equal(ambiguous(frame(w('idle',{identityReliable:false})))[0].status,'unobserved');

const wait=createTracker();assert.equal(wait(frame(w('needs_action'))).length,1);assert.deepEqual(wait(frame(w('needs_action'))),[],'Waiting for input should not produce repeat alerts');
