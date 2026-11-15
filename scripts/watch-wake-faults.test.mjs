import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, utimes, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  acquirePidLock,
  acquirePidLockSync,
  inspectLockOwner,
  parseLockRecord,
} from './lib/pid-lock.mjs';
import {
  collectWorkerDiskPaths,
  measureMinFreeBytesSync,
  measureMinFreeGb,
} from './lib/disk-free.mjs';
import { registerWorker, watchWorkers } from './work-watch.mjs';
import { spawnWorker } from './worker-runner/spawn-worker.mjs';
import { runWatcherUnitHealth } from './watcher-unit-health.mjs';
import { runWatch as runResponseWatch } from './response-watch.mjs';
import { runHealth as runSessionHealth } from './session-health.mjs';
import { runWatch as runAgentRequestWatch } from './agent-request-watch.mjs';
import { recordSchedule, serializeLedgerYaml } from './lib/ledger.mjs';
import { publish as publishAdvisory, consume as consumeAdvisory } from './lib/security-advisory.mjs';
import { main as ledgerCli, readLedger } from './work-ledger/ledger.mjs';
import { watch as runLedgerWatch } from './work-ledger/ledger-watch.mjs';
import { start as driveStart } from './work-ledger/drive.mjs';

const require = createRequire(import.meta.url);
const { checkDetachedWorkerCommand } = require('../.claude/hooks/lib/effective-argv.js');
const { detachedWorker } = require('../.agents/hooks/policies/bash.js');
const { withSession } = require('../templates/claude-user-profile/hooks/cost-guard-state.cjs');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const createdDirs = [];
test.after(async () => {
  await Promise.all(createdDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix = 'watch-wake-fault-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

function exitedChildPid() {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
    encoding: 'utf8',
  });
  const pid = Number(String(child.stdout || '').trim());
  assert.ok(Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  return pid;
}

test('fault 1a: pid-lock recovers dead-PID, recycled-start, boot-mismatch, and stale legacy locks while blocking live PIDs', async () => {
  const dir = await makeTempDir();
  const lockPath = path.join(dir, 'state.json.lock');
  const deadPid = exitedChildPid();

  // 1) Dead PID lock -> immediately quarantined into .recovered-locks/ + logged in recovery.jsonl.
  const deadRaw = `${JSON.stringify({ pid: deadPid, started: '2026-11-13T08:59:42.000Z' })}\n`;
  await writeFile(lockPath, deadRaw);
  const inspected = inspectLockOwner(parseLockRecord(deadRaw), Date.now());
  assert.equal(inspected.alive, false);
  assert.equal(inspected.reason, 'dead-pid');

  const recoveredEvents = [];
  const handle = await acquirePidLock(lockPath, {
    onRecover: (rec) => recoveredEvents.push(rec),
  });
  assert.equal(recoveredEvents.length, 1);
  assert.equal(recoveredEvents[0].deadPid, deadPid);
  assert.equal(recoveredEvents[0].reason, 'dead-pid');

  // Live owner lock MUST reject concurrent acquisition with EEXIST.
  assert.throws(() => acquirePidLockSync(lockPath), /EEXIST/);
  await assert.rejects(() => acquirePidLock(lockPath), /EEXIST/);
  await handle.release();

  // Quarantined lock file and recovery.jsonl audit entry exist.
  const quarantineDir = path.join(dir, '.recovered-locks');
  const quarantinedEntries = await readdir(quarantineDir);
  assert.ok(quarantinedEntries.some((name) => name.includes(`.dead-${deadPid}-`)));
  const recoveryLog = (await readFile(path.join(quarantineDir, 'recovery.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(recoveryLog.length, 1);
  assert.equal(recoveryLog[0].deadPid, deadPid);
  assert.equal(recoveryLog[0].recoveredByPid, process.pid);

  // 2) Boot ID mismatch even with live PID -> treated as dead pre-reboot lock and recovered.
  await writeFile(
    lockPath,
    `${JSON.stringify({ pid: process.pid, boot: '00000000-0000-0000-0000-000000000000' })}\n`,
  );
  const bootRecovered = acquirePidLockSync(lockPath);
  bootRecovered.release();

  // 3) Legacy pid-less lock: fresh (<30s) fails closed with EEXIST; stale (>30s) recovers cleanly.
  await writeFile(lockPath, 'legacy-no-pid\n');
  await assert.rejects(() => acquirePidLock(lockPath), /EEXIST/);
  const staleSec = (Date.now() - 45_000) / 1000;
  await utimes(lockPath, staleSec, staleSec);
  const legacyRecovered = await acquirePidLock(lockPath);
  await legacyRecovered.release();

  const updatedLog = (await readFile(path.join(quarantineDir, 'recovery.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(updatedLog.length, 3);
  assert.deepEqual(
    updatedLog.map((r) => r.reason),
    ['dead-pid', 'boot-mismatch', 'stale-pidless-lock'],
  );
});

test('fault 1b: dead-PID .lock self-heals across response-watch, session-health, agent-request-watch, ledger, security-advisory, cost-guard, and work-watch', async () => {
  const dir = await makeTempDir();
  const deadPid = exitedChildPid();
  const seedDeadLock = (file) =>
    writeFile(`${file}.lock`, `${JSON.stringify({ pid: deadPid, started: '2026-11-13T08:59:42Z' })}\n`);

  // (i) response-watch.mjs
  const rwDir = path.join(dir, 'rw');
  await mkdir(rwDir, { recursive: true });
  const rwStateFile = path.join(rwDir, 'state.json');
  await seedDeadLock(rwStateFile);
  const rwEvents = [];
  const rwState = await runResponseWatch(
    {
      stateFile: rwStateFile,
      guilds: [{ id: '10', defaultBotId: '20', channels: [{ id: '30', mode: 'all-human' }], nudgeChannelId: '31', escalation: { channelId: '32', userId: '41' } }],
    },
    {
      token: 'tok',
      now: Date.parse('2026-11-15T06:00:00Z'),
      log: (e) => rwEvents.push(e),
      fetchImpl: async (url) => {
        if (String(url).endsWith('/channels/30')) return { ok: true, json: async () => ({ guild_id: '10' }) };
        return { ok: true, json: async () => [] };
      },
    },
  );
  assert.equal(rwState.lastRun.result, 'complete');
  assert.ok(rwEvents.some((e) => e.stage === 'lock' && e.result === 'recovered' && e.deadPid === deadPid));

  // (ii) session-health.mjs
  const shDir = path.join(dir, 'sh');
  const shRepo = path.join(shDir, 'repo');
  await mkdir(path.join(shRepo, '.agents/context'), { recursive: true });
  await mkdir(path.join(shRepo, '.claude'), { recursive: true });
  await writeFile(path.join(shRepo, 'AGENTS.md'), 'rules\n');
  await writeFile(path.join(shRepo, '.agents/context/agents-rules.json'), '{}');
  await writeFile(path.join(shRepo, '.claude/settings.json'), '{"hooks":{}}');
  await writeFile(path.join(shRepo, 'work.md'), 'done\n');
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  execFileSync('git', ['-C', shRepo, 'init', '-q'], { env: gitEnv });
  execFileSync('git', ['-C', shRepo, 'add', '.'], { env: gitEnv });
  execFileSync('git', ['-C', shRepo, 'commit', '-qm', 'init'], { env: gitEnv });
  const headSha = execFileSync('git', ['-C', shRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const snapFile = path.join(shDir, 'win.json');
  await writeFile(snapFile, JSON.stringify({ windows: [{ name: 'w', aiRunning: true, output: 'ok' }] }));
  const shStateFile = path.join(shDir, 'state.json');
  await seedDeadLock(shStateFile);
  const shEvents = [];
  const shRes = await runSessionHealth(
    {
      stateFile: shStateFile,
      reportFile: path.join(shDir, 'report.md'),
      baselineRepo: shRepo,
      baselineSha: headSha,
      roles: [{ id: 'ops', botId: '20', window: 'w', workspace: shRepo, workFiles: [path.join(shRepo, 'work.md')], adapter: { kind: 'snapshot', path: snapFile } }],
    },
    { now: Date.parse('2026-11-15T06:00:00Z'), log: (e) => shEvents.push(e) },
  );
  assert.equal(shRes.rows[0].alive, 'alive');
  assert.ok(shEvents.some((e) => e.stage === 'lock_recovered' && e.deadPid === deadPid));

  // (iii) agent-request-watch.mjs
  const arwDir = path.join(dir, 'arw');
  await mkdir(arwDir, { recursive: true });
  const arwStateFile = path.join(arwDir, 'state.json');
  await writeFile(arwStateFile, JSON.stringify({ version: 1, channels: {}, errors: {} }));
  await seedDeadLock(arwStateFile);
  await runAgentRequestWatch(
    {
      roles: [{ id: 'a', botId: '1', aliases: ['갑'] }, { id: 'ops', botId: '3', aliases: ['운영'] }],
      stateFile: arwStateFile,
      sessionHealthConfig: path.join(arwDir, 'health.json'),
      recovery: { roleId: 'ops' },
      guilds: [{ id: '10' }],
      timezoneOffsetMinutes: 540,
    },
    {
      token: 'tok',
      now: Date.parse('2026-11-15T06:00:00Z'),
      log() {},
      healthProbe: async () => [{ role: 'a', alive: 'alive' }],
      fetchImpl: async (url) => {
        if (String(url).endsWith('/threads/active')) return { ok: true, json: async () => ({ threads: [] }) };
        if (String(url).endsWith('/guilds/10/channels')) return { ok: true, json: async () => [] };
        return { ok: true, json: async () => [] };
      },
    },
  );
  assert.ok((await readdir(path.join(arwDir, '.recovered-locks'))).includes('recovery.jsonl'));

  // (iv) scripts/lib/ledger.mjs & security-advisory.mjs
  const schedDir = path.join(dir, 'sched');
  await mkdir(schedDir, { recursive: true });
  const schedFile = path.join(schedDir, 'schedule.yaml');
  await writeFile(
    schedFile,
    serializeLedgerYaml({
      version: 1,
      timezone: 'UTC',
      schedules: [{ id: 'job', role: 'ops', task: 'Check', cadence: 'daily', time: '06:00', status: '있음', mechanism: { kind: 'timer', target: 't', timer: null }, approval: null, last_result: { at: null, outcome: 'not-run', evidence: null } }],
    }),
  );
  await seedDeadLock(schedFile);
  await recordSchedule(schedFile, 'job', 'success', { now: Date.parse('2026-11-15T06:01:00Z') });

  const advDir = path.join(dir, 'adv');
  await mkdir(advDir, { recursive: true });
  const advWorkFile = path.join(advDir, 'work.yaml');
  const advAssetsFile = path.join(advDir, 'assets.json');
  await writeFile(advWorkFile, 'version: 1\nwork: []\n');
  await writeFile(advAssetsFile, JSON.stringify({ assets: [{ ecosystem: 'npm', name: 'pkg', version: '1.0.0' }] }));
  const advConfig = {
    shared: { directory: path.join(advDir, 'shared') },
    role: 'ops',
    workLedger: advWorkFile,
    assets: { files: [advAssetsFile], lockfiles: [], osCommands: [] },
  };
  await publishAdvisory(advConfig, {
    schemaVersion: 1,
    id: 'CVE-2026-9999',
    sourceUrl: 'https://example.com/cve',
    affected: [{ ecosystem: 'npm', name: 'pkg', versions: ['1.0.0'] }],
    severity: 'high',
    action: 'Upgrade pkg',
    dueAt: '2026-11-20T00:00:00Z',
  });
  await seedDeadLock(advWorkFile);
  const consumed = await consumeAdvisory(advConfig);
  assert.equal(consumed[0].status, 'added');

  // (v) cost-guard-state.cjs withSession
  const cgDir = path.join(dir, 'cg');
  await mkdir(cgDir, { recursive: true, mode: 0o700 });
  const firstCg = withSession(cgDir, 'sess-1', (s) => {
    s.turn = 1;
    return 'ok';
  });
  assert.equal(firstCg.status, 'known');
  const sessionJsonFile = (await readdir(cgDir)).find((n) => n.endsWith('.json'));
  await seedDeadLock(path.join(cgDir, sessionJsonFile));
  const recoveredCg = withSession(cgDir, 'sess-1', (s) => {
    s.turn = 2;
    return s.turn;
  });
  assert.equal(recoveredCg.status, 'known');
  assert.equal(recoveredCg.value, 2);
  // Live PID lock returns state_busy instead of clobbering.
  await writeFile(path.join(cgDir, `${sessionJsonFile}.lock`), `${JSON.stringify({ pid: process.pid })}\n`);
  assert.equal(withSession(cgDir, 'sess-1', () => 'nope').reason, 'state_busy');

  // (vi) work-watch.mjs registry lock
  const wwDir = path.join(dir, 'ww');
  await mkdir(wwDir, { recursive: true });
  const regFile = path.join(wwDir, 'registry.json');
  await seedDeadLock(regFile);
  const wwRes = await watchWorkers({ root: wwDir, registryFile: regFile });
  assert.equal(wwRes.checked, 0);
  assert.ok((await readdir(path.join(wwDir, '.recovered-locks'))).includes('recovery.jsonl'));
});

test('fault 2a: spawn-worker auto-registers into work-watch; work-watch wakes role on stall, unit death, and result completion', async () => {
  const root = await makeTempDir('work-watch-fault-');
  const workDir = path.join(root, 'run-a');
  const wakeDir = path.join(root, 'wake');
  const registryFile = path.join(root, '.agents/work/work-watch/registry.json');
  const resultFile = path.join(workDir, 'result.md');
  const t0 = Date.parse('2026-11-15T06:00:00Z');

  let capturedSystemdArgs = null;
  const spawned = await spawnWorker(
    [
      '--root',
      root,
      '--id',
      'fix-a2',
      '--role',
      'infra',
      '--work-dir',
      workDir,
      '--wake-dir',
      wakeDir,
      '--result-file',
      resultFile,
      '--stall-min',
      '10',
      '--',
      'codex',
      'exec',
      'fix issue',
    ],
    {
      now: t0,
      execFileSyncImpl: () =>
        'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 100000000 50000000 20971520 50% /\n',
      systemdRunImpl: (args) => {
        capturedSystemdArgs = args;
        return '';
      },
    },
  );
  assert.equal(spawned.mode, 'systemd');
  assert.equal(spawned.unit, 'infra-worker-fix-a2.service');
  assert.ok(capturedSystemdArgs.includes('--unit=infra-worker-fix-a2.service'));

  const regAfterSpawn = JSON.parse(await readFile(registryFile, 'utf8'));
  assert.equal(regAfterSpawn.workers.length, 1);
  assert.equal(regAfterSpawn.workers[0].role, 'infra');
  assert.equal(regAfterSpawn.workers[0].resultFile, resultFile);

  // 1) 10 minutes with NO output progress while unit is active -> wakes spawning role ('stall').
  const stallCheck = await watchWorkers({
    root,
    registryFile,
    now: t0 + 10 * 60_000,
    unitProbe: async () => ({
      ok: true,
      loadState: 'loaded',
      activeState: 'active',
      subState: 'running',
      result: 'success',
      execMainStatus: null,
    }),
  });
  assert.deepEqual(stallCheck.stalled, ['fix-a2']);
  assert.equal(stallCheck.wakes.length, 1);
  assert.equal(stallCheck.wakes[0].reason, 'stall');
  assert.match(await readFile(stallCheck.wakes[0].wakeFile, 'utf8'), /\[일꾼 감시\] 진도 없음: fix-a2/);

  // Progress file written inside watchDir clears stalled state.
  const draftFile = path.join(workDir, 'draft.txt');
  await writeFile(draftFile, 'step 1 complete\n');
  const progressTime = t0 + 12 * 60_000;
  await utimes(draftFile, progressTime / 1000, progressTime / 1000);
  const progressedCheck = await watchWorkers({
    root,
    registryFile,
    now: progressTime,
    unitProbe: async () => ({
      ok: true,
      loadState: 'loaded',
      activeState: 'active',
      subState: 'running',
      result: 'success',
      execMainStatus: null,
    }),
  });
  assert.deepEqual(progressedCheck.stalled, []);
  assert.equal(progressedCheck.wakes.length, 0);

  // 2) Result file created (>0 bytes) -> marks worker 'done' and wakes spawning role ('done').
  await writeFile(resultFile, '끝: PR #999 abcdef1\n');
  const doneCheck = await watchWorkers({
    root,
    registryFile,
    now: t0 + 15 * 60_000,
    unitProbe: async () => ({
      ok: true,
      loadState: 'loaded',
      activeState: 'inactive',
      subState: 'dead',
      result: 'success',
      execMainStatus: 0,
    }),
  });
  assert.deepEqual(doneCheck.completed, ['fix-a2']);
  assert.equal(doneCheck.wakes.length, 1);
  assert.equal(doneCheck.wakes[0].reason, 'done');
  assert.match(await readFile(doneCheck.wakes[0].wakeFile, 'utf8'), /\[일꾼 감시\] 일꾼 끝: fix-a2/);

  // 3) Second worker whose systemd unit dies/fails without creating resultFile -> wakes spawning role ('dead').
  const deadResultFile = path.join(root, 'run-b/result.md');
  await registerWorker({
    root,
    registryFile,
    id: 'crash-b1',
    unit: 'infra-worker-crash-b1.service',
    role: 'infra',
    wakeDir,
    resultFile: deadResultFile,
    watchDirs: [path.dirname(deadResultFile)],
    stallMinutes: 15,
    now: t0 + 20 * 60_000,
  });
  const deadCheck = await watchWorkers({
    root,
    registryFile,
    now: t0 + 21 * 60_000,
    unitProbe: async () => ({
      ok: true,
      loadState: 'loaded',
      activeState: 'failed',
      subState: 'failed',
      result: 'exit-code',
      execMainStatus: 1,
    }),
  });
  assert.deepEqual(deadCheck.dead, ['crash-b1']);
  assert.equal(deadCheck.wakes.length, 1);
  assert.equal(deadCheck.wakes[0].reason, 'dead');
  assert.match(await readFile(deadCheck.wakes[0].wakeFile, 'utf8'), /\[일꾼 감시\] 유닛 죽음: crash-b1/);
});

test('fault 2b: PreToolUse guards block nohup/setsid/&/tmux -d/screen -dm launches of agy, codex, claude -p, and muse exec across hooks', async () => {
  const blockedCommands = [
    'nohup codex exec "fix bug" > /tmp/out.log 2>&1 &',
    'setsid claude -p "implement feature" > out.txt',
    'cd /tmp && agy "solve issue" &',
    'muse exec --prompt "analyze" &',
    'tmux new-session -d -s worker1 "codex exec run"',
    'screen -dmS worker2 claude --print "hello"',
  ];

  for (const cmd of blockedCommands) {
    const det = checkDetachedWorkerCommand(cmd);
    assert.ok(det && det.worker && det.detach, `expected checkDetachedWorkerCommand to flag: ${cmd}`);
    const pol = detachedWorker(cmd);
    assert.ok(pol && pol.reason, `expected bash policy detachedWorker to block: ${cmd}`);
    assert.match(pol.reason, /spawn-worker\.mjs/);
  }

  // Verify real hook CLI processes (lead-write-guard.js & session-contract-gate.cjs) deny with exit 2 / block decision.
  const leadGuard = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, '.claude/hooks/lead-write-guard.js')],
    {
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'nohup codex exec "task" &' },
      }),
      encoding: 'utf8',
    },
  );
  assert.equal(leadGuard.status, 0);
  const leadDecision = JSON.parse(leadGuard.stdout);
  assert.equal(leadDecision.decision, 'block');
  assert.match(leadDecision.reason, /spawn-worker\.mjs/);

  const codexGate = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, '.codex/hooks/session-contract-gate.cjs')],
    {
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'setsid muse exec "task"' },
      }),
      encoding: 'utf8',
    },
  );
  assert.equal(codexGate.status, 0);
  const codexDecision = JSON.parse(codexGate.stdout);
  assert.equal(codexDecision.decision, 'block');
  assert.match(codexDecision.reason, /spawn-worker\.mjs/);

  // Standard spawn-worker.mjs command and foreground commands MUST be allowed.
  const allowedCmd =
    'node scripts/worker-runner/spawn-worker.mjs --id w1 --role ops --result-file /tmp/res.md -- codex exec "task"';
  assert.equal(checkDetachedWorkerCommand(allowedCmd), null);
  assert.equal(detachedWorker(allowedCmd), null);
  assert.equal(checkDetachedWorkerCommand('claude --version'), null);
});

