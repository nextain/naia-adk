import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkMessage, assertMessage } from '../scripts/lib/message-guard.mjs';

const root = mkdtempSync(join(tmpdir(), 'message-guard-'));
mkdirSync(join(root, 'worker'));
writeFileSync(join(root, 'worker', 'brief.md'), 'work');
mkdirSync(join(root, 'empty'));
const pass = [
  '검사가 빠졌다. scripts/message-guard.mjs를 18:30까지 연결한다.',
  'scripts/check.mjs로 철저히 검사한다.',
  '최선을 다해 18:30까지 검사한다.',
  '더욱 노력해 PR #190을 확인한다.',
  '`pnpm test`로 결과로 증명한다.',
  '깊이 반성하며 /work/plan.md를 수정한다.',
  'I will be more careful using `pnpm test`.',
  'make sure to run tests at 12:30.',
  '일꾼을 worker/ 구동하였습니다.',
  '커밋 abc1234로 병합했습니다.',
  'https://example.com/deploy 에 배포했다.',
];
const block = [
  '깊이 반성합니다 … 더욱 철저히 하여 … 작업이 멈추지 않도록 관리하겠습니다',
  '말은 줄이고 결과로 증명하겠습니다',
  '최선을 다하겠습니다.',
  '더욱 노력하겠습니다.',
  '앞으로는 이런 일이 발생하지 않도록 하겠습니다.',
  'make sure to check everything.',
  'I will be more careful.',
  '일꾼을 즉시 구동하였고 확인 중입니다.',
  '문제를 해소했습니다.',
  '변경을 병합했습니다.',
  '서비스를 배포했다.',
  '일꾼을 empty/ 띄웠습니다.',
  '철저히 확인한다. scripts/check.mjs가 있다.',
];
for (const body of pass) test(`passes: ${body}`, () => assert.equal(checkMessage(body, {cwd: root}).ok, true));
for (const body of block) test(`blocks: ${body}`, () => {
  const result = checkMessage(body, {cwd: root});
  assert.equal(result.ok, false);
  assert.ok(result.issues.every(i => i.reason && i.suggestion));
});
test('empty folder fails even with other evidence', () => assert.equal(checkMessage('empty/ 를 abc1234로 구동했습니다.', {cwd: root}).ok, false));
test('optional unit hook blocks failure and accepts success', () => {
  const body = 'worker/ 를 구동했습니다.';
  assert.equal(checkMessage(body, {cwd: root, unitStatus: () => false}).ok, false);
  assert.equal(checkMessage(body, {cwd: root, unitStatus: () => true}).ok, true);
  assert.throws(() => assertMessage(body, {cwd: root, unitStatus: () => false}), /유닛 상태/);
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
