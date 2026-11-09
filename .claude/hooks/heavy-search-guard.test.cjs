const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const hook = path.join(__dirname, 'heavy-search-guard.js');
const file = '~/.claude/projects/sample/session.jsonl';
function run(command, tool_name = 'Bash') {
  const result = spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_name, tool_input: { command } }), encoding: 'utf8', timeout: 3000 });
  assert.equal(result.status, 0, result.stderr);
  return { decision: result.stdout ? JSON.parse(result.stdout).decision : undefined, warning: result.stderr };
}
for (const command of [
  `grep -oE '.{300}sample-id.{200}' ${file} &`,
  `cd sample && grep id ${file}`,
  `grep foo ${file} | head`,
  `bash -c 'grep id ${file}'`,
  `timeout 60 true; grep id ${file}`,
  `grep -R id ~/.claude/projects/`,
  `rg id ~/.claude/projects/`,
  `ag id ~/.claude/projects/`,
  `ugrep id ${file}`,
  `egrep id ${file}`,
  'cd ~/.claude/projects/sample && grep id session.jsonl',
  "bash -c 'cd ~/.claude/projects/sample; grep id session.jsonl'",
  'cd ~/.claude/projects/sample && rg id .',
  'cd ~/.claude/projects/sample && rg id',
  'cd ~/.claude/projects/sample && grep -R id',
  'rg id ~/.claude/projects/sample.name',
  'rg id ~/.claude/projects/sample/folder.txt/',
  `timeout 0 grep id ${file}`,
  `timeout invalid grep id ${file}`,
]) test(`blocks unbounded search: ${command}`, () => assert.equal(run(command).decision, 'block'));
for (const command of [
  `timeout 60 nice -n 19 grep -m 5 -F id ${file}`,
  'rg foo src/',
  'grep foo sample.jsonl',
  `timeout 60 bash -c 'grep id ${file}'`,
  `bash -c 'timeout 60 grep id ${file}'`,
  `echo 'grep foo ${file}'`,
  'grep foo ~/.claude/projects/sample/notes.txt',
  `grep -F '${file}' src/index.js`,
]) test(`allows bounded or unrelated search: ${command}`, () => assert.equal(run(command).decision, undefined));
test('warns about large regex without blocking bounded search', () => {
  const result = run(`timeout 60 grep -oE '.{300}id.{200}' ${file}`);
  assert.equal(result.decision, undefined);
  assert.match(result.warning, /warning/i);
});
test('fixed strings and match limit suppress regex warning', () => assert.equal(run(`timeout 60 grep -m 5 -F '.{300}' ${file}`).warning, ''));
test('ignores other tools', () => assert.equal(run(`grep id ${file}`, 'Read').decision, undefined));
test('uses metadata to distinguish files and directories with arbitrary suffixes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-heavy-search-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, '.claude/projects/sample');
  fs.mkdirSync(path.join(dir, 'folder.txt'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.xml'), 'sample');
  assert.equal(run(`rg id '${dir}/session.xml'`).decision, undefined);
  assert.equal(run(`rg id '${dir}/folder.txt'`).decision, 'block');
});
