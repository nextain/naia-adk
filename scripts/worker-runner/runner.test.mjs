import test from 'node:test';
import assert from 'node:assert/strict';
import { schedule, finish, cleanupPaths, parseBytes, terminalOutcome, launchAuthorized } from './core.mjs';
const job = (id, extra = {}) => ({ id, status: 'queued', budget: 4, remaining: 4, priority: 0, order: 1, ...extra });
test('insufficient budget queues; completion releases reservation and starts next', () => {
    const s = { jobs: [job('a'), job('b', { order: 2 })] };
    assert.deepEqual(schedule(s, 10, 5, 1), [{ type: 'start', id: 'a' }]);
    assert.equal(s.jobs[1].status, 'queued');
    const removed = [];
    finish(s, 'a', p => removed.push(p));
    assert.deepEqual(schedule(s, 10, 5, 2), [{ type: 'start', id: 'b' }]);
});
test('forced exit cleans owned temporary paths and releases reservation', () => {
    const s = { jobs: [job('a', { status: 'running', root: '/owned/a', cleanup: ['/owned/a/tmp'] })] };
    const removed = [];
    finish(s, 'a', p => removed.push(p), 'killed');
    assert.deepEqual(removed, ['/owned/a']);
    assert.equal(s.jobs[0].remaining, 0);
});
test('cleanup refuses outside paths and symlink ancestors without deleting', () => {
    const removed = [];
    const adapter = { isSymlink: p => p === '/owned/a/link', remove: p => removed.push(p) };
    assert.throws(() => cleanupPaths('/owned/a', ['/outside'], adapter), /outside/);
    assert.throws(() => cleanupPaths('/owned/a', ['/owned/a/link/child'], adapter), /symlink/);
    assert.deepEqual(removed, []);
});
test('below floor stops only newest lowest priority, waits for exit, resumes at front', () => {
    const s = { jobs: [job('a', { status: 'running', started: 1 }), job('b', { status: 'running', started: 2 }), job('c', { priority: 10 })] };
    assert.deepEqual(schedule(s, 4, 5, 3), [{ type: 'stop', id: 'b' }]);
    assert.deepEqual(schedule(s, 4, 5, 4), []);
    finish(s, 'b', () => { }, 'preempted');
    assert.equal(s.jobs[1].resume, true);
    assert.equal(s.jobs[1].status, 'queued');
    assert.deepEqual(schedule(s, 20, 5, 5)[0], { type: 'start', id: 'c' });
});
test('priority then FIFO; remaining reservation used; byte parser validates', () => {
    const s = { jobs: [job('r', { status: 'running', remaining: 1 }), job('a'), job('b', { priority: 2 })] };
    assert.deepEqual(schedule(s, 10, 5, 1), [{ type: 'start', id: 'b' }]);
    assert.equal(parseBytes('4G'), 4 * 1024 ** 3);
    assert.throws(() => parseBytes('-1G'));
});
test('FIFO within priority and floor equality admit exactly one', () => {
    const s = { jobs: [job('later', { order: 2 }), job('first', { order: 1 })] };
    assert.deepEqual(schedule(s, 9, 5, 10), [{ type: 'start', id: 'first' }]);
});
test('unknown disk writer chooses most recent reservation when selecting one victim', () => {
    const s = { jobs: [job('high', { priority: 100, status: 'running', started: 3 }), job('low', { priority: -100, status: 'running', started: 1 })] };
    assert.deepEqual(schedule(s, 1, 5, 4), [{ type: 'stop', id: 'high' }]);
});
test('fake workers finish failure and timeout; fake df permits the waiting next worker', () => {
    let free = 9;
    const running = new Set(), removed = [], s = { jobs: [job('a', { root: '/owned/a' }), job('b', { order: 2, root: '/owned/b' })] };
    const tick = () => schedule(s, free, 5, 1).forEach(e => {
        if (e.type === 'start')
            running.add(e.id);
        else
            running.delete(e.id);
    });
    tick();
    assert.deepEqual([...running], ['a']);
    for (const reason of ['failed', 'timeout']) {
        const id = [...running][0];
        finish(s, id, p => removed.push(p), reason);
        running.delete(id);
        free = 10;
        tick();
    }
    assert.deepEqual(removed, ['/owned/a', '/owned/b']);
    assert.equal(running.size, 0);
    assert.ok(s.jobs.every(j => j.remaining === 0));
});
test('cleanup rejects root symlink and lexical traversal before remove', () => {
    const removed = [], io = { isSymlink: p => p === '/owned/a', remove: p => removed.push(p) };
    assert.throws(() => cleanupPaths('/owned/a', [], io), /symlink/);
    assert.throws(() => cleanupPaths('/owned/a', ['/owned/a/../../other'], { ...io, isSymlink: () => false }), /outside/);
    assert.deepEqual(removed, []);
});
test('timeout fails even if worker exits zero; done grace finishes successfully', () => {
    assert.deepEqual(terminalOutcome({ timedOut: true }, { code: 0 }), { status: 'timeout', code: 124 });
    assert.deepEqual(terminalOutcome({ doneAt: 1, doneStopped: true }, { code: null, signal: 'SIGTERM' }), { status: 'finished', code: 0 });
    assert.equal(terminalOutcome({}, { code: 1 }).status, 'failed');
    assert.equal(terminalOutcome({}, { code: 0 }, 'SIGTERM').status, 'cancelled');
});
test('payload launch waits for durable owned root and matching committed process ID', () => {
    const state = { jobs: [job('a', { root: '/owned/a', status: 'running' })] };
    assert.equal(launchAuthorized(state, 123, 'a', '/owned/a'), false);
    state.jobs[0].child = 123;
    assert.equal(launchAuthorized(state, 123, 'a', '/owned/a'), true);
    assert.equal(launchAuthorized(state, 124, 'a', '/owned/a'), false);
    assert.equal(launchAuthorized(state, 123, 'a', '/outside'), false);
    state.jobs[0].status = 'abandoned';
    assert.equal(launchAuthorized(state, 123, 'a', '/owned/a'), false);
});
test('preemption between admission and payload launch releases reserved slot and requeues', () => {
    const s = { jobs: [job('a')] };
    assert.deepEqual(schedule(s, 9, 5, 1), [{ type: 'start', id: 'a' }]);
    assert.deepEqual(schedule(s, 4, 5, 2), [{ type: 'stop', id: 'a' }]);
    assert.equal(s.jobs[0].child, undefined);
    finish(s, 'a', () => assert.fail('no directory was created'), 'preempted');
    assert.equal(s.jobs[0].remaining, 0);
    assert.deepEqual(schedule(s, 9, 5, 3), [{ type: 'start', id: 'a' }]);
});
test('cli run survives a failing du and still finishes the worker', async () => {
    const { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { spawnSync } = await import('node:child_process');
    const base = mkdtempSync(join(tmpdir(), 'wr-du-'));
    try {
        const bin = join(base, 'bin');
        await import('node:fs').then(fs => fs.mkdirSync(bin));
        writeFileSync(join(bin, 'du'), '#!/bin/sh\necho "du: cannot access: No such file or directory" >&2\nexit 1\n');
        chmodSync(join(bin, 'du'), 0o755);
        const cli = new URL('./cli.mjs', import.meta.url).pathname;
        const r = spawnSync(process.execPath, [cli, 'run', '--state-dir', join(base, 'state'), '--id', 'du-fail', '--work-dir', base,
            '--budget', '1K', '--floor', '1K', '--timeout', '60', '--', '/bin/sh', '-c', 'echo ran > "$0"', join(base, 'out')],
            { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8', timeout: 60000 });
        assert.equal(r.status, 0, r.stderr);
        assert.equal(readFileSync(join(base, 'out'), 'utf8').trim(), 'ran');
        assert.match(r.stderr, /measure-error/);
    }
    finally {
        rmSync(base, { recursive: true, force: true });
    }
});

import fs from 'node:fs';
import path from 'node:path';
import { tmpdir as systemTmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { identity, processInfo, signalOwnedGroup } from './process.mjs';
process.env.WORKER_RUNNER_TEMP_BASE = systemTmpdir();
const cli = new URL('./cli.mjs', import.meta.url).pathname;
function fixture(fn) {
    const root = fs.mkdtempSync(path.join(systemTmpdir(), 'diskq2-'));
    try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function seed(root, jobs) {
    fs.mkdirSync(path.join(root, 'state'), { recursive: true });
    fs.writeFileSync(path.join(root, 'state/state.json'), JSON.stringify({ version: 1, sequence: jobs.length, jobs }));
}
function run(root, extra = [], env = {}) {
    return spawnSync(process.execPath, [cli, 'run', '--state-dir', path.join(root, 'state'), '--id', 'same-id', '--work-dir', root,
        '--budget', '1M', '--floor', '1K', '--poll-ms', '40', ...extra, '--', '/bin/sh', '-c', 'sleep 0.3; echo survived > out'],
        { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 15000 });
}
test('cli run survives a failing df during active worker poll and keeps the worker running', () => fixture(root => {
    fs.mkdirSync(path.join(root, 'bin'));
    fs.writeFileSync(path.join(root, 'bin/df'), `#!/bin/sh\nif [ -f '${root}/df-once' ]; then exit 1; fi\ntouch '${root}/df-once'\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted\\nfake 99999999 0 99999999 0%% /\\n'\n`, { mode: 0o755 });
    const r = run(root, [], { PATH: `${root}/bin:${process.env.PATH}` });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(root, 'out'), 'utf8').trim(), 'survived');
    assert.match(r.stderr, /supervisor-error/);
}));
test('reconcile cleanup error on an abandoned job does not abort or kill other running workers', () => {
    const state = { jobs: [job('dead', { status: 'running', root: '/owned/dead' }), job('healthy', { status: 'running' })] };
    finish(state, 'dead', () => { throw Error('EACCES'); }, 'abandoned');
    assert.equal(state.jobs[0].status, 'abandoned');
    assert.equal(state.jobs[0].remaining, 0);
    assert.match(state.jobs[0].cleanupError, /EACCES/);
    assert.equal(state.jobs[1].status, 'running');
});
test('reconcile ignores recycled child PGID after reboot and does not throw EPERM or signal unrelated groups', async () => {
    const { signalOwnedGroup } = await import('./process.mjs');
    const sent = [];
    const io = { identity: () => 'new', kill: (...args) => sent.push(args) };
    for (const child of [1, 0, -3, 123]) signalOwnedGroup({ child, childToken: 'old' }, 'SIGKILL', io);
    assert.deepEqual(sent, []);
    assert.doesNotThrow(() => signalOwnedGroup({ child: 123, childToken: 'new' }, 'SIGTERM', { ...io, kill: () => { throw Object.assign(Error('denied'), { code: 'EPERM' }); } }));
});
test('cli run reconciles dead owner with the same job id before checking active id collision', () => fixture(root => {
    seed(root, [job('same-id', { owner: 99999999, ownerToken: 'dead', status: 'running' })]);
    const r = run(root);
    assert.equal(r.status, 0, r.stderr);
}));
test('preempted low-priority job with front flag does not block higher-priority queued jobs', () => {
    const s = { jobs: [job('low', { priority: -100, front: true }), job('high', { priority: 100, budget: 1 })] };
    assert.deepEqual(schedule(s, 8, 5, 1), [{ type: 'start', id: 'high' }]);
});
test('unstartable oversized queue head with zero active workers does not deadlock smaller runnable jobs', () => {
    const s = { jobs: [job('large'), job('small', { budget: 1, order: 2 })] };
    assert.deepEqual(schedule(s, 8, 5, 1), [{ type: 'start', id: 'small' }]);
});
test('below floor tie-breaker stops higher-order job when priority and started timestamp match', () => {
    const s = { jobs: [job('first', { status: 'running', started: 1 }), job('later', { status: 'running', started: 1, order: 2 })] };
    assert.deepEqual(schedule(s, 4, 5, 2), [{ type: 'stop', id: 'later' }]);
});
test('parseBytes accepts non-dyadic decimal budgets like 1.3G and 0.3G', () => {
    assert.equal(parseBytes('1.3G'), Math.ceil(1.3 * 1024 ** 3));
    assert.equal(parseBytes('0.3G'), Math.ceil(0.3 * 1024 ** 3));
});
test('register rejects dangling symlinks via lstatSync', () => fixture(root => {
    const owned = path.join(root, 'state/runs/attempt-fake');
    fs.mkdirSync(owned, { recursive: true });
    fs.symlinkSync('/nonexistent-fake-target', path.join(owned, 'dangling'));
    seed(root, [job('same-id', { root: owned, status: 'running' })]);
    const r = spawnSync(process.execPath, [cli, 'register', '--state-dir', path.join(root, 'state'), '--id', 'same-id', '--path', path.join(owned, 'dangling')], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /symlink/i);
}));
test('adapter muse result-from-log excludes supervisor stderr JSON events and exits non-zero when result is empty', () => fixture(root => {
    const helper = new URL('./muse-result.sh', import.meta.url).pathname;
    const log = path.join(root, 'log'), result = path.join(root, 'result'), done = path.join(root, 'done');
    fs.writeFileSync(log, '# Result\nbody\n{"time":"now","trace":"other","event":"end"}\nmuse-ended 0\n');
    let r = spawnSync('bash', [helper, log, result, done, '0'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(result, 'utf8'), '# Result\nbody\n');
    fs.unlinkSync(result); fs.unlinkSync(done); fs.writeFileSync(log, 'no result\n');
    r = spawnSync('bash', [helper, log, result, done, '0'], { encoding: 'utf8' });
    assert.notEqual(r.status, 0); assert.equal(fs.existsSync(done), false);
}));

test('reconcile rejected cleanup root is isolated from a healthy CLI worker', () => fixture(root => {
    const unowned = path.join(root, 'unowned'); fs.mkdirSync(unowned);
    seed(root, [job('dead', { owner: 99999999, ownerToken: 'dead', status: 'running', root: unowned })]);
    const r = run(root);
    assert.equal(r.status, 0, r.stderr);
    const abandoned = JSON.parse(fs.readFileSync(path.join(root, 'state/state.json'))).jobs.find(j => j.id === 'dead');
    assert.equal(abandoned.status, 'abandoned');
    assert.equal(abandoned.remaining, 0);
    assert.match(abandoned.cleanupError, /Unowned/);
    assert.equal(fs.readFileSync(path.join(root, 'out'), 'utf8').trim(), 'survived');
}));
test('stale done marker never converts a failing worker to success', () => fixture(root => {
    const done = path.join(root, 'done'); fs.writeFileSync(done, '');
    fs.utimesSync(done, new Date(1000), new Date(1000));
    const r = spawnSync(process.execPath, [cli, 'run', '--state-dir', path.join(root, 'state'), '--id', 'done', '--work-dir', root,
        '--budget', '1K', '--floor', '1K', '--poll-ms', '30', '--done-file', done, '--', '/bin/sh', '-c', 'sleep 0.2; exit 7'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 7, r.stderr);
    assert.deepEqual(terminalOutcome({ doneAt: 1 }, { code: 7 }), { status: 'failed', code: 7 });
}));
test('fake df and du count conventional temp and budget kill without automatic restart', () => fixture(root => {
    const bin = path.join(root, 'bin'), work = path.join(root, 'work'), state = path.join(root, 'state');
    fs.mkdirSync(bin); fs.mkdirSync(work);
    fs.writeFileSync(path.join(bin, 'df'), `#!/bin/sh\nfree=99999999\nfor p in '${process.env.WORKER_RUNNER_TEMP_BASE}/pressure/tmp/pressure'; do if [ -f "$p" ]; then free=0; fi; done\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted\\nfake 99999999 0 %s 0%% /\\n' "$free"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'du'), `#!/bin/sh\nlast=''\nfor arg do last=$arg; done\nn=0\nif [ -f "$last/tmp/pressure" ]; then n=10240; fi\nprintf '%s\\t%s\\n' "$n" "$last"\n`, { mode: 0o755 });
    const r = spawnSync(process.execPath, [cli, 'run', '--state-dir', state, '--id', 'pressure', '--work-dir', work,
        '--budget', '1K', '--floor', '1K', '--poll-ms', '40', '--timeout', '10', '--', '/bin/sh', '-c',
        'test "$TMPDIR" = "$TMP" && test "$TMPDIR" = "$TEMP" || exit 9; if [ "$WORKER_RUNNER_RESUME" = 0 ]; then touch "$TMPDIR/pressure"; sleep 8; else echo resumed > out; fi'],
        { encoding: 'utf8', timeout: 15000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(r.status, 125, r.stderr);
    const events = r.stderr.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(events.some(e => e.event === 'budget-exceeded' && e.used === 10240 * 1024));
    assert.ok(events.some(e => e.event === 'stop'));
    assert.ok(!events.some(e => e.event === 'resume-queued'));
    assert.equal(events.filter(e => e.event === 'start').length, 1);
    assert.equal(fs.existsSync(path.join(work, 'out')), false);
    assert.equal(fs.existsSync(path.join(process.env.WORKER_RUNNER_TEMP_BASE, 'pressure')), false);
    const s = { jobs: [job('normal-low', { status: 'running', priority: -100, used: 4 }), job('excess-high', { status: 'running', priority: 100, used: 20 }), job('less-excess', { status: 'running', used: 12 })] };
    assert.deepEqual(schedule(s, 0, 5, 1), [{ type: 'stop', id: 'excess-high' }]);
}));
test('terminal state retention is bounded and active jobs are retained', () => fixture(root => {
    seed(root, Array.from({ length: 130 }, (_, n) => job(`old-${n}`, { status: 'finished', ended: n })));
    const r = run(root); assert.equal(r.status, 0, r.stderr);
    const s = JSON.parse(fs.readFileSync(path.join(root, 'state/state.json')));
    assert.equal(s.jobs.length, 100);
    assert.ok(s.jobs.some(j => j.id === 'same-id' && j.status === 'finished'));
    assert.ok(!s.jobs.some(j => j.id === 'old-0'));
}));
test('launcher drains background writers before owned root cleanup', () => fixture(root => {
    const r = spawnSync(process.execPath, [cli, 'run', '--state-dir', path.join(root, 'state'), '--id', 'background', '--work-dir', root,
        '--budget', '1M', '--floor', '1K', '--poll-ms', '30', '--timeout', '5', '--', '/bin/sh', '-c',
        'while :; do echo x >> "$TMPDIR/writer"; sleep 0.05; done & exit 0'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(path.join(process.env.WORKER_RUNNER_TEMP_BASE, 'background')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'state/state.json'))).jobs[0].status, 'finished');
}));
test('successful measurements recover baseline after initial du failure', () => fixture(root => {
    fs.mkdirSync(path.join(root, 'bin')); fs.mkdirSync(path.join(root, 'work'));
    fs.writeFileSync(path.join(root, 'bin/du'), `#!/bin/sh\nlast=''\nfor arg do last=$arg; done\nif [ "$last" = '${root}/work' ]; then\n n=0; [ ! -f '${root}/count' ] || n=$(cat '${root}/count'); n=$((n+1)); echo "$n" > '${root}/count'; [ "$n" -ne 1 ] || exit 1; echo "$((n*100)) $last"\nelse echo "0 $last"; fi\n`, { mode: 0o755 });
    const r = spawnSync(process.execPath, [cli, 'run', '--state-dir', path.join(root, 'state'), '--id', 'baseline', '--work-dir', path.join(root, 'work'),
        '--budget', '1M', '--floor', '1K', '--poll-ms', '40', '--', '/bin/sh', '-c', `while [ ! -f '${root}/count' ] || [ "$(cat '${root}/count')" -lt 3 ]; do sleep 0.05; done; while ! node -e 'const fs=require("node:fs"); const s=JSON.parse(fs.readFileSync(process.argv[1])); process.exit(s.jobs.some(j=>j.id==="baseline" && j.used>=102400)?0:1)' '${root}/state/state.json'; do sleep 0.05; done`], { encoding: 'utf8', timeout: 10000, env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` } });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(fs.readFileSync(path.join(root, 'state/state.json'))).jobs[0];
    assert.equal(j.initialUsage, 200 * 1024);
    assert.ok(j.used >= 100 * 1024);
}));
test('event log separates supervisor JSON while worker stderr stays in worker output', () => fixture(root => {
    const events = path.join(root, 'supervisor.jsonl');
    const r = spawnSync(process.execPath, [cli, 'run', '--state-dir', path.join(root, 'state'), '--id', 'events', '--work-dir', root,
        '--budget', '1M', '--floor', '1K', '--poll-ms', '30', '--event-log', events, '--', '/bin/sh', '-c', 'echo worker-out; echo worker-error >&2'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /worker-out/); assert.equal(r.stderr.trim(), 'worker-error');
    const rows = fs.readFileSync(events, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(rows.some(e => e.event === 'end'));
    assert.ok(rows.every(e => e.trace === 'events'));
}));

test('same-id restart waits for its dead-owner live child group to exit before admission', () => fixture(root => {
    const orphan = spawn('/bin/sleep', ['20'], { detached: true, stdio: 'ignore' });
    const childToken = identity(orphan.pid);
    const owned = path.join(root, 'state/runs/attempt-orphan');
    fs.mkdirSync(owned, { recursive: true });
    const stale = job('same-id', { owner: 99999999, ownerToken: 'dead', child: orphan.pid, childToken, root: owned, status: 'running' });
    try {
        assert.ok(childToken);
        seed(root, [stale]);
        const r = run(root);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(fs.readFileSync(path.join(root, 'out'), 'utf8').trim(), 'survived');
        const info = processInfo(orphan.pid);
        assert.ok(!info || info.state === 'Z');
        assert.equal(fs.existsSync(owned), false);
    } finally { signalOwnedGroup(stale, 'SIGKILL'); }
}));

test('process identity includes the kernel boot id so uptime ticks cannot collide after reboot', () => {
    const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const token = identity(process.pid);
    assert.ok(token.startsWith(`${boot}:`));
    const sent = [];
    signalOwnedGroup({ child: process.pid, childToken: `previous-boot:${token.split(':').at(-1)}` }, 'SIGKILL', { identity, kill: (...args) => sent.push(args) });
    assert.deepEqual(sent, []);
});

test('detached concurrent writer cleanup preserves exit 23 and permits immediate same-id rerun', () => fixture(root => {
    const payload = path.join(root, 'payload.cjs'), writer = path.join(root, 'writer.cjs');
    const ready = path.join(root, 'writer-ready'), done = path.join(root, 'writer-done'), result = path.join(root, 'result');
    fs.writeFileSync(writer, `const fs = require('node:fs');
        const [dir, ready, done] = process.argv.slice(2);
        fs.writeFileSync(ready, 'ready');
        const deadline = Date.now() + 10000;
        while (fs.existsSync(dir + '/0') && Date.now() < deadline)
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
        const end = Date.now() + 350;
        let n = 20000;
        while (Date.now() < end) {
            try { fs.writeFileSync(dir + '/' + n++, 'late'); }
            catch (e) { if (e.code === 'ENOENT') break; throw e; }
        }
        fs.writeFileSync(done, 'done');`);
    fs.writeFileSync(payload, `const fs = require('node:fs');
        const path = require('node:path');
        const { spawn } = require('node:child_process');
        const [writer, ready, done, result] = process.argv.slice(2);
        const dir = path.join(process.env.TMPDIR, 'concurrent');
        fs.mkdirSync(dir);
        for (let n = 0; n < 20000; n++) fs.writeFileSync(path.join(dir, String(n)), 'seed');
        spawn(process.execPath, [writer, dir, ready, done], { detached: true, stdio: 'ignore' }).unref();
        const deadline = Date.now() + 5000;
        while (!fs.existsSync(ready)) {
            if (Date.now() > deadline) throw Error('writer failed to start');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
        fs.writeFileSync(result, 'durable result');
        process.exit(23);`);
    const args = [cli, 'run', '--state-dir', path.join(root, 'state'), '--id', 'concurrent', '--work-dir', root,
        '--temp-base', root, '--budget', '256M', '--floor', '1K', '--poll-ms', '30', '--timeout', '15', '--'];
    const first = spawnSync(process.execPath, [...args, process.execPath, payload, writer, ready, done, result], { encoding: 'utf8', timeout: 20000 });
    assert.equal(first.status, 23, first.stderr);
    assert.equal(fs.readFileSync(result, 'utf8'), 'durable result');
    const previous = JSON.parse(fs.readFileSync(path.join(root, 'state/state.json'))).jobs.find(j => j.id === 'concurrent');
    assert.equal(previous.status, 'failed');
    assert.equal(previous.exitCode, 23);
    assert.equal(previous.cleanupRoot, undefined, first.stderr);
    assert.equal(fs.existsSync(path.join(root, 'concurrent')), false);
    const second = spawnSync(process.execPath, [...args, '/bin/true'], { encoding: 'utf8', timeout: 15000 });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(fs.readFileSync(result, 'utf8'), 'durable result');
}));

import {
    parseReviewHeaders,
    classifyRound,
    evaluateReviewCap,
    checkReviewCap,
    afterReviewCap,
} from './review-cap.mjs';

function writeTimed(file, content, sec) {
    fs.writeFileSync(file, content, 'utf8');
    const stamp = new Date(sec * 1000);
    fs.utimesSync(file, stamp, stamp);
}

test('review-cap blocks fix/rev rounds without review-lane and allows word-internal rev like reviewcap1', () => {
    for (const loopRound of ['fix7j', 'r20rev5', 'fix1', 'rev2', 'fix7frev1']) {
        assert.equal(classifyRound(loopRound).isLoop, true, loopRound);
        const res = evaluateReviewCap({ mode: 'check', round: loopRound, lane: '' });
        assert.equal(res.blocked, true, loopRound);
        assert.equal(res.exitCode, 3, loopRound);
        assert.match(res.reason, /review-lane:/);
    }
    for (const normalRound of ['reviewcap1', 'review5', 'prefix', 'r20', 'plan1']) {
        assert.equal(classifyRound(normalRound).isLoop, false, normalRound);
        const res = evaluateReviewCap({ mode: 'check', round: normalRound, lane: '' });
        assert.equal(res.blocked, false, normalRound);
        assert.equal(res.exitCode, 0, normalRound);
    }
});

test('review-cap allows 1 FAIL, blocks on 2nd FAIL, and ignores rounds without result files or with PASS', () => fixture(root => {
    writeTimed(path.join(root, 'brief-rev1.md'), 'review-lane: lane-a\n', 10);
    writeTimed(path.join(root, 'result-rev1.md'), '판정: FAIL\nfirst failure\n', 11);
    writeTimed(path.join(root, 'brief-rev0.md'), 'review-lane: lane-a\n', 12);
    writeTimed(path.join(root, 'result-rev0.md'), '판정: PASS\n판정: FAIL in body ignored\n', 13);
    writeTimed(path.join(root, 'brief-rev9.md'), 'review-lane: lane-a\n', 14);
    // result-rev9.md is absent and must be ignored.
    writeTimed(path.join(root, 'brief-fix1.md'), 'review-lane: lane-a\n', 15);
    const passOne = checkReviewCap({ instruction: path.join(root, 'brief-fix1.md') });
    assert.equal(passOne.blocked, false);
    assert.deepEqual(passOne.fails, ['rev1']);

    writeTimed(path.join(root, 'brief-rev2.md'), 'review-lane: lane-a\n', 20);
    writeTimed(path.join(root, 'result-rev2.md'), '판정: FAIL\nsecond failure\n', 21);
    writeTimed(path.join(root, 'brief-fix2.md'), 'review-lane: lane-a\n', 22);
    const blockedTwo = checkReviewCap({ instruction: path.join(root, 'brief-fix2.md') });
    assert.equal(blockedTwo.blocked, true);
    assert.equal(blockedTwo.exitCode, 3);
    assert.deepEqual(blockedTwo.fails, ['rev1', 'rev2']);
    assert.match(blockedTwo.reason, /갈래 lane-a 코드 검수 FAIL 2번\(rev1 rev2\) — fix2 를 막음/);
}));

test('review-cap-reset allows the reset fix round and recounts FAILs only after that brief timestamp', () => fixture(root => {
    writeTimed(path.join(root, 'brief-rev1.md'), 'review-lane: lane-a\n', 10);
    writeTimed(path.join(root, 'result-rev1.md'), '판정: FAIL\n', 11);
    writeTimed(path.join(root, 'brief-rev2.md'), 'review-lane: lane-a\n', 20);
    writeTimed(path.join(root, 'result-rev2.md'), '판정: FAIL\n', 21);

    writeTimed(path.join(root, 'brief-fix2.md'), 'review-lane: lane-a\nreview-cap-reset: lock counterexample in unit test and switch algorithm\n', 30);
    const resetRun = checkReviewCap({ instruction: path.join(root, 'brief-fix2.md') });
    assert.equal(resetRun.blocked, false);
    assert.equal(resetRun.resetUsed, true);
    assert.equal(resetRun.count, 2);

    writeTimed(path.join(root, 'brief-rev3.md'), 'review-lane: lane-a\n', 40);
    writeTimed(path.join(root, 'result-rev3.md'), '판정: FAIL\n', 41);
    writeTimed(path.join(root, 'brief-fix3.md'), 'review-lane: lane-a\n', 50);
    const afterOneNewFail = checkReviewCap({ instruction: path.join(root, 'brief-fix3.md') });
    assert.equal(afterOneNewFail.blocked, false);
    assert.deepEqual(afterOneNewFail.fails, ['rev3']);

    writeTimed(path.join(root, 'brief-rev4.md'), 'review-lane: lane-a\n', 60);
    writeTimed(path.join(root, 'result-rev4.md'), '판정: FAIL\n', 61);
    writeTimed(path.join(root, 'brief-fix4.md'), 'review-lane: lane-a\n', 70);
    const afterTwoNewFails = checkReviewCap({ instruction: path.join(root, 'brief-fix4.md') });
    assert.equal(afterTwoNewFails.blocked, true);
    assert.deepEqual(afterTwoNewFails.fails, ['rev3', 'rev4']);
}));

test('review-cap isolates mixed lanes and never blocks review rounds even at or above cap', () => fixture(root => {
    writeTimed(path.join(root, 'brief-rev1.md'), 'review-lane: lane-other\n', 10);
    writeTimed(path.join(root, 'result-rev1.md'), '판정: FAIL\n', 11);
    writeTimed(path.join(root, 'brief-rev2.md'), 'review-lane: lane-other\n', 12);
    writeTimed(path.join(root, 'result-rev2.md'), '판정: FAIL\n', 13);

    writeTimed(path.join(root, 'brief-rev3.md'), 'review-lane: lane-target\n', 20);
    writeTimed(path.join(root, 'result-rev3.md'), '판정: FAIL\n', 21);
    writeTimed(path.join(root, 'brief-fix1.md'), 'review-lane: lane-target\n', 22);
    const targetFix = checkReviewCap({ instruction: path.join(root, 'brief-fix1.md') });
    assert.equal(targetFix.blocked, false);
    assert.deepEqual(targetFix.fails, ['rev3']);

    // A reset in lane-other after lane-target's 2nd FAIL must not clear lane-target.
    writeTimed(path.join(root, 'brief-rev4.md'), 'review-lane: lane-target\n', 30);
    writeTimed(path.join(root, 'result-rev4.md'), '판정: FAIL\n', 31);
    writeTimed(path.join(root, 'brief-otherfix.md'), 'review-lane: lane-other\nreview-cap-reset: other lane reset\n', 40);

    // Review round in lane-target is still allowed despite 2 FAILs.
    writeTimed(path.join(root, 'brief-r20rev5.md'), 'review-lane: lane-target\n', 50);
    const revAllowed = checkReviewCap({ instruction: path.join(root, 'brief-r20rev5.md') });
    assert.equal(revAllowed.blocked, false);
    assert.equal(revAllowed.isRev, true);

    // Fix round in lane-target remains blocked.
    writeTimed(path.join(root, 'brief-fix2.md'), 'review-lane: lane-target\n', 51);
    const fixBlocked = checkReviewCap({ instruction: path.join(root, 'brief-fix2.md') });
    assert.equal(fixBlocked.blocked, true);
    assert.deepEqual(fixBlocked.fails, ['rev3', 'rev4']);
}));

test('review-cap writes wake markdown on blocked fix and capped review finish only when wakeDir is set, and supports custom patterns', () => fixture(root => {
    const wakeDir = path.join(root, 'wake');
    writeTimed(path.join(root, 'brief-rev1.md'), 'review-lane: lane-wake\n', 10);
    writeTimed(path.join(root, 'result-rev1.md'), '판정: FAIL\n', 11);
    writeTimed(path.join(root, 'brief-rev2.md'), 'review-lane: lane-wake\n', 20);
    writeTimed(path.join(root, 'result-rev2.md'), '판정: FAIL\n', 21);

    // Default (wakeDir omitted and env unset): no wake directory created.
    const noWake = afterReviewCap({ instruction: path.join(root, 'brief-rev2.md'), wakeDir: '' });
    assert.equal(noWake.wakeFile, null);
    assert.equal(fs.existsSync(wakeDir), false);

    // With wakeDir on after (review round): writes markdown note.
    const afterWake = afterReviewCap({ instruction: path.join(root, 'brief-rev2.md'), wakeDir, now: '2026-11-08T23:00:00Z' });
    assert.ok(afterWake.wakeFile);
    const afterContent = fs.readFileSync(afterWake.wakeFile, 'utf8');
    assert.match(afterContent, /\[검수 상한\] 갈래 lane-wake: 코드 검수 FAIL 2번\(rev1 rev2\)\. 검수 rev2 가 FAIL 로 끝남, 다음 고침은 막힘\./);
    assert.match(afterContent, /하네스북 10\.15·10\.16:.*review-cap-reset:/);

    // With wakeDir on check (blocked fix round): writes markdown note.
    writeTimed(path.join(root, 'brief-fix2.md'), 'review-lane: lane-wake\n', 30);
    const checkWake = checkReviewCap({ instruction: path.join(root, 'brief-fix2.md'), wakeDir, now: '2026-11-08T23:01:00Z' });
    assert.equal(checkWake.blocked, true);
    assert.ok(checkWake.wakeFile);
    assert.match(fs.readFileSync(checkWake.wakeFile, 'utf8'), /고침 fix2 띄우기를 막음\./);

    // Custom round classification, result filename, and fail verdict pattern.
    const customConfig = {
        fixPattern: /^patch-\d+$/,
        revPattern: /^audit-\d+$/,
        briefPattern: /^task-(.+)\.txt$/,
        resultFile: 'out-{round}.txt',
        failPattern: /^VERDICT:\s*REJECT/,
    };
    writeTimed(path.join(root, 'task-audit-1.txt'), 'review-lane: custom\n', 10);
    writeTimed(path.join(root, 'out-audit-1.txt'), 'VERDICT: REJECT\n', 11);
    writeTimed(path.join(root, 'task-patch-1.txt'), 'review-lane: custom\n', 20);
    const customCheck = checkReviewCap({ instruction: path.join(root, 'task-patch-1.txt'), cap: 1, config: customConfig });
    assert.equal(customCheck.blocked, true);
    assert.deepEqual(customCheck.fails, ['audit-1']);
    assert.deepEqual(parseReviewHeaders('review-lane: a\nreview-cap-reset: b\n'), { lane: 'a', reset: 'b' });
}));

test('cli run enforces review-cap before execution, emits wake note after review round, and supports --review-cap and --no-review-cap', () => fixture(root => {
    const state = path.join(root, 'state'), wake = path.join(root, 'wake');
    writeTimed(path.join(root, 'brief-rev1.md'), 'review-lane: cli-lane\n', 10);
    writeTimed(path.join(root, 'result-rev1.md'), '판정: FAIL\n', 11);
    writeTimed(path.join(root, 'brief-rev2.md'), 'review-lane: cli-lane\n', 20);

    // Running rev2 writes result-rev2.md with FAIL; after-hook writes wake note.
    const revRun = spawnSync(process.execPath, [cli, 'run', '--state-dir', state, '--id', 'cli-rev2', '--work-dir', root,
        '--budget', '64K', '--floor', '1K', '--poll-ms', '30', '--instruction', path.join(root, 'brief-rev2.md'),
        '--review-cap-wake-dir', wake, '--', '/bin/sh', '-c', `printf '판정: FAIL\\n' > '${path.join(root, 'result-rev2.md')}'`],
        { encoding: 'utf8', timeout: 10000 });
    assert.equal(revRun.status, 0, revRun.stderr);
    const wakeFilesAfterRev = fs.readdirSync(wake);
    assert.equal(wakeFilesAfterRev.length, 1);
    assert.match(fs.readFileSync(path.join(wake, wakeFilesAfterRev[0]), 'utf8'), /검수 rev2 가 FAIL 로 끝남/);

    // Next fix round without reset is blocked with exit code 3 and one-line stderr before running command.
    const marker = path.join(root, 'should-not-exist');
    writeTimed(path.join(root, 'brief-fix2.md'), 'review-lane: cli-lane\n', 30);
    const blockedFix = spawnSync(process.execPath, [cli, 'run', '--state-dir', state, '--id', 'cli-fix2', '--work-dir', root,
        '--budget', '64K', '--floor', '1K', '--poll-ms', '30', '--instruction', path.join(root, 'brief-fix2.md'),
        '--', '/bin/sh', '-c', `touch '${marker}'`],
        { encoding: 'utf8', timeout: 10000 });
    assert.equal(blockedFix.status, 3);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(blockedFix.stderr.trim().split('\n').length, 1);
    assert.match(blockedFix.stderr, /review-cap: 갈래 cli-lane 코드 검수 FAIL 2번\(rev1 rev2\) — fix2 를 막음/);

    // Raising cap via --review-cap 3 allows fix2 to run.
    const capThree = spawnSync(process.execPath, [cli, 'run', '--state-dir', state, '--id', 'cli-fix2-cap3', '--work-dir', root,
        '--budget', '64K', '--floor', '1K', '--poll-ms', '30', '--instruction', path.join(root, 'brief-fix2.md'),
        '--review-cap', '3', '--', '/bin/sh', '-c', `echo cap3 > '${marker}'`],
        { encoding: 'utf8', timeout: 10000 });
    assert.equal(capThree.status, 0, capThree.stderr);
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'cap3');

    // Disabling via --no-review-cap allows execution and records review-cap-disabled in events and state.
    const noCap = spawnSync(process.execPath, [cli, 'run', '--state-dir', state, '--id', 'cli-fix2-nocap', '--work-dir', root,
        '--budget', '64K', '--floor', '1K', '--poll-ms', '30', '--instruction', path.join(root, 'brief-fix2.md'),
        '--no-review-cap', '--', '/bin/sh', '-c', `echo nocap > '${marker}'`],
        { encoding: 'utf8', timeout: 10000 });
    assert.equal(noCap.status, 0, noCap.stderr);
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'nocap');
    const events = noCap.stderr.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(events.some(e => e.event === 'review-cap-disabled' && e.trace === 'cli-fix2-nocap'));
    const savedJob = JSON.parse(fs.readFileSync(path.join(state, 'state.json'), 'utf8')).jobs.find(j => j.id === 'cli-fix2-nocap');
    assert.equal(savedJob.reviewCapDisabled, true);

    // Missing review-lane on fix/rev round exits 3 on CLI; word-internal rev (reviewcap1) without review-lane succeeds.
    writeTimed(path.join(root, 'brief-fix7j.md'), 'worker-disk-budget: 64K\n', 40);
    const missingLaneCli = spawnSync(process.execPath, [cli, 'run', '--state-dir', state, '--id', 'cli-fix7j', '--work-dir', root,
        '--budget', '64K', '--floor', '1K', '--poll-ms', '30', '--instruction', path.join(root, 'brief-fix7j.md'),
        '--', '/bin/sh', '-c', 'exit 0'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(missingLaneCli.status, 3);
    assert.match(missingLaneCli.stderr, /fix7j 는 고침·검수 회차인데 지시서에 'review-lane:' 줄이 없음/);

    writeTimed(path.join(root, 'brief-reviewcap1.md'), 'worker-disk-budget: 64K\n', 41);
    const wordInternalCli = spawnSync(process.execPath, [cli, 'run', '--state-dir', state, '--id', 'cli-reviewcap1', '--work-dir', root,
        '--budget', '64K', '--floor', '1K', '--poll-ms', '30', '--instruction', path.join(root, 'brief-reviewcap1.md'),
        '--', '/bin/sh', '-c', `echo reviewcap1-ok > '${marker}'`], { encoding: 'utf8', timeout: 10000 });
    assert.equal(wordInternalCli.status, 0, wordInternalCli.stderr);
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'reviewcap1-ok');

    // Invalid --review-cap value fails closed.
    const invalidCap = spawnSync(process.execPath, [cli, 'run', '--state-dir', state, '--id', 'cli-bad-cap', '--work-dir', root,
        '--budget', '1K', '--floor', '1K', '--review-cap', '0', '--', '/bin/sh', '-c', 'exit 0'], { encoding: 'utf8', timeout: 10000 });
    assert.notEqual(invalidCap.status, 0);
}));
