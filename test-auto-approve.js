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

const gitRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-c-policy-')));
const previewRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'preview-policy-')));
try {
  const command = 'npm install --prefix work/local-preview react react-dom esbuild --no-audit --no-fund';
  const request = cmd => ({ cwd: previewRoot, tool_name: 'Bash', tool_input: { command: cmd } });
  assert.equal(classify(request(command), env).allow, true);
  assert.equal(runHook(request(command)).requests.length, 0);
  assert.equal(classify(request(command), { AUTO_APPROVE: 'off' }).allow, false);
  for (const cmd of [command + ' extra-package', command + ' --global', command + ' && npm publish',
    command.replace('work/local-preview', '/tmp/preview'), command.replace('react-dom', 'unknown'),
    'npm_config_registry=https://example.com ' + command, command + ' --registry=https://example.com',
    command + ';', command + ' --force']) assert.equal(classify(request(cmd), env).allow, false, cmd);
  fs.symlinkSync(path.dirname(previewRoot), path.join(previewRoot, 'work'));
  assert.equal(classify(request(command), env).allow, false, 'outward symlink asks');
  fs.unlinkSync(path.join(previewRoot, 'work'));
  fs.symlinkSync(path.join(previewRoot, 'missing'), path.join(previewRoot, 'work'));
  assert.equal(classify(request(command), env).allow, false, 'broken symlink asks');
} finally { fs.rmSync(previewRoot, { recursive: true, force: true }); }
try {
  fs.mkdirSync(path.join(gitRoot, 'REPOS', 'harness-core'), { recursive: true });
  fs.mkdirSync(path.join(gitRoot, 'repo with spaces'));
  fs.symlinkSync(path.dirname(gitRoot), path.join(gitRoot, 'outside'));
  const check = command => classify({ cwd: gitRoot, tool_name: 'Bash', tool_input: { command } }, env).allow;
  for (const command of [
    'git -C REPOS/harness-core pull --ff-only',
    'git --no-pager -C REPOS/harness-core diff --stat',
    'git -C REPOS -C harness-core status',
    "git -C 'repo with spaces' status",
    'git -C REPOS/harness-core ls-remote --heads origin main',
    'git -C REPOS/harness-core status && ls REPOS',
  ]) assert.equal(check(command), true, command);
  for (const command of [
    'git -C .. status', 'git -C outside status', 'git -C missing status',
    'git -C REPOS/harness-core push', 'git -C REPOS/harness-core pull',
    'git -C REPOS/harness-core reset --hard',
    'git -C REPOS/harness-core -c core.sshCommand=evil pull --ff-only',
    'git -C REPOS/harness-core status && git push',
    'git -C REPOS/harness-core -C ../../.. status',
    'git -C REPOS/harness-core/.git status', 'git -C', 'git -C --no-pager status',
  ]) assert.equal(check(command), false, command);
  const request = { cwd: gitRoot, tool_name: 'Bash', tool_input: { command: 'git -C REPOS/harness-core pull --ff-only' } };
  assert.equal(runHook(request).requests.length, 0);
  assert.equal(classify(request, { AUTO_APPROVE: 'off' }).allow, false);
} finally { fs.rmSync(gitRoot, { recursive: true, force: true }); }


