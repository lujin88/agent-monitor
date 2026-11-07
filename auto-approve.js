// Decides which permission requests approve.js may approve on its own, without asking
// on the iPad. Anything not clearly covered here goes to the Dashboard as before.
//
// Auto-approved:
//   - read-only tools (Read, Glob, Grep, LS, NotebookRead)
//   - file edits (Edit, Write, MultiEdit, NotebookEdit) inside the project folder
//   - shell commands where every part is a read-only or common development command
//     and every path stays inside the project folder
// Also allowed: exact git pull --ff-only, and ls-remote queries to origin/upstream.
// Pull updates local files and may run configured Git hooks; it is not read-only.
// Also allowed: a project component.tgz sent to the official MagicPath archive endpoint.
// Never auto-approved, even inside the project: interpreters running code given on the
// command line or piped in (node -e, python -c, ...), writes that resolve outside the
// project through .. or a symlink, and writes to agent permission files (.claude/,
// .codex/, settings*.json, hooks.json). These go to the normal approval, not a denial.
// Always asked: deleting, other network access, git push / history rewrites, sudo, installs,
// writing outside the project, shell redirection or substitution, unknown MCP and web tools.
// Known Chrome DevTools observation tools below may run without asking, but saving
// browser data to disk and other browser actions still require a decision.
// Window resizing is separately allowed with bounded integer dimensions.
// Selecting existing tabs and waiting for text are also allowed. These browser
// operations do not need a project cwd; filesystem/shell rules below still do.
//
// classify() never throws; it returns { allow: true, rule } or { allow: false, reason }.
// Turn auto-approval off with AUTO_APPROVE=off in the agent's environment.

const path = require('path');
const fs = require('fs');

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'shell', 'local_shell', 'exec_command', 'container.exec']);

// Exact names and input keys, not a wildcard such as "mcp__*" or "get_*".
// Reject new/unknown options so a future tool version cannot silently add writes.
const BROWSER_READ_INPUTS = {
  list_pages: [],
  take_snapshot: ['pageId', 'verbose'],
  take_screenshot: ['pageId', 'format', 'fullPage', 'quality', 'uid'],
  list_console_messages: ['pageId', 'pageIdx', 'pageSize', 'types', 'includePreservedMessages', 'includeStackTraces', 'serviceWorkerId'],
  get_console_message: ['pageId', 'msgid'],
  list_network_requests: ['pageId', 'pageIdx', 'pageSize', 'resourceTypes', 'includePreservedRequests'],
  get_network_request: ['pageId', 'reqid'],
};
const BROWSER_READ_TOOLS = new Map(Object.entries(BROWSER_READ_INPUTS)
  .map(([name, keys]) => ['mcp__chrome_devtools__' + name, new Set(keys)]));

// First word of a command -> 'read' | 'dev' | function(args) returning 'read' | 'dev' | null.
const READ_COMMANDS = ['ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo', 'printf', 'which', 'file', 'stat', 'du', 'df',
  'grep', 'egrep', 'rg', 'sort', 'uniq', 'diff', 'cmp', 'tree', 'date', 'basename', 'dirname', 'realpath', 'true', 'test',
  'jq', 'cut', 'tr', 'column', 'nl', 'sha1sum', 'shasum', 'md5', 'md5sum', 'type', 'cd'];
const DEV_COMMANDS = ['node', 'python', 'python3', 'pytest', 'tsc', 'eslint', 'prettier', 'jest', 'vitest', 'mkdir', 'touch',
  'cp', 'mv', 'sed', 'awk', 'make', 'deno', 'bun', 'swift', 'swiftc', 'ruby', 'go', 'cargo', 'xcodebuild'];
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files', 'blame', 'shortlog', 'describe', 'tag', 'remote', 'config']);
const GIT_DEV = new Set(['add', 'commit', 'switch', 'restore', 'stash', 'checkout', 'mv', 'worktree']);
const NPM_DEV = new Set(['test', 't', 'run', 'run-script', 'start', 'ls', 'list', 'outdated', 'view', 'pack', 'build']);

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

// Split on &&, ||, ; and | outside quotes. Each part is { text, piped }: piped means the
// part reads the previous part's output on stdin (a single |).
function segments(cmd) {
  const parts = [];
  let cur = '', quote = null, piped = false;
  const push = (next) => { parts.push({ text: cur.trim(), piped }); cur = ''; piped = next; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) { if (c === quote) quote = null; cur += c; continue; }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if ((c === '&' && cmd[i + 1] === '&') || (c === '|' && cmd[i + 1] === '|')) { push(false); i++; continue; }
    if (c === ';') { push(false); continue; }
    if (c === '|') { push(true); continue; }
    cur += c;
  }
  if (quote) return null;
  push(false);
  return parts.filter((p) => p.text);
}

