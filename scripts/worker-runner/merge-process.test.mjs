import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

for (const unavailable of ['boot', 'namespace']) {
    test(`A-1 missing local ${unavailable} identity fails closed for legacy child`, async () => {
        const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
        const exited = once(child, 'exit');
        await once(child, 'spawn');
        const originalRead = fs.readFileSync, originalLink = fs.readlinkSync;
        try {
            fs.readFileSync = function (p, ...args) { if (unavailable === 'boot' && p === '/proc/sys/kernel/random/boot_id') throw Error('unavailable'); return originalRead.call(this, p, ...args); };
            fs.readlinkSync = function (p, ...args) { if (unavailable === 'namespace' && p === '/proc/self/ns/pid') throw Error('unavailable'); return originalLink.call(this, p, ...args); };
            const mod = await import(`./process.mjs?missing=${unavailable}`);
            fs.readFileSync = originalRead; fs.readlinkSync = originalLink;
            const job = { child: child.pid, owner: process.pid, ownerToken: mod.processInfo(process.pid).startTime };
            assert.equal(mod.ownedGroupAlive(job), false, 'legacy ownership cannot be upgraded without local identity');
            job.childToken = mod.identity(child.pid);
            let sent = false;
            assert.equal(mod.signalOwnedGroup(job, 'SIGKILL', { owned: () => true, kill: () => { sent = true; } }), false);
            assert.equal(sent, false);
        } finally {
            fs.readFileSync = originalRead; fs.readlinkSync = originalLink;
            child.kill('SIGTERM'); await exited;
        }
    });
}