// Tightened rules (agent-monitor security fix). Normal development commands still pass;
// the requests below go to the normal approval instead of being approved automatically.
const routineDev = [
  'node script.js', 'node scripts/build.js --watch', 'node --test', 'node --check app.js', 'node script.js -e x -p 3000',
  'node -r ./setup.js script.js', 'npm run build', 'npm test', 'python3 tool.py', 'python3 -m pytest -q',
  'python -u tools/check.py --out dist/x.json', 'ruby script.rb', 'bun run build', 'bun test', 'deno run main.ts',
  'deno test', 'make', 'make test', 'cat data.json | node scripts/parse.js', 'cat a.txt | python3 tool.py',
  'git commit -m "Update settings handling"', 'cat .claude/settings.json', 'ls .codex',
  'tsc --outDir=dist', 'cp a.js dist/a.js', 'git commit -m "' + 'long message '.repeat(30) + '"', 'node build.js --name=' + 'x'.repeat(300),
];
for (const c of routineDev) assert.equal(bash(c).allow, true, 'routine command must stay automatic: ' + c + ' (' + bash(c).reason + ')');
const inline = [
  'node -e "require(1)"', "node -e 'x'", 'node --eval x', 'node --eval=x', 'node -p 1+1', 'node --print 1', 'node -pe 1',
  'node -r ./setup.js -e x', 'node --input-type module -e x', 'node -', 'echo x | node', 'cat a.js | node -',
  'python -c "print(1)"', 'python3 -c x', 'python3 -Bc x', 'python3 -W ignore -c x', 'python3 -Wonce -c x',
  'python3 -', 'echo x | python3', 'ruby -e x', 'ruby -ne x', 'ruby -rjson -e x', 'deno eval x', 'deno repl',
  'echo x | deno run -', 'bun -e x', 'bun --eval x', 'bun -p 1', 'bun --print 1', 'ls && node -e x',
  'git status; python3 -c x',
];
for (const c of inline) {
  const r = bash(c);
  assert.equal(r.allow, false, 'inline code should ask: ' + c);
}
assert.equal(bash('node -e x').reason, 'runs inline code');
const agentConfig = [
  'mkdir .claude', 'touch .claude/settings.json', 'cp x.json .claude/settings.local.json', 'sed -i "" s/a/b/ .codex/config.toml',
  'cp a.json settings.json', 'cp a.json config/settings.dev.json', 'cp a.json hooks.json', 'mv a .CLAUDE/b',
  'cd .claude && touch x', 'git add .claude/settings.json',
];
for (const c of agentConfig) assert.equal(bash(c).allow, false, 'agent config write should ask: ' + c);
for (const f of ['.claude/settings.json', '.claude/settings.local.json', '.codex/config.toml', 'sub/.claude/agents/a.md',
  'settings.json', 'app/settings.local.json', 'hooks.json', '.Claude/x']) {
  assert.equal(tool('Write', { file_path: P + '/' + f }).allow, false, 'edit of agent config should ask: ' + f);
  assert.equal(tool('Edit', { file_path: f }).allow, false, 'relative edit of agent config should ask: ' + f);
}
assert.equal(tool('Read', { file_path: P + '/.claude/settings.json' }).allow, true, 'reading settings stays automatic');
assert.equal(tool('Write', { file_path: P + '/src/config.json' }).allow, true, 'other JSON stays automatic');
// The case from the review: the agent's project folder is ~/.buzz, which contains .claude/settings.json.
const buzzHome = '/Users/test/.buzz';
assert.equal(tool('Edit', { file_path: buzzHome + '/.claude/settings.json' }, buzzHome).allow, false);
assert.equal(classify({ tool_name: 'Bash', cwd: buzzHome, tool_input: { command: 'cp x .claude/settings.json' } }, env).allow, false);
// External feedback (GitHub): long-form delete/rename options slipped past the short-flag
// guard and were approved as read-only. Only listing forms of branch/tag stay automatic.
const gitListing = ['git branch', 'git branch -a', 'git branch -r', 'git branch -v', 'git branch -vv', 'git branch -av',
  'git branch --show-current', 'git branch --list', 'git branch --list "feat/*"', 'git branch -l', 'git branch --all',
  'git branch --contains HEAD', 'git branch --merged main', 'git branch --no-merged', 'git --no-pager branch -a',
  'git tag', 'git tag -l', 'git tag --list "v1.*"', 'git tag -n5', 'git tag --contains HEAD', 'git tag --points-at HEAD'];
