import path from 'node:path';
export function parseBytes(value) {
    const match = /^(\d+(?:\.\d+)?)([KMGT]?)(?:i?B)?$/i.exec(String(value));
    if (!match)
        throw Error(`Invalid byte budget: ${value}`);
    const result = Number(match[1]) * 1024 ** ('KMGT'.indexOf(match[2].toUpperCase()) + 1);
    if (!Number.isSafeInteger(result) || result <= 0)
        throw Error('Budget must be positive integer bytes');
    return result;
}
export function cleanupPaths(root, paths, io) {
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
    if (j.root)
        remove(j.root);
    j.remaining = 0;
    delete j.root;
    delete j.child;
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
export function schedule(state, free, floor, now) {
    const active = state.jobs.filter(j => ['running', 'stopping'].includes(j.status));
    if (active.some(j => j.status === 'stopping'))
        return [];
    if (free < floor) {
        const victim = active.sort((a, b) => a.priority - b.priority || b.started - a.started)[0];
        if (!victim)
            return [];
        victim.status = 'stopping';
        victim.preempt = true;
        return [{ type: 'stop', id: victim.id }];
    }
    let available = free - active.reduce((n, j) => n + j.remaining, 0) - floor;
    const effects = [];
    for (const j of state.jobs.filter(j => j.status === 'queued').sort((a, b) => Number(!!b.front) - Number(!!a.front) || b.priority - a.priority || a.order - b.order)) {
        if (j.budget > available)
            break;
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
    if (job.timedOut)
        return { status: 'timeout', code: 124 };
    if (job.doneAt)
        return { status: 'finished', code: 0 };
    return { status: result.code === 0 ? 'finished' : 'failed', code: result.code ?? 1 };
}
export function launchAuthorized(state, pid, id, root) {
    return state.jobs.some(j => j.id === id && j.root === root && j.child === pid && j.status === 'running');
}
