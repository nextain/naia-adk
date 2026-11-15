// The payload cannot run until its process-group ID has been committed to state.
import fs from 'node:fs';
import { launchAuthorized } from './core.mjs';
import { spawn } from 'node:child_process';
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
    child.once('exit', (code) => { process.exitCode = code ?? 1; });
}
else
    process.exitCode = 1;
