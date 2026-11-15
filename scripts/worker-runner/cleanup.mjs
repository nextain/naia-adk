import fs from 'node:fs';
import path from 'node:path';

function ancestors(target) {
    if (target.split(path.sep).includes('..')) throw Error('Cleanup traversal rejected');
    let current = path.parse(target).root;
    for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        try { if (fs.lstatSync(current).isSymbolicLink()) throw Error('Cleanup symlink rejected'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
}

// Pin the inode before changing its mode. O_PATH also opens mode-000 objects
// on Linux; chmod through procfs then addresses that descriptor, not a new path.
function restoreMode(target, stat, mode) {
    let fd;
    try {
        try { fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (stat.isDirectory() ? fs.constants.O_DIRECTORY : 0)); }
        catch (error) {
            if (process.platform !== 'linux' || !['EACCES', 'EPERM'].includes(error.code)) throw error;
            fd = fs.openSync(target, 0x200000 | fs.constants.O_NOFOLLOW);
        }
        const actual = fs.fstatSync(fd);
        if (actual.dev !== stat.dev || actual.ino !== stat.ino || actual.isSymbolicLink() || (actual.isFile() && (actual.nlink !== 1 || actual.uid !== process.getuid()))) throw Error('Cleanup inode changed');
        try { fs.fchmodSync(fd, mode); }
        catch (error) {
            if (process.platform !== 'linux' || error.code !== 'EBADF') throw error;
            fs.chmodSync(`/proc/self/fd/${fd}`, mode);
        }
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function removeOwnedRoot(root, job, runs) {
    if (root.split(path.sep).includes('..')) throw Error('Cleanup traversal rejected');
    root = path.resolve(root);
    ancestors(root);
    let stat;
    try { stat = fs.lstatSync(root); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Unowned cleanup root');
    const rootFd = fs.openSync(root, (process.platform === 'linux' ? 0x200000 : fs.constants.O_RDONLY)
        | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
        const pinned = fs.fstatSync(rootFd);
        if (pinned.dev !== stat.dev || pinned.ino !== stat.ino) throw Error('Cleanup root inode changed');
        const anchoredRoot = process.platform === 'linux' ? `/proc/self/fd/${rootFd}/.` : root;
        const conventional = job?.tempRoot === root && job?.tempBase && path.dirname(root) === job.tempBase;
        if (conventional) {
            if (stat.uid !== process.getuid()) throw Error('Unowned cleanup root');
            restoreMode(root, stat, stat.mode | 0o700);
            const marker = path.join(anchoredRoot, '.worker-runner-owner');
            let markerStat;
            try { markerStat = fs.lstatSync(marker); }
            catch (error) { if (error.code === 'ENOENT') throw Error('Unowned cleanup marker'); throw error; }
            if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink !== 1 || markerStat.uid !== process.getuid()) throw Error('Unowned cleanup marker');
            restoreMode(marker, markerStat, 0o600);
            const fd = fs.openSync(marker, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            try {
                const actual = fs.fstatSync(fd);
                if (actual.ino !== markerStat.ino || actual.dev !== markerStat.dev || actual.nlink !== 1 || fs.readFileSync(fd, 'utf8') !== job.tempToken) throw Error('Unowned cleanup root');
            } finally { fs.closeSync(fd); }
        } else if (path.dirname(root) !== runs || !path.basename(root).startsWith('attempt-')) throw Error('Unowned cleanup root');
        const repair = (target, depth = 0) => {
            // Limit live descriptors even if a worker constructs a deeply nested tree.
            if (depth >= 128) return;
            let fd;
            try {
                const flags = (process.platform === 'linux' ? 0x200000 : fs.constants.O_RDONLY)
                    | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
                fd = fs.openSync(target, flags);
                const entry = fs.fstatSync(fd);
                const anchored = process.platform === 'linux' ? `/proc/self/fd/${fd}` : target;
                try {
                    try { fs.fchmodSync(fd, entry.mode | 0o700); }
                    catch (error) {
                        if (process.platform !== 'linux' || error.code !== 'EBADF') throw error;
                        fs.chmodSync(anchored, entry.mode | 0o700);
                    }
                } catch { /* foreign parents may contain our own locked children */ }
                for (const child of fs.readdirSync(anchored, { withFileTypes: true })) {
                    if (!child.isDirectory()) continue;
                    try { repair(path.join(anchored, child.name), depth + 1); }
                    catch { /* keep repairing accessible siblings */ }
                }
            } finally { if (fd !== undefined) fs.closeSync(fd); }
        };
        for (let attempt = 0; ; attempt++) {
            try { repair(anchoredRoot); } catch { /* rm determines whether cleanup succeeded */ }
            try {
                const current = fs.lstatSync(root);
                if (current.isSymbolicLink() || current.dev !== pinned.dev || current.ino !== pinned.ino) throw Error('Cleanup root inode changed');
                fs.rmSync(root, { recursive: true, force: true, maxRetries: attempt === 0 ? 5 : 0, retryDelay: 100 });
                return;
            } catch (error) {
                // A detached writer can invalidate rimraf's listing. Bound fresh
                // walks without adding sleeps beyond rm's own retry backoff.
                if (error.code !== 'ENOTEMPTY' || attempt >= 1) throw error;
            }
        }
    } finally { fs.closeSync(rootFd); }
}
