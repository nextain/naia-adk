import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { removeOwnedRoot } from './cleanup.mjs';

function fixture(fn) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'runnermerge-cleanup-'));
    const root = path.join(base, 'attempt-test'); fs.mkdirSync(root);
    try { return fn({ base, root }); }
    finally { fs.rmSync(base, { recursive: true, force: true }); }
}

test('B-3 descriptor traversal preserves outside modes during parent symlink swap', () => fixture(({ base, root }) => {
    const tmp = path.join(root, 'tmp'), moved = path.join(root, 'moved'), outside = path.join(base, 'outside');
    fs.mkdirSync(path.join(tmp, 'locked'), { recursive: true });
    fs.mkdirSync(path.join(outside, 'locked'), { recursive: true });
    fs.chmodSync(path.join(outside, 'locked'), 0o500);
    const original = fs.readdirSync; let swapped = false;
    fs.readdirSync = function (p, ...args) {
        const names = original.call(this, p, ...args);
        if (!swapped && fs.statSync(p).ino === fs.statSync(tmp).ino) {
            swapped = true; fs.renameSync(tmp, moved); fs.symlinkSync(outside, tmp);
        }
        return names;
    };
    try {
        removeOwnedRoot(root, {}, base);
        assert.equal(swapped, true);
        assert.equal(fs.statSync(path.join(outside, 'locked')).mode & 0o777, 0o500);
    } finally { fs.readdirSync = original; }
}));

test('A-4 foreign directory chmod EPERM does not prevent child repair or removal', () => fixture(({ base, root }) => {
    const parent = path.join(root, 'foreign'), child = path.join(parent, 'locked');
    fs.mkdirSync(child, { recursive: true }); fs.chmodSync(child, 0o500);
    const parentInode = fs.statSync(parent).ino, childInode = fs.statSync(child).ino;
    const chmod = fs.chmodSync, fchmod = fs.fchmodSync; let repaired = false, denied = false;
    const check = (stat) => {
        if (stat.ino === parentInode) { denied = true; throw Object.assign(Error('foreign'), { code: 'EPERM' }); }
        if (stat.ino === childInode) repaired = true;
    };
    fs.chmodSync = function (p, mode) { check(fs.statSync(p)); return chmod.call(this, p, mode); };
    fs.fchmodSync = function (fd, mode) { check(fs.fstatSync(fd)); return fchmod.call(this, fd, mode); };
    try { removeOwnedRoot(root, {}, base); assert.equal(denied, true); assert.equal(repaired, true); assert.equal(fs.existsSync(root), false); }
    finally { fs.chmodSync = chmod; fs.fchmodSync = fchmod; }
}));

test('B-2 removal retries ENOTEMPTY and starts a fresh walk', () => fixture(({ base, root }) => {
    const original = fs.rmSync; let calls = 0;
    fs.rmSync = function (p, options) {
        if (p === root) {
            calls++;
            assert.equal(options.maxRetries, calls === 1 ? 5 : 0);
            assert.equal(options.retryDelay, 100);
            if (calls === 1) throw Object.assign(Error('late writer'), { code: 'ENOTEMPTY' });
        }
        return original.call(this, p, options);
    };
    try { removeOwnedRoot(root, {}, base); assert.equal(calls, 2); assert.equal(fs.existsSync(root), false); }
    finally { fs.rmSync = original; }
}));

test('B-2 removal tolerates concurrent detached child writes', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'runnermerge-writer-'));
    const root = path.join(base, 'attempt-writer'); fs.mkdirSync(root);
    const child = spawn(process.execPath, ['-e', `const fs=require('fs'); const p=process.argv[1]; const end=Date.now()+350; process.stdout.write('ready\\n'); let i=0; while(Date.now()<end) { try { fs.writeFileSync(p+'/'+(i++%80), 'x'); } catch {} }`, root], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    try {
        await once(child.stdout, 'data');
        removeOwnedRoot(root, {}, base);
        await exited;
        assert.equal(fs.existsSync(root), false);
    } finally { await exited; fs.rmSync(base, { recursive: true, force: true }); }
});

test('B-2 persistent ENOTEMPTY ends after two fresh walks', () => fixture(({ base, root }) => {
    const original = fs.rmSync; let calls = 0;
    fs.rmSync = function (p, ...args) {
        if (p === root) { calls++; assert.equal(args[0].maxRetries, calls === 1 ? 5 : 0); throw Object.assign(Error('persistent writer'), { code: 'ENOTEMPTY' }); }
        return original.call(this, p, ...args);
    };
    try { assert.throws(() => removeOwnedRoot(root, {}, base), { code: 'ENOTEMPTY' }); assert.equal(calls, 2); }
    finally { fs.rmSync = original; }
}));

test('B-3 conventional root swap cannot chmod an external owner marker', () => fixture(({ base, root }) => {
    const outside = path.join(base, 'outside'), moved = path.join(base, 'moved');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(root, '.worker-runner-owner'), 'owned');
    const foreignMarker = path.join(outside, '.worker-runner-owner');
    fs.writeFileSync(foreignMarker, 'foreign'); fs.chmodSync(foreignMarker, 0o400);
    const inode = fs.statSync(root).ino, original = fs.closeSync;
    let swapped = false;
    fs.closeSync = function (fd) {
        if (!swapped && fs.fstatSync(fd).ino === inode) {
            swapped = true; fs.renameSync(root, moved); fs.symlinkSync(outside, root);
        }
        return original.call(this, fd);
    };
    try {
        assert.throws(() => removeOwnedRoot(root, { tempRoot: root, tempBase: base, tempToken: 'owned' }, base));
        assert.equal(swapped, true);
        assert.equal(fs.statSync(foreignMarker).mode & 0o777, 0o400);
        assert.equal(fs.readFileSync(foreignMarker, 'utf8'), 'foreign');
    } finally { fs.closeSync = original; }
}));
