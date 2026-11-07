// Opt-in local policy for project reports. No shell command is executed here.
// Unknown syntax, destinations, flags and file paths fail closed.
const fs = require('fs');
const path = require('path');

function tokens(script) {
  if (typeof script !== 'string' || script.length > 65536) return null;
  const out = [];
  const re = /[ \t]+|'([^']*)'|([A-Za-z0-9_./:@%+=,-]+)|([|<])/y;
  let i = 0;
  while (i < script.length) {
    re.lastIndex = i;
    const m = re.exec(script);
    if (!m) return null;
    i = re.lastIndex;
    if (m[1] !== undefined) out.push({ value: m[1], word: true });
    else if (m[2]) out.push({ value: m[2], word: true });
    else if (m[3]) out.push({ value: m[3], word: false });
    else continue;
    // Adjacent quoted/unquoted fragments are not supported. Never reinterpret
    // shell concatenation as separate arguments.
    if (i < script.length && !/[ \t|<]/.test(script[i])) return null;
  }
  return out;
}
function contained(root, file) {
  const rel = path.relative(root, file);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
function pngAllowed(file, cwd, roots) {
  const full = path.resolve(cwd, file), real = fs.realpathSync(full);
  if (path.extname(full).toLowerCase() !== '.png' || !roots.some(root =>
    path.isAbsolute(root) && contained(path.resolve(root), full) && contained(fs.realpathSync(root), real))) return false;
  const stat = fs.statSync(real);
  if (!stat.isFile() || stat.size < 8 || stat.size > 25 * 1024 * 1024) return false;
  const fd = fs.openSync(real, 'r');
  try {
    const header = Buffer.alloc(8);
    return fs.readSync(fd, header, 0, 8, 0) === 8 && header.equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  } finally { fs.closeSync(fd); }
}
function classifyBuzzSend(script, cwd, policy) {
  try {
    const t = tokens(script);
    if (!t || !path.isAbsolute(cwd)) return false;
    const pipes = t.flatMap((x, i) => !x.word && x.value === '|' ? [i] : []);
    let args = t, piped = false;
    if (pipes.length) {
      if (pipes.length !== 1) return false;
      const before = t.slice(0, pipes[0]);
      if (before.length < 3 || before.some(x => !x.word) || before[0].value !== 'printf' || before[1].value !== '%s\\n') return false;
      args = t.slice(pipes[0] + 1); piped = true;
    }
    let bodyFile = null;
    const redirect = args.findIndex(x => !x.word && x.value === '<');
    if (redirect >= 0) {
      if (piped || redirect !== args.length - 2 || !args[redirect + 1].word) return false;
      bodyFile = args[redirect + 1].value; args = args.slice(0, redirect);
    }
    if (args.some(x => !x.word)) return false;
    args = args.map(x => x.value);
    if (args[0] !== 'buzz' || args[1] !== 'messages' || args[2] !== 'send') return false;
    const fields = {}, files = [], mentions = [];
    for (let i = 3; i < args.length; i += 2) {
      const flag = args[i], value = args[i + 1];
      if (value === undefined) return false;
      if (flag === '--file') files.push(value);
      else if (flag === '--mention') mentions.push(value);
      else if (['--channel', '--reply-to', '--content'].includes(flag) && fields[flag] === undefined) fields[flag] = value;
      else return false;
    }
    const rule = policy?.channels?.[fields['--channel']];
    if (!rule || typeof fields['--content'] !== 'string' || !/^[a-f0-9]{64}$/.test(fields['--reply-to'] || '')) return false;
    if (mentions.some(m => !rule.mentions.includes(m)) || files.length > 10) return false;
    if (files.some(f => !pngAllowed(f, cwd, rule.imageRoots))) return false;
    if (fields['--content'] === '-') {
      // Unknown stdin is not an approval for arbitrary content.
      if (!piped && !bodyFile) return false;
      if (bodyFile) {
        const full = path.resolve(cwd, bodyFile);
        if (!rule.messageFiles.includes(full) || fs.realpathSync(full) !== full) return false;
        const stat = fs.statSync(full);
        if (!stat.isFile() || stat.size > 65536) return false;
      }
    } else if (piped || bodyFile) return false;
    return true;
  } catch (_) { return false; }
}
function allowConfiguredBuzzSend(script, cwd) {
  try {
    return classifyBuzzSend(script, cwd, JSON.parse(fs.readFileSync(path.join(__dirname, 'buzz-auto-approve.json'), 'utf8')));
  } catch (_) { return false; }
}
module.exports = { classifyBuzzSend, allowConfiguredBuzzSend };
