import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkMessage, assertMessage } from '../scripts/lib/message-guard.mjs';

const root = mkdtempSync(join(tmpdir(), 'message-guard-'));
mkdirSync(join(root, 'worker'));
writeFileSync(join(root, 'worker', 'brief.md'), 'work');
const cases = JSON.parse(readFileSync(new URL('../.agents/skills/manage-discord-sessions/helper/message-guard-cases.json', import.meta.url), 'utf8'));
for (const body of cases.pass) test(`passes: ${body}`, () => assert.equal(checkMessage(body, {cwd: root}).ok, true));
for (const body of cases.block) test(`blocks: ${body}`, () => {
  const result = checkMessage(body, {cwd: root});
  assert.equal(result.ok, false);
  assert.ok(result.issues.every(i => i.reason && i.suggestion));
});
test('worker requires actual execution evidence for its directory', () => {
  const body = '일꾼을 worker/ 구동했습니다.';
  assert.equal(checkMessage(body, {cwd: root, unitStatus: () => false}).ok, false);
  assert.equal(checkMessage(body, {cwd: root, unitStatus: () => true}).ok, true);
  assert.throws(() => assertMessage(body, {cwd: root, unitStatus: () => false}), /유닛/);
  writeFileSync(join(root, 'worker', 'run.done'), 'done');
  assert.equal(checkMessage(body, {cwd: root}).ok, true);
});
test('default checker verifies the named unit and working directory with systemctl', () => {
  const bin = join(root, 'bin'); mkdirSync(bin);
  const active = join(root, 'active'); mkdirSync(active);
  const systemctl = join(bin, 'systemctl');
  writeFileSync(systemctl, `#!/bin/sh\nprintf 'ActiveState=active\\nWorkingDirectory=%s\\n' '${active}'\n`, {mode: 0o755});
  const previous = process.env.PATH; process.env.PATH = `${bin}:${previous}`;
  try {
    const other = join(root, 'other'); mkdirSync(other);
    assert.equal(checkMessage('일꾼 active/ test.service 구동했습니다.', {cwd: root}).ok, true);
    assert.equal(checkMessage('일꾼 other/ test.service 구동했습니다.', {cwd: root}).ok, false);
  } finally { process.env.PATH = previous; }
});
test('CLI rejects and returns reason', () => {
  const result = spawnSync(process.execPath, ['scripts/message-guard.mjs'], {input:'철저히 하겠습니다.', encoding:'utf8'});
  assert.equal(result.status, 1); assert.match(result.stdout, /구체 근거/);
});
test('patterns are configurable', () => {
  const configPath = join(root, 'patterns.json');
  writeFileSync(configPath, JSON.stringify({abstract:['custom promise'], progress:[]}));
  assert.equal(checkMessage('custom promise', {configPath}).ok, false);
  assert.equal(checkMessage('철저히 하겠습니다', {configPath}).ok, true);
});