test('fault 3: watcher-unit-health wakes role on failed or N consecutive failures and escalates to CEO after >2 streak', async () => {
  const dir = await makeTempDir('watcher-unit-fault-');
  const wakeDir = path.join(dir, 'wake');
  const stateFile = path.join(dir, 'watcher-state.json');
  const candidatesFile = path.join(dir, 'ceo-escalation-candidates.json');
  const t0 = Date.parse('2026-11-15T06:00:00Z');
  const discordPosts = [];

  const config = {
    role: 'infra',
    wakeDir,
    stateFile,
    candidatesFile,
    failureThreshold: 2,
    escalationAfterStreak: 2,
    repeatMinutes: 30,
    escalation: { channelId: '9001', userId: '7777' },
  };

  let unitSnapshot = [
    // Immediate failed state -> wakes on check #1
    {
      unit: 'minho-ext-agent-watch.service',
      loadState: 'loaded',
      activeState: 'failed',
      subState: 'failed',
      result: 'exit-code',
      execMainStatus: 1,
      nRestarts: 0,
    },
    // Oneshot exiting 1 (inactive/exit-code) -> wakes at streak=2, escalates at streak=3 (>2)
    {
      unit: 'naia-l4-watch.service',
      loadState: 'loaded',
      activeState: 'inactive',
      subState: 'dead',
      result: 'exit-code',
      execMainStatus: 1,
      nRestarts: 0,
    },
    // Transient worker unit must be ignored by watcher-unit-health
    {
      unit: 'minho-worker-abc.service',
      loadState: 'loaded',
      activeState: 'failed',
      subState: 'failed',
      result: 'exit-code',
      execMainStatus: 1,
      nRestarts: 0,
    },
  ];

  const fetchImpl = async (_url, init) => {
    discordPosts.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ id: `msg-${discordPosts.length}` }) };
  };

  // Check #1 (streak = 1): minho-ext-agent-watch (activeState=failed) wakes immediately; naia-l4-watch (inactive) waits for N=2.
  const r1 = await runWatcherUnitHealth(config, {
    now: t0,
    token: 'bot-token',
    fetchImpl,
    unitProbe: async () => unitSnapshot,
  });
  assert.equal(r1.degraded, true);
  assert.deepEqual(r1.wakes.map((w) => w.unit), ['minho-ext-agent-watch.service']);
  assert.equal(r1.escalations.length, 0);
  assert.equal(discordPosts.length, 0);

  // Check #2 (streak = 2 >= N): naia-l4-watch wakes role; still streak <= 2 so no CEO escalation yet.
  const r2 = await runWatcherUnitHealth(config, {
    now: t0 + 60_000,
    token: 'bot-token',
    fetchImpl,
    unitProbe: async () => unitSnapshot,
  });
  assert.deepEqual(r2.wakes.map((w) => w.unit), ['naia-l4-watch.service']);
  assert.equal(r2.escalations.length, 0);
  assert.equal(discordPosts.length, 0);

  // Check #3 (streak = 3 > 2): both units recorded in ceo-escalation-candidates.json AND sent via Discord escalation path!
  const r3 = await runWatcherUnitHealth(config, {
    now: t0 + 120_000,
    token: 'bot-token',
    fetchImpl,
    unitProbe: async () => unitSnapshot,
  });
  assert.equal(r3.escalations.length, 2);
  assert.equal(discordPosts.length, 2);
  assert.ok(discordPosts.every((p) => p.allowed_mentions.users.includes('7777')));
  const candidatesAfter3 = JSON.parse(await readFile(candidatesFile, 'utf8'));
  assert.equal(candidatesAfter3.candidates['naia-l4-watch.service'].streak, 3);
  assert.equal(candidatesAfter3.candidates['naia-l4-watch.service'].status, 'sent');
  assert.equal(candidatesAfter3.candidates['minho-ext-agent-watch.service'].status, 'sent');

  // Check #4 (streak = 4): already confirmed in episode -> no duplicate CEO spam.
  await runWatcherUnitHealth(config, {
    now: t0 + 180_000,
    token: 'bot-token',
    fetchImpl,
    unitProbe: async () => unitSnapshot,
  });
  assert.equal(discordPosts.length, 2);

  // Recovery: units succeed -> streak resets to 0 and candidates marked resolved.
  unitSnapshot = unitSnapshot.map((u) => ({
    ...u,
    activeState: 'inactive',
    subState: 'dead',
    result: 'success',
    execMainStatus: 0,
  }));
  const r5 = await runWatcherUnitHealth(config, {
    now: t0 + 240_000,
    token: 'bot-token',
    fetchImpl,
    unitProbe: async () => unitSnapshot,
  });
  assert.equal(r5.degraded, false);
  const candidatesAfterRecovery = JSON.parse(await readFile(candidatesFile, 'utf8'));
  assert.equal(candidatesAfterRecovery.candidates['naia-l4-watch.service'].status, 'resolved');
});

