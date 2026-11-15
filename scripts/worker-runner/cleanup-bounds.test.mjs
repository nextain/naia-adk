import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { schedule, finish, cleanupFailure } from './core.mjs';
const cli = new URL('./cli.mjs', import.meta.url).pathname;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 6000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (fn()) return; await pause(25); }
    throw Error('fixture condition timed out');
}
const queued = (id, extra = {}) => ({ id, status: 'queued', budget: 4, remaining: 0, priority: 0, order: 1, ...extra });
test('stale stopping reservation remains charged while fitting queued work starts', () => {
    const stuck = queued('stuck', { status: 'stopping', remaining: 6, stopAt: 1, recoveryBlocked: true });
    const state = { jobs: [stuck, queued('fits', { budget: 2 })] };
    assert.deepEqual(schedule(state, 14, 5, 12000), [{ type: 'start', id: 'fits' }]);
    assert.equal(stuck.remaining, 6);
});
test('blocked recovery reservation does not make a large queue head starve smaller work', () => {
    const state = { jobs: [queued('blocked', { status: 'running', remaining: 6, recoveryBlocked: true }), queued('large', { budget: 5 }), queued('small', { budget: 2, order: 2 })] };
    assert.deepEqual(schedule(state, 14, 5, 12000), [{ type: 'start', id: 'small' }]);
});
test('preemption retains original work usage baseline across cleanup and resume', () => {
    const state = { jobs: [queued('resume', { status: 'running', root: '/owned/attempt', remaining: 4, initialUsage: 12345 })] };
    finish(state, 'resume', () => {}, 'preempted');
    assert.equal(state.jobs[0].initialUsage, 12345);
    assert.deepEqual(schedule(state, 20, 5, 20), [{ type: 'start', id: 'resume' }]);
    assert.equal(state.jobs[0].initialUsage, 12345);
});
test('actual queued CLI round obeys timeout without launching payload', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'queued-timeout-'));
    const state = path.join(base, 'state'), payload = path.join(base, 'payload');
    const child = spawn(process.execPath, [cli, 'run', '--state-dir', state, '--temp-base', base, '--id', 'queue-timeout', '--work-dir', base, '--budget', '1M', '--floor', '1T', '--timeout', '0.2', '--poll-ms', '30', '--', '/bin/sh', '-c', `touch '${payload}'`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
    try {
        await until(() => child.exitCode !== null, 4000);
        assert.equal(child.exitCode, 124, output);
        assert.equal(fs.existsSync(payload), false);
        const job = JSON.parse(fs.readFileSync(path.join(state, 'state.json'), 'utf8')).jobs[0];
        assert.equal(job.status, 'timeout');
    } finally {
        if (child.exitCode === null) { child.kill('SIGTERM'); await pause(200); }
        fs.rmSync(base, { recursive: true, force: true });
    }
});
test('legacy 7134268 rejects abandoned conventional root: replacement requires drained supervisors', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-cleanup-incompat-'));
    const legacy = path.join(base, 'legacy'), state = path.join(base, 'state'), owned = path.join(base, 'new-temp-root');
    try {
        fs.mkdirSync(legacy); fs.mkdirSync(state); fs.mkdirSync(owned);
        for (const file of ['cli.mjs', 'core.mjs', 'launch.mjs']) {
            const result = spawnSync('git', ['show', `7134268:scripts/worker-runner/${file}`], { encoding: 'utf8' });
            assert.equal(result.status, 0, result.stderr); fs.writeFileSync(path.join(legacy, file), result.stdout);
        }
        fs.writeFileSync(path.join(state, 'state.json'), JSON.stringify({ version: 2, sequence: 1, jobs: [{ id: 'new-abandoned', status: 'running', owner: 99999999, ownerToken: 'dead', root: owned, tempRoot: owned, tempBase: base, tempToken: 'new-token', remaining: 4096, budget: 4096 }] }));
        const result = spawnSync(process.execPath, [path.join(legacy, 'cli.mjs'), 'status', '--state-dir', state], { encoding: 'utf8', timeout: 3000 });
        assert.notEqual(result.status, 0); assert.match(result.stderr, /Unowned cleanup root/);
        assert.equal(fs.existsSync(owned), true);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('cleanup retry policy caps attempts, backoff, and attention while ending a preempted round', () => {
    const job = { status: 'queued', cleanupError: 'EACCES', cleanupCode: 'EACCES', remaining: 0 };
    for (let attempt = 1; attempt <= 5; attempt++) {
        assert.equal(cleanupFailure(job, 100), attempt === 5);
        assert.equal(job.cleanupAttempts, attempt);
        assert.equal(job.cleanupNextAt - 100, Math.min(30000, 1000 * 2 ** (attempt - 1)));
    }
    assert.equal(job.status, 'failed'); assert.equal(job.cleanupExhausted, true);
    assert.equal(job.cleanupAlerted, true); assert.equal(cleanupFailure(job, 100), false);
    for (let n = 0; n < 10; n++) cleanupFailure(job, 100);
    assert.equal(job.cleanupAttempts, 5); assert.equal(job.cleanupNextAt - 100, 16000);
});
test('permanent cleanup failures request human attention only once and fail queued round immediately', () => {
    for (const error of [{ cleanupCode: 'EPERM' }, { cleanupError: 'Unowned cleanup root' }, { cleanupError: 'Cleanup symlink rejected' }]) {
        const job = { status: 'queued', ...error };
        assert.equal(cleanupFailure(job, 100), true); assert.equal(job.status, 'failed');
        assert.equal(job.cleanupExhausted, true); assert.equal(cleanupFailure(job, 100), false);
    }
});
test('live legacy supervisor exits and kills its payload when a new conventional root is abandoned', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-supervisor-incompat-'));
    const legacy = path.join(base, 'legacy'), state = path.join(base, 'state'), stateFile = path.join(state, 'state.json');
    let child, payloadPid;
    try {
        fs.mkdirSync(legacy);
        for (const file of ['cli.mjs', 'core.mjs', 'launch.mjs']) {
            const result = spawnSync('git', ['show', `7134268:scripts/worker-runner/${file}`], { encoding: 'utf8' });
            assert.equal(result.status, 0, result.stderr); fs.writeFileSync(path.join(legacy, file), result.stdout);
        }
        child = spawn(process.execPath, [path.join(legacy, 'cli.mjs'), 'run', '--state-dir', state, '--id', 'legacy-live', '--work-dir', base, '--budget', '1M', '--floor', '1K', '--poll-ms', '50', '--', '/bin/sleep', '30'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
        await until(() => { try { payloadPid = JSON.parse(fs.readFileSync(stateFile)).jobs.find(j => j.id === 'legacy-live')?.child; return !!payloadPid; } catch { return false; } });
        const owned = path.join(base, 'abandoned-new'); fs.mkdirSync(owned);
        const patch = `const fs=require('node:fs');const file=${JSON.stringify(stateFile)};const s=JSON.parse(fs.readFileSync(file));s.jobs.push(${JSON.stringify({ id: 'new-dead', status: 'running', owner: 99999999, root: owned, tempRoot: owned, budget: 4096, remaining: 4096 })});fs.writeFileSync(file,JSON.stringify(s));`;
        const edit = spawnSync('flock', ['--exclusive', path.join(state, 'state.lock'), process.execPath, '-e', patch], { encoding: 'utf8', timeout: 3000 }); assert.equal(edit.status, 0, edit.stderr);
        await until(() => child.exitCode !== null, 4000);
        assert.notEqual(child.exitCode, 0); assert.match(output, /Unowned cleanup root/);
        await until(() => { try { return fs.readFileSync(`/proc/${payloadPid}/stat`, 'utf8').split(') ')[1].startsWith('Z'); } catch { return true; } });
    } finally {
        if (child && child.exitCode === null) child.kill('SIGTERM');
        if (payloadPid) { try { process.kill(-payloadPid, 'SIGKILL'); } catch {} }
        await pause(100); fs.rmSync(base, { recursive: true, force: true });
    }
});

test('status exposes pending cleanup, obeys retry deadline, caps deletion attempts and alerts once', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-status-bounds-'));
    const stateDir = path.join(base, 'state'), root = path.join(stateDir, 'runs', 'attempt-denied');
    const stateFile = path.join(stateDir, 'state.json'), calls = path.join(base, 'remove-calls'), probe = path.join(base, 'status-probe.mjs');
    try {
        fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, 'data'), 'retain');
        const job = { id: 'cleanup-queued', owner: process.pid, status: 'queued', cleanupRoot: root, cleanupError: 'EACCES', cleanupCode: 'EACCES', cleanupAttempts: 4, cleanupNextAt: Date.now() + 60000, remaining: 0, budget: 4096 };
        fs.writeFileSync(stateFile, JSON.stringify({ version: 2, sequence: 1, jobs: [job] }));
        fs.writeFileSync(probe, `import fs from 'node:fs';
const remove = fs.rmSync;
fs.rmSync = function(target, ...args) { if (target === ${JSON.stringify(root)}) { fs.appendFileSync(${JSON.stringify(calls)}, 'remove\\n'); throw Object.assign(Error('forced EACCES'), {code:'EACCES'}); } return remove.call(this,target,...args); };
process.argv = [process.execPath, ${JSON.stringify(cli)}, 'status', '--state-dir', ${JSON.stringify(stateDir)}];
await import(${JSON.stringify(pathToFileURL(cli).href)});
`);
        const status = () => {
            const result = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 4000 });
            assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
        };
        const pending = status().cleanupPending;
        assert.equal(pending.length, 1); assert.equal(pending[0].cleanupRoot, root); assert.equal(pending[0].cleanupAttempts, 4);
        assert.equal(fs.existsSync(calls), false, 'future retry deadline must suppress rm');
        const ready = JSON.parse(fs.readFileSync(stateFile)); ready.jobs[0].cleanupNextAt = 0;
        fs.writeFileSync(stateFile, JSON.stringify(ready));
        const exhausted = status().cleanupPending[0]; assert.equal(exhausted.cleanupAttempts, 5); assert.equal(exhausted.cleanupExhausted, true);
        const final = JSON.parse(fs.readFileSync(stateFile)).jobs[0]; assert.equal(final.status, 'failed'); assert.equal(final.cleanupAlerted, true);
        const count = fs.readFileSync(calls, 'utf8'); assert.equal(count, 'remove\n');
        status(); status(); assert.equal(fs.readFileSync(calls, 'utf8'), count, 'exhausted cleanup must never retry');
        assert.equal((fs.readFileSync(path.join(stateDir, 'supervisor.jsonl'), 'utf8').match(/"event":"human-attention"/g) || []).length, 1);
        assert.equal(fs.readFileSync(path.join(root, 'data'), 'utf8'), 'retain');
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
