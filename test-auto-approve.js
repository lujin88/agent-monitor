// Auto-approval rules: what approve.js may approve without asking, and what always goes to the iPad.
// No command is executed; payloads are synthetic.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const { EventEmitter } = require('events');
const { classify } = require('./auto-approve');
const P = '/Users/test/projects/demo';
const env = {};
const bash = (command, extra = {}) => classify({ tool_name: 'Bash', cwd: P, tool_input: { command }, ...extra }, env);
const tool = (tool_name, tool_input, cwd = P) => classify({ tool_name, cwd, tool_input }, env);

const allowed = [
  'ls -la', 'git status', 'git diff --stat', 'git log --oneline -5', 'cat README.md', 'grep -rn "TODO" src',
  "grep -E 'foo$' a.js", 'node test-server-state.js', 'npm test', 'npm run build', 'python3 scripts/check.py',
  'git add server.js && git commit -m "Fix prune"', 'mkdir -p dist && cp a.js dist/a.js', 'cd src && ls',
  'node --check app.js 2>&1', 'pytest -q >/dev/null', 'FOO=1 node app.js', 'find . -name "x.js"', 'sed -n 1,20p a.js',
  'git switch -c feature', 'git --no-pager diff', 'wc -l a.js | sort -n', 'pnpm test',
  'git pull --ff-only', 'git ls-remote --heads origin feat/no-tank',
  'git ls-remote origin', 'git ls-remote --tags upstream v1',
  'git --no-pager ls-remote --heads --exit-code origin main',
];
const asked = [
  'rm a.js', 'rm -rf build', 'sudo ls', 'git push', 'git push origin main', 'git reset --hard', 'git clean -fd',
  'git checkout -- .', 'git checkout .', 'git restore a.js', 'git commit --amend -m x', 'git branch -D old', 'git stash drop',
  'git -c core.fsmonitor=x status', 'git -C /etc status', 'git log --output=/tmp/x', 'git pull', 'git fetch', 'git rebase main',
  'npm install', 'npm i left-pad', 'npm ci', 'npm publish', 'npx create-app', 'yarn', 'pip install x', 'python3 -m pip install x',
  'curl https://x.y', 'wget x', 'ssh host', 'cat ~/.ssh/id_rsa', 'cat /etc/passwd', 'ls ..', 'cd .. && ls', 'cp a.js /tmp/a.js',
  'node /tmp/evil.js', 'echo $HOME', 'echo `id`', 'echo $(id)', 'ls *.js', 'echo hi > a.txt', 'cat < a.txt', 'sleep 100 &',
  'ls | xargs rm', 'cat a | sh', 'find . -delete', 'find . -exec rm {} ;', 'sed -i "" s/a/b/ /tmp/x', 'PATH=/tmp node a.js',
  'NODE_OPTIONS=--require=./x node a.js', 'git add -A --force', 'chmod +x a.sh', 'kill 123', 'open .', 'osascript -e x',
  'security find-generic-password', 'tail -f server.log', "awk 'BEGIN{system(\"id\")}'", 'cp a.js .git/hooks/pre-commit',
  'touch .git/hooks/post-checkout', 'ls\nrm a', 'brew install x', '', 'echo "unterminated',
  'git pull --ff-only --rebase', 'git pull --ff-only origin main', 'git pull --ff-only --force',
  'git -c core.hooksPath=/tmp pull --ff-only', 'git pull --ff-only && git push',
  'git ls-remote --upload-pack=evil origin', 'git ls-remote origin --upload-pack=evil',
  'git ls-remote https://example.com/repo', 'git ls-remote ext::evil',
  'git ls-remote /tmp/repo', 'git ls-remote --heads', 'git ls-remote origin ../other',
  'git -c core.sshCommand=evil ls-remote origin',
];
for (const c of allowed) assert.equal(bash(c).allow, true, 'should auto-approve: ' + c + ' (' + bash(c).reason + ')');
for (const c of asked) assert.equal(bash(c).allow, false, 'should ask: ' + JSON.stringify(c));

