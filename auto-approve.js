// Decides which permission requests approve.js may approve on its own, without asking
// on the iPad. Anything not clearly covered here goes to the Dashboard as before.
//
// Auto-approved:
//   - read-only tools (Read, Glob, Grep, LS, NotebookRead)
//   - file edits (Edit, Write, MultiEdit, NotebookEdit) inside the project folder
//   - shell commands where every part is a read-only or common development command
//     and every path stays inside the project folder
// Always asked: deleting, network access, git push / history rewrites, sudo, installs,
// writing outside the project, shell redirection or substitution, MCP and web tools.
//
// classify() never throws; it returns { allow: true, rule } or { allow: false, reason }.
// Turn auto-approval off with AUTO_APPROVE=off in the agent's environment.

const path = require('path');

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'shell', 'local_shell', 'exec_command', 'container.exec']);

// First word of a command -> 'read' | 'dev' | function(args) returning 'read' | 'dev' | null.
const READ_COMMANDS = ['ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo', 'printf', 'which', 'file', 'stat', 'du', 'df',
  'grep', 'egrep', 'rg', 'sort', 'uniq', 'diff', 'cmp', 'tree', 'date', 'basename', 'dirname', 'realpath', 'true', 'test',
  'jq', 'cut', 'tr', 'column', 'nl', 'sha1sum', 'shasum', 'md5', 'md5sum', 'type', 'cd'];
const DEV_COMMANDS = ['node', 'python', 'python3', 'pytest', 'tsc', 'eslint', 'prettier', 'jest', 'vitest', 'mkdir', 'touch',
  'cp', 'mv', 'sed', 'awk', 'make', 'deno', 'bun', 'swift', 'swiftc', 'ruby', 'go', 'cargo', 'xcodebuild'];
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files', 'blame', 'shortlog', 'describe', 'tag', 'remote', 'config']);
const GIT_DEV = new Set(['add', 'commit', 'switch', 'restore', 'stash', 'checkout', 'mv', 'worktree']);
const NPM_DEV = new Set(['test', 't', 'run', 'run-script', 'start', 'exec', 'ls', 'list', 'outdated', 'view', 'pack', 'build']);

// Things that are never approved automatically, wherever they appear in a command part.
const NEVER = [/(^|\s)--force(-with-lease)?(\s|=|$)/]; // force flags are worth a look
// Variables that change which program or code actually runs.
const RISKY_ENV = /^(PATH|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|BASH_ENV|ENV|SHELL|HOME|GIT_[A-Z_]*|LD_[A-Z_]*|DYLD_[A-Z_]*)=/;