function inside(base, p) {
  const rel = path.relative(base, path.resolve(base, p));
  // '..' or '../x' leaves; a name that merely starts with dots ('...', '..cache') does not.
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}
// Paths inside .git can run code (hooks) or rewrite history: ask.
function protectedPath(base, p) {
  const rel = path.relative(base, path.resolve(base, p)).split(path.sep);
  return rel[0] === '.git';
}

// Resolve symlinks in the longest existing part of an absolute path and append the rest
// (path.resolve has already removed any ..). null when it cannot be resolved with
// confidence: a broken symlink, a loop, or no permission to look.
function realish(p) {
  let head = path.resolve(p);
  const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync(head), ...tail); } catch (err) {
      // Too long or under a regular file: no such path can exist, so nothing to follow.
      if (err.code === 'ENOENT') {
        try { fs.lstatSync(head); return null; } catch (_) { /* really missing: look at the parent */ }
      } else if (err.code !== 'ENAMETOOLONG' && err.code !== 'ENOTDIR') return null;
      const parent = path.dirname(head);
      if (parent === head) return null;
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}
// Inside the project after following symlinks, for paths that may be written.
function realInside(root, p) {
  const r = realish(root), t = realish(path.resolve(root, p));
  return !!r && !!t && inside(r, t);
}
// Agent permission and hook files: changing them changes what runs without asking.
// Checked as written and after symlinks; case-insensitive like the default macOS disk.
const AGENT_CONFIG_DIRS = new Set(['.claude', '.codex']);
function agentConfigName(full) {
  const parts = full.toLowerCase().split(path.sep), name = parts[parts.length - 1];
  return parts.some((x) => AGENT_CONFIG_DIRS.has(x)) || /^settings.*\.json$/.test(name) || name === 'hooks.json';
}
function agentConfigPath(base, p) {
  const full = path.resolve(base, p), real = realish(full);
  return agentConfigName(full) || (!!real && agentConfigName(real));
}

// Interpreters given code on the command line, or on stdin from a pipe, run code nobody
// can review in a file. Running a script file stays a development command.
// Options listed here take the next word as their value.
const INTERPRETER_VALUE_OPTIONS = {
  node: ['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--env-file',
    '--input-type', '--watch-path', '--test-name-pattern', '--test-reporter', '--test-reporter-destination',
    '--test-shard', '--disable-warning', '--redirect-warnings', '--title', '--inspect-port'],
  bun: ['-r', '--preload', '--cwd', '--env-file', '--config', '-c'],
};
function inlineCode(argv, piped) {
  const [cmd, ...args] = argv;
  let script = null;
  if (cmd === 'node' || cmd === 'bun') {
    const takesValue = new Set(INTERPRETER_VALUE_OPTIONS[cmd]);
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { script = args[i + 1] ?? null; break; }
      if (!a.startsWith('-') || a === '-') { script = a; break; }
      if (/^-[a-z]*[ep][a-z]*$/.test(a) && a.length <= 3) return true; // -e -p -pe -ep
      if (/^--(eval|print)(=|$)/.test(a)) return true;
      if (takesValue.has(a)) i++;
    }
  } else if (cmd === 'python' || cmd === 'python3' || cmd === 'ruby') {
    // Short options cluster (-Bc); after a value option the rest of the word is its value.
    const code = cmd === 'ruby' ? 'e' : 'c', stop = cmd === 'ruby' ? '' : 'm';
    const valueChars = cmd === 'ruby' ? 'rICEFTx0' : 'WX';
    outer: for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { script = args[i + 1] ?? null; break; }
      if (!a.startsWith('-') || a === '-') { script = a; break; }
      if (a.startsWith('--')) continue;
      for (let j = 1; j < a.length; j++) {
        if (a[j] === code) return true;
        if (stop && a[j] === stop) { script = 'module'; break outer; }
        if (valueChars.includes(a[j])) { if (j === a.length - 1) i++; break; }
      }
    }
  } else if (cmd === 'deno') {
    const sub = args.find((a) => !a.startsWith('-'));
    if (sub === 'eval' || sub === 'repl') return true;
    if (sub !== 'run') return false;
    script = args.slice(args.indexOf('run') + 1).find((a) => !a.startsWith('-') || a === '-') ?? null;
  } else if (cmd === 'swift' || cmd === 'swiftc') {
    script = args.find((a) => !a.startsWith('-') || a === '-') ?? null;
  } else return false;
  // `node -` or a pipe into an interpreter with no script file runs whatever arrives on stdin.
  return script === '-' || (piped && script === null);
}