test('fault 4: work-ledger refuses >2 drops (including drop+recreate) and >2 due deferrals on human cards into escalated_human, and blocks reply-without-ledger closure', async () => {
  const root = await makeTempDir('ledger-fault-');
  const t0 = Date.parse('2026-11-15T06:00:00Z');
  const msgDrop = '1568971282698211489';

  // (a) Drop+recreate 3 times on same human msg_id -> 3rd drop refused & transitioned to escalated_human.
  await ledgerCli([
    'add', '--root', root, '--role', 'minho', '--id', 'dsk-1',
    '--title', '딥시크 검토 1', '--due', '2026-11-15T08:00:00Z', '--channel', 'ch-infra', '--msg-id', msgDrop,
  ]);
  await ledgerCli(['drop', '--root', root, '--role', 'minho', '--id', 'dsk-1', '--reason', '1차 취소']);

  await ledgerCli([
    'add', '--root', root, '--role', 'minho', '--id', 'dsk-2',
    '--title', '딥시크 검토 2', '--due', '2026-11-15T09:00:00Z', '--channel', 'ch-infra', '--msg-id', msgDrop,
  ]);
  await ledgerCli(['drop', '--root', root, '--role', 'minho', '--id', 'dsk-2', '--reason', '2차 취소']);

  await ledgerCli([
    'add', '--root', root, '--role', 'minho', '--id', 'dsk-3',
    '--title', '딥시크 검토 3', '--due', '2026-11-15T10:00:00Z', '--channel', 'ch-infra', '--msg-id', msgDrop,
  ]);
  await assert.rejects(
    () => ledgerCli(['drop', '--root', root, '--role', 'minho', '--id', 'dsk-3', '--reason', '3차 취소 시도']),
    /사람에게 올림/,
  );

  let ledger = await readLedger(root, 'minho');
  const card3 = ledger.items.find((i) => i.id === 'dsk-3');
  assert.equal(card3.status, 'escalated_human');
  const totalDropsForMsg = ledger.items
    .filter((i) => i.from?.msg_id === msgDrop)
    .reduce((sum, i) => sum + (i.drop_count || 0), 0);
  assert.equal(totalDropsForMsg, 3);

  // Attempting to open a 4th card for the same escalated human msg_id is refused.
  await assert.rejects(
    () =>
      ledgerCli([
        'add', '--root', root, '--role', 'minho', '--id', 'dsk-4',
        '--title', '딥시크 우회 재생성', '--due', '2026-11-15T11:00:00Z', '--channel', 'ch-infra', '--msg-id', msgDrop,
      ]),
    /이미 사람에게 올림\(escalated_human\) 상태인 사람 지시/,
  );

  // (b) Postponing due >2 times on a human card -> 3rd deferral refused & transitioned to escalated_human.
  const msgDefer = '1570862021191270512';
  await ledgerCli([
    'add', '--root', root, '--role', 'minho', '--id', 'defer-card',
    '--title', '기한 미룸 검증', '--due', '2026-11-15T07:00:00Z', '--channel', 'ch-infra', '--msg-id', msgDefer,
  ]);
  await ledgerCli(['due', '--root', root, '--role', 'minho', '--id', 'defer-card', '--due', '2026-11-15T08:00:00Z', '--reason', '1차 연기']);
  await ledgerCli(['due', '--root', root, '--role', 'minho', '--id', 'defer-card', '--due', '2026-11-15T09:00:00Z', '--reason', '2차 연기']);
  await assert.rejects(
    () => ledgerCli(['due', '--root', root, '--role', 'minho', '--id', 'defer-card', '--due', '2026-11-15T10:00:00Z', '--reason', '3차 연기']),
    /사람에게 올림/,
  );
  ledger = await readLedger(root, 'minho');
  assert.equal(ledger.items.find((i) => i.id === 'defer-card').status, 'escalated_human');

  // (c) ledger-watch wakes '사람에게 올림' for escalated cards AND still wakes '장부에 없는 사람 글' even if bot replied without recording a ledger card!
  const watchRes = await runLedgerWatch({
    root,
    now: t0,
    config: {
      roles: [
        {
          role: 'minho',
          channels: ['ch-infra'],
          human_ids: ['ceo-user'],
          user_ids: ['minho-bot'],
        },
      ],
    },
    adapter: {
      async messages() {
        return [
          {
            id: '5001',
            author_id: 'ceo-user',
            created_at: new Date(t0 - 10 * 60_000).toISOString(),
            body: '<@minho-bot> 이 지시 처리해줘',
            mentions: ['minho-bot'],
          },
          {
            id: '5002',
            author_id: 'minho-bot',
            reply_to_id: '5001',
            created_at: new Date(t0 - 9 * 60_000).toISOString(),
            body: '네 확인하겠습니다!',
          },
          {
            id: '5003',
            author_id: 'minho-bot',
            created_at: new Date(t0 - 8 * 60_000).toISOString(),
            body: '추가 안내입니다.',
          },
        ];
      },
    },
  });

  const reasonsById = new Map(watchRes.wakes.map((w) => [w.id, w.reason]));
  assert.equal(reasonsById.get('dsk-3'), '사람에게 올림');
  assert.equal(reasonsById.get('defer-card'), '사람에게 올림');
  assert.equal(reasonsById.get('human-5001'), '장부에 없는 사람 글');
});

