import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from './core.mjs';

test('B-1 default temporary base falls back to state filesystem and explicit mismatch names path', () => {
    const devices = p => ({ dev: p === '/tmp' || p === '/explicit' ? 1 : 2 });
    assert.equal(core.selectTempBase(undefined, '/fake-state', devices), '/fake-state/runs');
    assert.equal(core.selectTempBase(undefined, '/fake-state', () => ({ dev: 2 })), '/tmp');
    assert.throws(() => core.selectTempBase('/explicit', '/fake-state', devices), /\/explicit/);
});
test('B-4 foreign cleanup attention belongs to foreign owner, preserving live watch marker', () => {
    assert.equal(core.attentionOwner('watch', 101, { owner: 202 }, 303), 202);
    assert.equal(core.attentionOwner('watch', 101, {}, 303), 101);
    assert.equal(core.attentionOwner('run', undefined, { owner: 202 }, 303), 202);
});
test('group cleanup waits for descendants, settling delay, and a second absence check', async () => {
    const job = { child: 123 }; const calls = [];
    let present = false;
    const io = { alive: () => { calls.push('check'); return present; }, sleep: async ms => { calls.push(ms); present = true; } };
    assert.equal(await core.groupSettled(job, io), false);
    assert.deepEqual(calls, ['check', 100, 'check']);
    calls.length = 0; present = false;
    io.sleep = async ms => calls.push(ms);
    assert.equal(await core.groupSettled(job, io), true);
    assert.deepEqual(calls, ['check', 100, 'check']);
    calls.length = 0;
    assert.equal(await core.groupSettled({}, io), true);
    assert.deepEqual(calls, []);
    present = true;
    assert.equal(await core.groupSettled(job, io), false);
    assert.deepEqual(calls, ['check']);
});

test('B-1 CLI admits default temp base on split filesystem and rejects explicit mismatch', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const { spawnSync } = await import('node:child_process');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-default-'));
    try {
        const state = path.join(base, 'state');
        const preload = path.join(base, 'split.cjs');
        fs.writeFileSync(preload, `const fs = require('node:fs'); const original = fs.statSync; fs.statSync = function(p, ...args) { const value = original.call(this, p, ...args); if (p === '/tmp') return Object.assign(Object.create(Object.getPrototypeOf(value)), value, { dev: -999 }); return value; }; require('node:module').syncBuiltinESMExports();`);
        const env = { ...process.env, NODE_OPTIONS: `--require=${preload}` };
        delete env.WORKER_RUNNER_TEMP_BASE;
        const args = [process.env.RUNNER_MERGE_TEST_CLI || 'scripts/worker-runner/cli.mjs', 'run', '--state-dir', state, '--work-dir', base, '--floor', '1K', '--budget', '1M', '--poll-ms', '20'];
        const result = spawnSync(process.execPath, [...args, '--id', 'default', '--', process.execPath, '-e', "require('node:fs').writeFileSync('payload-root',process.env.WORKER_RUNNER_TMP_ROOT)"], { env, encoding: 'utf8', timeout: 15000 });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(fs.readFileSync(path.join(base, 'payload-root'), 'utf8'), path.join(state, 'runs/default'));
        const denied = spawnSync(process.execPath, [...args, '--id', 'explicit', '--temp-base', '/tmp', '--', '/bin/true'], { env, encoding: 'utf8', timeout: 5000 });
        assert.notEqual(denied.status, 0);
        assert.match(denied.stderr, /Temporary base \/tmp/);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('B-4 actual foreign watch alert leaves its live owner attention available after state loss', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const { spawnSync } = await import('node:child_process');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-attention-'));
    try {
        const state = path.join(base, 'state'); fs.mkdirSync(state);
        const outside = path.join(base, 'outside'); fs.mkdirSync(outside);
        const root = path.join(base, 'unsafe'); fs.symlinkSync(outside, root);
        const foreign = 2147483647;
        const file = path.join(state, 'state.json');
        fs.writeFileSync(file, JSON.stringify({ version: 2, sequence: 1, jobs: [{ id: 'foreign-dead', owner: foreign, status: 'failed', cleanupRoot: root, tempRoot: root, tempToken: 'owned' }] }));
        const args = [process.env.RUNNER_MERGE_TEST_CLI || 'scripts/worker-runner/cli.mjs', 'watch', '--state-dir', state, '--owner', String(process.pid), '--id', 'live'];
        const first = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 5000 });
        assert.equal(first.status, 0, first.stderr);
        assert.equal(fs.existsSync(path.join(state, `.attention-${foreign}`)), true);
        assert.equal(fs.existsSync(path.join(state, `.attention-${process.pid}`)), false);
        // The live watch then loses its state, which must still produce its own alert.
        fs.unlinkSync(file);
        const lost = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 5000 });
        assert.equal(lost.status, 1, lost.stderr);
        const events = fs.readFileSync(path.join(state, 'supervisor.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
        assert.equal(events.filter(e => e.trace === 'live' && e.event === 'human-attention').length, 1);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
