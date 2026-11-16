'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const cli = path.join(root, '.agents/scripts/approval-plan.mjs');
const lib = require('../lib/deploy-plan.js');
const { classifyProdMutations } = require('../lib/deploy-command-classifier.js');
const human = require('../lib/deploy-human-approval.js');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('registered targets override dev/test and unregistered targets retain their behavior', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-test-'));
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(path.join(dir, 'config/deploy-gate.json'), JSON.stringify({ services: { 'azure:vm:sample-dev-vm': {}, 'azure:group:rg-test-one': {}, 'ssh:test-host': {} }, testHosts: ['sample-dev-vm', 'test-host'] }));
  const run = (s) => classifyProdMutations(s, dir, 0, false, dir);
  assert.ok(run('az vm run-command invoke -g rg-dev -n sample-dev-vm --command-id RunShellScript --scripts id').length);
  assert.ok(run('az vm run-command invoke -g rg-test-one -n other-dev --command-id RunShellScript --scripts id').length);
  assert.ok(run('ssh test-host touch /tmp/a').length);
  assert.equal(run('az vm run-command invoke -g rg-dev -n other-dev --command-id RunShellScript --scripts id').length, 0);
  const hook = (command) => spawnSync(process.execPath, [path.join(root, '.claude/hooks/deploy-guard.js')], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: dir, session_id: 'test' }), encoding: 'utf8',
    env: { ...process.env, HOME: dir, XDG_STATE_HOME: path.join(dir, 'state'), DEPLOY_READINESS_ROOT: dir, CLAUDE_PROJECT_DIR: dir },
  });
  const registered = hook('az vm run-command invoke -g rg-dev -n sample-dev-vm --command-id RunShellScript --scripts id');
  assert.equal(JSON.parse(registered.stdout).decision, 'block');
  const unregistered = hook('az vm run-command invoke -g rg-dev -n other-dev --command-id RunShellScript --scripts id');
  assert.equal(unregistered.stdout.trim(), '');
});

test('assert checks the consumed step command, plan and files, including copied scripts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-assert-'));
  const gates = path.join(dir, '.agents/progress/work/gates');
  const state = path.join(dir, 'state');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.mkdirSync(gates, { recursive: true });
  fs.mkdirSync(state);
  const planFile = path.join(gates, 'deploy-plan.json');
  const script = path.join(dir, 'run.sh');
  const marker = path.join(dir, 'executed');
  const source = `#!/bin/sh\nnode ${cli} assert ${planFile} s1 || exit 1\ntouch ${marker}\n`;
  fs.writeFileSync(script, source);
  const command = `bash ${script}`;
  const plan = { scenario: [{ id: 's1', commands: [command], files: { [script]: sha(source) } }, { id: 's2', commands: ['true'], files: {} }] };
  const savePlan = () => fs.writeFileSync(planFile, JSON.stringify(plan));
  savePlan();
  const env = { ...process.env, DEPLOY_APPROVAL_STATE_DIR: state, HOME: dir, XDG_STATE_HOME: state };
  const invoke = () => spawnSync(process.execPath, [cli, 'assert', planFile, 's1'], { env, encoding: 'utf8' });
  const saveState = (step, commandHash) => fs.writeFileSync(path.join(state, 'deploy-plan-state.json'), JSON.stringify({ challenges: [{ kind: 'step', planSha: sha(fs.readFileSync(planFile)), step, code: 'STEP-ABCDEF', approvedAt: new Date().toISOString(), approvedVia: 'discord', executed: [commandHash] }] }));
  assert.notEqual(invoke().status, 0);
  saveState('s2', human.commandHash(command));
  assert.notEqual(invoke().status, 0);
  saveState('s1', human.commandHash('other'));
  assert.notEqual(invoke().status, 0);
  saveState('s1', human.commandHash(command));
  assert.equal(invoke().status, 0);
  const outsideCli = path.join(dir, 'outside-approval-plan.mjs');
  fs.symlinkSync(cli, outsideCli);
  assert.notEqual(spawnSync(process.execPath, [outsideCli, 'assert', planFile, 's1'], { env, encoding: 'utf8' }).status, 0);
  const outsideBody = source.replace(cli, outsideCli);
  fs.writeFileSync(script, outsideBody);
  assert.ok(lib.assertScriptProblems(plan, dir, planFile).length);
  fs.writeFileSync(script, source);
  fs.appendFileSync(planFile, ' ');
  assert.notEqual(invoke().status, 0);
  savePlan();
  fs.appendFileSync(script, '# changed\n');
  assert.notEqual(invoke().status, 0);
  fs.writeFileSync(script, source);
  assert.equal(invoke().status, 0);
  assert.deepEqual(lib.assertScriptProblems(plan, dir, planFile), []);
  fs.writeFileSync(script, '#!/bin/sh\ntouch /tmp/unsafe\n');
  assert.ok(lib.assertScriptProblems(plan, dir, planFile).length);
  const check = spawnSync(process.execPath, [cli, 'check', planFile], { env, encoding: 'utf8' });
  assert.notEqual(check.status, 0);
  assert.match(check.stdout, /첫 동작.*assert/);
  fs.writeFileSync(script, source);
  fs.writeFileSync(path.join(state, 'deploy-plan-state.json'), '{}');
  for (const [program, args] of [['perl', ['-e', 'exec "bash", $ARGV[0]', script]], ['awk', ['BEGIN { exit system("bash " ARGV[1]) }', script]], ['sh', [path.join(dir, 'copy.sh')]]]) {
    if (program === 'sh') fs.copyFileSync(script, args[0]);
    const result = spawnSync(program, args, { env, encoding: 'utf8' });
    assert.notEqual(result.status, 0, program);
    assert.equal(fs.existsSync(marker), false, program);
  }
});

