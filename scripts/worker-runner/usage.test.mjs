import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
const cli = new URL('./cli.mjs', import.meta.url).pathname;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const value = fn(); if (value) return value; await delay(30); }
    throw Error('usage fixture timed out');
}
async function fixture(fn) {
    const root = fs.mkdtempSync(path.join(tmpdir(), 'runner-usage-'));
    const state = path.join(root, 'state'), bin = path.join(root, 'bin'), free = path.join(root, 'free');
    fs.mkdirSync(state); fs.mkdirSync(bin); fs.writeFileSync(free, '1048576');
    fs.writeFileSync(path.join(bin, 'df'), '#!/bin/sh\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted on\\nfixture 2097152 0 "\ncat "$USAGE_FIXTURE_FREE"\nprintf " 0%% /\\n"\n', { mode: 0o755 });
    let child;
    const read = () => { try { return JSON.parse(fs.readFileSync(path.join(state, 'state.json'))).jobs; } catch { return []; } };
    const run = (command, tempBase = root, budget = '1M') => {
        child = spawn(process.execPath, [cli, 'run', '--id', 'me', '--state-dir', state, '--work-dir', root, '--temp-base', tempBase,
            '--budget', budget, '--floor', '1K', '--poll-ms', '50', '--timeout', '45', '--', '/bin/sh', '-c', command],
            { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, USAGE_FIXTURE_FREE: free }, stdio: ['ignore', 'pipe', 'pipe'] });
        child.output = ''; child.stdout.on('data', x => child.output += x); child.stderr.on('data', x => child.output += x);
        return child;
    };
    try { await fn({ root, state, free, read, run }); }
    finally {
        if (child && child.exitCode === null) { child.kill('SIGTERM'); await until(() => child.exitCode !== null || child.signalCode !== null).catch(() => child.kill('SIGKILL')); }
        await delay(250); fs.rmSync(root, { recursive: true, force: true });
    }
}
test('work usage excludes other workers roots and runner state growth', () => fixture(async ({ root, state, read, run }) => {
    const other = path.join(root, 'other'); fs.mkdirSync(other);
    fs.writeFileSync(path.join(state, 'state.json'), JSON.stringify({ version: 2, sequence: 1, jobs: [{ id: 'other', status: 'finished', root: other, ended: Date.now() }] }));
    const child = run('sleep 3');
    await until(() => read().find(j => j.id === 'me' && j.child && j.initialUsage != null));
    fs.writeFileSync(path.join(other, 'foreign-data'), Buffer.alloc(2 * 1024 * 1024));
    fs.writeFileSync(path.join(state, 'audit-data'), Buffer.alloc(2 * 1024 * 1024));
    await until(() => read().find(j => j.id === 'me' && j.used != null));
    await until(() => child.exitCode !== null);
    assert.equal(child.exitCode, 0, child.output);
    const mine = read().find(j => j.id === 'me');
    assert.equal(mine.status, 'finished'); assert.ok(mine.used < 1024 * 1024, JSON.stringify(mine));
}));
test('preemption resume preserves initial work baseline and charges persistent writes', () => fixture(async ({ root, free, read, run }) => {
    const child = run('if [ "$WORKER_RUNNER_RESUME" = 1 ]; then sleep 2; else dd if=/dev/zero of=persistent bs=131072 count=1 2>/dev/null; sleep 12; fi');
    const first = await until(() => read().find(j => j.id === 'me' && j.child && fs.existsSync(path.join(root, 'persistent'))));
    const baseline = first.initialUsage, firstChild = first.child;
    fs.writeFileSync(free, '0');
    await until(() => read().find(j => j.id === 'me' && j.status === 'queued' && j.resume));
    fs.writeFileSync(free, '1048576');
    const resumed = await until(() => read().find(j => j.id === 'me' && j.child && j.child !== firstChild && j.status === 'running'));
    assert.equal(resumed.initialUsage, baseline);
    await until(() => child.exitCode !== null);
    assert.equal(child.exitCode, 0, child.output);
    const mine = read().find(j => j.id === 'me');
    assert.equal(mine.initialUsage, baseline); assert.ok(mine.used >= 131072, JSON.stringify(mine));
}));

test('nested state and owned temporary root charge one MiB once and retain three MiB reservation', () => fixture(async ({ state, read, run }) => {
    fs.mkdirSync(path.join(state, 'runs'));
    const child = run('dd if=/dev/zero of="$TMPDIR/one-mib" bs=1048576 count=1 2>/dev/null; sleep 3', path.join(state, 'runs'), '4M');
    const active = await until(() => read().find(j => j.id === 'me' && j.status === 'running' && j.used >= 1048576));
    assert.ok(active.used < 1.25 * 1048576, JSON.stringify(active));
    assert.ok(active.remaining > 2.75 * 1048576 && active.remaining <= 3 * 1048576, JSON.stringify(active));
    await until(() => child.exitCode !== null);
    assert.equal(child.exitCode, 0, child.output);
}));