// sed scripts: w/W write files, e runs commands, r/R read any file, s///w and s///e too.
// Parses each script; anything it cannot read with confidence asks.
function sedScriptSafe(script) {
  let i = 0;
  const n = script.length;
  const skipRegex = (d) => { // after an opening delimiter d; returns false if unterminated
    for (i++; i < n; i++) { if (script[i] === '\\') { i++; continue; } if (script[i] === d) return true; if (script[i] === '\n') return false; }
    return false;
  };
  while (i < n) {
    const c = script[i];
    if (/[\s;!{}]/.test(c)) { i++; continue; }
    if (/[0-9$,~+IM]/.test(c)) { i++; continue; } // addresses and regex address flags
    if (c === '/') { if (!skipRegex('/')) return false; i++; continue; }
    if (c === '\\') { i++; if (i >= n || !skipRegex(script[i])) return false; i++; continue; }
    if (c === 's' || c === 'y') {
      i++;
      const d = script[i];
      if (!d || /[\s\\\n]/.test(d)) return false;
      i--; // skipRegex starts after the delimiter position
      i++; if (!skipRegex(d)) return false; // pattern
      if (!skipRegex(d)) return false; // replacement
      i++;
      if (c === 's') {
        const flags = /^[gpiImMe0-9w]*/.exec(script.slice(i))[0];
        if (/[we]/.test(flags)) return false;
        i += flags.length;
      }
      continue;
    }
    if ('wWerR'.includes(c)) return false;
    if ('aic'.includes(c)) { while (i < n && script[i] !== '\n') i++; continue; } // text to end of line
    if ('btT:'.includes(c)) { i++; while (i < n && !/[;\n}]/.test(script[i])) i++; continue; } // labels
    if (/[pPdDnNgGhHxlq=zF#]/.test(c)) { if (c === '#') { while (i < n && script[i] !== '\n') i++; } else i++; continue; }
    if (c === 'Q' || c === 'L') { i++; continue; }
    return false;
  }
  return true;
}
function sedScriptsSafe(args) {
  const scripts = [];
  let first = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-f' || a.startsWith('--file') || /^-[a-zA-Z]*f/.test(a) && !a.startsWith('--')) return false; // script from a file
    if (a === '-e' || a === '--expression') { scripts.push(args[++i] ?? ''); continue; }
    if (a.startsWith('--expression=')) { scripts.push(a.slice(13)); continue; }
    if (/^-[a-zA-Z]*e./.test(a) && !a.startsWith('--')) { scripts.push(a.slice(a.indexOf('e') + 1)); continue; }
    if (a === '-i' && (args[i + 1] === '' || /^\./.test(args[i + 1] || ''))) { i++; continue; } // BSD -i '' / -i .bak
    if (a.startsWith('-')) continue;
    if (first === null) first = a;
  }
  if (!scripts.length && first !== null) scripts.push(first);
  return scripts.every(sedScriptSafe);
}

// python -m <module>, also after other options (-I -m pip) or attached (-mpip).
function pythonModule(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--' || !a.startsWith('-') || a === '-') return null;
    if (a.startsWith('--')) continue;
    for (let j = 1; j < a.length; j++) {
      if (a[j] === 'm') return j === a.length - 1 ? (args[i + 1] ?? null) : a.slice(j + 1);
      if ('WX'.includes(a[j])) { if (j === a.length - 1) i++; break; }
      if (a[j] === 'c') return null;
    }
  }
  return null;
}

