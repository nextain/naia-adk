import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { checkRetro } from './retro-format-check.mjs';

const good = `# writer 매일 회고 — 2026-11-11

쓴 역할: writer
## 1. 회고
Evidence and results.
## 2. 목표 개선
Next change.
## 3. 리서치
https://example.org/source
## 4. 잡생각
An idea.
## 5. 계속 밀리는 일
None.
`;
const options = { role: 'writer', day: '2026-11-11' };

test('daily format permits extra headings and optional heading detail', () => {
  assert.deepEqual(checkRetro(good.replace('## 1. 회고', '## 0. 메모\nextra\n## 1. 회고 (오늘)'), options), []);
});

test('checks title, author, ordered unique headings and research source', () => {
  const broken = good.replace('# writer', '# other').replace('쓴 역할: writer', '쓴 역할:')
    .replace('## 2. 목표 개선\nNext change.\n', '')
    .replace('## 4. 잡생각', '## 4. 잡생각\n## 2. 목표 개선\n## 2. 목표 개선')
    .replace('https://example.org/source', 'no source');
  const problems = checkRetro(broken, options).join('\n');
  for (const part of ['title', 'author', 'expected one heading', 'source URL']) assert.match(problems, new RegExp(part));
  assert.ok(checkRetro(good.replace('## 2. 목표 개선\nNext change.\n', '').replace('## 4. 잡생각', '## 4. 잡생각\n## 2. 목표 개선'), options).some((p) => p.includes('out of order')));
});

test('fenced examples cannot satisfy a missing source or section', () => {
  const broken = good.replace('https://example.org/source', '```\nhttps://example.org/source\n```')
    .replace('## 5. 계속 밀리는 일', '```\n## 5. 계속 밀리는 일\n```');
  const problems = checkRetro(broken, options);
  assert.ok(problems.some((p) => p.includes('source URL')));
  assert.ok(problems.some((p) => p.includes('계속 밀리는 일')));
});

test('hidden HTML comments cannot satisfy the research source requirement', () => {
  for (const comment of [
    '<!-- https://example.invalid/hidden -->',
    '<!--\nhttps://example.invalid/hidden\n-->',
  ]) {
    const problems = checkRetro(good.replace('https://example.org/source', comment), options);
    assert.ok(problems.some((problem) => problem.includes('source URL')));
  }
  const visibleSource = good.replace('https://example.org/source', '<!-- https://example.invalid/hidden -->\nhttps://example.org/source');
  assert.deepEqual(checkRetro(visibleSource, options), []);
  const fenceInComment = good.replace('https://example.org/source', '<!--\n```\n-->\nhttps://example.org/source');
  assert.deepEqual(checkRetro(fenceInComment, options), []);
  const commentInFence = good.replace('https://example.org/source', '```\n<!--\n```\nhttps://example.org/source');
  assert.deepEqual(checkRetro(commentInFence, options), []);
});

test('the declared author must match the role', () => {
  assert.ok(checkRetro(good.replace('쓴 역할: writer', '쓴 역할: other'), options).some((p) => p.includes('author')));
});

test('aggregate periods require the extra sections', () => {
  const weekly = good.replace('매일 회고', '주간 회고');
  assert.equal(checkRetro(weekly, { ...options, period: 'weekly' }).length, 2);
  assert.deepEqual(checkRetro(`${weekly}\n## 6. 되풀이된 문제\nnone\n## 7. 다음 기간 목표\nnext\n`, { ...options, period: 'weekly' }), []);
  assert.throws(() => checkRetro(good, { ...options, day: '2026-02-30' }));
});

test('CLI reads stdin and distinguishes invalid format from invocation error', () => {
  const run = (input, args) => spawnSync(process.execPath, ['scripts/retro-format-check.mjs', ...args], { input, encoding: 'utf8' });
  assert.equal(run(good, ['-', 'writer', '2026-11-11', 'daily']).status, 0);
  assert.equal(run('', ['-', 'writer', '2026-11-11', 'daily']).status, 1);
  assert.equal(run('', ['-', 'writer', 'bad', 'daily']).status, 2);
  assert.equal(run('', ['missing-file', 'writer', '2026-11-11', 'daily']).status, 2);
});
