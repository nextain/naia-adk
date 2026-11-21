#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeOwnedRoot } from './cleanup.mjs';
import { schedule, finish, cleanupFailure, cleanupPaths, parseBytes, terminalOutcome, selectTempBase, attentionOwner, groupSettled } from './core.mjs';
import { checkReviewCap, afterReviewCap, DEFAULT_REVIEW_CAP_CONFIG } from './review-cap.mjs';
import { measureMinFreeBytesSync } from '../lib/disk-free.mjs';
import { supervisorCommand } from '../work-ledger/worker-profile.mjs';
import { registerWorker, updateWorkerRuntime } from '../work-watch.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
import { identity, processInfo, ownerIdentity, localIdentity, bootId, pidNamespace, ownedGroupAlive, stopOwned } from './process.mjs';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
const execAsync = promisify(execFile);
const alive = (pid, token) => {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    if (token && identity(pid) !== token && processInfo(pid)?.startTime !== token)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return e.code === 'EPERM';
    }
};
const args = process.argv.slice(2), action = args.shift(), options = { 'watch-dirs': [] };
let command = [];
while (args.length) {
    const key = args.shift();
    if (key === '--') {
        command = args.splice(0);
        break;
    }
    if (key === '--no-review-cap') {
        options['no-review-cap'] = args.length && !args[0].startsWith('--') ? args.shift() : true;
        continue;
    }
    if (key === '--allow-unregistered-test') {
        options['allow-unregistered-test'] = true;
        continue;
    }
    if (!key.startsWith('--') || !args.length)
        throw Error(`Invalid option ${key}`);
    const optName = key.slice(2);
    const optVal = args.shift();
    if (optName === 'watch-dir') {
        options['watch-dir'] = optVal;
        options['watch-dirs'].push(optVal);
    }
    else {
        options[optName] = optVal;
    }
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
const STATE_VERSION = 2;
function saveState(state) {
    if (state?.version > STATE_VERSION) throw Error('Unsupported future state version');
    state.version = STATE_VERSION;
    const terminal = state.jobs.filter(j => !['running', 'stopping', 'queued'].includes(j.status)).sort((a, b) => (b.ended || 0) - (a.ended || 0));
    const retain = new Set(terminal.slice(0, 100));
    state.jobs = state.jobs.filter(j => ['running', 'stopping', 'queued'].includes(j.status) || j.cleanupRoot || retain.has(j));
 const next = `${stateFile}.${process.pid}`; fs.writeFileSync(next, JSON.stringify(state, null, 2), { mode: 0o600 }); fs.renameSync(next, stateFile); }
async function transaction(fn) {
    // The lease receives EOF even after supervisor SIGKILL; the kernel releases flock.
    const lockFile = path.join(stateDir, 'state.lock');
    noSymlinkAncestors(lockFile);
    const lease = spawn('flock', ['--exclusive', lockFile, 'sh', '-c', 'printf "locked\\n"; read -r release'], { stdio: ['pipe', 'pipe', 'inherit'] });
    lease.stdin.on('error', () => { });
    const closed = new Promise(resolve => lease.once('close', resolve));
    let acquisitionTimer;
    await new Promise((resolve, reject) => {
        acquisitionTimer = setTimeout(() => { lease.stdin.end(); lease.kill(); reject(Error('Lock acquisition timeout')); }, 2000);
        lease.once('error', reject);
        lease.once('close', code => reject(Error(`Lock lease exited before acquisition: ${code}`)));
        lease.stdout.once('data', resolve);
    }).finally(() => clearTimeout(acquisitionTimer));
    try {
        if (action === 'watch' && !fs.existsSync(stateFile)) { const error = Error('Missing supervisor state'); error.stateLost = true; throw error; }
        const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { version: 1, jobs: [], sequence: 0 };
        if (state && state.version == null) state.version = 1;
        const before = JSON.stringify(state);
        if (state?.version > STATE_VERSION) {
            if (action !== 'status') throw Error('Unsupported future state version');
            console.log(JSON.stringify(state, null, 2)); return;
        }
        if (!state || !Array.isArray(state.jobs) || !Number.isFinite(state.version) || !Number.isFinite(state.sequence)) { const error = Error('Invalid or lost state'); error.stateLost = true; throw error; }
        const committed = [];
        const result = await fn(state, callback => committed.push(callback));
        if (JSON.stringify(state) !== before) saveState(state);
        for (const callback of committed) callback();
        return result;
    }
    finally {
        lease.stdin.end();
        await closed;
    }
}
function freeBytes() {
    const extra = [stateDir, ...(options['work-dir'] ? [path.resolve(options['work-dir'])] : [])];
    return measureMinFreeBytesSync(extra, {
        explicitPaths: options['disk-paths'],
        execFileSyncImpl: execFileSync,
        timeoutMs: 1000,
    }).bytes;
}
async function usage(dir, excludes = []) {
    let out;
    try {
        out = (await execAsync('du', ['-sk', ...excludes.map(p => `--exclude=${p.replace(/[\\*?\[]/g, '\\$&')}`), '--', dir], { encoding: 'utf8', timeout: 1000, maxBuffer: 1024 * 1024 })).stdout;
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
function workExclusions(dir, jobs = []) {
    const nested = p => { if (!p || p === dir) return false; const rel = path.relative(dir, p); return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
    const paths = [stateDir, ...jobs.flatMap(j => [j.root, j.cleanupRoot, j.tempRoot])].filter(nested);
    return [...new Set(paths)].filter(p => !paths.some(other => other !== p && p.startsWith(other + path.sep)));
}
let cleanupJob;
function removeOwned(root) {
    return removeOwnedRoot(root, cleanupJob, path.join(stateDir, 'runs'));
}

function finishJob(state, id, reason) {
    cleanupJob = state.jobs.find(j => j.id === id);
    const attempted = !!cleanupJob.root;
    try {
        finish(state, id, removeOwned, reason);
        if (attempted && cleanupJob.cleanupError) recordCleanupFailure(cleanupJob);
    } finally { cleanupJob = undefined; }
}
function recordCleanupFailure(j) {
    event('cleanup-failed', j, { error: j.cleanupError });
    if (cleanupFailure(j)) event('human-attention', j, { error: j.cleanupError, root: j.cleanupRoot });
}
const stop = (j, signal = 'SIGTERM') => stopOwned(j, signal);
const groupAlive = j => ownedGroupAlive(j);
function event(type, j, detail = {}) {
    if (type === 'human-attention') {
        const owner = attentionOwner(action, options.owner, j, process.pid);
        const marker = path.join(stateDir, `.attention-${owner}`);
        try { fs.writeFileSync(marker, '', { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code === 'EEXIST' && !j.cleanupAlerted) return; /* best effort when the disk itself is unavailable */ }
        try {
            const markers = fs.readdirSync(stateDir).filter(name => /^\.attention-\d+$/.test(name)).flatMap(name => { try { return [{ name, stamp: fs.statSync(path.join(stateDir, name)).mtimeMs }]; } catch { return []; } }).sort((a, b) => b.stamp - a.stamp);
            for (const entry of markers.slice(100)) { try { fs.unlinkSync(path.join(stateDir, entry.name)); } catch { /* another supervisor may already have pruned it */ } }
        } catch { /* notification retention must never prevent stopping the worker */ }
    }
    const foreign = action !== 'run' || j.id !== options.id || ['restored', 'recovered', 'cleanup-error', 'cleanup-failed', 'recovery-blocked'].includes(type);
    const line = JSON.stringify({ time: new Date().toISOString(), trace: j.id, event: type, ...detail }) + '\n';
    if (foreign) { try { fs.appendFileSync(path.join(stateDir, 'supervisor.jsonl'), line); } catch { /* keep foreign events out of the calling round's log even when audit storage fails */ } return; }
    if (options['event-log']) { try { fs.appendFileSync(options['event-log'], line); } catch { /* stderr remains available */ process.stderr.write(line); } }
    else process.stderr.write(line);
}
async function reconcile(state) {
    // Failed roots remain durable even after the owning invocation has exited.
    // df still counts their bytes; never credit a failed deletion as free space.
    for (const j of state.jobs.filter(j => j.cleanupRoot && localIdentity(j) && !j.cleanupExhausted && Date.now() >= (j.cleanupNextAt || 0))) {
        cleanupJob = j;
        try {
            removeOwned(j.cleanupRoot);
            delete j.cleanupRoot;
            delete j.cleanupError;
            for (const key of ['cleanupAttempts', 'cleanupNextAt', 'cleanupExhausted', 'cleanupAlerted', 'cleanupCode']) delete j[key];
        } catch (error) {
            j.cleanupError = error.message; j.cleanupCode = error.code;
            recordCleanupFailure(j);
        } finally { cleanupJob = undefined; }
    }
    for (const j of state.jobs.filter(j => j.status === 'stopping')) {
        j.stopAt ??= Date.now();
        if (Date.now() - j.stopAt >= 10000 && !j.stoppingAlerted) {
            event('human-attention', j, { error: 'Stopping exceeded ten seconds; reservation retained, queue may continue' });
            j.stoppingAlerted = true;
        }
    }
    // Restore only a legacy record whose still-live owner proves the child identity.
    for (const j of state.jobs.filter(j => j.status === 'abandoned' && localIdentity(j) && alive(j.owner, j.ownerToken) && j.child && j.root)) {
        if (!groupAlive(j)) continue;
        const runs = path.join(stateDir, 'runs');
        if (path.dirname(j.root) !== runs || !path.basename(j.root).startsWith('attempt-')) continue;
        noSymlinkAncestors(j.root);
        if (!fs.existsSync(j.root)) continue;
        if (bootId && pidNamespace && processInfo(j.owner)?.startTime === j.ownerToken) { j.ownerBootId ??= bootId; j.ownerNamespace ??= pidNamespace; }
        j.status = 'running'; j.remaining = Math.max(0, j.budget - (j.used || 0)); delete j.ended;
        event('restored', j);
    }
    for (const j of state.jobs.filter(j => ['running', 'stopping', 'queued'].includes(j.status) && localIdentity(j) && alive(j.owner, j.ownerToken))) {
        if (bootId && pidNamespace && processInfo(j.owner)?.startTime === j.ownerToken) { j.ownerBootId ??= bootId; j.ownerNamespace ??= pidNamespace; }
        if (j.child && !j.childToken) groupAlive(j);
    }
    for (const j of state.jobs.filter(j => ['running', 'stopping', 'queued'].includes(j.status) && localIdentity(j) && !alive(j.owner, j.ownerToken))) {
        if (j.child && !j.childToken && processInfo(j.child)) {
            if (!j.recoveryBlocked) { event('human-attention', j, { error: 'Legacy child identity cannot be proven; reservation retained' }); j.recoveryBlocked = true; }
            continue;
        }
        if (j.child && groupAlive(j)) {
            if (stop(j, 'SIGKILL')) continue;
            if (!j.recoveryBlocked) { event('recovery-blocked', j, { error: 'Cannot signal owned group; reservation retained' }); j.recoveryBlocked = true; }
            continue;
        }
        if (!await groupSettled(j, { alive: groupAlive, sleep })) continue;
        finishJob(state, j.id, 'abandoned');
        if (j.cleanupError) event('cleanup-error', j, { error: j.cleanupError });
        event('recovered', j);
    }
}
function retryPolicy(report) {
    let message, count = 0;
    return error => {
        if (!error) { count = 0; message = undefined; return 0; }
        count++;
        if (message !== error.message) { report('supervisor-error', { error: error.message }); message = error.message; }
        return Math.min(10000, 1000 * 2 ** Math.min(count - 1, 4));
    };
}
if (action === 'watch') {
    const retry = retryPolicy((type, detail) => event(type, { id: options.id || options.owner }, detail));
    // Independent process survives an uncatchable supervisor SIGKILL.
    for (;;) {
        let pending = false, delay = 500;
        try {
            await transaction(async (state) => { await reconcile(state); pending = state.jobs.some(j => j.owner === Number(options.owner) && ['queued', 'running', 'stopping'].includes(j.status)); });
            retry();
        } catch (error) {
            delay = retry(error);
            if (!alive(Number(options.owner)) || error.stateLost || error instanceof SyntaxError || /future state version/.test(error.message)) { process.exitCode = 1; event('human-attention', { id: options.id || options.owner }, { error: error.message }); break; }
            pending = true;
        }
        if (!pending)
            break;
        await sleep(delay);
    }
}
else if (action === 'status') {
    await transaction(async (state) => { await reconcile(state); console.log(JSON.stringify({ freeBytes: freeBytes(), cleanupPending: state.jobs.filter(j => j.cleanupRoot).map(({ id, cleanupRoot, cleanupError, cleanupAttempts, cleanupNextAt, cleanupExhausted }) => ({ id, cleanupRoot, cleanupError, cleanupAttempts, cleanupNextAt, cleanupExhausted })), reservedBytes: state.jobs.filter(j => ['running', 'stopping'].includes(j.status)).reduce((n, j) => n + j.remaining, 0), jobs: state.jobs.filter(j => ['running', 'stopping', 'queued'].includes(j.status)).sort((a, b) => b.priority - a.priority || Number(!!b.front) - Number(!!a.front) || a.order - b.order).map(({ id, status, budget, remaining, priority, resume }) => ({ id, status, budget, remaining, priority, resume })) }, null, 2)); });
}
else if (action === 'register') {
    // Registration creates a fresh directory; existing paths are never adopted.
    await transaction(state => {
        const j = state.jobs.find(j => j.id === options.id && j.status === 'running');
        if (!j?.root)
            throw Error('No running attempt');
        if ((options.path || '').split(path.sep).includes('..')) throw Error('Cleanup traversal rejected');
        const target = path.resolve(options.path || '');
        const relative = path.relative(j.root, target);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
            throw Error('Cleanup outside owned root');
        cleanupPaths(j.root, [target], { isSymlink: p => { try { return fs.lstatSync(p).isSymbolicLink(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }, remove: () => { } });
        fs.mkdirSync(target);
        console.log(target);
    });
}
else if (action === 'run') {
    if (!options.id || !options['work-dir'])
        throw Error('run requires --id, --work-dir and -- command');
    const watchRole = (options.role || process.env.WORKER_ROLE || '').trim();
    const watchResultFile = (options['result-file'] || process.env.WORKER_RESULT_FILE || '').trim();
    const allowUnregisteredTest = Boolean(options['allow-unregistered-test']);
    if ((!watchRole || !watchResultFile) && !allowUnregisteredTest) {
        throw Error('unregistered worker-runner run refused: --role (or WORKER_ROLE) and --result-file (or WORKER_RESULT_FILE) are required so work-watch tracks every worker; use scripts/worker-runner/spawn-worker.mjs');
    }
    const adkRoot = path.resolve(options['adk-root'] || process.env.ADK_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
    command = await supervisorCommand({ root: adkRoot, role: watchRole, id: options.id, workDir: path.resolve(options['work-dir']), result: watchResultFile, opts: options, command });
    if (!bootId || !pidNamespace) throw Error('Process identity metadata unavailable; admission refused');
    const tempName = options['temp-name'] || options.id;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(tempName) || tempName.includes('..')) throw Error('Invalid temporary name');
    const explicitTempBase = options['temp-base'] || process.env.WORKER_RUNNER_TEMP_BASE;
    const suppliedTempBase = explicitTempBase || '/tmp';
    if (suppliedTempBase.split(path.sep).includes('..')) throw Error('Temporary base traversal rejected');
    const tempBase = selectTempBase(explicitTempBase, stateDir, fs.statSync);
    if (!explicitTempBase && tempBase === path.join(stateDir, 'runs')) fs.mkdirSync(tempBase, { recursive: true, mode: 0o700 });
    noSymlinkAncestors(tempBase);
    const workDir = fs.realpathSync(options['work-dir']);
    if (fs.statSync(tempBase).dev !== fs.statSync(stateDir).dev || fs.statSync(workDir).dev !== fs.statSync(stateDir).dev) throw Error('Work and state directories must share a filesystem');
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
    const reviewCapDisabled = Boolean(options['no-review-cap']);
    const reviewCap = options['review-cap'] !== undefined
        ? Number(options['review-cap'])
        : (process.env.REVIEW_CAP ? Number(process.env.REVIEW_CAP) : DEFAULT_REVIEW_CAP_CONFIG.cap);
    if (!Number.isInteger(reviewCap) || reviewCap < 1)
        throw Error('Invalid review cap');
    const reviewCapWakeDir = options['review-cap-wake-dir'] || process.env.REVIEW_CAP_WAKE_DIR || '';
    if (reviewCapWakeDir)
        noSymlinkAncestors(path.resolve(reviewCapWakeDir));
    if (reviewCapDisabled) {
        event('review-cap-disabled', { id: options.id }, { instruction: options.instruction || null });
    }
    else if (options.instruction) {
        const capCheck = checkReviewCap({ instruction: options.instruction, id: options.id, cap: reviewCap, wakeDir: reviewCapWakeDir });
        if (capCheck.blocked) {
            process.stderr.write(`${capCheck.reason}\n`);
            process.exit(3);
        }
        if (capCheck.resetUsed)
            event('review-cap-reset', { id: options.id }, { lane: capCheck.lane, count: capCheck.count, fails: capCheck.fails, reset: capCheck.reset });
    }
    if (watchRole && watchResultFile) {
        const watchDirs = options['watch-dirs'].length
            ? options['watch-dirs'].map(d => path.resolve(workDir, d))
            : [workDir];
        await registerWorker({
            root: adkRoot,
            registryFile: options['work-watch-registry'] || process.env.ADK_WORK_WATCH_REGISTRY,
            id: options.id,
            unit: options.unit || process.env.WORKER_UNIT || null,
            role: watchRole,
            wakeDir: options['wake-dir'] || reviewCapWakeDir || undefined,
            resultFile: path.resolve(workDir, watchResultFile),
            doneFile: options['done-file'] ? path.resolve(workDir, options['done-file']) : null,
            watchDirs,
            stallMinutes: options['stall-min'] !== undefined ? Number(options['stall-min']) : 15,
            pid: process.pid,
            command,
        });
    }
    const budget = parseBytes(options.budget || instruction.disk_budget || options['default-budget'] || '1G'), floor = parseBytes(options.floor || '5G');
    const p = options.priority || instruction.disk_priority || 'normal', priority = ({ low: -100, normal: 0, high: 100 })[p] ?? Number(p);
    if (!Number.isFinite(priority))
        throw Error('Invalid priority');
    const timeout = Number(options.timeout || 0);
    if (!Number.isFinite(timeout) || timeout < 0)
        throw Error('Invalid timeout');
    let child, childExit, requestedSignal, ownedAttempt, latestUsage, measuredAt = 0, completed = false;
    let initialDone;
    try { initialDone = fs.statSync(options['done-file']).mtimeMs; } catch { /* absent marker */ }
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'])
        process.on(sig, () => { requestedSignal = sig; });
    try { fs.unlinkSync(path.join(stateDir, `.attention-${process.pid}`)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const dispatchId = randomUUID();
    let admitted = false, admissionError;
    while (!admitted) {
        admitted = await transaction(async state => {
            if (state.jobs.some(j => ['running', 'queued', 'stopping'].includes(j.status) && !localIdentity(j))) throw Error('State belongs to another process namespace or boot');
            await reconcile(state);
            const previous = state.jobs.find(j => j.id === options.id && ['queued', 'running', 'stopping'].includes(j.status));
            if (previous) {
                if (previous.recoveryBlocked) { admissionError = Error('Recovery blocked; operator must verify the existing round'); return true; }
                if (alive(previous.owner, previous.ownerToken)) { admissionError = Error('Active id already exists'); return true; }
                return false; // An owned orphan was signaled; wait for exit outside the shared lock.
            }
            if (state.jobs.some(j => j.id === options.id && j.cleanupRoot)) { admissionError = Error('Previous attempt cleanup is pending'); return true; }
            state.jobs = state.jobs.filter(j => j.id !== options.id);
            state.jobs.push({ id: options.id, owner: process.pid, ...ownerIdentity(process.pid), floor, status: 'queued', budget, remaining: 0, priority, order: ++state.sequence, admittedAt: Date.now(), workDir, command, ...(reviewCapDisabled ? { reviewCapDisabled: true } : {}) });
            return true;
        });
        if (admissionError) throw admissionError;
        if (!admitted) {
            if (requestedSignal) { process.exitCode = 130; break; }
            await sleep(50);
        }
    }
    if (!admitted) process.exit(process.exitCode);

    const watcher = spawn(process.execPath, [fileURLToPath(import.meta.url), 'watch', '--state-dir', stateDir, '--owner', String(process.pid), '--id', options.id], { detached: true, stdio: 'ignore' });
    watcher.on('error', error => { event('watch-error', { id: options.id }, { error: error.message }); });
    watcher.unref();
    const retry = retryPolicy((type, detail) => event(type, { id: options.id }, detail));
    const measureRetry = retryPolicy((_type, detail) => event('measure-error', { id: options.id }, detail));
    let retryDelay = 0;
    while (!completed) {
        try {
            let free, measurementError, usageError, startUsage = null;
            let snapshot; try { snapshot = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
            const ownSnapshot = snapshot?.jobs.find(j => j.id === options.id);
            // Measurements are asynchronous and outside flock: slow du cannot hold the shared scheduler hostage.
            if (child && !childExit && ownedAttempt && Date.now() - measuredAt >= Math.min(1000, Number(options['poll-ms'] || 1000))) {
                const values = await Promise.allSettled([usage(workDir, workExclusions(workDir, snapshot?.jobs)), usage(ownedAttempt.root)]);
                if (values.every(v => v.status === 'fulfilled')) latestUsage = values.map(v => v.value);
                else usageError = values.find(v => v.status === 'rejected').reason;
                measuredAt = Date.now();
            }
            if (!child && latestUsage == null && !ownSnapshot?.cleanupRoot) { try { startUsage = await usage(workDir, workExclusions(workDir, snapshot?.jobs)); latestUsage = [startUsage, 0]; } catch (error) { usageError = error; } }
            try { free = freeBytes(); } catch (error) { measurementError = error; }
            const pressureUsage = new Map();
            const effectiveFloor = Math.max(floor, ...(snapshot?.jobs || []).filter(j => ['queued', 'running', 'stopping'].includes(j.status)).map(j => j.floor || floor));
            if (free != null && free < effectiveFloor) {
                await Promise.all((snapshot?.jobs || []).filter(j => localIdentity(j) && j.status === 'running' && j.root).map(async j => {
                    try { const [work, temp] = await Promise.all([usage(j.workDir, workExclusions(j.workDir, snapshot?.jobs)), usage(j.root)]);
                        pressureUsage.set(j.id, Math.max(0, work - (j.initialUsage || 0)) + Math.max(0, temp - (j.initialTempUsage || 0)));
                    } catch {}
                }));
            }
            await transaction(async (state, defer) => {
                if (state.jobs.some(x => ['running', 'queued', 'stopping'].includes(x.status) && !localIdentity(x))) { const error = Error('Foreign process namespace state'); error.stateLost = true; throw error; }
                for (const [id, used] of pressureUsage) { const measured = state.jobs.find(x => x.id === id); if (measured) { measured.used = used; measured.remaining = Math.max(0, measured.budget - used); /* owner's event loop observes the threshold transition */ } }
                await reconcile(state);
                const j = state.jobs.find(j => j.id === options.id);
                if (!j) { const error = Error('Missing job state'); error.stateLost = true; throw error; }
                if (!['running', 'queued', 'stopping'].includes(j.status)) {
                    if (!child) { defer(() => { completed = true; process.exitCode = 1; }); return; }
                    if (bootId && pidNamespace && processInfo(j.owner)?.startTime === j.ownerToken) { j.ownerBootId ??= bootId; j.ownerNamespace ??= pidNamespace; }
        j.status = 'running'; j.remaining = Math.max(0, j.budget - (j.used || 0));
                }
                if (j.used > j.budget && !j.overBudget) { event('budget-exceeded', j, { used: j.used, budget: j.budget }); j.overBudget = true; }
                if (child && ownedAttempt) {
                    Object.assign(j, { root: ownedAttempt.root, child: ownedAttempt.child, childToken: ownedAttempt.childToken });
                    if (j.initialUsage == null && ownedAttempt.initialUsage != null) j.initialUsage = ownedAttempt.initialUsage;
                    groupAlive(j);
                }
                if (childExit) {
                    // A command may leave descendants: terminate its own process group before releasing space.
                    if (j.child && groupAlive(j)) {
                        stop(j, 'SIGKILL');
                        return;
                    }
                    if (!await groupSettled(j, { alive: groupAlive, sleep })) return;
                    const preempt = j.preempt && !requestedSignal;
                    const result = terminalOutcome(j, childExit, requestedSignal);
                    finishJob(state, j.id, preempt ? 'preempted' : result.status);
                    j.exitCode = result.code;
                    delete j.preempt;
                    delete j.stopAt;
                    delete j.stopEvent;
                    if (!preempt) delete j.doneAt;
                    delete j.doneStopped;
                    delete j.timedOut;
                    defer(() => {
                        child = undefined; childExit = undefined; ownedAttempt = undefined; latestUsage = undefined;
                        event(preempt ? 'resume-queued' : 'end', j, { result: j.exitCode });
                        if (!preempt) { completed = true; process.exitCode = requestedSignal ? 128 + (os.constants.signals[requestedSignal] || 15) : j.exitCode; }
                    });
                    return;
                }
                if (timeout && j.status === 'queued' && Date.now() - j.admittedAt >= timeout * 1000) {
                    finishJob(state, j.id, 'timeout'); j.exitCode = 124;
                    defer(() => { completed = true; process.exitCode = 124; }); return;
                }
                if (requestedSignal && j.status === 'queued') {
                    finishJob(state, j.id, 'cancelled');
                    defer(() => { completed = true; process.exitCode = 130; });
                    return;
                }
                if (j.status === 'running' && child) {
                    if (latestUsage && !pressureUsage.has(j.id)) {
                        const [workUsed, tempUsed] = latestUsage;
                        const workWithoutTemp = workUsed;
                        if (j.initialUsage == null) j.initialUsage = workWithoutTemp;
                        j.used = Math.max(0, workWithoutTemp - j.initialUsage) + Math.max(0, tempUsed - (j.initialTempUsage || 0));
                        j.remaining = Math.max(0, j.budget - j.used);
                    }
                    if (j.used > j.budget && !j.overBudget) event('budget-exceeded', j, { used: j.used, budget: j.budget });
                    j.overBudget = j.used > j.budget;
                    if (j.used > j.budget * 2) { j.budgetKilled = true; j.status = 'stopping'; j.preempt = false; j.stopAt = Date.now(); stop(j); }
                    if (options['done-file']) {
                        try { const stamp = fs.statSync(options['done-file']).mtimeMs; if (stamp !== initialDone && stamp >= j.started - 50) j.doneAt ??= Date.now(); } catch { /* absent marker */ }
                    }
                    const done = j.doneAt && Date.now() - j.doneAt >= Number(options['done-grace'] || 300) * 1000;
                    if (timeout && Date.now() - j.admittedAt >= timeout * 1000)
                        j.timedOut = true;
                    if (done) j.doneStopped = true;
                    if (requestedSignal || done || j.timedOut) {
                        j.status = 'stopping';
                        j.preempt = false;
                        j.stopAt = Date.now();
                        stop(j);
                    }
                }
                const effects = free == null ? [] : schedule(state, free, Math.max(floor, ...state.jobs.filter(x => ['queued', 'running', 'stopping'].includes(x.status)).map(x => x.floor || floor)), Date.now());
                // Effects are persisted for each owner to observe; foreign events never enter this worker's log.
                void effects;
                if (j.status === 'stopping' && !child) {
                    finishJob(state, j.id, 'preempted');
                    delete j.preempt;
                    delete j.stopAt;
                }
                if (j.status === 'stopping' && child) {
                    if (!j.stopEvent) { event('stop', j, { used: j.used, budget: j.budget }); j.stopEvent = true; }
                    j.stopAt ??= Date.now();
                    stop(j, Date.now() - j.stopAt > 5000 ? 'SIGKILL' : 'SIGTERM');
                }
                if (j.status === 'running' && !child) {
                    event('start', j, { resume: !!j.resume });
                    j.attempt = (j.attempt ?? 0) + 1;
                    j.used = 0; delete j.overBudget;
                    j.tempBase = tempBase; j.tempRoot = path.join(tempBase, tempName); j.tempToken = randomUUID();
                    noSymlinkAncestors(j.tempRoot);
                    if (fs.existsSync(j.tempRoot)) throw Error('Temporary root already exists');
                    j.root = j.tempRoot;
                    saveState(state); // Persist ownership before creating anything or launching a process.
                    fs.mkdirSync(j.root, { mode: 0o700 });
                    fs.writeFileSync(path.join(j.root, '.worker-runner-owner'), j.tempToken, { mode: 0o600 });
                    j.initialUsage ??= startUsage ?? latestUsage?.[0];
                    const payloadTmp = path.join(j.root, 'tmp'); fs.mkdirSync(payloadTmp, { mode: 0o700 });
                    try { j.initialTempUsage = await usage(j.root); } catch { j.initialTempUsage = 0; }
                    child = spawn(process.execPath, [fileURLToPath(new URL('./launch.mjs', import.meta.url)), stateFile, j.id, j.root, ...command], { cwd: workDir, stdio: 'inherit', detached: true, env: { ...process.env, TMPDIR: payloadTmp, TMP: payloadTmp, TEMP: payloadTmp, WORKER_RUNNER_TMP_ROOT: j.root, WORKER_RUNNER_STATE_DIR: stateDir, WORKER_RUNNER_ID: j.id, WORKER_RUNNER_DISPATCH: dispatchId, WORKER_RUNNER_ATTEMPT: String(j.attempt), WORKER_RUNNER_RESUME: j.resume ? '1' : '0' } });
                    j.child = child.pid;
                    j.childToken = identity(child.pid);
                    ownedAttempt = { root: j.root, child: j.child, childToken: j.childToken, initialUsage: j.initialUsage, tempRoot: j.tempRoot, tempBase: j.tempBase, tempToken: j.tempToken, ownerBootId: bootId, ownerNamespace: pidNamespace };
                    groupAlive(j);
                    event('temp-root', j, { root: j.root, instruction: 'Use TMPDIR, TMP and TEMP for all attempt-local files; never create an external temporary root.' });
                    child.once('error', e => { event('spawn-error', j, { error: e.message }); childExit = { code: 1 }; });
                    child.once('exit', (code, signal) => { childExit = { code, signal }; });
                }
            });
            retryDelay = Math.max(retry(measurementError), measureRetry(usageError));
        } catch (error) {
            retryDelay = retry(error);
            if (error.stateLost || /Temporary root already exists|Symlink ancestor rejected/.test(error.message) || error instanceof SyntaxError || /future state version/.test(error.message) || !fs.existsSync(stateFile)) {
                event('human-attention', { id: options.id }, { error: error.message });
                if (ownedAttempt) { stop(ownedAttempt, 'SIGKILL');
                    for (let n = 0; n < 100 && groupAlive(ownedAttempt); n++) await sleep(25);
                    if (await groupSettled(ownedAttempt, { alive: groupAlive, sleep })) { cleanupJob = ownedAttempt; try { removeOwned(ownedAttempt.root); } catch {} finally { cleanupJob = undefined; } }
                }
                completed = true; process.exitCode = 1;
            }
        }
        if (!completed) await sleep(retryDelay || Number(options['poll-ms'] || 1000));
    }
    if (options.instruction && !reviewCapDisabled)
        afterReviewCap({ instruction: options.instruction, id: options.id, cap: reviewCap, wakeDir: reviewCapWakeDir });
    if (watchRole && watchResultFile && process.exitCode && process.exitCode !== 0) {
        try {
            await updateWorkerRuntime({
                root: adkRoot,
                registryFile: options['work-watch-registry'] || process.env.ADK_WORK_WATCH_REGISTRY,
                id: options.id,
                role: watchRole,
                launchFailed: false,
            });
        } catch { /* best-effort runtime update */ }
    }
}
else {
    console.error(`Usage: node ${path.basename(fileURLToPath(import.meta.url))} run|status|register --state-dir DIR [options] -- command`);
    process.exitCode = 2;
}
