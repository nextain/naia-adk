#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseBytes } from './core.mjs';
import { measureMinFreeBytesSync } from '../lib/disk-free.mjs';
import { registerWorker, updateWorkerRuntime, safeToken, readRegistryUnlocked } from '../work-watch.mjs';
import { readLedger } from '../work-ledger/ledger.mjs';
import fsp from 'node:fs/promises';
import { defaultRegistryPath } from '../work-watch.mjs';

const CLI_PATH = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const REPO_ROOT = path.resolve(path.dirname(CLI_PATH), '../..');

function parseArgs(argv) {
  const args = [...argv];
  const opts = { watchDirs: [] };
  let command = [];
  while (args.length) {
    const key = args.shift();
    if (key === '--') {
      command = args.splice(0);
      break;
    }
    if (key === '--foreground' || key === '--no-review-cap') {
      opts[key.slice(2)] = true;
      continue;
    }
    if (!key.startsWith('--') || !args.length) {
      throw new Error(`Invalid option: ${key}`);
    }
    const name = key.slice(2);
    const val = args.shift();
    if (name === 'watch-dir') opts.watchDirs.push(val);
    else if (name === 'card-id') opts.cardId = val;
    else opts[name] = val;
  }
  return { opts, command };
}

export async function spawnWorker(argv = process.argv.slice(2), deps = {}) {
  const { opts, command } = parseArgs(argv);
  const env = deps.env || process.env;
  const root = path.resolve(opts.root || env.ADK_ROOT || REPO_ROOT);
  const id = safeToken(opts.id, 'worker id');
  const role = safeToken(opts.role || env.ADK_ROLE || env.NAIA_ROLE, 'role');
  const cardId = opts.cardId;
  if (cardId) {
    const l = await readLedger(root, role);
    const item = l.items.find(i => i.id === cardId);
    if (!item) throw new Error(`Card ${cardId} not found in ledger`);
    if (item.status !== 'open') throw new Error(`Card ${cardId} is not open (status: ${item.status})`);
  }

  const model = opts.model;
  if (model) {
      const profilePath = path.resolve(root, 'config/tier-profile.json');
      if (fs.existsSync(profilePath)) {
          const profile = JSON.parse(await fsp.readFile(profilePath, 'utf8'));
          const max = profile.model_quotas?.[model];
          if (max) {
              const registryFile = path.resolve(opts.registry || defaultRegistryPath(root, env));
              const registry = await readRegistryUnlocked(registryFile);
              const running = registry.workers.filter(w => w.status === 'running' && w.command?.includes(model));
              if (running.length >= max) {
                  throw new Error(`Model quota exceeded for ${model}`);
              }
          }
      }
  }

  if (!opts['result-file']) {
    throw new Error('spawn-worker requires --result-file <path>');
  }
  if (!command.length) {
    throw new Error('spawn-worker requires -- <command...>');
  }

  const workDir = path.resolve(opts['work-dir'] || process.cwd());
  fs.mkdirSync(workDir, { recursive: true });
  const resultFile = path.resolve(workDir, opts['result-file']);
  const doneFile = opts['done-file'] ? path.resolve(workDir, opts['done-file']) : null;
  const watchDirs = opts.watchDirs.length
    ? opts.watchDirs.map((d) => path.resolve(workDir, d))
    : [workDir];
  const unitBase = opts.unit || `${role}-worker-${id}`.replace(/[^A-Za-z0-9_.-]/g, '-');
  const unit = unitBase.endsWith('.service') ? unitBase : `${unitBase}.service`;
  const stallMinutes = opts['stall-min'] !== undefined ? Number(opts['stall-min']) : 15;
  const floorBytes = parseBytes(opts.floor || '5G');

  // Pre-launch multi-mount disk floor gate (workDir + stateDir + / + ~ + ~/.gemini + ~/.claude + ~/.cache + /tmp).
  const stateDir = path.resolve(
    opts['state-dir'] || env.WORKER_RUNNER_STATE_DIR || path.join(workDir, '.worker-runner-state'),
  );
  const disk = measureMinFreeBytesSync([stateDir, workDir, path.dirname(resultFile)], {
    env,
    explicitPaths: opts['disk-paths'],
    execFileSyncImpl: deps.execFileSyncImpl,
  });
  if (disk.bytes < floorBytes) {
    throw new Error(
      `Disk free space below floor (${disk.bytes} < ${floorBytes} bytes on ${disk.bottleneckMount || 'filesystem'})`,
    );
  }

  // Auto-register into work-watch BEFORE launching so fast crashes are never missed.
  const registration = await registerWorker({
    root,
    registryFile: opts.registry,
    id,
    unit: opts.foreground ? null : unit,
    role,
    wakeDir: opts['wake-dir'],
    resultFile,
    doneFile,
    watchDirs,
    stallMinutes,
    command,
    env,
    now: deps.now,
  });

  const runnerArgs = [
    CLI_PATH,
    'run',
    '--state-dir',
    stateDir,
    '--id',
    id,
    '--adk-root',
    root,
    '--role',
    role,
    '--result-file',
    resultFile,
    '--stall-min',
    String(stallMinutes),
    ...(!opts.foreground && unit ? ['--unit', unit] : []),
    ...(opts['wake-dir'] ? ['--wake-dir', path.resolve(root, opts['wake-dir'])] : []),
    ...(opts.registry ? ['--work-watch-registry', path.resolve(root, opts.registry)] : []),
    ...watchDirs.flatMap((d) => ['--watch-dir', d]),
    '--work-dir',
    workDir,
    '--floor',
    opts.floor || '5G',
    ...(opts.budget ? ['--budget', opts.budget] : []),
    ...(opts.priority ? ['--priority', opts.priority] : []),
    ...(opts.timeout ? ['--timeout', opts.timeout] : []),
    ...(opts.instruction ? ['--instruction', path.resolve(workDir, opts.instruction)] : []),
    ...(doneFile ? ['--done-file', doneFile] : []),
    ...(opts['review-cap'] ? ['--review-cap', String(opts['review-cap'])] : []),
    ...(opts['no-review-cap'] ? ['--no-review-cap'] : []),
    ...(opts['disk-paths'] ? ['--disk-paths', String(opts['disk-paths'])] : []),
    '--',
    ...command,
  ];

  if (opts.foreground) {
    await updateWorkerRuntime({
      root,
      registryFile: opts.registry,
      id,
      unit: null,
      pid: process.pid,
      env,
      now: deps.now,
    });
    const runImpl = deps.spawnSyncImpl || spawnSync;
    const res = runImpl(process.execPath, runnerArgs, {
      cwd: workDir,
      stdio: 'inherit',
      env,
    });
    if ((res.status ?? 1) !== 0) {
      await updateWorkerRuntime({
        root,
        registryFile: opts.registry,
        id,
        launchFailed: true,
        launchError: `worker-runner exited with status ${res.status ?? 1}`,
        env,
        now: deps.now,
      });
    }
    return { mode: 'foreground', id, unit: null, exitCode: res.status ?? 1, registration };
  }

  const systemdRunArgs = [
    '--user',
    `--unit=${unit}`,
    '--collect',
    `--working-directory=${workDir}`,
    `--setenv=WORKER_ROLE=${role}`,
    `--setenv=WORKER_RESULT_FILE=${resultFile}`,
    `--setenv=WORKER_UNIT=${unit}`,
    ...(opts['log-file']
      ? [
          `--property=StandardOutput=append:${path.resolve(workDir, opts['log-file'])}`,
          `--property=StandardError=append:${path.resolve(workDir, opts['log-file'])}`,
        ]
      : []),
    '--',
    process.execPath,
    ...runnerArgs,
  ];

  const systemdImpl =
    deps.systemdRunImpl ||
    ((args, execOpts) => execFileSync('systemd-run', args, execOpts));

  try {
    systemdImpl(systemdRunArgs, {
      cwd: workDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
  } catch (error) {
    await updateWorkerRuntime({
      root,
      registryFile: opts.registry,
      id,
      launchFailed: true,
      launchError: error?.stderr ? String(error.stderr).trim() : error?.message || String(error),
      env,
      now: deps.now,
    });
    throw error;
  }

  return { mode: 'systemd', id, unit, exitCode: 0, registration };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const out = await spawnWorker();
    console.log(JSON.stringify({ event: 'worker-spawned', id: out.id, unit: out.unit, mode: out.mode }));
    process.exitCode = out.exitCode;
  } catch (error) {
    console.error(`spawn-worker failed: ${error.message}`);
    process.exitCode = 1;
  }
}
