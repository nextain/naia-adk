import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { missingPaths, requiredPaths } from './check-unit-paths.mjs';
const script = fileURLToPath(new URL('./check-unit-paths.mjs', import.meta.url));
test('a path without "-" is required and a path with "-" is not', () => {
  const unit = '[Service]\nReadWritePaths=/a -/b +/c\nReadOnlyPaths=/d\nEnvironment=ReadWritePaths=/e\n';
  assert.deepEqual(requiredPaths(unit).map(item => item.path), ['/a', '/c', '/d']);
  assert.deepEqual(missingPaths(unit, path => path !== '/a').map(item => item.path), ['/a']);
});
test('the command fails while .next/cache is missing and passes once it exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unit-paths-'));
  const cache = join(dir, '.next', 'cache');
  const unit = join(dir, 'x.service');
  writeFileSync(unit, `[Service]\nReadWritePaths=${dir} ${cache}\n`);
  const before = spawnSync(process.execPath, [script, unit], { encoding: 'utf8' });
  assert.equal(before.status, 1);
  assert.match(before.stderr, /없음 .*\.next\/cache/);
  mkdirSync(cache, { recursive: true });
  const after = spawnSync(process.execPath, [script, unit], { encoding: 'utf8' });
  assert.equal(after.status, 0);
  assert.match(after.stdout, /요구 경로 2개 있음/);
});