// Tools
assert.equal(tool('Read', { file_path: P + '/a.js' }).allow, true);
assert.equal(tool('Read', { file_path: '/Users/test/.ssh/id_rsa' }).allow, false, 'reading outside the project asks');
assert.equal(tool('Grep', { pattern: 'x' }).allow, true);
assert.equal(tool('Edit', { file_path: P + '/src/a.js' }).allow, true);
assert.equal(tool('Write', { file_path: 'notes/new.md' }).allow, true, 'relative paths resolve inside the project');
assert.equal(tool('Write', { file_path: P + '/../other/a.js' }).allow, false);
assert.equal(tool('Write', { file_path: '/Users/test/.zshrc' }).allow, false);
assert.equal(tool('Edit', { file_path: P + '/.git/config' }).allow, false, '.git is never edited automatically');
assert.equal(tool('Edit', {}).allow, false);
assert.equal(tool('WebFetch', { url: 'https://x.y' }).allow, false, 'network tools ask');
assert.equal(tool('mcp__github__create_pr', {}).allow, false, 'MCP tools ask');
const resizeName = 'mcp__chrome_devtools__resize_page';
const resizeInput = { pageId: 2, width: 1440, height: 1120 };
assert.equal(tool(resizeName, resizeInput).allow, true, 'exact screenshot request');
for (const input of [null, [], {}, { ...resizeInput, width: '1440' },
  { ...resizeInput, width: 0 }, { ...resizeInput, height: -1 },
  { ...resizeInput, width: 8193 }, { ...resizeInput, height: 1.5 },
  { ...resizeInput, pageId: -1 }, { ...resizeInput, pageId: '2' },
  { ...resizeInput, url: 'https://example.com' }, { ...resizeInput, filePath: '/tmp/output' }]) {
  assert.equal(tool(resizeName, input).allow, false, 'invalid/expanded resize asks');
}
assert.equal(classify({ tool_name: resizeName, cwd: P, tool_input: resizeInput }, { AUTO_APPROVE: 'off' }).allow, false);
assert.equal(tool('mcp__other__resize_page', resizeInput).allow, false);
const browserConvenience = [
  ['mcp__chrome_devtools__select_page', { pageId: 2 }],
  ['mcp__chrome_devtools__select_page', { pageId: 2, bringToFront: true }],
  ['mcp__chrome_devtools__wait_for', { pageId: 2, text: ['Ready'], timeout: 60000 }],
  ['mcp__chrome_devtools__wait_for', { pageId: 2, text: ['Ready'] }],
];
for (const [name, input] of browserConvenience) {
  assert.equal(tool(name, input).allow, true);
  assert.equal(classify({ tool_name: name, tool_input: input }, env).allow, true, 'browser operations need no cwd');
  assert.equal(tool(name, { ...input, unknown: true }).allow, false);
  assert.equal(tool(name, { ...input, pageId: '2' }).allow, false);
  assert.equal(tool(name, null).allow, false);
  assert.equal(classify({ tool_name: name, tool_input: input }, { AUTO_APPROVE: 'off' }).allow, false);
}
assert.equal(tool('mcp__chrome_devtools__select_page', { pageId: 2, bringToFront: 'yes' }).allow, false);
for (const text of [[], [''], 'Ready', [42]]) {
  assert.equal(tool('mcp__chrome_devtools__wait_for', { pageId: 2, text }).allow, false);
}
for (const timeout of [-1, 60001, '1000', 1.5]) {
  assert.equal(tool('mcp__chrome_devtools__wait_for', { pageId: 2, text: ['Ready'], timeout }).allow, false);
}
assert.equal(tool(resizeName, resizeInput, os.homedir()).allow, true);
assert.equal(classify({ tool_name: 'mcp__chrome_devtools__list_pages', tool_input: {} }, env).allow, true);
// Exact, observation-only Chrome DevTools tools. No navigation, scripts, clicks,
// file output, lookalike providers, or new options are implicitly authorized.
for (const name of ['list_pages', 'take_snapshot', 'take_screenshot', 'list_console_messages',
  'get_console_message', 'list_network_requests', 'get_network_request']) {
  const input = name === 'list_pages' ? {} : { pageId: 1 };
  const browserTool = 'mcp__chrome_devtools__' + name;
  assert.equal(tool(browserTool, input).allow, true, name);
  assert.equal(tool(browserTool, { ...input, filePath: '/tmp/output' }).allow, false);
  assert.equal(tool(browserTool, { ...input, futureOption: true }).allow, false);
  assert.equal(tool(browserTool, null).allow, false);
  assert.equal(tool(browserTool, []).allow, false);
  assert.equal(classify({ tool_name: browserTool, cwd: P, tool_input: input }, { AUTO_APPROVE: 'off' }).allow, false);
}
for (const name of ['new_page', 'navigate_page', 'evaluate_script', 'click', 'fill', 'upload_file', 'close_page']) {
  assert.equal(tool('mcp__chrome_devtools__' + name, {}).allow, false, name + ' still asks');
}
assert.equal(tool('mcp__other__list_pages', {}).allow, false);
assert.equal(tool('mcp__chrome_devtools__get_network_request', { pageId: 1, requestFilePath: 'request.txt' }).allow, false);
assert.equal(tool('mcp__chrome_devtools__get_network_request', { pageId: 1, responseFilePath: 'response.txt' }).allow, false);
assert.equal(tool('Bash', { command: 'ls' }, '/').allow, false, 'no project folder: ask');
assert.equal(tool('Bash', { command: 'ls' }, os.homedir()).allow, false, 'home folder is not a project');
assert.equal(tool('Bash', { command: 'ls' }, 'relative/dir').allow, false);
assert.equal(classify({ tool_name: 'Bash', tool_input: { command: 'ls' } }, env).allow, false, 'missing cwd asks');
// Codex-style array commands
assert.equal(tool('shell', { command: ['bash', '-lc', 'git status'] }).allow, true);
assert.equal(tool('shell', { command: ['bash', '-lc', 'rm -rf x'] }).allow, false);
assert.equal(tool('shell', { command: ['git', 'status'] }).allow, true);
assert.equal(tool('shell', { command: ['ls'], workdir: '/tmp' }).allow, false, 'workdir outside the project asks');
// Switch
assert.equal(classify({ tool_name: 'Bash', cwd: P, tool_input: { command: 'ls' } }, { AUTO_APPROVE: 'off' }).allow, false);
// Never throws
for (const bad of [null, 5, 'x', {}, { tool_name: 'Bash', cwd: P, tool_input: null }, { tool_name: 'Bash', cwd: P, tool_input: { command: 'x'.repeat(5000) } }]) assert.equal(classify(bad, env).allow, false);