test('fault 5: multi-mount disk floor blocks worker launch when root, home, cache, tmp is <5G even if work mount has 310G free', async () => {
  const dir = await makeTempDir('disk-floor-fault-');
  const fakeHome = path.join(dir, 'home');
  const fakeWork = path.join(dir, 'work');
  await mkdir(path.join(fakeHome, '.gemini'), { recursive: true });
  await mkdir(path.join(fakeHome, '.claude'), { recursive: true });
  await mkdir(path.join(fakeHome, '.cache'), { recursive: true });
  await mkdir(fakeWork, { recursive: true });

  const paths = collectWorkerDiskPaths([fakeWork], {
    homeDir: fakeHome,
    tmpDir: '/tmp',
    env: {},
  });
  assert.ok(paths.includes(fakeWork));
  assert.ok(paths.includes('/'));
  assert.ok(paths.includes(fakeHome));
  assert.ok(paths.includes(path.join(fakeHome, '.gemini')));
  assert.ok(paths.includes(path.join(fakeHome, '.claude')));
  assert.ok(paths.includes(path.join(fakeHome, '.cache')));
  assert.ok(paths.includes('/tmp'));

  // Simulate /dev/sdb1 (/srv/work) = 310G free while /dev/root (/) = 3.4G free.
  const simulatedDf = [
    'Filesystem 1024-blocks Used Available Capacity Mounted on',
    '/dev/sdb1 527433728 190000000 325058560 36% /srv/work',
    '/dev/root 258998272 255433112 3565160 99% /',
  ].join('\n');

  const minDisk = measureMinFreeBytesSync([fakeWork], {
    homeDir: fakeHome,
    env: {},
    execFileSyncImpl: () => simulatedDf,
  });
  assert.equal(minDisk.bottleneckMount, '/');
  assert.equal(minDisk.bytes, 3565160 * 1024);

  // (a) spawnWorker blocks before registration/launch when / is below 5G floor.
  await assert.rejects(
    () =>
      spawnWorker(
        [
          '--root',
          dir,
          '--id',
          'disk-blocked',
          '--role',
          'ops',
          '--work-dir',
          fakeWork,
          '--result-file',
          path.join(fakeWork, 'res.md'),
          '--floor',
          '5G',
          '--',
          'echo',
          'hi',
        ],
        {
          execFileSyncImpl: () => simulatedDf,
        },
      ),
    /Disk free space below floor.*on \//,
  );

  // (b) worker-runner/cli.mjs measures multi-mount freeBytes (bottleneck / = 3.4G) and refuses to schedule child (exits 124 on queue timeout).
  const binDir = path.join(dir, 'bin');
  await mkdir(binDir, { recursive: true });
  const fakeDfPath = path.join(binDir, 'df');
  await writeFile(
    fakeDfPath,
    `#!/bin/sh\nprintf '%s\\n' '${simulatedDf.replace(/\n/g, "' '")}'\n`,
  );
  await chmod(fakeDfPath, 0o755);

  const cliStatus = spawnSync(
    process.execPath,
    [
      path.join(REPO_ROOT, 'scripts/worker-runner/cli.mjs'),
      'status',
      '--state-dir',
      path.join(fakeWork, 'state'),
      '--work-dir',
      fakeWork,
    ],
    {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      encoding: 'utf8',
    },
  );
  assert.equal(cliStatus.status, 0);
  assert.equal(JSON.parse(cliStatus.stdout).freeBytes, 3565160 * 1024);

  const neverRanMarker = path.join(fakeWork, 'should-not-run.txt');
  const cliRun = spawnSync(
    process.execPath,
    [
      path.join(REPO_ROOT, 'scripts/worker-runner/cli.mjs'),
      'run',
      '--state-dir',
      path.join(fakeWork, 'state'),
      '--id',
      'cli-disk-blocked',
      '--work-dir',
      fakeWork,
      '--floor',
      '5G',
      '--timeout',
      '0.15',
      '--',
      process.execPath,
      '-e',
      `require("node:fs").writeFileSync(${JSON.stringify(neverRanMarker)}, "ran")`,
    ],
    {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      encoding: 'utf8',
    },
  );
  assert.equal(cliRun.status, 124);
  await assert.rejects(() => readFile(neverRanMarker, 'utf8'), /ENOENT/);

  // (c) measureMinFreeGb (used by work-ledger/drive.mjs freeGb) reflects low / mount.
  const minGb = await measureMinFreeGb([fakeWork], {
    homeDir: fakeHome,
    env: {},
    statfsImpl: async (target) => {
      if (String(target).startsWith(fakeWork)) {
        return { bavail: 310 * 262144, bsize: 4096 }; // 310 GiB
      }
      return { bavail: 2 * 262144, bsize: 4096 }; // 2 GiB on /, ~, /tmp
    },
  });
  assert.equal(minGb, 2);

  // Verify drive.mjs start() rejects when free space across worker mounts is below min_free_gb.
  const driveCfg = {
    roles: [{ role: 'ops', wake_dir: path.join(dir, 'wake') }],
    drive: {
      enabled: true,
      worker: { command: [process.execPath, '-e', 'process.exit(0)'], models: ['m1'] },
      disk: { path: fakeWork, min_free_gb: 5 },
      owner_ids: ['123456'],
    },
  };
  await mkdir(path.join(dir, 'config'), { recursive: true });
  await writeFile(path.join(dir, 'config/work-ledger.json'), JSON.stringify(driveCfg));
  const promptPath = path.join(fakeWork, 'prompt.md');
  await writeFile(promptPath, '# Task instruction\nDo the work.\n');
  await ledgerCli([
    'add', '--root', dir, '--role', 'ops', '--id', 'drive-low-disk',
    '--title', '드라이브 디스크 바닥선 시험', '--due', '2026-11-15T05:00:00Z',
    '--channel', 'ch', '--msg-id', '-',
    '--prompt', promptPath,
    '--result-file', path.join(fakeWork, 'drive-result.md'),
    '--model', 'm1',
  ]);
  const opsLedger = await readLedger(dir, 'ops');
  const driveItem = opsLedger.items.find((i) => i.id === 'drive-low-disk');
  await assert.rejects(
    () =>
      driveStart({
        root: dir,
        role: 'ops',
        item: driveItem,
        now: Date.parse('2026-11-15T06:00:00Z'),
        config: driveCfg,
        freeGb: (diskPath) =>
          measureMinFreeGb([diskPath], {
            homeDir: fakeHome,
            env: {},
            statfsImpl: async (target) =>
              String(target).startsWith(fakeWork)
                ? { bavail: 310 * 262144, bsize: 4096 }
                : { bavail: 2 * 262144, bsize: 4096 },
          }),
      }),
    /Free space 2\.00 GB is below 5 GB/,
  );
});