// Shell syntax that hides what really runs or writes somewhere: always ask.
// Allowed exceptions are stripped first: 2>&1, >/dev/null, 2>/dev/null.
function unsafeSyntax(cmd) {
  const s = cmd.replace(/\s\d?>\s*\/dev\/null/g, ' ').replace(/\s2>&1/g, ' ');
  if (/[`\n\r]/.test(s)) return 'substitution or multi-line';
  if (/\$\(|<\(|>\(/.test(s)) return 'substitution';
  if (/[<>]/.test(s)) return 'redirection';
  if (/(^|[^&])&($|[^&])/.test(s)) return 'background job';
  return null;
}

// Minimal shell word splitter: handles '...' and "..." (no expansion inside single quotes).
// Returns null for anything it cannot read with confidence.
function words(segment) {
  const out = [];
  let cur = '', quote = null, had = false;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      if (quote === '"' && (c === '$' || c === '\\')) return null; // expansion inside double quotes
      cur += c;
    } else if (c === "'" || c === '"') { quote = c; had = true; }
    else if (/\s/.test(c)) { if (cur || had) out.push(cur); cur = ''; had = false; }
    else if (c === '\\' || c === '$' || c === '*' || c === '?' || c === '~' || c === '{' || c === '[') {
      // Variables, globs and ~ could point anywhere; only a plain $ at the very end of a regex-like
      // argument is not worth special-casing. Ask instead.
      return null;
    } else cur += c;
  }
  if (quote) return null;
  if (cur || had) out.push(cur);
  return out;
}

// Split on &&, ||, ; and | outside quotes.
function segments(cmd) {
  const parts = [];
  let cur = '', quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) { if (c === quote) quote = null; cur += c; continue; }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if ((c === '&' && cmd[i + 1] === '&') || (c === '|' && cmd[i + 1] === '|')) { parts.push(cur); cur = ''; i++; continue; }
    if (c === ';' || c === '|') { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (quote) return null;
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function inside(base, p) {
  const rel = path.relative(base, path.resolve(base, p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
// Paths inside .git can run code (hooks) or rewrite history: ask.
function protectedPath(base, p) {
  const rel = path.relative(base, path.resolve(base, p)).split(path.sep);
  return rel[0] === '.git';
}

function sedInPlaceOrExec(args) { return args.some((a) => /^-[a-zA-Z]*i/.test(a) || /^--in-place/.test(a)) ? 'dev' : 'read'; }

function commandKind(argv) {
  const [cmd, ...args] = argv;
  if (cmd === 'git') {
    const at = args.findIndex((a) => !a.startsWith('-')), sub = args[at], global = at < 0 ? args : args.slice(0, at);
    // Before the subcommand, -C/--git-dir/--work-tree point elsewhere and -c can set commands git
    // will run. Anywhere, --output writes files and --ext-diff/--exec-path run other programs.
    if (global.some((a) => a !== '--no-pager')) return null;
    if (args.some((a) => /^--(git-dir|work-tree|output|exec-path|ext-diff)/.test(a))) return null;
    if (sub === 'branch' && args.some((a) => /^-[a-zA-Z]*[dDmM]/.test(a))) return null; // delete/rename branches
    if (sub === 'tag' && args.some((a) => /^-[a-zA-Z]*d/.test(a))) return null;
    if (sub === 'remote' && args.some((a) => ['add', 'remove', 'rm', 'set-url', 'rename'].includes(a))) return null;
    if (sub === 'config' && !args.some((a) => ['--get', '--list', '-l', '--get-all'].includes(a))) return null;
    if (sub === 'checkout' && args.some((a) => a === '--' || a === '.')) return null; // discards local changes
    if (sub === 'restore' && !args.includes('--staged')) return null; // discards local changes
    if (sub === 'stash' && args.some((a) => ['drop', 'clear', 'pop'].includes(a))) return null;
    if (sub === 'worktree' && args.some((a) => ['remove', 'prune'].includes(a))) return null;
    if (sub === 'commit' && args.some((a) => a === '--amend')) return null;
    if (GIT_READ.has(sub)) return 'read';
    if (GIT_DEV.has(sub)) return 'dev';
    return null; // push, pull, fetch, clone, reset, clean, rebase, merge, ...
  }
  if (cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn') {
    const sub = args.find((a) => !a.startsWith('-'));
    if (cmd === 'yarn' && sub === undefined) return null; // bare `yarn` installs
    return NPM_DEV.has(sub) ? 'dev' : null; // install, ci, publish, add, update, ...
  }
  if (cmd === 'find') return args.some((a) => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls'].includes(a)) ? null : 'read';
  if (cmd === 'sed') return sedInPlaceOrExec(args);
  if (cmd === 'awk' && args.some((a) => /system\s*\(|print\s*>|\|\s*"/.test(a))) return null;
  if (cmd === 'python' || cmd === 'python3') {
    if (args[0] === '-m' && ['pip', 'http.server', 'venv', 'ensurepip'].includes(args[1])) return null;
  }
  if (cmd === 'tail' && args.some((a) => a === '-f' || a === '-F')) return null; // never ends
  if (READ_COMMANDS.includes(cmd)) return 'read';
  if (DEV_COMMANDS.includes(cmd)) return 'dev';
  return null;
}

// Every argument that looks like a path must stay inside the project (and out of .git).
function pathsInside(argv, base) {
  for (const a of argv.slice(1)) {
    if (!a || a.startsWith('-')) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(a)) return false; // URLs mean network
    const looksLikePath = a.startsWith('/') || a.startsWith('.') || a.includes('/');
    if (!looksLikePath) continue;
    if (!inside(base, a) || protectedPath(base, a)) return false;
  }
  return true;
}

function shellScript(input) {
  const c = input.command ?? input.cmd;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.every((x) => typeof x === 'string')) {
    if (c.length === 3 && /(^|\/)(ba|z)?sh$/.test(c[0]) && /^-l?c$/.test(c[1])) return c[2];
    if (c.length && !/(^|\/)(ba|z)?sh$/.test(c[0])) return c.map((x) => (/^[\w./:=@%+,-]+$/.test(x) ? x : `'${x.replace(/'/g, '')}'`)).join(' ');
  }
  return null;
}