// git checkout: only switching or creating branches. Force, patch/ours/theirs/merge,
// pathspecs (--, ., or a name that exists as a file or folder) throw away changes.
function gitCheckoutSafe(rest, base) {
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-b' || a === '--track' || a === '-t') { if (a === '-b') i++; continue; }
    if (a === '--detach' || a === '-q' || a === '--quiet' || a === '--no-track') continue;
    if (a.startsWith('-')) return false; // -f, --force, -B, -p, --ours, --theirs, -m, --merge, --discard-changes, --
    positional.push(a);
  }
  if (positional.length > 1) return false;
  if (positional.length === 1) {
    const p = positional[0];
    if (p === '.' || p.startsWith(':')) return false;
    try { fs.lstatSync(path.resolve(base || '/', p)); return false; } catch (_) { /* not a path: a branch or commit */ }
  }
  return true;
}
// git restore only touching the index (--staged without --worktree) keeps working files.
function gitRestoreIndexOnly(rest) {
  const staged = rest.includes('--staged'); // as before; -S is not added here
  const worktree = rest.some((a) => a === '--worktree' || /^-[a-zA-Z]*W/.test(a) && !a.startsWith('--'));
  return staged && !worktree;
}

// A debugger port lets whoever reaches it run code. Only loopback addresses.
function inspectSafe(argv) {
  if (!['node', 'bun', 'deno'].includes(argv[0])) return true;
  const ok = (v) => /^\d+$/.test(v) || /^(127\.0\.0\.1|localhost):\d+$/i.test(v);
  for (let i = 1; i < argv.length; i++) {
    const m = /^--inspect(-brk|-wait|-port|-publish-uid)?(=(.*))?$/.exec(argv[i]);
    if (!m) continue;
    if (m[2] !== undefined) { if (m[1] !== '-publish-uid' && !ok(m[3])) return false; continue; }
    if (m[1] === '-port') { if (!ok(argv[i + 1] || '')) return false; i++; }
  }
  return true;
}

// The Agent Monitor folder itself (this file, approve.js, token.txt, logs): reading the
// token lets a script answer approvals; editing the rules changes what is approved.
const MONITOR_DIR = realish(__dirname);
function inMonitorDir(p) {
  const r = realish(p);
  return !!MONITOR_DIR && !!r && inside(MONITOR_DIR, r); // unresolvable: nothing to read there
}
// p contains the monitor folder (a recursive search from here would read it).
function containsMonitorDir(p) {
  const r = realish(p);
  return !!MONITOR_DIR && !!r && inside(r, MONITOR_DIR);
}

function sedInPlaceOrExec(args) { return args.some((a) => /^-[a-zA-Z]*i/.test(a) || /^--in-place/.test(a)) ? 'dev' : 'read'; }

// git branch / git tag in a listing form only: query options, and names only as
// --list patterns or as the value of a query option such as --contains.
const GIT_LIST_FLAGS = {
  branch: new Set(['-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--show-current', '-l', '--list',
    '-i', '--ignore-case', '--color', '--no-color', '--column', '--no-column', '--omit-empty']),
  tag: new Set(['-l', '--list', '-n', '-i', '--ignore-case', '--color', '--no-color', '--column', '--no-column', '--omit-empty']),
};
const GIT_LIST_VALUE_FLAGS = new Set(['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format', '--abbrev']);
function gitListOnly(sub, rest) {
  const flags = GIT_LIST_FLAGS[sub];
  const listing = rest.some((a) => a === '-l' || a === '--list' || (sub === 'branch' && /^-[arv]*l[arv]*$/.test(a)));
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') return false;
    if (flags.has(a)) continue;
    if (sub === 'branch' && /^-[arvl]+$/.test(a)) continue; // -av, -vv, -ra
    if (sub === 'tag' && /^-n\d+$/.test(a)) continue;
    const name = a.split('=')[0];
    if (GIT_LIST_VALUE_FLAGS.has(name)) {
      // Value is optional for --contains/--merged; a following word is taken as the commit.
      if (!a.includes('=') && rest[i + 1] !== undefined && !rest[i + 1].startsWith('-')) i++;
      continue;
    }
    if (a.startsWith('-')) return false; // -d, -D, --delete, -m, --move, -c, --copy, -f, -u, -a (tag), ...
    if (!listing) return false; // a name without --list creates a branch or tag
  }
  return true;
}

