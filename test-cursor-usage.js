const assert = require('assert/strict');
const crypto = require('crypto');
const { cursorWindows, createCursorPoller, plainToken, deriveSafeKey, SAFE_PREFIX } = require('./cursor-usage');
function encryptLikeCursor(text, password) {
  const c = crypto.createCipheriv('aes-128-cbc', deriveSafeKey(password), Buffer.alloc(16, ' '));
  return SAFE_PREFIX + Buffer.concat([Buffer.from('v10'), c.update(text, 'utf8'), c.final()]).toString('base64');
}
(async () => {
  const data = { enabled: true, billingCycleEnd: '1792186211000', planUsage: { autoPercentUsed: 98.93416666666667, apiPercentUsed: 27.036363636363635, totalPercentUsed: 92.89 } };
  const windows = cursorWindows(data);
  assert.deepEqual(windows.map(w => Math.round(w.usedPercent)), [99, 27]);
  assert(windows.every(w => w.resetsAt === 1792186211));
  assert.deepEqual(cursorWindows({ planUsage: { autoPercentUsed: 0, apiPercentUsed: 100 } }).map(w => w.usedPercent), [0, 100]);
  assert.deepEqual(cursorWindows({ planUsage: { autoPercentUsed: null, apiPercentUsed: '27' } }), []);
  assert.deepEqual(cursorWindows({ ...data, enabled: false }), []);
  assert.deepEqual(cursorWindows({}), []);
  assert.equal(cursorWindows({ planUsage: { includedSpend: 25, limit: 100 } })[0].usedPercent, 25);
  let saved, status, calls = 0, release;
  const poll = createCursorPoller({ onUsage: w => saved = w, onStatus: s => status = s, readUsage: () => { calls++; return new Promise(r => release = r); } });
  const first = poll(); await poll(); assert.equal(calls, 1, 'polls must not overlap');
  release(windows); await first; assert.equal(status, 'ok'); assert.deepEqual(saved, windows);
  const failed = createCursorPoller({ onUsage: w => saved = w, onStatus: s => status = s, readUsage: async () => { throw Object.assign(new Error('private response must not leak'), {status:'missing'}); } });
  await failed(); assert.equal(status, 'missing'); assert.deepEqual(saved, windows, 'keep last successful reading after transient failure');
  // Cursor 3.x encrypted-at-rest token: decrypted with the Keychain key, asked for once.
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhdXRoMHx1c2VyIn0.sig';
  const stored = encryptLikeCursor(jwt, 'keychain-secret');
  let asks = 0; const readPassword = async () => { asks++; return 'keychain-secret'; };
  const both = await Promise.all([plainToken(stored, { readPassword }), plainToken(stored, { readPassword })]);
  assert.deepEqual(both, [jwt, jwt]); assert.equal(asks, 1, 'parallel polls share one Keychain read');
  assert.equal(await plainToken(stored, { readPassword }), jwt); assert.equal(asks, 1, 'derived key is reused');
  assert.equal(await plainToken(jwt, { readPassword: async () => { throw Error('not needed'); } }), jwt, 'plain JWTs pass through');
  await assert.rejects(plainToken(encryptLikeCursor(jwt, 'other'), { readPassword }), e => e.status === 'keychain', 'wrong key reports keychain, never leaks');
  await assert.rejects(plainToken(stored, { readPassword: async () => { throw Object.assign(Error('denied'), { status: 'keychain' }); } }), e => e.status === 'keychain');
  console.log('Cursor usage regression tests passed (incl. encrypted-at-rest token)');
})().catch(e => { console.error(e); process.exitCode = 1; });
