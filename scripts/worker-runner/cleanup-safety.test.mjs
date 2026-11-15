import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeOwnedRoot } from './cleanup.mjs';

function fixture(fn) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-safety-'));
    const root = path.join(base, 'worker');
    fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(root, '.worker-runner-owner'), 'token');
    const job = { tempRoot: root, tempBase: base, tempToken: 'token' };
    try { fn({ base, root, job }); }
    finally { fs.rmSync(base, { recursive: true, force: true }); }
}

test('conventional root and mode-000 marker recover before ownership validation', () => fixture(({ root, job }) => {
    fs.chmodSync(path.join(root, '.worker-runner-owner'), 0);
    fs.chmodSync(root, 0o400);
    removeOwnedRoot(root, job, '/unused/runs');
    assert.equal(fs.existsSync(root), false);
}));

test('missing root returns without chmod or rm even if another actor recreates it', () => fixture(({ root, job }) => {
    fs.rmSync(root, { recursive: true });
    const original = fs.lstatSync, originalRm = fs.rmSync;
    let removed = false;
    fs.lstatSync = function (p, ...args) {
        if (p === root) {
            // ancestors() sees missing first, final root lookup sees missing next.
            const error = Object.assign(Error('gone'), { code: 'ENOENT' });
            throw error;
        }
        return original.call(this, p, ...args);
    };
    fs.rmSync = function (...args) { removed = true; return originalRm.apply(this, args); };
    try { removeOwnedRoot(root, job, '/unused/runs'); assert.equal(removed, false); }
    finally { fs.lstatSync = original; fs.rmSync = originalRm; }
}));

test('EPERM repairing a parent still repairs its accessible children', () => fixture(({ root, job }) => {
    const child = path.join(root, 'tmp/locked');
    fs.mkdirSync(child); fs.writeFileSync(path.join(child, 'data'), 'x'); fs.chmodSync(child, 0o500);
    const original = fs.fchmodSync, originalOpen = fs.openSync;
    const denied = new Set(); let childRepaired = false;
    fs.openSync = function (p, ...args) { const fd = originalOpen.call(this, p, ...args); if (p === path.join(root, 'tmp')) denied.add(fd); else denied.delete(fd); return fd; };
    fs.fchmodSync = function (fd, mode) {
        if (denied.has(fd)) throw Object.assign(Error('foreign owner'), { code: 'EPERM' });
        if (fs.fstatSync(fd).ino === fs.statSync(child).ino) childRepaired = true;
        return original.call(this, fd, mode);
    };
    try { removeOwnedRoot(root, job, '/unused/runs'); assert.equal(childRepaired, true); }
    finally { fs.fchmodSync = original; fs.openSync = originalOpen; }
}));

test('cleanup leaves external symlink and file hardlink modes unchanged', () => fixture(({ base, root, job }) => {
    const outside = path.join(base, 'outside'); fs.mkdirSync(outside); fs.chmodSync(outside, 0o500);
    const file = path.join(base, 'file'); fs.writeFileSync(file, 'safe'); fs.chmodSync(file, 0o400);
    fs.symlinkSync(outside, path.join(root, 'tmp/link')); fs.linkSync(file, path.join(root, 'tmp/hardlink'));
    removeOwnedRoot(root, job, '/unused/runs');
    assert.equal(fs.statSync(outside).mode & 0o777, 0o500); assert.equal(fs.statSync(file).mode & 0o777, 0o400);
}));

test('actual run cleans chmod-0400 TMPDIR and chmod-0000 owner marker outside TMPDIR', async () => {
    const { spawnSync } = await import('node:child_process');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-run-'));
    try {
        const result = spawnSync(process.execPath, [new URL('./cli.mjs', import.meta.url).pathname, 'run', '--allow-unregistered-test', '--state-dir', path.join(base, 'state'), '--temp-base', base, '--id', 'locked-worker', '--work-dir', base, '--budget', '4M', '--floor', '1K', '--poll-ms', '30', '--', '/bin/sh', '-c', 'test "$TMPDIR" != "$WORKER_RUNNER_TMP_ROOT" || exit 31; test -f "$WORKER_RUNNER_TMP_ROOT/.worker-runner-owner" || exit 32; test ! -e "$TMPDIR/.worker-runner-owner" || exit 33; chmod 0000 "$WORKER_RUNNER_TMP_ROOT/.worker-runner-owner"; chmod 0400 "$TMPDIR"; chmod 0400 "$WORKER_RUNNER_TMP_ROOT"'], { encoding: 'utf8', timeout: 10000 });
        assert.equal(result.status, 0, result.stderr);
        const job = JSON.parse(fs.readFileSync(path.join(base, 'state/state.json'), 'utf8')).jobs.find(j => j.id === 'locked-worker');
        assert.equal(job.cleanupRoot, undefined);
        assert.equal(fs.existsSync(path.join(base, 'locked-worker')), false);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('ownership validation rejects traversal and hardlinked marker before chmod', () => fixture(({ base, root, job }) => {
    assert.throws(() => removeOwnedRoot(`${root}/../worker`, job, '/unused/runs'), /traversal/);
    const marker = path.join(root, '.worker-runner-owner');
    fs.linkSync(marker, path.join(base, 'marker-link'));
    fs.chmodSync(marker, 0o400);
    assert.throws(() => removeOwnedRoot(root, job, '/unused/runs'), /Unowned cleanup marker/);
    assert.equal(fs.statSync(marker).mode & 0o777, 0o400);
}));

test('O_NOFOLLOW prevents chmod when a checked directory is replaced by a symlink', () => fixture(({ base, root, job }) => {
    const checked = path.join(root, 'tmp'), outside = path.join(base, 'outside');
    fs.mkdirSync(outside); fs.mkdirSync(path.join(outside, 'locked')); fs.chmodSync(path.join(outside, 'locked'), 0o500); fs.chmodSync(outside, 0o500);
    const original = fs.openSync;
    let replaced = false;
    fs.openSync = function (p, ...args) {
        if (!replaced && fs.realpathSync(p) === checked) { replaced = true; fs.rmdirSync(checked); fs.symlinkSync(outside, checked); }
        return original.call(this, p, ...args);
    };
    try { removeOwnedRoot(root, job, '/unused/runs'); assert.equal(replaced, true); assert.equal(fs.statSync(outside).mode & 0o777, 0o500); assert.equal(fs.statSync(path.join(outside, 'locked')).mode & 0o777, 0o500); }
    finally { fs.openSync = original; fs.chmodSync(outside, 0o700); fs.chmodSync(path.join(outside, 'locked'), 0o700); }
}));