function commandKind(argv, base) {
  const [cmd, ...args] = argv;
  if (cmd === 'git') {
    const at = args.findIndex((a) => !a.startsWith('-')), sub = args[at], global = at < 0 ? args : args.slice(0, at);
    // Before the subcommand, -C/--git-dir/--work-tree point elsewhere and -c can set commands git
    // will run. Anywhere, --output writes files and --ext-diff/--exec-path run other programs.
    if (global.some((a) => a !== '--no-pager')) return null;
    if (args.some((a) => /^--(git-dir|work-tree|output|exec-path|ext-diff)/.test(a))) return null;
    const rest = args.slice(at + 1);
    if (sub === 'pull') {
      // Only use the configured upstream. No URLs, refspecs, config overrides,
      // rebase/merge flags, submodule options, or remote helpers from the request.
      return rest.length === 1 && rest[0] === '--ff-only' ? 'dev' : null;
    }
    if (sub === 'ls-remote') {
      let i = 0;
      const flags = new Set(['--heads', '--tags', '--refs', '--exit-code', '--quiet']);
      while (flags.has(rest[i])) i++;
      if (!['origin', 'upstream'].includes(rest[i++])) return null;
      return rest.slice(i).every((ref) => /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(ref) && !ref.includes('..')) ? 'read' : null;
    }
    // branch and tag create, delete, rename and copy too, also with long options
    // (--delete, --move, --copy, ...). Only listing forms are read-only; anything else asks.
    if ((sub === 'branch' || sub === 'tag') && !gitListOnly(sub, rest)) return null;
    if (sub === 'remote' && args.some((a) => ['add', 'remove', 'rm', 'set-url', 'rename'].includes(a))) return null;
    if (sub === 'config' && !args.some((a) => ['--get', '--list', '-l', '--get-all'].includes(a))) return null;
    // Anything that can throw away uncommitted work asks.
    if (sub === 'checkout' && !gitCheckoutSafe(rest, base)) return null;
    if (sub === 'switch' && rest.some((a) => /^(-f|--force|--discard-changes|-C|--force-create|--merge|-m)$/.test(a) || /^-[a-zA-Z]*[fCm]/.test(a) && !a.startsWith('--'))) return null;
    if (sub === 'restore' && !gitRestoreIndexOnly(rest)) return null;
    if (sub === 'mv' && rest.some((a) => a === '-f' || a === '--force' || /^-[a-zA-Z]*f/.test(a) && !a.startsWith('--'))) return null;
    if (sub === 'stash' && args.some((a) => ['drop', 'clear', 'pop'].includes(a))) return null;
    if (sub === 'worktree' && args.some((a) => ['remove', 'prune'].includes(a))) return null;
    if (sub === 'commit' && args.some((a) => a === '--amend')) return null;
    if (GIT_READ.has(sub)) return 'read';
    if (GIT_DEV.has(sub)) return 'dev';
    return null; // push, fetch, clone, reset, clean, rebase, merge, ...
  }
  // Installs and remote code: only the listed subcommands run without asking.
  if (cmd === 'bun') {
    const sub = args.find((a) => !a.startsWith('-'));
    if (sub === undefined) return args.every((a) => ['--version', '-v', '--help', '-h'].includes(a)) ? 'read' : null;
    return ['run', 'test', 'build'].includes(sub) ? 'dev' : null; // install, add, x, create, upgrade, ...
  }
  if (cmd === 'go') {
    const at = args.findIndex((a) => !a.startsWith('-')), sub = args[at], rest = args.slice(at + 1);
    if (['build', 'test', 'vet', 'fmt'].includes(sub)) return 'dev';
    if (sub === 'version') return 'read';
    if (sub === 'env') return rest.some((a) => /^-(w|u)$/.test(a)) ? null : 'read'; // go env -w writes global config
    if (sub === 'run') {
      // Only local files or packages; pkg@version downloads and runs remote code.
      const targets = rest.filter((a) => !a.startsWith('-'));
      return targets.length && targets.every((a) => !a.includes('@') && (/^\.\.?(\/|$)/.test(a) || a.startsWith('/') || a.endsWith('.go'))) ? 'dev' : null;
    }
    return null; // install, get, generate, mod, work, ...
  }
  if (cmd === 'cargo') {
    const sub = args.find((a) => !a.startsWith('-') && !a.startsWith('+'));
    if (sub === undefined) return args.every((a) => ['--version', '-V', '--help', '-h'].includes(a)) ? 'read' : null;
    return ['build', 'test', 'check', 'run'].includes(sub) ? 'dev' : null; // install, add, publish, ...
  }
  if (cmd === 'deno') {
    const sub = args.find((a) => !a.startsWith('-'));
    if (!['run', 'test', 'check', 'fmt', 'lint', 'task'].includes(sub)) return null; // install, add, compile, upgrade, ...
    if (args.some((a) => /^(npm|jsr|https?):/i.test(a))) return null; // remote code
    return 'dev';
  }
  if (cmd === 'make' && args.some((a) => /^(--eval(=|$)|-E)/.test(a))) return null; // --eval runs make code from the command line
  if (cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn') {
    const sub = args.find((a) => !a.startsWith('-'));
    if (cmd === 'yarn' && sub === undefined) return null; // bare `yarn` installs
    // npm exec can download and run any package; pnpm/yarn exec only run installed binaries.
    if (sub === 'exec' && cmd !== 'npm') return 'dev';
    return NPM_DEV.has(sub) ? 'dev' : null; // install, ci, publish, add, update, ...
  }
  if (cmd === 'find') return args.some((a) => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls'].includes(a)) ? null : 'read';
  if (cmd === 'sed') return sedScriptsSafe(args) ? sedInPlaceOrExec(args) : null;
  // awk can run commands (system, pipes, getline) and write files (print > f).
  if (cmd === 'awk' && args.some((a) => /system\s*\(|getline|>|\|/.test(a))) return null;
  if (cmd === 'python' || cmd === 'python3') {
    if (['pip', 'pip3', 'http.server', 'venv', 'ensurepip'].includes(pythonModule(args))) return null;
  }
  // Output options make read-only tools write files; treat them as development commands
  // so the written path gets the full project/symlink checks.
  if (cmd === 'sort' && args.some((a) => /^(-[a-zA-Z]*o|--output)/.test(a))) return 'dev';
  if (cmd === 'uniq' && args.filter((a) => !a.startsWith('-')).length >= 2) return 'dev';
  if (cmd === 'tree' && args.some((a) => /^-[a-zA-Z]*o/.test(a))) return 'dev';
  // ripgrep --pre runs any program on every searched file.
  if (cmd === 'rg' && args.some((a) => /^--pre(=|$)/.test(a))) return null;
  // make -f - reads the makefile (that is, commands) from stdin.
  if (cmd === 'make' && args.some((a, i) => /^(-f|--file|--makefile)$/.test(a) && args[i + 1] === '-' || /^(-f-|--(file|makefile)=-)$/.test(a))) return null;
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

// Requested preview install includes dependency lifecycle scripts. This assumes
// trusted project/npm configuration; classification is not a runtime sandbox.
function previewInstall(script, cwd) {
  const expected = ['npm', 'install', '--prefix', 'work/local-preview', 'react', 'react-dom', 'esbuild', '--no-audit', '--no-fund'];
  const argv = words(script);
  if (!argv || argv.length !== expected.length || argv.some((arg, i) => arg !== expected[i])) return false;
  try {
    const root = fs.realpathSync(cwd);
    let candidate = path.join(cwd, 'work', 'local-preview');
    for (;;) {
      let stat;
      try { stat = fs.lstatSync(candidate); }
      catch (err) {
        if (err.code !== 'ENOENT' || candidate === cwd) return false;
        candidate = path.dirname(candidate);
        continue;
      }
      // A broken or outward-pointing symlink must not become an auto-approved
      // destination. Missing descendants may be created under a verified parent.
      const real = fs.realpathSync(candidate);
      return fs.statSync(real).isDirectory() && inside(root, real);
    }
  } catch (_) { return false; }
}

function classifyShell(script, cwd) {
  if (typeof script !== 'string' || !script.trim() || script.length > 2000) return { allow: false, reason: 'no readable command' };
  const bad = unsafeSyntax(script);
  if (bad) return { allow: false, reason: bad };
  const parts = segments(script);
  if (!parts || !parts.length) return { allow: false, reason: 'unreadable command' };
  if (parts.length === 1 && previewInstall(script, cwd)) {
    return { allow: true, rule: 'local React preview dependencies (scripts allowed)' };
  }
  let base = cwd, kind = 'read';
  for (const { text: part, piped } of parts) {
    if (NEVER.some((re) => re.test(part))) return { allow: false, reason: 'force flag' };
    const argv = words(part);
    if (!argv || !argv.length) return { allow: false, reason: 'variables, globs or escapes' };
    while (argv.length && /^[A-Za-z_][A-Za-z0-9_]*=[\w./:-]*$/.test(argv[0])) { // FOO=1 cmd
      if (RISKY_ENV.test(argv[0])) return { allow: false, reason: 'changes which program runs' };
      argv.shift();
    }
    if (!argv.length) return { allow: false, reason: 'variable assignment only' };
    let commandBase = base;
    if (argv[0] === 'git') {
      // Normalize only supported global directory/pager options, then apply the
      // same command rules. -C changes Git's cwd, not subsequent shell commands.
      let i = 1;
      while (i < argv.length) {
        if (argv[i] === '--no-pager') { i++; continue; }
        if (argv[i] !== '-C') break;
        const target = argv[i + 1];
        if (typeof target !== 'string' || !target || target.startsWith('-')) return { allow: false, reason: 'invalid git directory' };
        const resolved = path.resolve(commandBase, target);
        if (!inside(cwd, resolved) || protectedPath(cwd, resolved) || resolved.split(path.sep).includes('.git')) return { allow: false, reason: 'git directory outside the project' };
        try {
          const realRoot = fs.realpathSync(cwd), realTarget = fs.realpathSync(resolved);
          if (!fs.statSync(realTarget).isDirectory() || !inside(realRoot, realTarget) || realTarget.split(path.sep).includes('.git')) return { allow: false, reason: 'git directory outside the project' };
        } catch (_) { return { allow: false, reason: 'unverified git directory' }; }
        commandBase = resolved;
        argv.splice(i, 2);
      }
    }
    if (argv[0] === 'cd' && (argv.length < 2 || argv[1] === '-' || argv[1] === '--')) return { allow: false, reason: 'cd leaves the project' };
    const k = commandKind(argv, commandBase);
    if (!k) return { allow: false, reason: `${argv[0]} needs your decision` };
    if (inlineCode(argv, piped)) return { allow: false, reason: 'runs inline code' };
    if (!inspectSafe(argv)) return { allow: false, reason: 'debugger open beyond this Mac' };
    if (inMonitorDir(commandBase) || argv.slice(1).some((a) => !a.startsWith('-') && inMonitorDir(path.resolve(commandBase, a)))) {
      return { allow: false, reason: 'Agent Monitor folder' };
    }
    if (!pathsInside(argv, commandBase)) return { allow: false, reason: 'path outside the project' };
    if (k === 'dev') {
      // A development command may write any file it names, also as --flag=value.
      // Follow symlinks and keep agent permission files out of reach.
      if (!realInside(cwd, commandBase)) return { allow: false, reason: 'folder outside the project' };
      for (const a of argv.slice(1)) {
        // --flag=value, or a short option with an attached path (-o/abs/file).
        const value = !a.startsWith('-') ? a
          : ((/^--?[^=]+=(.+)$/.exec(a) || [])[1] ?? (/^-[a-zA-Z](.*\/.*)$/.exec(a) || [])[1]);
        if (!value || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) continue;
        if (a.startsWith('-') && !inside(commandBase, value)) return { allow: false, reason: 'path outside the project' };
        if (!realInside(cwd, path.resolve(commandBase, value))) return { allow: false, reason: 'path outside the project' };
        if (agentConfigPath(commandBase, value)) return { allow: false, reason: 'agent settings or hooks' };
      }
    }
    if (argv[0] === 'cd') base = path.resolve(base, argv[1] || base);
    if (k === 'dev') kind = 'dev';
  }
  return { allow: true, rule: kind === 'read' ? 'read-only command' : 'development command' };
}

function magicPathUpload(command, cwd, workdir) {
  // Match the literal command generated by MagicPath, including its destination.
  const upload = /^curl -fsS -X PUT --data-binary @component\.tgz (['"]?)https:\/\/api\.magicpath\.ai\/mcp\/transfers\/mcs_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/[A-Za-z0-9_-]+\/archive\1$/;
  if (command.length > 2000 || /[\r\n]/.test(command) || !upload.test(command)) return false;
  const archive = path.join(workdir, 'component.tgz');
  return inside(fs.realpathSync(cwd), fs.realpathSync(archive)) && fs.lstatSync(archive).isFile();
}

function classify(p, env = process.env) {
  try {
    if (env.AUTO_APPROVE === 'off') return { allow: false, reason: 'auto-approval off' };
    if (!p || typeof p !== 'object') return { allow: false, reason: 'no request' };
    const tool = typeof p.tool_name === 'string' ? p.tool_name : '';
    const input = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {};
    const cwd = typeof p.cwd === 'string' && path.isAbsolute(p.cwd) ? path.resolve(p.cwd) : null;

    if (tool === 'mcp__chrome_devtools__select_page' || tool === 'mcp__chrome_devtools__wait_for') {
      const selecting = tool === 'mcp__chrome_devtools__select_page';
      const keys = selecting ? ['pageId', 'bringToFront'] : ['pageId', 'text', 'timeout'];
      const validOptions = selecting
        ? (input.bringToFront === undefined || typeof input.bringToFront === 'boolean')
        : (Array.isArray(input.text) && input.text.length > 0 && input.text.length <= 100 &&
          input.text.every((value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 10000) &&
          (input.timeout === undefined || (Number.isSafeInteger(input.timeout) && input.timeout >= 0 && input.timeout <= 60000)));
      if (!p.tool_input || Array.isArray(p.tool_input) ||
          Object.keys(input).some((key) => !keys.includes(key)) ||
          !Number.isSafeInteger(input.pageId) || input.pageId < 0 || !validOptions) {
        return { allow: false, reason: 'invalid browser selection or wait parameters' };
      }
      return { allow: true, rule: selecting ? 'select existing browser page' : 'wait for browser text' };
    }

    if (tool === 'mcp__chrome_devtools__resize_page') {
      const keys = ['pageId', 'width', 'height'];
      if (!p.tool_input || Array.isArray(p.tool_input) ||
          Object.keys(input).some((key) => !keys.includes(key)) ||
          !Number.isSafeInteger(input.pageId) || input.pageId < 0 ||
          !['width', 'height'].every((key) => Number.isSafeInteger(input[key]) && input[key] >= 1 && input[key] <= 8192)) {
        return { allow: false, reason: 'invalid browser resize parameters' };
      }
      return { allow: true, rule: 'browser window resize' };
    }

    if (BROWSER_READ_TOOLS.has(tool)) {
      if (!p.tool_input || typeof p.tool_input !== 'object' || Array.isArray(p.tool_input)) {
        return { allow: false, reason: 'invalid browser input' };
      }
      const keys = BROWSER_READ_TOOLS.get(tool);
      if (Object.keys(input).some((key) => !keys.has(key))) {
        return { allow: false, reason: 'browser output path or unknown option' };
      }
      return { allow: true, rule: 'read-only browser inspection' };
    }

    // Filesystem and shell permissions still require a bounded project folder.
    if (!cwd || cwd === '/' || cwd === path.resolve(require('os').homedir())) return { allow: false, reason: 'no project folder' };

    if (inMonitorDir(cwd)) return { allow: false, reason: 'Agent Monitor folder' };
    if (READ_TOOLS.has(tool)) {
      const target = input.file_path || input.notebook_path || input.path;
      const where = typeof target === 'string' ? path.resolve(cwd, target) : cwd;
      if (inMonitorDir(where) || containsMonitorDir(where)) return { allow: false, reason: 'Agent Monitor folder' };
      if (typeof target === 'string' && !inside(cwd, target)) return { allow: false, reason: 'path outside the project' };
      return { allow: true, rule: 'read-only tool' };
    }
    if (EDIT_TOOLS.has(tool)) {
      const target = input.file_path || input.notebook_path;
      if (typeof target !== 'string' || !target) return { allow: false, reason: 'no file path' };
      if (!inside(cwd, target) || protectedPath(cwd, target)) return { allow: false, reason: 'path outside the project' };
      if (!realInside(cwd, target)) return { allow: false, reason: 'path outside the project' };
      if (agentConfigPath(cwd, target)) return { allow: false, reason: 'agent settings or hooks' };
      if (inMonitorDir(path.resolve(cwd, target))) return { allow: false, reason: 'Agent Monitor folder' };
      return { allow: true, rule: 'edit inside project' };
    }
    if (SHELL_TOOLS.has(tool)) {
      const workdir = typeof input.workdir === 'string' ? path.resolve(cwd, input.workdir) : cwd;
      if (!inside(cwd, workdir) || !realInside(cwd, workdir)) return { allow: false, reason: 'path outside the project' };
      // Local, destination-scoped reporting exception. Inspect original strings
      // only; shellScript's array conversion is not a security parser.
      const original = input.command ?? input.cmd;
      if (typeof original === 'string') {
        if (magicPathUpload(original, cwd, workdir)) {
          return { allow: true, rule: 'MagicPath component archive upload' };
        }
        try {
          if (require('./buzz-auto-approve').allowConfiguredBuzzSend(original, workdir)) {
            return { allow: true, rule: 'approved Buzz project report' };
          }
        } catch (_) { /* Missing policy/module keeps normal approval behavior. */ }
      }
      return classifyShell(shellScript(input), workdir);
    }
    return { allow: false, reason: `${tool || 'tool'} needs your decision` };
  } catch (_) {
    return { allow: false, reason: 'could not classify' };
  }
}

module.exports = { classify, classifyShell };
