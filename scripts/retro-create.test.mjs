import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { request, template } from './retro-create.mjs';
import { checkRetro } from './retro-format-check.mjs';

const role = 'writer', day = '2026-11-11', period = 'weekly';
const cli = (...args) => spawnSync(process.execPath, ['scripts/retro-create.mjs', ...args], { encoding: 'utf8' });

test('template provides all sections; unfinished research fails validation', () => {
  const draft = template(role, day, period);
  const problems = checkRetro(draft, { role, day, period });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /source URL/);
  assert.match(draft, /## 7\. 다음 기간 목표/);
});

test('request uses configured role and artifact and describes period', () => {
  const text = request(role, day, period, 'reviews/weekly.md');
  assert.match(text, /담당 역할: writer/);
  assert.match(text, /결과 문서: reviews\/weekly.md/);
  assert.match(text, /지난 7일/);
  assert.match(text, /인터넷 검색/);
  assert.throws(() => request(role, day, period, 'bad\npath'));
  assert.throws(() => template(role, day, 'constructor'));
});

test('CLI creates a repair request for a missing file and refuses overwrite', () => {
  const missing = cli('repair', role, day, period, 'nonexistent-retro-document.md');
  assert.equal(missing.status, 0);
  assert.match(missing.stdout, /회고 문서가 없음/);
  const existing = cli('template', role, day, period, '--output', 'scripts/retro-create.mjs');
  assert.equal(existing.status, 2);
  assert.match(existing.stderr, /EEXIST/);
});

test('CLI emits correction request for an invalid existing document', () => {
  const result = cli('repair', role, day, period, 'scripts/retro-create.test.mjs');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /교정:/);
  assert.match(result.stdout, /source URL|heading/);
});