function classifyShell(script, cwd) {
  if (typeof script !== 'string' || !script.trim() || script.length > 2000) return { allow: false, reason: 'no readable command' };
  const bad = unsafeSyntax(script);
  if (bad) return { allow: false, reason: bad };
  const parts = segments(script);
  if (!parts || !parts.length) return { allow: false, reason: 'unreadable command' };
  let base = cwd, kind = 'read';
  for (const part of parts) {
    if (NEVER.some((re) => re.test(part))) return { allow: false, reason: 'force flag' };
    const argv = words(part);
    if (!argv || !argv.length) return { allow: false, reason: 'variables, globs or escapes' };
    while (argv.length && /^[A-Za-z_][A-Za-z0-9_]*=[\w./:-]*$/.test(argv[0])) { // FOO=1 cmd
      if (RISKY_ENV.test(argv[0])) return { allow: false, reason: 'changes which program runs' };
      argv.shift();
    }
    if (!argv.length) return { allow: false, reason: 'variable assignment only' };
    const k = commandKind(argv);
    if (!k) return { allow: false, reason: `${argv[0]} needs your decision` };
    if (!pathsInside(argv, base)) return { allow: false, reason: 'path outside the project' };
    if (argv[0] === 'cd') base = path.resolve(base, argv[1] || base);
    if (k === 'dev') kind = 'dev';
  }
  return { allow: true, rule: kind === 'read' ? 'read-only command' : 'development command' };
}

function classify(p, env = process.env) {
  try {
    if (env.AUTO_APPROVE === 'off') return { allow: false, reason: 'auto-approval off' };
    if (!p || typeof p !== 'object') return { allow: false, reason: 'no request' };
    const tool = typeof p.tool_name === 'string' ? p.tool_name : '';
    const input = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {};
    const cwd = typeof p.cwd === 'string' && path.isAbsolute(p.cwd) ? path.resolve(p.cwd) : null;
    // Without a project folder there is nothing to keep requests inside.
    if (!cwd || cwd === '/' || cwd === path.resolve(require('os').homedir())) return { allow: false, reason: 'no project folder' };

    if (READ_TOOLS.has(tool)) {
      const target = input.file_path || input.notebook_path || input.path;
      if (typeof target === 'string' && !inside(cwd, target)) return { allow: false, reason: 'path outside the project' };
      return { allow: true, rule: 'read-only tool' };
    }
    if (EDIT_TOOLS.has(tool)) {
      const target = input.file_path || input.notebook_path;
      if (typeof target !== 'string' || !target) return { allow: false, reason: 'no file path' };
      if (!inside(cwd, target) || protectedPath(cwd, target)) return { allow: false, reason: 'path outside the project' };
      return { allow: true, rule: 'edit inside project' };
    }
    if (SHELL_TOOLS.has(tool)) {
      const workdir = typeof input.workdir === 'string' ? path.resolve(cwd, input.workdir) : cwd;
      if (!inside(cwd, workdir)) return { allow: false, reason: 'path outside the project' };
      return classifyShell(shellScript(input), workdir);
    }
    return { allow: false, reason: `${tool || 'tool'} needs your decision` };
  } catch (_) {
    return { allow: false, reason: 'could not classify' };
  }
}

module.exports = { classify, classifyShell };
