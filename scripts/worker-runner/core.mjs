import path from 'node:path';
export function parseBytes(value) {
    const match = /^(\d+(?:\.\d+)?)([KMGT]?)(?:i?B)?$/i.exec(String(value));
    if (!match)
        throw Error(`Invalid byte budget: ${value}`);
    const raw = Number(match[1]) * 1024 ** ('KMGT'.indexOf(match[2].toUpperCase()) + 1);
    const result = match[2] ? Math.ceil(raw) : raw;
    if (!Number.isSafeInteger(result) || result <= 0)
        throw Error('Budget must be positive integer bytes');
    return result;
}
export function cleanupPaths(root, paths, io) {
    if ([root, ...paths].some(target => target.split(path.sep).includes('..'))) throw Error('Cleanup outside owned root: traversal rejected');
    root = path.resolve(root);
    for (const target of [root, ...paths]) {
        const resolved = path.resolve(target), relative = path.relative(root, resolved);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
            throw Error('Cleanup outside owned root');
        let current = path.parse(resolved).root;
        for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
            current = path.join(current, part);
            if (io.isSymlink(current))
                throw Error('Cleanup symlink rejected');
        }
    }
    io.remove(root);
}
export function finish(state, id, remove, reason = 'finished') {
    const j = state.jobs.find(j => j.id === id);
    if (j.root) {
        try { remove(j.root); } catch (error) { j.cleanupError = error.message; j.cleanupCode = error.code; j.cleanupRoot = j.root; }
    }
    j.remaining = 0;
    delete j.root;
    delete j.child;
    delete j.childToken;
    delete j.members;
    if (reason === 'preempted') {
        j.status = 'queued';
        j.resume = true;
        j.front = true;
    }
    else {
        j.status = reason;
        j.ended = Date.now();
    }
}
// Five total attempts, with bounded exponential backoff; retain the root for operators.
export function cleanupFailure(j, now = Date.now()) {
    if (j.cleanupExhausted) return false;
    j.cleanupAttempts = (j.cleanupAttempts || 0) + 1;
    j.cleanupNextAt = now + Math.min(30000, 1000 * 2 ** (j.cleanupAttempts - 1));
    const permanent = /Unowned|[Ss]ymlink|traversal/.test(j.cleanupError || '') || j.cleanupCode === 'EPERM';
    if (!permanent && j.cleanupAttempts < 5) return false;
    j.cleanupExhausted = true;
    if (j.status === 'queued') { j.status = 'failed'; j.ended = now; j.exitCode = 1; j.remaining = 0; }
    if (j.cleanupAlerted) return false;
    j.cleanupAlerted = true;
    return true;
}
export function schedule(state, free, floor, now) {
    const active = state.jobs.filter(j => ['running', 'stopping'].includes(j.status));
    if (active.some(j => j.status === 'stopping' && now - (j.stopAt ?? now) < 10000))
        return [];
    if (free < floor) {
        const candidates = active.filter(j => j.status === 'running');
        const unknown = candidates.every(j => (j.used || 0) <= j.budget);
        const victim = candidates.sort((a, b) => Math.max(0, (b.used || 0) - b.budget) - Math.max(0, (a.used || 0) - a.budget) || (unknown ? b.started - a.started || b.budget - a.budget : a.priority - b.priority) || b.started - a.started || b.order - a.order)[0];
        if (!victim)
            return [];
        victim.status = 'stopping';
        victim.budgetKilled = (victim.used || 0) > victim.budget;
        victim.preempt = !victim.budgetKilled;
        victim.stopAt = now;
        return [{ type: 'stop', id: victim.id }];
    }
    let available = free - active.reduce((n, j) => n + j.remaining, 0) - floor;
    const effects = [];
    for (const j of state.jobs.filter(j => j.status === 'queued' && !j.cleanupRoot).sort((a, b) => b.priority - a.priority || Number(!!b.front) - Number(!!a.front) || a.order - b.order)) {
        if (j.budget > available) {
            if (j.budget > free - floor) continue;
            if (active.some(x => x.recoveryBlocked || (x.status === 'stopping' && now - (x.stopAt ?? now) >= 10000))) continue;
            break;
        }
        j.status = 'running';
        j.started = now;
        j.remaining = j.budget;
        j.front = false;
        available -= j.budget;
        effects.push({ type: 'start', id: j.id });
    }
    return effects;
}
export function terminalOutcome(job, result, signal) {
    if (signal)
        return { status: 'cancelled', code: 128 };
    if (job.budgetKilled) return { status: 'budget-killed', code: 125 };
    if (job.timedOut)
        return { status: 'timeout', code: 124 };
    if (job.doneAt && (job.doneStopped || result.code === 0))
        return { status: 'finished', code: 0 };
    return { status: result.code === 0 ? 'finished' : 'failed', code: result.code ?? 1 };
}
export function launchAuthorized(state, pid, id, root) {
    return state.jobs.some(j => j.id === id && j.root === root && j.child === pid && j.status === 'running');
}

// A watch may reconcile another owner's failed cleanup; never consume its own alert.
export function attentionOwner(action, watchOwner, job, currentPid) {
    return job.owner || (action === 'watch' ? Number(watchOwner) : currentPid);
}
export function selectTempBase(explicit, stateDir, stat) {
    const candidate = path.resolve(explicit || '/tmp');
    if (stat(candidate).dev === stat(stateDir).dev) return candidate;
    if (explicit) throw Error(`Temporary base ${candidate} must share the state filesystem`);
    return path.join(stateDir, 'runs');
}
// Only call after an actual child exit or orphan-group exit, never cleanup retries.
export async function groupSettled(job, { alive, sleep }) {
    if (!job.child) return true;
    if (alive(job)) return false;
    await sleep(100);
    return !alive(job);
}
