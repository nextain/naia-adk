// The payload cannot run until its process-group ID has been committed to state.
import fs from 'node:fs';
import os from 'node:os';
import { launchAuthorized } from './core.mjs';
import { spawn } from 'node:child_process';
import { processInfo } from './process.mjs';
const [stateFile, id, root, ...command] = process.argv.slice(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let authorized = false;
for (let n = 0; n < 200; n++) {
    try {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        const job = state.jobs.find(j => j.id === id && j.root === root);
        if (!job || !['running', 'stopping'].includes(job.status))
            break;
        if (launchAuthorized(state, process.pid, id, root)) {
            authorized = true;
            break;
        }
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    await sleep(50);
}
if (authorized) {
    const child = spawn(command[0], command.slice(1), { stdio: 'inherit' });
    child.once('error', error => { console.error(error.message); process.exitCode = 1; });
    // Keep the identity-anchoring leader alive until every inherited group member is gone.
    // A payload may exit successfully while leaving a background writer behind.
    const members = () => fs.readdirSync('/proc').filter(p => /^\d+$/.test(p) && Number(p) !== process.pid).map(Number).filter(pid => {
        const info = processInfo(pid);
        return info?.group === process.pid && info.session === process.pid && info.state !== 'Z';
    });
    process.on('SIGTERM', () => { /* supervisor signals the whole group; retain the leader until cleanup */ });
    child.once('exit', async (code, signal) => {
        const started = Date.now();
        while (members().length) {
            for (const pid of members()) {
                const info = processInfo(pid);
                if (info?.group !== process.pid || info.session !== process.pid) continue;
                try { process.kill(pid, Date.now() - started >= 1000 ? 'SIGKILL' : 'SIGTERM'); } catch (error) { if (!['ESRCH', 'EPERM'].includes(error.code)) throw error; }
            }
            await sleep(25);
        }
        process.exitCode = code ?? (signal ? 128 + os.constants.signals[signal] : 1);
    });
}
else
    process.exitCode = 1;
