// Synthetic files and command strings only. Never send messages or run commands.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { classifyBuzzSend } = require('./buzz-auto-approve');
const { classify } = require('./auto-approve');
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'buzz-policy-test-')));
try {
  const images = path.join(dir, 'images'), body = path.join(dir, 'report.md');
  fs.mkdirSync(images);
  fs.writeFileSync(path.join(images, 'a.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  fs.writeFileSync(path.join(images, 'fake.png'), 'not a PNG');
  fs.writeFileSync(body, 'Synthetic project report');
  fs.symlinkSync(body, path.join(images, 'link.png'));
  const id = 'a'.repeat(64), channel = 'test-channel';
  const policy = { channels: { [channel]: { imageRoots: [images], messageFiles: [body], mentions: [id] } } };
  const base = `buzz messages send --channel ${channel} --reply-to ${id} --mention ${id} --file images/a.png --content`;
  const direct = `${base} 'Report complete'`;
  const piped = `printf '%s\\n' 'Report with literal \`code\`, $(not-executed), | and < text' '' | ${base} -`;
  const redirected = `${base} - < report.md`;
  const yes = c => assert.equal(classifyBuzzSend(c, dir, policy), true, c);
  const no = c => assert.equal(classifyBuzzSend(c, dir, policy), false, c);
  [direct, piped, redirected].forEach(yes);
  [
    `${base} -`, `${direct} --broadcast`, `${direct} --kind 1`,
    `${direct} --channel other`, direct.replace(channel, 'other'),
    direct.replace(`--mention ${id}`, `--mention ${'b'.repeat(64)}`),
    direct.replace('images/a.png', 'images/fake.png'),
    direct.replace('images/a.png', 'images/link.png'),
    direct.replace('images/a.png', '../private.png'),
    `${direct}; rm -rf x`, `${direct} && echo x`, `${direct}\necho x`,
    direct.replace("'Report complete'", '"$(id)"'),
    direct.replace("'Report complete'", "'Report'complete"),
    redirected.replace('report.md', 'other.md'), `${redirected} < report.md`,
    `${piped} | sh`, `${direct} > output`, piped.replace("'%s\\n'", "'%b'"),
    `cat report.md | ${base} -`, `${direct} --file images/missing.png`,
  ].forEach(no);
  assert.equal(classifyBuzzSend(direct, dir, {}), false);
  assert.equal(classifyBuzzSend(direct, dir, null), false);
  assert.equal(classify({ cwd: dir, tool_name: 'Bash', tool_input: { command: direct } }, { AUTO_APPROVE: 'off' }).allow, false);
  assert.equal(classify({ cwd: dir, tool_name: 'Bash', tool_input: { command: direct } }, {}).allow, false, 'synthetic channel not in local policy');
  console.log('Buzz policy tests passed: direct text, literal printf pipe, fixed message file; unknown channels, files, flags and shell execution blocked.');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
