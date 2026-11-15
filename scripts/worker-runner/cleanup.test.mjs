import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const cli = new URL('./cli.mjs', import.meta.url).pathname;
test('read-only abandoned attempt is removed without following internal symlinks', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-permissions-'));
    const state = path.join(base, 'state'), owned = path.join(state, 'runs/attempt-readonly'), locked = path.join(owned, 'tmp/readonly'), outside = path.join(base, 'outside');
    try {
        fs.mkdirSync(locked, { recursive: true }); fs.mkdirSync(outside);
        fs.writeFileSync(path.join(locked, 'data'), 'occupied'); fs.writeFileSync(path.join(outside, 'keep'), 'safe');
        fs.symlinkSync(outside, path.join(owned, 'external')); fs.chmodSync(outside, 0o555); fs.chmodSync(locked, 0o555);
        fs.writeFileSync(path.join(state, 'state.json'), JSON.stringify({ version: 2, sequence: 1, jobs: [{ id: 'dead', owner: 99999999, ownerToken: 'dead', status: 'running', root: owned, remaining: 4096, budget: 4096 }] }));
        const r = spawnSync(process.execPath, [cli, 'status', '--state-dir', state], { encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr); assert.equal(fs.existsSync(owned), false);
        assert.equal(fs.statSync(outside).mode & 0o777, 0o555); assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'safe');
    } finally { fs.chmodSync(outside, 0o755); if (fs.existsSync(locked)) fs.chmodSync(locked, 0o755); fs.rmSync(base, { recursive: true, force: true }); }
});
test('EACCES cleanup is recorded, retained beyond history limit, and retried by status', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-retry-'));
    const state = path.join(base, 'state'), owned = path.join(state, 'runs/attempt-denied');
    try {
        fs.mkdirSync(owned, { recursive: true }); fs.writeFileSync(path.join(owned, 'data'), Buffer.alloc(8192));
        const jobs = [{ id: 'dead', owner: 99999999, ownerToken: 'dead', status: 'running', root: owned, remaining: 4096, budget: 4096 }, ...Array.from({ length: 101 }, (_, i) => ({ id: `history-${i}`, status: 'finished', ended: Date.now() + 1000 }))];
        fs.writeFileSync(path.join(state, 'state.json'), JSON.stringify({ version: 2, sequence: jobs.length, jobs }));
        const probe = path.join(base, 'probe.mjs');
        fs.writeFileSync(probe, `import fs from 'node:fs';\nconst rm = fs.rmSync;\nfs.rmSync = function(p, ...args) { if(p === ${JSON.stringify(owned)}) throw Object.assign(Error('forced EACCES'), {code:'EACCES'}); return rm.call(this,p,...args); };\nprocess.argv = [process.execPath, ${JSON.stringify(cli)}, 'status', '--state-dir', ${JSON.stringify(state)}];\nawait import(${JSON.stringify(pathToFileURL(cli).href)});\n`);
        const r = spawnSync(process.execPath, [probe], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr);
        let j = JSON.parse(fs.readFileSync(path.join(state, 'state.json'))).jobs.find(j => j.id === 'dead');
        assert.ok(j, 'pending cleanup must survive history pruning'); assert.equal(j.cleanupRoot, owned); assert.match(j.cleanupError, /EACCES/);
        assert.equal(fs.statSync(path.join(owned, 'data')).size, 8192, 'failed cleanup still occupies disk measured by df');
        assert.match(fs.readFileSync(path.join(state, 'supervisor.jsonl'), 'utf8'), /"event":"cleanup-failed"/);
        const paused = JSON.parse(fs.readFileSync(path.join(state, 'state.json')));
        paused.jobs.find(j => j.id === 'dead').cleanupNextAt = Date.now() + 60000;
        fs.writeFileSync(path.join(state, 'state.json'), JSON.stringify(paused));
        const statusProbe = fs.readFileSync(probe, 'utf8');
        const launch = id => {
            const args = [process.execPath, cli, 'run', '--allow-unregistered-test', '--state-dir', state, '--temp-base', base, '--id', id, '--work-dir', base, '--budget', '1M', '--floor', '1K', '--poll-ms', '30', '--', '/bin/sh', '-c', 'echo survived'];
            fs.writeFileSync(probe, statusProbe.replace(/process\.argv = .*;\n/, `process.argv = ${JSON.stringify(args)};\n`));
            return spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 10000 });
        };
        const duplicate = launch('dead'); assert.notEqual(duplicate.status, 0); assert.match(duplicate.stderr, /cleanup is pending/); assert.doesNotMatch(duplicate.stdout, /survived/);
        const healthy = launch('healthy'); assert.equal(healthy.status, 0, healthy.stderr); assert.match(healthy.stdout, /survived/);
        const pendingState = JSON.parse(fs.readFileSync(path.join(state, 'state.json'), 'utf8'));
        pendingState.jobs.find(j => j.id === 'dead').cleanupNextAt = 0; // Advance this fixture to its scheduled retry.
        fs.writeFileSync(path.join(state, 'state.json'), JSON.stringify(pendingState));
        const retry = spawnSync(process.execPath, [cli, 'status', '--state-dir', state], { encoding: 'utf8' }); assert.equal(retry.status, 0, retry.stderr);
        assert.equal(fs.existsSync(owned), false);
        j = JSON.parse(fs.readFileSync(path.join(state, 'state.json'))).jobs.find(j => j.id === 'dead'); assert.ok(!j || !j.cleanupRoot);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('preempted round cannot relaunch over its failed cleanup root', async () => {
    const { finish, schedule } = await import('./core.mjs');
    const state = { jobs: [{ id: 'retry', status: 'running', root: '/owned/attempt-first', budget: 4, remaining: 4, priority: 0, order: 1 }] };
    finish(state, 'retry', () => { throw Error('EACCES'); }, 'preempted');
    assert.deepEqual(schedule(state, 100, 5, 1), []);
    assert.equal(state.jobs[0].cleanupRoot, '/owned/attempt-first');
    delete state.jobs[0].cleanupRoot; delete state.jobs[0].cleanupError;
    assert.deepEqual(schedule(state, 100, 5, 2), [{ type: 'start', id: 'retry' }]);
});

test('retry clears a conventional root already removed between reconciliations', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-missing-')), state = path.join(base, 'state'), owned = path.join(base, 'gone');
    try {
        fs.mkdirSync(state);
        fs.writeFileSync(path.join(state, 'state.json'), JSON.stringify({ version: 2, sequence: 1, jobs: [{ id: 'gone', status: 'finished', cleanupRoot: owned, cleanupError: 'EACCES', tempRoot: owned, tempBase: base, tempToken: 'fixture', remaining: 0 }] }));
        const result = spawnSync(process.execPath, [cli, 'status', '--state-dir', state], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
        const j = JSON.parse(fs.readFileSync(path.join(state, 'state.json'))).jobs[0]; assert.equal(j.cleanupRoot, undefined); assert.equal(j.cleanupError, undefined);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