for (const c of gitListing) assert.equal(bash(c).allow, true, 'listing stays automatic: ' + c + ' (' + bash(c).reason + ')');
const gitChanges = ['git branch --delete x', 'git branch --delete --force x', 'git branch --move a b', 'git branch --move b',
  'git branch --copy a b', 'git branch --copy b', 'git branch -d x', 'git branch -D x', 'git branch -m a b', 'git branch -M a b',
  'git branch -c a b', 'git branch -C a b', 'git branch -f x HEAD', 'git branch --force x HEAD', 'git branch new-name',
  'git branch new-name main', 'git branch -u origin/x', 'git branch --set-upstream-to=origin/x', 'git branch --unset-upstream',
  'git branch --edit-description', 'git branch -l -d x', 'git branch --list x --delete', 'git branch -- x',
  'git tag --delete v1', 'git tag -d v1', 'git tag v2', 'git tag v2 HEAD', 'git tag -a v2 -m x', 'git tag --annotate v2',
  'git tag -f v1', 'git tag --force v1', 'git tag -s v2', 'git --no-pager tag --delete v1'];
for (const c of gitChanges) assert.equal(bash(c).allow, false, 'branch/tag change should ask: ' + c);

// QA-reproduced bypasses (review of ceb0fe1): one step writes outside the project,
// runs a command, or throws away uncommitted work. All go to the normal approval.
const qaBypasses = [
  'cd && cp a.js x', 'cd', 'cd -', 'cd && cp a.js .zshrc', 'cd -- && touch x',
  "sed -n 'w /tmp/x' a.js", "sed -n '1w out.txt' a.js", "sed 'W /tmp/x' a.js", "sed 's/a/b/w /tmp/x' a.js",
  "sed 's/a/b/e' a.js", "sed -e 'e id' a.js", "sed -n -e 1p -e 'w /tmp/x' a.js", "sed --expression='w /tmp/x' a.js",
  "sed 'r /etc/passwd' a.js", 'sed -f script.sed a.js', "sed -i '' '1w /tmp/x' a.js",
  'sort -o/tmp/x a.txt', 'sort -o /tmp/x a.txt', 'sort --output=/tmp/x a.txt', 'uniq a.txt /tmp/x', 'tree -o/tmp/x',
  'git checkout -f', 'git checkout -f main', 'git checkout --force main', 'git checkout -B main', 'git checkout -p',
  'git checkout --ours a.js', 'git checkout --theirs a.js', 'git checkout -m main', 'git checkout HEAD~1 -- a.js',
  'git checkout main a.js', 'git checkout --discard-changes main',
  'git restore --staged --worktree .', 'git restore --worktree a.js', 'git restore -SW a.js', 'git restore -W a.js',
  'git restore --source=HEAD a.js', 'git switch -f main', 'git switch --discard-changes main', 'git switch -C main',
  'git switch --force-create main', 'git mv -f a.js b.js',
  'rg --pre=sh x', 'rg --pre sh x', "awk 'BEGIN{while((\"id\" | getline l)>0)print l}'",
  "awk '{getline line < \"/etc/passwd\"}'", "awk '{print $1 > \"/tmp/x\"}' a.txt", "awk '{printf \"%s\", $1 > \"/tmp/x\"}' a.txt",
  "awk '{print | \"sh\"}' a.txt", "awk 'BEGIN{\"id\"|getline x; print x}'", "awk 'BEGIN{\"id\" |getline x}'", "awk 'BEGIN{system(\"id\")}'",
  'make -f -', 'make -f-', 'make --file=-', 'make --makefile -', 'echo all: | make -f -',
  'python3 -I -m pip install x', 'python3 -Impip install x', 'python3 -B -m pip install x', 'python -m venv .venv',
  'python3 -I -m http.server',
];
for (const c of qaBypasses) assert.equal(bash(c).allow, false, 'QA bypass should ask: ' + JSON.stringify(c));
const stillRoutine = [
  'cd src && ls', "sed -n '1,20p' a.js", "sed 's/foo/bar/g' a.js", "sed -E 's#a/b#c/d#g' a.js", "sed -i '' 's/a/b/' a.js",
  "sed -i.bak 's/a/b/' a.js", "sed -n '10,$p' a.js", "sed -e 1d -e 's/x/y/' a.js", 'sort a.txt', 'sort -o out.txt a.txt',
  'sort -n -r a.txt', 'uniq a.txt', 'uniq -c a.txt', 'git checkout main', 'git checkout -b feat', 'git checkout -b feat origin/main',
  'git checkout feat/x', 'git restore --staged a.js', 'git switch main', 'git switch -c feat', 'git mv a.js b.js',
  'rg -n foo src', "awk '{print $1}' a.txt", "awk -F, '{print $2}' a.csv",
  'make', 'make test', 'make -C src', 'make -f build.mk', 'python3 -m pytest -q', 'python3 -I tool.py',
];
for (const c of stillRoutine) assert.equal(bash(c).allow, true, 'routine command must stay automatic: ' + c + ' (' + bash(c).reason + ')');

