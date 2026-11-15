#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { schedule, finish, cleanupPaths, parseBytes, terminalOutcome } from './core.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
function identity(pid) {
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    }
    catch {
        return null;
    }
}
const alive = (pid, token) => {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    if (token && identity(pid) !== token)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return e.code === 'EPERM';
    }
};
const args = process.argv.slice(2), action = args.shift(), options = {};
let command = [];
while (args.length) {
    const key = args.shift();
    if (key === '--') {
        command = args.splice(0);
        break;
    }
    if (!key.startsWith('--') || !args.length)
        throw Error(`Invalid option ${key}`);
    options[key.slice(2)] = args.shift();
}
const stateDir = path.resolve(options['state-dir'] || process.env.WORKER_RUNNER_STATE_DIR || path.join(os.homedir(), '.local/state/worker-runner'));
function noSymlinkAncestors(target) {
    let p = path.parse(target).root;
    for (const part of target.slice(p.length).split(path.sep).filter(Boolean)) {
        p = path.join(p, part);
        try {
            if (fs.lstatSync(p).isSymbolicLink())
                throw Error('Symlink ancestor rejected');
        }
        catch (e) {
            if (e.code !== 'ENOENT')
                throw e;
        }
    }
}
noSymlinkAncestors(stateDir);
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
if (fs.lstatSync(stateDir).isSymbolicLink())
    throw Error('State directory cannot be symlink');
