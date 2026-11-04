import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sha256, readProtectedFile } from './approved-root-runner.mjs';
import { verifyDigest, verifyReview, assertSeparateHost, readSigningKey } from './sign-approved-runner.mjs';
const cli = fileURLToPath(new URL('./sign-approved-runner.mjs', import.meta.url));
const temp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'signer-'));
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
test('review must be clean and bind the exact reviewed plan digest', () => {
  const digest = sha256(Buffer.from('approved plan'));
  verifyReview(Buffer.from(JSON.stringify({ verdict: 'clean', planSha256: digest })), digest);
  for (const review of [{ verdict: 'FAIL', planSha256: digest }, { verdict: 'clean', planSha256: '0'.repeat(64) }]) assert.throws(() => verifyReview(Buffer.from(JSON.stringify(review)), digest));
});
test('plan, review and role replacement invalidate pinned digests', () => {
  for (const name of ['Plan', 'Review', 'Roles']) {
    verifyDigest(Buffer.from('approved'), sha256(Buffer.from('approved')), name);
    assert.throws(() => verifyDigest(Buffer.from('replacement'), sha256(Buffer.from('approved')), name), /digest mismatch/);
    assert.throws(() => verifyDigest(Buffer.from('approved'), undefined, name));
  }
});
test('execution host and same caller UID cannot hold the signing key', () => {
  assert.throws(() => assertSeparateHost(sha256(readProtectedFile('/etc/machine-id'))), /execution host/);
  assert.throws(() => assertSeparateHost('invalid'));
  assert.throws(() => readSigningKey('/nonexistent', process.getuid()), /UID must differ/);
});
test('real CLI rejects original unpinned invocation and execution-host signing', () => {
  let result = spawnSync(process.execPath, [cli, 'key', 'plan', 'review', '1001', 'step', 'lead', 'roles'], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /Usage/); assert.equal(result.stdout, '');
  result = spawnSync(process.execPath, [cli, 'key', 'plan', 'review', String(process.getuid() + 1), 'step', 'lead', 'roles', '--expected-plan-sha256', '0'.repeat(64), '--expected-review-sha256', '0'.repeat(64), '--expected-roles-sha256', '0'.repeat(64), '--execution-machine-id-sha256', sha256(readProtectedFile('/etc/machine-id'))], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /execution host/); assert.equal(result.stdout, '');
});
test('workspace files, symlinks and hard links cannot become trusted signing inputs', () => {
  const filename = path.join(temp, 'input'); fs.writeFileSync(filename, 'data', { mode: 0o600 });
  assert.throws(() => readProtectedFile(filename));
  const symbolic = path.join(temp, 'symbolic'); fs.symlinkSync(filename, symbolic);
  assert.throws(() => readSigningKey(symbolic, process.getuid() + 1));
  const hard = path.join(temp, 'hard'); fs.linkSync(filename, hard);
  assert.throws(() => readSigningKey(hard, process.getuid() + 1));
});

test('real CLI rejects co-resident caller identity and workspace key before signing', () => {
  const input = path.join(temp, 'private-key'); fs.writeFileSync(input, 'not a key', { mode: 0o600 });
  const invoke = uid => spawnSync(process.execPath, [cli, input, input, input, String(uid), 'step', 'lead', input, '--expected-plan-sha256', '0'.repeat(64), '--expected-review-sha256', '0'.repeat(64), '--expected-roles-sha256', '0'.repeat(64), '--execution-machine-id-sha256', '0'.repeat(64)], { encoding: 'utf8' });
  const same = invoke(process.getuid());
  assert.equal(same.status, 1); assert.match(same.stderr, /UID must differ/); assert.equal(same.stdout, '');
  const workspace = invoke(process.getuid() + 1);
  assert.equal(workspace.status, 1); assert.match(workspace.stderr, /Untrusted path/); assert.equal(workspace.stdout, '');
});

test('key descriptor guard checks real permissions and link count after trusted ancestors', () => {
  const boundary = fs.mkdtempSync(path.join(temp, 'key-boundary-'));
  fs.chmodSync(boundary, 0o700);
  const filename = path.join(boundary, 'key');
  fs.writeFileSync(filename, 'synthetic-key-bytes', { mode: 0o600 });
  for (const mode of [0o400, 0o600]) {
    fs.chmodSync(filename, mode);
    assert.equal(readSigningKey(filename, process.getuid() + 1, boundary).toString(), 'synthetic-key-bytes');
  }
  for (const mode of [0o644, 0o640, 0o660, 0o700, 0o6000 | 0o600]) {
    fs.chmodSync(filename, mode);
    assert.throws(() => readSigningKey(filename, process.getuid() + 1, boundary));
  }
  fs.chmodSync(filename, 0o600);
  const linked = path.join(boundary, 'linked');
  fs.linkSync(filename, linked);
  assert.throws(() => readSigningKey(linked, process.getuid() + 1, boundary), /single-link/);
  fs.unlinkSync(linked);
  const symbolic = path.join(boundary, 'symbolic');
  fs.symlinkSync(filename, symbolic);
  assert.throws(() => readSigningKey(symbolic, process.getuid() + 1, boundary), /Untrusted path/);
});
