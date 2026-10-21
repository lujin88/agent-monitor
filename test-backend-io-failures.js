// Deterministic I/O failures; no real network, credentials or production files.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

function checkWriterCleanup() {
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const writes = [], unlinks = [], renames = [], errors = [];
  const context = {
    process: { pid: 123 }, path,
    console: { error: (...args) => errors.push(args.join(' ')) },
    fs: {
      writeFile(file, data, options, cb) { writes.push({ file, data, options, cb }); },
      unlink(file, cb) { unlinks.push({ file, cb }); },
      rename(from, to, cb) { renames.push({ from, to, cb }); },
    },
  };
  vm.createContext(context);
  vm.runInContext(src.slice(src.indexOf('const writers ='), src.indexOf('\nlet sessions =')), context);
  context.writeJson('/synthetic/state.json', '{"version":1}');
  context.writeJson('/synthetic/state.json', '{"version":2}');
  assert.equal(writes.length, 1);
  writes[0].cb(Object.assign(new Error('private payload must not be logged'), { code: 'ENOSPC' }));
  assert.equal(unlinks.length, 1);
  assert.equal(writes.length, 1, 'failed write cleanup must finish before reusing its temp path');
  unlinks[0].cb(null);
  assert.equal(writes.length, 2);
  writes[1].cb(null);
  assert.equal(renames.length, 1);
  renames[0].cb(null);
  assert.equal(writes[1].data, '{"version":2}');
  assert(errors.some(x => x.includes('state.json') && x.includes('ENOSPC')), 'failure is diagnosable without data');
  assert(!errors.join('').includes('private payload'));

  // A failed rename has the same cleanup ordering guarantee.
  context.writeJson('/synthetic/state.json', '{"version":3}');
  context.writeJson('/synthetic/state.json', '{"version":4}');
  writes[2].cb(null);
  renames[1].cb(Object.assign(new Error('private path'), { code: 'EACCES' }));
  assert.equal(writes.length, 3);
  unlinks[1].cb(null);
  assert.equal(writes.length, 4);
  writes[3].cb(null); renames[2].cb(null);
}

// Shutdown flush: a final snapshot queued behind an in-progress write (with an older
// state already queued) replaces the older state, and draining waits for it to land.
async function checkShutdownDrain() {
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const writes = [], unlinks = [], renames = [], disk = {};
  const context = {
    process: { pid: 7 }, path, console: { error() {} },
    fs: {
      writeFile(file, data, options, cb) { writes.push({ file, data, options, cb }); },
      unlink(file, cb) { unlinks.push({ file, cb }); },
      rename(from, to, cb) { renames.push({ from, to, cb }); },
    },
  };
  vm.createContext(context);
  vm.runInContext(src.slice(src.indexOf('const writers ='), src.indexOf('\nlet sessions =')), context);
  const tick = () => new Promise(r => setImmediate(r));
  const land = (i) => { writes[i].cb(null); renames.at(-1).cb(null); disk[renames.at(-1).to] = writes[i].data; };

  context.writeJson('/synthetic/state.json', '{"v":1}');        // in progress
  context.writeJson('/synthetic/state.json', '{"v":2}');        // newer state queued
  context.writeJson('/synthetic/state.json', '{"v":"final"}');  // shutdown snapshot
  let result = null;
  context.drainWrites().then(r => { result = r; });
  await tick();
  assert.equal(result, null, 'drain must wait for the in-progress write');
  assert.equal(writes[0].options.mode, 0o600, 'temp file is private');
  land(0);
  await tick();
  assert.equal(result, null, 'drain must also wait for the queued final snapshot');
  assert.equal(writes.length, 2, 'the superseded queued state is never written');
  assert.equal(writes[1].data, '{"v":"final"}');
  land(1);
  await tick();
  assert.deepEqual([...result], [], 'all saved');
  assert.equal(disk['/synthetic/state.json'], '{"v":"final"}', 'latest snapshot wins');

  // A failed final save is reported by file name, not silently treated as saved.
  context.writeJson('/synthetic/usage.json', '{"u":1}');
  result = null;
  context.drainWrites().then(r => { result = r; });
  writes[2].cb(Object.assign(new Error('x'), { code: 'ENOSPC' }));
  unlinks[0].cb(null);
  await tick();
  assert.deepEqual([...result], ['usage.json']);
  // An idle queue resolves immediately.
  result = null;
  context.drainWrites().then(r => { result = r; });
  await tick();
  assert.deepEqual([...result], ['usage.json'], 'the last write of usage.json failed and stays reported');
}

async function checkGrokRosterDeadline() {
  const timers = [], requests = [];
  const ctx = {
    module: { exports: {} }, Buffer,
    setTimeout(fn, ms) { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimeout(timer) { timer.cleared = true; },
    require(name) {
      if (name === 'https') return { request(url, options, cb) {
        const req = new EventEmitter();
        req.end = () => {};
        req.setTimeout = () => {}; // socket timeout never starts before a connection exists
        req.destroy = () => { req.destroyed = true; req.emit('close'); };
        requests.push(req); return req;
      }};
      if (name === './cursor-usage') return {};
      if (name === './grok-usage') return {};
      return require(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'grok-watch.js'), 'utf8') + '\nmodule.exports.testRoster = roster;', ctx);
  let settled = false;
  const pending = ctx.module.exports.testRoster('synthetic').then(x => { settled = true; return x; });
  assert.equal(timers.length, 1, 'roster needs a wall-clock deadline even if DNS/TLS never connects');
  timers[0].fn();
  const result = await pending;
  assert(settled, 'deadline settles roster so reconnect can proceed');
  assert.equal(result.size, 0);
  assert(requests[0].destroyed);
  assert(timers[0].cleared);
}
(async () => {
  checkWriterCleanup();
  await checkShutdownDrain();
  await checkGrokRosterDeadline();
  console.log('Backend I/O failure tests passed: write/rename cleanup ordering, shutdown drain with latest snapshot and failed save, Grok pre-connection deadline.');
})().catch(error => { console.error(error); process.exitCode = 1; });