const stateFile = path.join(stateDir, 'state.json');
function saveState(state) { const next = `${stateFile}.${process.pid}`; fs.writeFileSync(next, JSON.stringify(state, null, 2), { mode: 0o600 }); fs.renameSync(next, stateFile); }
async function transaction(fn) {
    // The lease receives EOF even after supervisor SIGKILL; the kernel releases flock.
    const lockFile = path.join(stateDir, 'state.lock');
    noSymlinkAncestors(lockFile);
    const lease = spawn('flock', ['--exclusive', lockFile, 'sh', '-c', 'printf "locked\\n"; read -r release'], { stdio: ['pipe', 'pipe', 'inherit'] });
    lease.stdin.on('error', () => { });
    const closed = new Promise(resolve => lease.once('close', resolve));
    await new Promise((resolve, reject) => {
        lease.once('error', reject);
        lease.once('close', code => reject(Error(`Lock lease exited before acquisition: ${code}`)));
        lease.stdout.once('data', resolve);
    });
    try {
        const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { version: 1, jobs: [], sequence: 0 };
        const result = await fn(state);
        saveState(state);
        return result;
    }
    finally {
        lease.stdin.end();
        await closed;
    }
}
function freeBytes() {
    const row = execFileSync('df', ['-Pk', stateDir], { encoding: 'utf8' }).trim().split('\n').at(-1).trim().split(/\s+/);
    const n = Number(row[3]) * 1024;
    if (!Number.isFinite(n))
        throw Error('Cannot read disk free space');
    return n;
}
function usage(dir) {
    let out;
    try {
        out = execFileSync('du', ['-sk', '--', dir], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
    }
    catch (e) {
        // du exits 1 when a file vanishes mid-walk but still prints the total; keep that.
        out = typeof e.stdout === 'string' ? e.stdout : '';
    }
    const kb = Number(out.split(/\s+/)[0]);
    if (!out.trim() || !Number.isFinite(kb))
        throw Error(`Cannot measure disk usage for ${dir}`);
    return kb * 1024;
}
function removeOwned(root) {
    const runs = path.join(stateDir, 'runs');
    if (path.dirname(root) !== runs || !path.basename(root).startsWith('attempt-'))
        throw Error('Unowned cleanup root');
    cleanupPaths(root, [], { isSymlink: p => {
            try {
                return fs.lstatSync(p).isSymbolicLink();
            }
            catch (e) {
                if (e.code === 'ENOENT')
                    return false;
                throw e;
            }
        }, remove: p => fs.rmSync(p, { recursive: true, force: true }) });
}
function stop(j, signal = 'SIGTERM') {
    if (j.child && groupAlive(j.child)) {
        try {
            process.kill(-j.child, signal);
        }
        catch (e) {
            if (e.code !== 'ESRCH')
                throw e;
        }
    }
}
function groupAlive(pid) {
    try {
        process.kill(-pid, 0);
        return true;
    }
    catch (e) {
        return e.code === 'EPERM';
    }
}
function event(type, j, detail = {}) { console.error(JSON.stringify({ time: new Date().toISOString(), trace: j.id, event: type, ...detail })); }
async function reconcile(state) {
    for (const j of state.jobs.filter(j => ['running', 'stopping', 'queued'].includes(j.status) && !alive(j.owner, j.ownerToken))) {
        if (j.child && groupAlive(j.child)) {
            stop(j, 'SIGKILL');
            continue;
        }
        finish(state, j.id, removeOwned, 'abandoned');
        event('recovered', j);
    }
}
if (action === 'watch') {
    // Independent process survives an uncatchable supervisor SIGKILL.
    for (;;) {
        let pending = false;
        await transaction(async (state) => { await reconcile(state); pending = state.jobs.some(j => j.owner === Number(options.owner) && ['queued', 'running', 'stopping'].includes(j.status)); });
        if (!pending)
            break;
        await sleep(500);
    }
}
else if (action === 'status') {
    await transaction(async (state) => { await reconcile(state); console.log(JSON.stringify({ freeBytes: freeBytes(), reservedBytes: state.jobs.filter(j => ['running', 'stopping'].includes(j.status)).reduce((n, j) => n + j.remaining, 0), jobs: state.jobs.filter(j => ['running', 'stopping', 'queued'].includes(j.status)).sort((a, b) => Number(!!b.front) - Number(!!a.front) || b.priority - a.priority || a.order - b.order).map(({ id, status, budget, remaining, priority, resume }) => ({ id, status, budget, remaining, priority, resume })) }, null, 2)); });
}
else if (action === 'register') {
    // Registration creates a fresh directory; existing paths are never adopted.
    await transaction(state => {
        const j = state.jobs.find(j => j.id === options.id && j.status === 'running');
        if (!j?.root)
            throw Error('No running attempt');
        const target = path.resolve(options.path || '');
        const relative = path.relative(j.root, target);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
            throw Error('Cleanup outside owned root');
        cleanupPaths(j.root, [target], { isSymlink: p => fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink(), remove: () => { } });
        fs.mkdirSync(target);
        console.log(target);
    });
}
else if (action === 'run') {
    if (!command.length || !options.id || !options['work-dir'])
        throw Error('run requires --id, --work-dir and -- command');
    const workDir = fs.realpathSync(options['work-dir']);
    let instruction = {};
    if (options.instruction) {
        const text = fs.readFileSync(options.instruction, 'utf8');
        try {
            instruction = JSON.parse(text);
        }
        catch {
            instruction = { disk_budget: /^\s*worker-disk-budget:\s*(\S+)/mi.exec(text)?.[1], disk_priority: /^\s*worker-disk-priority:\s*(\S+)/mi.exec(text)?.[1] };
        }
    }
    const budget = parseBytes(options.budget || instruction.disk_budget || options['default-budget'] || '1G'), floor = parseBytes(options.floor || '5G');
    const p = options.priority || instruction.disk_priority || 'normal', priority = ({ low: -100, normal: 0, high: 100 })[p] ?? Number(p);
    if (!Number.isFinite(priority))
        throw Error('Invalid priority');
    const timeout = Number(options.timeout || 0);
    if (!Number.isFinite(timeout) || timeout < 0)
        throw Error('Invalid timeout');
    let child, childExit, requestedSignal, completed = false;
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'])
        process.on(sig, () => { requestedSignal = sig; });
    await transaction(state => {
        if (state.jobs.some(j => j.id === options.id && ['queued', 'running', 'stopping'].includes(j.status)))
            throw Error('Active id already exists');
        state.jobs = state.jobs.filter(j => j.id !== options.id);
        state.jobs.push({ id: options.id, owner: process.pid, ownerToken: identity(process.pid), floor, status: 'queued', budget, remaining: 0, priority, order: ++state.sequence, workDir, command });
    });
    const watcher = spawn(process.execPath, [fileURLToPath(import.meta.url), 'watch', '--state-dir', stateDir, '--owner', String(process.pid)], { detached: true, stdio: 'ignore' });
    watcher.on('error', error => { event('watch-error', { id: options.id }, { error: error.message }); requestedSignal = 'SIGTERM'; });
    watcher.unref();
    try {
        while (!completed) {
            await transaction(async (state) => {
                await reconcile(state);
                const j = state.jobs.find(j => j.id === options.id);
                if (!j)
                    throw Error('Missing job state');
                if (childExit) {
                    // A command may leave descendants: terminate its own process group before releasing space.
                    if (j.child && groupAlive(j.child)) {
                        stop(j, 'SIGKILL');
                        return;
                    }
                    const preempt = j.preempt && !requestedSignal;
                    const result = terminalOutcome(j, childExit, requestedSignal);
                    finish(state, j.id, removeOwned, preempt ? 'preempted' : result.status);
                    j.exitCode = result.code;
                    delete j.preempt;
                    delete j.stopAt;
                    delete j.doneAt;
                    delete j.timedOut;
                    child = undefined;
                    childExit = undefined;
                    event(preempt ? 'resume-queued' : 'end', j, { result: j.exitCode });
                    if (!preempt) {
                        completed = true;
                        process.exitCode = requestedSignal ? 128 + (os.constants.signals[requestedSignal] || 15) : j.exitCode;
                        return;
                    }
                }
                if (requestedSignal && j.status === 'queued') {
                    finish(state, j.id, removeOwned, 'cancelled');
                    completed = true;
                    process.exitCode = 130;
                    return;
                }
                if (j.status === 'running' && child) {
                    if (!j.measuredAt || Date.now() - j.measuredAt >= 10000) {
                        // A failed measurement keeps the last estimate; it must never take the worker down.
                        try {
                            const grown = j.initialUsage == null ? 0 : Math.max(0, usage(workDir) - j.initialUsage);
                            j.remaining = Math.max(0, j.budget - grown - usage(j.root));
                        }
                        catch (e) {
                            event('measure-error', j, { error: e.message });
                        }
                        j.measuredAt = Date.now();
                    }
                    if (options['done-file'] && fs.existsSync(options['done-file']))
                        j.doneAt ??= Date.now();
                    const done = j.doneAt && Date.now() - j.doneAt >= Number(options['done-grace'] || 300) * 1000;
                    if (timeout && Date.now() - j.started >= timeout * 1000)
                        j.timedOut = true;
                    if (requestedSignal || done || j.timedOut) {
                        j.status = 'stopping';
                        j.preempt = false;
                        j.stopAt = Date.now();
                        stop(j);
                    }
                }
                const effects = schedule(state, freeBytes(), Math.max(floor, ...state.jobs.filter(x => ['queued', 'running', 'stopping'].includes(x.status)).map(x => x.floor || floor)), Date.now());
                // Only the owning supervisor starts or signals its own child.
                for (const effect of effects) {
                    const target = state.jobs.find(x => x.id === effect.id);
                    event(effect.type, target);
                }
                if (j.status === 'stopping' && !child) {
                    finish(state, j.id, removeOwned, 'preempted');
                    delete j.preempt;
                    delete j.stopAt;
                }
                if (j.status === 'stopping' && child) {
                    j.stopAt ??= Date.now();
                    stop(j, Date.now() - j.stopAt > 5000 ? 'SIGKILL' : 'SIGTERM');
                }
                if (j.status === 'running' && !child) {
                    const runs = path.join(stateDir, 'runs');
                    fs.mkdirSync(runs, { recursive: true, mode: 0o700 });
                    j.root = path.join(runs, `attempt-${randomUUID()}`);
                    saveState(state); // Persist ownership before creating anything or launching a process.
                    fs.mkdirSync(j.root, { mode: 0o700 });
                    fs.mkdirSync(path.join(j.root, 'tmp'));
                    try {
                        j.initialUsage = usage(workDir);
                    }
                    catch (e) {
                        j.initialUsage = null;
                        event('measure-error', j, { error: e.message });
                    }
                    child = spawn(process.execPath, [fileURLToPath(new URL('./launch.mjs', import.meta.url)), stateFile, j.id, j.root, ...command], { cwd: workDir, stdio: 'inherit', detached: true, env: { ...process.env, TMPDIR: path.join(j.root, 'tmp'), WORKER_RUNNER_TMP_ROOT: j.root, WORKER_RUNNER_STATE_DIR: stateDir, WORKER_RUNNER_ID: j.id, WORKER_RUNNER_RESUME: j.resume ? '1' : '0' } });
                    j.child = child.pid;
                    child.once('error', e => { event('spawn-error', j, { error: e.message }); childExit = { code: 1 }; });
                    child.once('exit', (code, signal) => { childExit = { code, signal }; });
                }
            });
            if (!completed)
                await sleep(Number(options['poll-ms'] || 1000));
        }
    }
    catch (error) {
        if (child) {
            await transaction(state => {
                const j = state.jobs.find(j => j.id === options.id);
                if (j) {
                    j.status = 'stopping';
                    j.preempt = false;
                    stop(j, 'SIGKILL');
                }
            });
            await new Promise(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', resolve));
        }
        await transaction(state => {
            const j = state.jobs.find(j => j.id === options.id);
            if (j && (!j.child || !groupAlive(j.child)))
                finish(state, j.id, removeOwned, 'failed');
        });
        throw error;
    }
}
else {
    console.error(`Usage: node ${path.basename(fileURLToPath(import.meta.url))} run|status|register --state-dir DIR [options] -- command`);
    process.exitCode = 2;
}