// Paths that resolve outside the project through .. or a symlink.
const linkRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'link-policy-')));
const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'link-outside-')));
try {
  const proj = path.join(linkRoot, 'proj');
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.symlinkSync(outside, path.join(proj, 'out'));
  fs.symlinkSync(path.join(outside, 'file.txt'), path.join(proj, 'outfile'));
  fs.symlinkSync(path.join(linkRoot, 'missing'), path.join(proj, 'broken'));
  fs.mkdirSync(path.join(linkRoot, 'cfg'));
  fs.symlinkSync(path.join(proj, 'src'), path.join(proj, 'inner'));
  const sh = (command) => classify({ tool_name: 'Bash', cwd: proj, tool_input: { command } }, env);
  const ed = (file_path) => classify({ tool_name: 'Write', cwd: proj, tool_input: { file_path } }, env);
  for (const c of ['touch out/x', 'cp a.js out/a.js', 'cp a.js outfile', 'mkdir -p out/new/deeper', 'sed -i "" s/a/b/ outfile',
    'cd out && touch x', 'cd src && cp a.js ../../x', 'touch src/../../x', 'touch broken', 'tsc --outDir=out',
    'tsc --outDir=../elsewhere', 'node build.js --out=out/x.js']) {
    assert.equal(sh(c).allow, false, 'write through .. or symlink should ask: ' + c);
  }
  for (const f of ['out/x.js', 'outfile', 'out/new/dir/x.js', 'broken', 'src/../../x.js']) {
    assert.equal(ed(path.join(proj, f)).allow, false, 'edit through symlink should ask: ' + f);
  }
  for (const c of ['touch src/x', 'cp a.js inner/a.js', 'mkdir -p src/new/deeper', 'cd inner && touch x', 'ls out', 'cat outfile']) {
    assert.equal(sh(c).allow, true, 'inside the project should stay automatic: ' + c + ' (' + sh(c).reason + ')');
  }
  assert.equal(ed(path.join(proj, 'inner/x.js')).allow, true, 'symlink that stays inside is fine');
  assert.equal(classify({ tool_name: 'exec_command', cwd: proj, tool_input: { cmd: 'touch x', workdir: 'out' } }, env).allow, false,
    'Codex workdir through a symlink should ask');
  // A symlink named innocently that points at an agent config folder.
  fs.mkdirSync(path.join(proj, '.claude'));
  fs.symlinkSync(path.join(proj, '.claude'), path.join(proj, 'cfg'));
  assert.equal(sh('touch cfg/x').allow, false, 'symlink to .claude should ask');
  assert.equal(ed(path.join(proj, 'cfg/x')).allow, false, 'edit via symlink to .claude should ask');
  // Blocked requests go to the normal approval: the hook asks instead of denying.
  for (const command of ['node -e x', 'touch out/x', 'cp a .claude/settings.json']) {
    const req = { session_id: 's', cwd: proj, tool_name: 'Bash', tool_input: { command } };
    assert.equal(classify(req, env).allow, false);
    const hook = runHook(req);
    assert.equal(hook.requests.length, 1, 'goes to the dashboard for a decision: ' + command);
  }
} finally {
  fs.rmSync(linkRoot, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}

console.log(`Auto-approve passed: ${allowed.length + routineDev.length + gitListing.length + stillRoutine.length} commands approved, ${asked.length + inline.length + agentConfig.length + gitChanges.length + qaBypasses.length} still asked, inline code / symlink / agent config / branch-tag / QA bypass rules, tools inside/outside the project, Codex arrays, off switch, no command text in the log, questions never answered.`);