test('shell, Node and Python assert forms bind the actual step and stop on failure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-assert-lang-'));
  const gates = path.join(dir, '.agents/progress/work/gates');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.mkdirSync(gates, { recursive: true });
  const planFile = path.join(gates, 'deploy-plan.json');
  const marker = path.join(dir, 'marker');
  const argv = JSON.stringify([cli, 'assert', planFile, 's1']);
  const forms = [
    ['bash', 'job.sh', `#!/bin/sh\nnode ${cli} assert ${planFile} "$1" || exit 1\ntouch ${marker}\n`, ['s1']],
    ['node', 'job.cjs', `require("node:child_process").execFileSync("node", ${argv});\nrequire("node:fs").writeFileSync("${marker}", "x");\n`, []],
    ['node', 'job.mjs', `(await import("node:child_process")).execFileSync("node", ${argv});\n(await import("node:fs")).writeFileSync("${marker}", "x");\n`, []],
    ['python3', 'job.py', `__import__("subprocess").run(${JSON.stringify(['node', cli, 'assert', planFile, 's1'])}, check=True)\nopen("${marker}", "w").write("x")\n`, []],
  ];
  const env = { ...process.env, HOME: dir, XDG_STATE_HOME: path.join(dir, 'state'), DEPLOY_APPROVAL_STATE_DIR: path.join(dir, 'state') };
  for (const [program, name, body, extra] of forms) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, body);
    const command = [program, file, ...extra].join(' ');
    const plan = { scenario: [{ id: 's1', commands: [command], files: { [file]: sha(body) } }] };
    fs.writeFileSync(planFile, JSON.stringify(plan));
    assert.deepEqual(lib.assertScriptProblems(plan, dir, planFile), [], name);
    assert.notEqual(spawnSync(program, [file, ...extra], { env }).status, 0, name);
    assert.equal(fs.existsSync(marker), false, name);
  }
});


test('only the first valid self-check line is exempt from file references', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-refs-'));
  const plan = path.join(dir, 'deploy-plan.json');
  const script = path.join(dir, 'run.sh');
  const data = path.join(dir, 'data.json');
  fs.writeFileSync(plan, '{}');
  fs.writeFileSync(data, '{}');
  const first = `node ${cli} assert ${plan} s1 || exit 1`;
  fs.writeFileSync(script, `#!/bin/sh\n${first}\ncat ${data}\n`);
  const refs = () => lib.referencedFiles(`bash ${script}`, dir).map((x) => x.path);
  assert.ok(refs().includes(script));
  assert.ok(refs().includes(data));
  assert.ok(!refs().includes(plan));
  assert.ok(!refs().includes(cli));
  fs.appendFileSync(script, `${first}\n`);
  assert.ok(refs().includes(plan));
  assert.ok(refs().includes(cli));
  fs.writeFileSync(script, `#!/bin/sh\necho start\n${first}\n`);
  assert.ok(refs().includes(plan));
  fs.writeFileSync(script, `#!/bin/sh\nnode /outside/.agents/scripts/approval-plan.mjs assert ${plan} s1 || exit 1\n`);
  assert.ok(refs().includes(plan));
});
