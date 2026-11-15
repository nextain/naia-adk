import fs from 'node:fs';
const read = (fn) => { try { return fn(); } catch { return null; } };
export const bootId = read(() => fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim());
export const pidNamespace = read(() => fs.readlinkSync('/proc/self/ns/pid'));
export const localIdentity = job => (!job.ownerBootId || job.ownerBootId === bootId) && (!job.ownerNamespace || job.ownerNamespace === pidNamespace);
export const ownerIdentity = pid => ({ ownerToken: processInfo(pid)?.startTime, ownerBootId: bootId, ownerNamespace: pidNamespace });
export function processInfo(pid) {
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return { parent: Number(fields[1]), startTime: fields[19], token: `${bootId}:${fields[19]}`, group: Number(fields[2]), session: Number(fields[3]), state: fields[0] };
    } catch { return null; }
}
export const identity = pid => processInfo(pid)?.token ?? null;
// An extant, identity-matched member anchors the group even after its leader exits.
export function ownedGroupAlive(job) {
    if (!bootId || !pidNamespace || !localIdentity(job) || !Number.isInteger(job.child) || job.child <= 1) return false;
    const leader = processInfo(job.child);
    const owner = processInfo(job.owner);
    const verifiedOwner = owner && [owner.startTime, owner.token].includes(job.ownerToken) && owner.state !== 'Z';
    if (!job.childToken && verifiedOwner && leader?.parent === job.owner && leader.group === job.child && leader.session === job.child) job.childToken = leader.token;
    if (leader && leader.token !== job.childToken) return false;
    const anchored = leader?.token === job.childToken || (job.members || []).some(m => {
        const info = processInfo(m.pid);
        return info?.token === m.token && info.group === job.child && info.session === job.child;
    });
    if (!anchored) return false;
    job.members = fs.readdirSync('/proc').filter(p => /^\d+$/.test(p)).flatMap(p => {
        const info = processInfo(Number(p));
        return info?.group === job.child && info.session === job.child && info.state !== 'Z' ? [{ pid: Number(p), token: info.token }] : [];
    });
    return job.members.length > 0;
}
export function signalOwnedGroup(job, signal, io = { owned: ownedGroupAlive, kill: process.kill.bind(process) }) {
    if (!bootId || !pidNamespace || !Number.isInteger(job.child) || job.child <= 1 || !job.childToken) return false;
    const owned = io.owned ? io.owned(job) : io.identity(job.child) === job.childToken;
    if (!owned) return false;
    try { io.kill(-job.child, signal); return true; }
    catch (error) { if (['ESRCH', 'EPERM'].includes(error.code)) return false; throw error; }
}
export const stopOwned = signalOwnedGroup;
