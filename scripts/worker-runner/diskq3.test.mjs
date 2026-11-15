import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const source = process.env.DISKQ3_RUNNER_SOURCE || path.dirname(new URL(import.meta.url).pathname);
const cli = path.join(source, 'cli.mjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, ms = 7000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await delay(25); } throw Error('fixture condition timed out'); }
async function fixture(fn) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diskq3-test-')), children = [];
    const env = { ...process.env, TMPDIR: root, TMP: root, TEMP: root };
    const launch = (file, args) => { const child = spawn(process.execPath, [file, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] }); child.output = ''; child.stdout.on('data', x => child.output += x); child.stderr.on('data', x => child.output += x); children.push(child); return child; };
    const stateDir = path.join(root, 'state'), stateFile = path.join(stateDir, 'state.json');
    const read = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { jobs: [] }; } };
    const run = (id, command = 'sleep 0.3', extra = [], file = cli) => launch(file, ['run', '--state-dir', stateDir, '--id', id, '--work-dir', root, '--budget', '1M', '--floor', '1K', '--poll-ms', '50', ...(file === cli ? ['--temp-base', root] : []), ...extra, '--', '/bin/sh', '-c', command]);
    try { await fn({ root, env, stateDir, stateFile, read, launch, run }); }
    finally { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await delay(900); for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await delay(150); fs.rmSync(root, { recursive: true, force: true }); }
}
test('repro A: conventional root contains isolated TMPDIR and is removed', () => fixture(async ({ root, run }) => {
    const child = run('conventional', 'printf "%s\\n%s\\n%s\\n" "$TMPDIR" "$TMP" "$TEMP"; printf payload > "$TMPDIR/data"');
    await until(() => child.exitCode !== null);
    assert.equal(child.exitCode, 0, child.output);
    const values = child.output.split('\n').filter(x => x.startsWith(root));
    assert.deepEqual(values, Array(3).fill(path.join(root, 'conventional', 'tmp')));
    assert.equal(fs.existsSync(path.join(root, 'conventional')), false);
}));
test('repro A: over-budget writer fails once instead of resuming forever', () => fixture(async ({ run, read }) => {
    const child = run('writer', 'dd if=/dev/zero of="$TMPDIR/data" bs=1048576 count=4 2>/dev/null; sleep 10');
    await until(() => child.exitCode !== null, 6000);
    assert.notEqual(child.exitCode, 0);
    assert.equal(read().jobs[0].status, 'budget-killed');
    assert.equal((child.output.match(/"event":"start"/g) || []).length, 1);
}));
test('repro B: actual legacy CLI survives new run and watch with reservation intact', () => fixture(async ({ root, stateDir, run, launch, read }) => {
    const legacy = path.join(root, 'legacy'); fs.mkdirSync(legacy);
    for (const file of ['cli.mjs', 'core.mjs', 'launch.mjs']) {
        fs.copyFileSync(path.join(source, 'fixtures/legacy-7134268', file), path.join(legacy, file));
    }
    const old = run('legacy-round', 'sleep 6', [], path.join(legacy, 'cli.mjs'));
    await until(() => read().jobs.some(j => j.id === 'legacy-round' && j.child));
    await delay(1150); // Let the historical supervisor record its first usage sample.
    const before = read().jobs.find(j => j.id === 'legacy-round'); assert.equal(before.childToken, undefined);
    const newer = run('new-round', 'sleep 2');
    const watcher = launch(cli, ['watch', '--state-dir', stateDir, '--owner', String(old.pid)]);
    await delay(1400);
    const legacyJob = read().jobs.find(j => j.id === 'legacy-round');
    console.log('mixed-version', JSON.stringify({ legacyStatus: legacyJob.status, remaining: legacyJob.remaining, oldAlive: old.exitCode === null, newAlive: newer.exitCode === null }));
    assert.equal(legacyJob.status, 'running'); assert.equal(legacyJob.remaining, before.remaining); assert.ok(legacyJob.ownerBootId); assert.ok(legacyJob.ownerNamespace); assert.equal(fs.existsSync(legacyJob.root), true);
    assert.equal(old.exitCode, null); assert.equal(newer.exitCode, null);
    await until(() => newer.exitCode !== null); assert.equal(newer.exitCode, 0, newer.output);
    watcher.kill('SIGTERM');
}));
test('repro C: corrupt-state watch exits when owner is dead and groups errors', () => fixture(async ({ stateDir, stateFile, launch }) => {
    fs.mkdirSync(stateDir); fs.writeFileSync(stateFile, '{invalid');
    const child = launch(cli, ['watch', '--state-dir', stateDir, '--owner', '99999999']);
    await until(() => child.exitCode !== null, 2500);
    const log = fs.readFileSync(path.join(stateDir, 'supervisor.jsonl'), 'utf8');
    assert.equal((log.match(/supervisor-error/g) || []).length, 1, log);
    assert.equal((log.match(/human-attention/g) || []).length, 1, log);
}));
test('repro C: state loss stops supervisor and emits one human notification', () => fixture(async ({ run, stateFile, stateDir, read }) => {
    const child = run('lost-state', 'sleep 0.4'); await until(() => read().jobs.some(j => j.child));
    fs.writeFileSync(stateFile, JSON.stringify({ version: 2, jobs: [], sequence: 0 }));
    await until(() => child.exitCode !== null, 3500);
    assert.notEqual(child.exitCode, 0);
    await delay(650);
    const logPath = path.join(stateDir, 'supervisor.jsonl');
    const combined = child.output + (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '');
    assert.equal((combined.match(/human-attention/g) || []).length, 1, combined);
}));
test('future schema is read only: run and watch reject, status preserves exact bytes', () => fixture(async ({ stateDir, stateFile, launch, run }) => {
    fs.mkdirSync(stateDir); const original = '{ "version": 999, "sequence": 0, "jobs": [] }\n'; fs.writeFileSync(stateFile, original);
    for (const [child, readOnly] of [[run('future'), false], [launch(cli, ['watch', '--state-dir', stateDir, '--owner', '99999999']), false], [launch(cli, ['status', '--state-dir', stateDir]), true]]) {
        await until(() => child.exitCode !== null, 3000); assert.equal(fs.readFileSync(stateFile, 'utf8'), original);
        if (!readOnly) assert.notEqual(child.exitCode, 0); else assert.equal(child.exitCode, 0);
    }
}));
test('foreign recovery is recorded in supervisor log, never caller stderr', () => fixture(async ({ stateDir, stateFile, launch }) => {
    fs.mkdirSync(stateDir); fs.writeFileSync(stateFile, JSON.stringify({ version: 1, sequence: 1, jobs: [{ id: 'foreign', status: 'running', owner: 99999999, ownerToken: 'dead', budget: 100, remaining: 100 }] }));
    const child = launch(cli, ['status', '--state-dir', stateDir]); await until(() => child.exitCode !== null);
    assert.doesNotMatch(child.output, /"event":"recovered"/);
    const logs = fs.readdirSync(stateDir).filter(x => x.endsWith('.jsonl')).map(x => fs.readFileSync(path.join(stateDir, x), 'utf8')).join('');
    assert.match(logs, /"trace":"foreign".*"event":"recovered"/);
}));
const { schedule } = await import(pathToFileURL(path.join(source, 'core.mjs')));
const queued = (id, extra = {}) => ({ id, status: 'queued', budget: 4, remaining: 0, priority: 0, order: 1, ...extra });
test('same priority resumed front precedes earlier queued round', () => {
    const state = { jobs: [queued('earlier'), queued('resume', { order: 2, front: true })] };
    assert.deepEqual(schedule(state, 9, 5, 1), [{ type: 'start', id: 'resume' }]);
});
test('impossible large head does not starve fitting rounds while another is active', () => {
    const state = { jobs: [queued('active', { status: 'running', budget: 1, remaining: 1 }), queued('large', { budget: 20 }), queued('small', { budget: 1, order: 2 })] };
    assert.deepEqual(schedule(state, 10, 5, 2), [{ type: 'start', id: 'small' }]);
});
test('stale stopping round does not prevent a second floor victim', () => {
    const state = { jobs: [queued('stuck', { status: 'stopping', stopAt: 1 }), queued('running', { status: 'running', started: 2 })] };
    assert.deepEqual(schedule(state, 1, 5, 12000), [{ type: 'stop', id: 'running' }]);
});
test('Muse extraction preserves nonzero exit, result marker, and done marker', () => fixture(async ({ root }) => {
    const log = path.join(root, 'worker.log'), result = path.join(root, 'result.md'), done = path.join(root, 'round.done');
    fs.writeFileSync(log, 'noise\n# Result\ncompleted\n');
    const child = spawnSync('/bin/sh', [path.join(source, 'muse-result.sh'), log, result, done, '7'], { encoding: 'utf8' });
    assert.equal(child.status, 7); assert.equal(fs.existsSync(done), true);
    assert.equal(fs.readFileSync(result, 'utf8'), '# Result\ncompleted\n'); assert.match(fs.readFileSync(log, 'utf8'), /result-from-log/);
    fs.rmSync(result); fs.writeFileSync(log, 'noise\n');
    const empty = spawnSync('/bin/sh', [path.join(source, 'muse-result.sh'), log, result, done, '0']);
    assert.equal(empty.status, 1); assert.match(fs.readFileSync(log, 'utf8'), /no-result rc=0/);
}));
test('foreign PID namespace is never considered an owned process group', async () => {
    const { ownedGroupAlive, pidNamespace, ownerIdentity } = await import(pathToFileURL(path.join(source, 'process.mjs')));
    assert.ok(pidNamespace); assert.match(ownerIdentity(process.pid).ownerToken, /^\d+$/);
    assert.equal(ownedGroupAlive({ child: process.pid, ownerNamespace: 'pid:[foreign-fixture]' }), false);
});
test('signal exit from payload retains conventional shell exit code', () => fixture(async ({ run }) => {
    const child = run('signal-result', 'kill -TERM $$'); await until(() => child.exitCode !== null);
    assert.equal(child.exitCode, 143, child.output);
}));
test('preexisting conventional temporary directory is never adopted or removed', () => fixture(async ({ root, run }) => {
    const existing = path.join(root, 'collision'); fs.mkdirSync(existing); fs.writeFileSync(path.join(existing, 'sentinel'), 'owned elsewhere');
    const child = run('collision'); await until(() => child.exitCode !== null, 3500);
    assert.notEqual(child.exitCode, 0); assert.equal(fs.readFileSync(path.join(existing, 'sentinel'), 'utf8'), 'owned elsewhere');
}));
test('repro C: externally terminated queued round exits without rewriting idle state', () => fixture(async ({ run, read, stateFile }) => {
    const child = run('queued-terminal', 'sleep 1', ['--floor', '1T']);
    await until(() => read().jobs.some(j => j.status === 'queued'));
    const state = read(); state.jobs[0].status = 'abandoned'; fs.writeFileSync(stateFile, JSON.stringify(state));
    await until(() => child.exitCode !== null, 3000);
    const stamp = fs.statSync(stateFile).mtimeMs; await delay(650); assert.equal(fs.statSync(stateFile).mtimeMs, stamp);
}));
test('supervisor transient error retry is exponential and duplicate suppressed', () => fixture(async ({ root, env, run, read }) => {
    const bin = path.join(root, 'bin'); fs.mkdirSync(bin); const calls = path.join(root, 'calls');
    fs.writeFileSync(path.join(bin, 'df'), `#!/bin/sh\nif [ -f '${root}/fail-df' ]; then read -r uptime rest < /proc/uptime; printf '%s\\n' "$uptime" >> '${calls}'; exit 1; fi\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted\\nfake 99999999 0 99999999 0%% /\\n'\n`, { mode: 0o755 });
    env.PATH = `${bin}:${process.env.PATH}`;
    const child = run('retry', 'sleep 30');
    await until(() => read().jobs.some(j => j.child)); fs.writeFileSync(path.join(root, 'fail-df'), '');
    await until(() => fs.existsSync(calls) && fs.readFileSync(calls, 'utf8').trim().split('\n').length >= 3, 12000);
    const ticks = fs.readFileSync(calls, 'utf8').trim().split('\n').map(n => Number(n) * 1000), gaps = ticks.slice(1).map((n, i) => n - ticks[i]);
    assert.ok(gaps[0] >= 900, JSON.stringify(gaps)); assert.ok(gaps[1] >= 1900, JSON.stringify(gaps));
    assert.equal((child.output.match(/supervisor-error/g) || []).length, 1, child.output);
    fs.rmSync(path.join(root, 'fail-df')); child.kill('SIGTERM');
    await until(() => child.exitCode !== null, 7000);
}));
test('masked kernel boot identifier does not crash process module import', () => fixture(async ({ root }) => {
    const moduleURL = pathToFileURL(path.join(source, 'process.mjs')).href;
    const probe = path.join(root, 'masked-proc.mjs');
    fs.writeFileSync(probe, `import fs from 'node:fs';\nconst original = fs.readFileSync;\nfs.readFileSync = function(file, ...args) { if (file === '/proc/sys/kernel/random/boot_id') throw Object.assign(Error('masked'), { code: 'EACCES' }); return original.call(this, file, ...args); };\nconst processModule = await import(${JSON.stringify(moduleURL)});\nif (processModule.bootId !== null) process.exitCode = 2;\n`);
    const result = spawnSync(process.execPath, [probe], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
}));
test('temporary naming rejects traversal and symlink collision without touching target', () => fixture(async ({ root, run }) => {
    const target = path.join(root, 'target'); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'sentinel'), 'keep');
    fs.symlinkSync(target, path.join(root, 'linked'));
    for (const name of ['../target', 'linked']) {
        const child = run('safe-round', 'true', ['--temp-name', name]); await until(() => child.exitCode !== null, 3500); assert.notEqual(child.exitCode, 0, child.output);
    }
    assert.equal(fs.readFileSync(path.join(target, 'sentinel'), 'utf8'), 'keep'); assert.equal(fs.lstatSync(path.join(root, 'linked')).isSymbolicLink(), true);
}));
test('independent df pressure refreshes other workers before selecting an innocent victim', () => fixture(async ({ root, env, run, read }) => {
    const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'df'), `#!/bin/sh\nif [ -f '${root}/pressure' ]; then available=512; else available=99999999; fi\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted\\nfake 99999999 0 %s 0%% /\\n' "$available"\n`, { mode: 0o755 });
    env.PATH = `${bin}:${process.env.PATH}`;
    const lowWork = path.join(root, 'low-work'), highWork = path.join(root, 'high-work'); fs.mkdirSync(lowWork); fs.mkdirSync(highWork);
    const low = run('innocent', 'sleep 10', ['--work-dir', lowWork, '--floor', '1M', '--priority', 'low']);
    await until(() => read().jobs.some(j => j.id === 'innocent' && j.child));
    const high = run('violator', `sleep 0.25; dd if=/dev/zero of="$TMPDIR/data" bs=1024 count=1536 2>/dev/null; touch '${root}/pressure'; sleep 10`, ['--work-dir', highWork, '--floor', '1M', '--priority', 'high', '--poll-ms', '1000']);
    await until(() => read().jobs.some(j => j.id === 'violator' && ['stopping', 'budget-killed'].includes(j.status)), 5000);
    const jobs = read().jobs; assert.equal(jobs.find(j => j.id === 'innocent').status, 'running');
    assert.ok(jobs.find(j => j.id === 'violator').used > 1024 * 1024);
    assert.doesNotMatch(low.output, /"event":"stop"/); assert.notEqual(high.exitCode, 0);
}));
test('missing boot metadata refuses admission before executing payload', () => fixture(async ({ root, stateDir }) => {
    const probe = path.join(root, 'masked-admission.mjs'), payload = path.join(root, 'payload-ran');
    fs.writeFileSync(probe, `import fs from 'node:fs';\nconst original = fs.readFileSync;\nfs.readFileSync = function(file, ...args) { if (file === '/proc/sys/kernel/random/boot_id') throw Object.assign(Error('masked'), { code: 'EACCES' }); return original.call(this, file, ...args); };\nprocess.argv = [process.execPath, ${JSON.stringify(cli)}, 'run', '--state-dir', ${JSON.stringify(stateDir)}, '--temp-base', ${JSON.stringify(root)}, '--id', 'missing-metadata', '--work-dir', ${JSON.stringify(root)}, '--budget', '1M', '--floor', '1K', '--', '/bin/sh', '-c', ${JSON.stringify(`touch '${payload}'`)}];\nawait import(${JSON.stringify(pathToFileURL(cli).href)});\n`);
    const result = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 3000 }); assert.notEqual(result.status, 0, result.stderr); assert.equal(result.error, undefined); assert.equal(fs.existsSync(payload), false);
}));
test('unknown outside writer fallback selects newest start then largest reservation', () => {
    const state = { jobs: [queued('older-large', { status: 'running', started: 1, budget: 100, remaining: 100 }), queued('new-small', { status: 'running', started: 2, budget: 10, remaining: 10 }), queued('new-large', { status: 'running', started: 2, budget: 20, remaining: 20 })] };
    assert.deepEqual(schedule(state, 1, 5, 10), [{ type: 'stop', id: 'new-large' }]);
});
test('corrupt state produces one human notification across actual supervisor and detached watch', () => fixture(async ({ run, read, stateDir, stateFile }) => {
    const child = run('shared-alert', 'sleep 10'); await until(() => read().jobs.some(j => j.child));
    await delay(650); // The detached watch has entered its own polling loop.
    fs.writeFileSync(stateFile, '{corrupt'); await until(() => child.exitCode !== null, 8000); await delay(1100);
    const logPath = path.join(stateDir, 'supervisor.jsonl');
    const combined = child.output + (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '');
    assert.notEqual(child.exitCode, 0); assert.equal((combined.match(/human-attention/g) || []).length, 1, combined);
}));
test('registration rejects lexical traversal even when normalized target stays inside owned root', () => fixture(async ({ run, read, stateDir, launch }) => {
    run('registration', 'sleep 10'); await until(() => read().jobs.some(j => j.child));
    const root = read().jobs.find(j => j.id === 'registration').root;
    const child = launch(cli, ['register', '--state-dir', stateDir, '--id', 'registration', '--path', `${root}/unused/../fresh`]);
    await until(() => child.exitCode !== null); assert.notEqual(child.exitCode, 0, child.output); assert.equal(fs.existsSync(path.join(root, 'fresh')), false);
}));
test('same-ID admission rejects duplicate after durably restoring a live legacy abandoned round', () => fixture(async ({ root, stateDir, stateFile, read, run, launch }) => {
    const { processInfo } = await import(pathToFileURL(path.join(source, 'process.mjs')));
    const ownerScript = path.join(root, 'idle-owner.mjs'), childFile = path.join(root, 'child-pid');
    fs.writeFileSync(ownerScript, `import fs from 'node:fs';\nimport { spawn } from 'node:child_process';\nconst child = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });\nfs.writeFileSync(${JSON.stringify(childFile)}, String(child.pid));\nconst timer = setInterval(() => {}, 1000);\nprocess.on('SIGTERM', () => { child.kill('SIGTERM'); clearInterval(timer); });\n`);
    const owner = launch(ownerScript, []); await until(() => fs.existsSync(childFile));
    const child = Number(fs.readFileSync(childFile, 'utf8'));
    await until(() => processInfo(child)?.group === child);
    const ownedRoot = path.join(stateDir, 'runs', 'attempt-fixture'); fs.mkdirSync(ownedRoot, { recursive: true });
    const budget = 1024 * 1024, used = 8192;
    fs.writeFileSync(stateFile, JSON.stringify({ version: 1, sequence: 1, jobs: [{ id: 'restore-round', owner: owner.pid, ownerToken: processInfo(owner.pid).startTime, child, root: ownedRoot, status: 'abandoned', budget, used, remaining: 0, floor: 1024, priority: 0, order: 1, workDir: root }] }));
    const duplicate = run('restore-round', 'true'); await until(() => duplicate.exitCode !== null);
    assert.notEqual(duplicate.exitCode, 0); assert.match(duplicate.output, /Active id already exists/);
    const restored = read().jobs.find(j => j.id === 'restore-round');
    assert.equal(restored.status, 'running'); assert.equal(restored.remaining, budget - used); assert.equal(fs.existsSync(restored.root), true); assert.equal(owner.exitCode, null);
}));
test('legacy group adoption rejects a detached child belonging to another live owner', async () => {
    const { ownedGroupAlive, processInfo } = await import(pathToFileURL(path.join(source, 'process.mjs')));
    const child = spawn('/bin/sleep', ['10'], { detached: true, stdio: 'ignore' });
    try {
        await until(() => processInfo(child.pid)?.group === child.pid);
        const job = { owner: process.ppid, ownerToken: processInfo(process.ppid).startTime, child: child.pid };
        assert.equal(ownedGroupAlive(job), false); assert.equal(job.childToken, undefined);
    } finally { child.kill('SIGTERM'); await new Promise(resolve => child.once('close', resolve)); }
});