// End to end inside approve.js: an auto-approved request prints "allow" without contacting the
// Dashboard, and the log line never contains the command.
function runHook(payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-approve-'));
  const requests = []; let printed = '', exited = false;
  const stdin = new EventEmitter(); stdin.setEncoding = () => {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'approve.js'), 'utf8'), {
    require(name) {
      if (name === 'http') return { request(options) { const r = { options, on() {}, end(b) { r.body = JSON.parse(b); } }; requests.push(r); return r; } };
      if (name === './auto-approve') return require('./auto-approve');
      return require(name);
    },
    __dirname: dir, URL, Buffer, setTimeout: () => 0,
    process: { argv: ['node', 'approve.js', 'claude'], env: {}, stdin, stdout: { on() {}, write(s, cb) { printed += s; if (cb) cb(); } }, exit() { exited = true; } },
  });
  stdin.emit('data', JSON.stringify(payload)); stdin.emit('end');
  let log = ''; try { log = fs.readFileSync(path.join(dir, 'auto-approve.log'), 'utf8'); } catch (_) {}
  return { requests, printed, exited, log };
}
const auto = runHook({ session_id: 's', cwd: P, tool_name: 'Bash', tool_input: { command: 'git status --short secret-arg-7731' } });
assert.equal(auto.requests.length, 0, 'auto-approved request never reaches the Dashboard');
assert.deepEqual(JSON.parse(auto.printed).hookSpecificOutput.decision, { behavior: 'allow' });
assert(auto.exited);
assert(auto.log.includes('"rule":"read-only command"') && auto.log.includes('"project":"demo"'));
assert(!auto.log.includes('secret-arg-7731'), 'command text is not logged');
const ask = runHook({ session_id: 's', cwd: P, tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
for (const command of ['git pull --ff-only', 'git ls-remote --heads origin feat/no-tank']) {
  const result = runHook({ session_id: 's', cwd: P, tool_name: 'Bash', tool_input: { command } });
  assert.equal(result.requests.length, 0, 'routine Git request skips Dashboard');
  assert.equal(JSON.parse(result.printed).hookSpecificOutput.decision.behavior, 'allow');
  assert.equal(classify({ cwd: P, tool_name: 'Bash', tool_input: { command } }, { AUTO_APPROVE: 'off' }).allow, false);
}
const browserAuto = runHook({ session_id: 's', cwd: P, tool_name: 'mcp__chrome_devtools__take_snapshot', tool_input: { pageId: 1 } });
const resizeAuto = runHook({ session_id: 's', cwd: P, tool_name: resizeName, tool_input: resizeInput });
assert.equal(resizeAuto.requests.length, 0, 'resize never reaches Dashboard');
assert.equal(JSON.parse(resizeAuto.printed).hookSpecificOutput.decision.behavior, 'allow');
assert(resizeAuto.log.includes('browser window resize'));
for (const [name, input] of browserConvenience) {
  const result = runHook({ session_id: 's', tool_name: name, tool_input: input });
  assert.equal(result.requests.length, 0, 'browser convenience skips Dashboard without cwd');
  assert.equal(JSON.parse(result.printed).hookSpecificOutput.decision.behavior, 'allow');
}
assert.equal(browserAuto.requests.length, 0, 'browser inspection never reaches Dashboard');
assert.equal(JSON.parse(browserAuto.printed).hookSpecificOutput.decision.behavior, 'allow');
assert.equal(ask.requests.length, 1); assert.equal(ask.requests[0].options.path, '/ask'); assert.equal(ask.printed, '');
assert.equal(ask.log, '', 'nothing logged when asking');
const question = runHook({ session_id: 's', cwd: P, tool_name: 'AskUserQuestion', tool_input: {} });
assert.equal(question.printed, '', 'questions are never answered automatically');

console.log(`Auto-approve passed: ${allowed.length} commands approved, ${asked.length} still asked, tools inside/outside the project, Codex arrays, off switch, no command text in the log, questions never answered.`);
