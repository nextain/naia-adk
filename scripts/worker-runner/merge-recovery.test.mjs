import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
const cli = new URL('./cli.mjs', import.meta.url).pathname;

test('dead supervisor stale recycled child group cannot kill an unrelated fixture process', async () => {
    const root = fs.mkdtempSync(path.join(tmpdir(), 'runner-stale-group-'));
    const child = spawn('/bin/sleep', ['20'], { detached: true, stdio: 'ignore' });
    const exited = new Promise(resolve => child.once('exit', resolve));
    try {
        const state = path.join(root, 'state'); fs.mkdirSync(state);
        fs.writeFileSync(path.join(state, 'state.json'), JSON.stringify({ version: 1, sequence: 1, jobs: [{
            id: 'stale', owner: 99999999, ownerToken: 'dead', status: 'running',
            child: child.pid, childToken: 'stale', budget: 1024, remaining: 1024,
        }] }));
        const r = spawnSync(process.execPath, [cli, 'status', '--state-dir', state], { encoding: 'utf8', timeout: 10000 });
        assert.equal(r.status, 0, r.stderr);
        const stat = fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8');
        assert.notEqual(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0], 'Z', 'stale child PID must never authorize a signal');
    } finally {
        // This is the child created by this test; never signal a supplied PID/group.
        child.kill('SIGKILL'); await exited;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('foreign group EPERM cannot abort a healthy supervisor or authorize a signal', () => {
    const root = fs.mkdtempSync(path.join(tmpdir(), 'runner-eperm-group-'));
    try {
        const state = path.join(root, 'state'); fs.mkdirSync(state);
        const preload = path.join(root, 'eperm.cjs'), attempts = path.join(root, 'attempts'), result = path.join(root, 'result');
        fs.writeFileSync(preload, `const fs = require('node:fs');
            const original = process.kill.bind(process);
            process.kill = (pid, signal) => {
                if (pid === -888888) {
                    if (signal !== 0) fs.appendFileSync(${JSON.stringify(attempts)}, String(signal));
                    throw Object.assign(Error('fixture foreign group denied'), { code: 'EPERM' });
                }
                return original(pid, signal);
            };`);
        fs.writeFileSync(path.join(state, 'state.json'), JSON.stringify({ version: 1, sequence: 1, jobs: [{
            id: 'foreign', owner: 99999999, ownerToken: 'dead', status: 'running', child: 888888,
            budget: 1024, remaining: 1024,
        }] }));
        const r = spawnSync(process.execPath, ['--require', preload, cli, 'run', '--id', 'healthy', '--state-dir', state,
            '--work-dir', root, '--temp-base', root, '--budget', '1M', '--floor', '1K', '--poll-ms', '30', '--',
            '/bin/sh', '-c', 'echo survived > "$1"', 'fixture', result], { encoding: 'utf8', timeout: 10000 });
        assert.equal(r.status, 0, r.stderr);
        assert.equal(fs.readFileSync(result, 'utf8').trim(), 'survived');
        assert.equal(fs.existsSync(attempts), false, 'identity failure must prevent a destructive signal attempt');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
