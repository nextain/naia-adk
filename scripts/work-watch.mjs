#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { withPidLock, readProcStatSync } from './lib/pid-lock.mjs';

const execFileAsync = promisify(execFile);

const SKIP_DIRS = new Set(['.git', 'node_modules', '.pnpm-store', '.recovered-locks']);
const MAX_SCAN_DEPTH = 4;
const MAX_SCAN_ENTRIES = 4000;
const TERMINAL_RETENTION_MS = 7 * 24 * 3600_000;
const MAX_TERMINAL_WORKERS = 200;

export function safeToken(value, label = 'identifier') {
  const str = String(value ?? '').trim();
  if (!str || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(str) || str.includes('..')) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return str;
}

export function defaultRegistryPath(root = process.cwd(), env = process.env) {
  if (env?.ADK_WORK_WATCH_REGISTRY) {
    return path.resolve(root, env.ADK_WORK_WATCH_REGISTRY);
  }
  return path.resolve(root, '.agents/work/work-watch/registry.json');
}

export function defaultWakeDir(root = process.cwd(), env = process.env) {
  if (env?.ADK_WAKE_DIR) {
    return path.resolve(root, env.ADK_WAKE_DIR);
  }
  return path.resolve(root, '.agents/work/l4/wake');
}

export function scanProgressSignatureSync(watchDirs = [], extraFiles = [], fsImpl = fs) {
  let count = 0;
  let totalBytes = 0;
  let maxMtimeMs = 0;
  let visited = 0;

  const inspectFile = (target) => {
    if (!target) return;
    try {
      const st = fsImpl.lstatSync(target);
      if (st.isSymbolicLink()) return;
      if (st.isFile()) {
        count += 1;
        totalBytes += st.size;
        if (st.mtimeMs > maxMtimeMs) maxMtimeMs = Math.floor(st.mtimeMs);
      }
    } catch {
      // Missing files are normal before output appears.
    }
  };

  const walk = (dir, depth) => {
    if (visited >= MAX_SCAN_ENTRIES || depth > MAX_SCAN_DEPTH) return;
    let entries;
    try {
      entries = fsImpl.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= MAX_SCAN_ENTRIES) break;
      if (SKIP_DIRS.has(entry.name)) continue;
      visited += 1;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        inspectFile(full);
      }
    }
  };

  for (const dir of watchDirs) {
    if (dir) walk(path.resolve(dir), 0);
  }
  for (const file of extraFiles) {
    if (file) inspectFile(path.resolve(file));
  }
  return {
    count,
    totalBytes,
    maxMtimeMs,
    signature: `${count}:${totalBytes}:${maxMtimeMs}`,
  };
}

export async function defaultUnitProbe(unit) {
  try {
    const { stdout } = await execFileAsync(
      'systemctl',
      [
        '--user',
        'show',
        unit,
        '--no-pager',
        '--property=Id,LoadState,ActiveState,SubState,Result,ExecMainStatus,ExecMainPID,NRestarts',
      ],
      { timeout: 5000, encoding: 'utf8' },
    );
    const props = {};
    for (const line of String(stdout || '').split(/\r?\n/)) {
      const idx = line.indexOf('=');
      if (idx > 0) {
        props[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
    return {
      ok: true,
      loadState: props.LoadState || 'unknown',
      activeState: props.ActiveState || 'unknown',
      subState: props.SubState || 'unknown',
      result: props.Result || 'unknown',
      execMainStatus: Number.isFinite(Number(props.ExecMainStatus))
        ? Number(props.ExecMainStatus)
        : null,
      execMainPid: Number.isFinite(Number(props.ExecMainPID))
        ? Number(props.ExecMainPID)
        : 0,
      restarts: Number.isFinite(Number(props.NRestarts)) ? Number(props.NRestarts) : 0,
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error),
      loadState: 'error',
      activeState: 'unknown',
      subState: 'unknown',
      result: 'unknown',
    };
  }
}

export function defaultPidProbe(pid, startToken = null) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (!error || error.code !== 'EPERM') return false;
  }
  const stat = readProcStatSync(pid);
  if (stat?.state === 'Z') return false;
  if (startToken && stat?.start && stat.start !== startToken) return false;
  return true;
}

async function readRegistryUnlocked(registryFile) {
  try {
    const raw = await fsp.readFile(registryFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.workers)) {
      throw new Error('Invalid work-watch registry');
    }
    return { version: 1, workers: parsed.workers };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { version: 1, workers: [] };
    }
    throw error;
  }
}

async function writeRegistryUnlocked(registryFile, doc) {
  await fsp.mkdir(path.dirname(registryFile), { recursive: true, mode: 0o700 });
  const tmp = `${registryFile}.${process.pid}.${randomUUID()}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(tmp, registryFile);
}

async function writeRoleWakeFile(wakeDir, role, workerId, kind, headline, bodyLines, nowMs, seq = 0) {
  await fsp.mkdir(wakeDir, { recursive: true, mode: 0o700 });
  const safeRole = safeToken(role, 'role');
  const safeId = safeToken(workerId, 'worker id').replace(/\./g, '_');
  const safeKind = safeToken(kind, 'wake kind');
  const stamp = new Date(nowMs + seq).toISOString().replace(/\D/g, '');
  const base = `${stamp}-work-watch-${safeId}-${safeKind}-route-${safeRole}.md`;
  let target = path.join(wakeDir, base);
  const content = `${headline}\n${bodyLines.filter(Boolean).join('\n')}\n`;
  try {
    await fsp.writeFile(target, content, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
    target = path.join(
      wakeDir,
      `${stamp}-work-watch-${safeId}-${safeKind}-${randomUUID().slice(0, 8)}-route-${safeRole}.md`,
    );
    await fsp.writeFile(target, content, { flag: 'wx', mode: 0o600 });
  }
  return target;
}

function inspectResultCompletionSync(worker, fsImpl = fs) {
  if (!worker.resultFile) return { done: false };
  try {
    const st = fsImpl.statSync(worker.resultFile);
    if (!st.isFile() || st.size <= 0) {
      return { done: false };
    }
    if (
      worker.initialResultMtimeMs != null &&
      Math.floor(st.mtimeMs) <= worker.initialResultMtimeMs &&
      st.size === worker.initialResultSize
    ) {
      return { done: false };
    }
    return { done: true, size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
  } catch {
    return { done: false };
  }
}

export async function registerWorker(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const env = options.env || process.env;
  const registryFile = path.resolve(options.registryFile || defaultRegistryPath(root, env));
  const now = options.now ?? Date.now();
  const id = safeToken(options.id, 'worker id');
  const role = safeToken(options.role, 'role');
  if (!options.resultFile) {
    throw new Error('registerWorker requires resultFile');
  }
  const resultFile = path.resolve(root, options.resultFile);
  const doneFile = options.doneFile ? path.resolve(root, options.doneFile) : null;
  const wakeDir = path.resolve(root, options.wakeDir || defaultWakeDir(root, env));
  const rawWatchDirs = Array.isArray(options.watchDirs)
    ? options.watchDirs
    : options.watchDirs
      ? [options.watchDirs]
      : [path.dirname(resultFile)];
  const watchDirs = [...new Set(rawWatchDirs.filter(Boolean).map((d) => path.resolve(root, d)))];
  if (!watchDirs.length) {
    watchDirs.push(path.dirname(resultFile));
  }
  const stallMinutes = Number(options.stallMinutes ?? 15);
  if (!Number.isFinite(stallMinutes) || stallMinutes <= 0) {
    throw new Error(`Invalid stallMinutes: ${options.stallMinutes}`);
  }
  const unit = options.unit ? safeToken(options.unit, 'unit') : null;
  const pid = Number.isInteger(options.pid) && options.pid > 0 ? options.pid : null;
  const startToken =
    options.startToken || (pid ? readProcStatSync(pid)?.start || null : null);

  let initialResultMtimeMs = null;
  let initialResultSize = null;
  try {
    const st = fs.statSync(resultFile);
    if (st.isFile()) {
      initialResultMtimeMs = Math.floor(st.mtimeMs);
      initialResultSize = st.size;
    }
  } catch {
    // Expected when resultFile does not exist before worker starts.
  }

  const progress = scanProgressSignatureSync(watchDirs, [resultFile, doneFile]);

  return withPidLock(`${registryFile}.lock`, async () => {
    const doc = await readRegistryUnlocked(registryFile);
    const entry = {
      id,
      unit,
      role,
      wakeDir,
      resultFile,
      doneFile,
      watchDirs,
      stallMinutes,
      pid,
      startToken,
      command: Array.isArray(options.command) ? options.command.map(String) : null,
      startedAt: new Date(now).toISOString(),
      startedAtMs: now,
      status: 'running',
      initialResultMtimeMs,
      initialResultSize,
      lastProgressAt: now,
      lastProgressSig: progress.signature,
      alerts: {},
    };
    doc.workers = doc.workers.filter((w) => w.role !== role || w.id !== id);
    doc.workers.push(entry);
    await writeRegistryUnlocked(registryFile, doc);
    return entry;
  }, { nowMs: now });
}

export async function updateWorkerRuntime(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const env = options.env || process.env;
  const registryFile = path.resolve(options.registryFile || defaultRegistryPath(root, env));
  const now = options.now ?? Date.now();
  const id = safeToken(options.id, 'worker id');
  const role = options.role === undefined ? undefined : safeToken(options.role, 'role');

  return withPidLock(`${registryFile}.lock`, async () => {
    const doc = await readRegistryUnlocked(registryFile);
    const matches = doc.workers.filter((w) => w.id === id && (role === undefined || w.role === role));
    if (matches.length > 1) throw new Error('Worker ID is ambiguous; specify its role');
    const [worker] = matches;
    if (!worker) return null;
    if (options.unit !== undefined) worker.unit = options.unit ? safeToken(options.unit, 'unit') : null;
    if (options.pid !== undefined) {
      worker.pid = Number.isInteger(options.pid) && options.pid > 0 ? options.pid : null;
      worker.startToken =
        options.startToken !== undefined
          ? options.startToken
          : worker.pid
            ? readProcStatSync(worker.pid)?.start || null
            : null;
    }
    if (options.launchFailed) {
      worker.launchFailed = true;
      worker.launchError = String(options.launchError || 'launch failed');
    }
    await writeRegistryUnlocked(registryFile, doc);
    return worker;
  }, { nowMs: now });
}

export async function watchWorkers(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const env = options.env || process.env;
  const registryFile = path.resolve(options.registryFile || defaultRegistryPath(root, env));
  const now = options.now ?? Date.now();
  const repeatMinutes = Number(options.repeatMinutes ?? 30);
  const unitProbe = options.unitProbe || defaultUnitProbe;
  const pidProbe = options.pidProbe || defaultPidProbe;

  return withPidLock(`${registryFile}.lock`, async () => {
    const doc = await readRegistryUnlocked(registryFile);
    const wakes = [];
    const completed = [];
    const dead = [];
    const stalled = [];
    let dirty = false;
    let seq = 0;

    const activeWorkers = doc.workers.filter((w) => w.status === 'running');

    for (const worker of activeWorkers) {
      // 1. Result file created (non-empty) => Done!
      const completion = inspectResultCompletionSync(worker);
      if (completion.done) {
        worker.status = 'done';
        worker.completedAt = new Date(now).toISOString();
        worker.stalled = false;
        dirty = true;
        completed.push(worker.id);
        if (!worker.alerts?.doneAt) {
          const wakeFile = await writeRoleWakeFile(
            worker.wakeDir,
            worker.role,
            worker.id,
            'done',
            `[일꾼 감시] 일꾼 끝: ${worker.id}`,
            [
              `역할: ${worker.role}`,
              worker.unit ? `유닛: ${worker.unit}` : null,
              `결과: ${worker.resultFile} (${completion.size} bytes)`,
              `감시 폴더: ${(worker.watchDirs || []).join(', ')}`,
              '결과 파일을 읽고 후속 조치를 진행하세요.',
            ],
            now,
            seq++,
          );
          worker.alerts = { ...(worker.alerts || {}), doneAt: now };
          wakes.push({ role: worker.role, id: worker.id, reason: 'done', wakeFile });
        }
        continue;
      }

      // 2. Unit / PID liveness check before result file exists.
      let deadReason = null;
      if (worker.launchFailed) {
        deadReason = `띄우기 실패: ${worker.launchError || 'launch failed'}`;
      } else if (worker.unit) {
        const u = await unitProbe(worker.unit);
        if (u.ok) {
          if (u.activeState === 'failed' || u.result === 'failed') {
            deadReason = `systemd 유닛 실패 (ActiveState=${u.activeState}, Result=${u.result}, status=${u.execMainStatus ?? 'n/a'})`;
          } else if (
            ['inactive', 'deactivating'].includes(u.activeState) &&
            u.subState === 'dead' &&
            (u.loadState !== 'not-found' || now - (worker.startedAtMs || 0) >= 5_000)
          ) {
            // If a fallback pid is tracked and still alive, keep watching; otherwise unit exited without result.
            const pidStillAlive = worker.pid ? pidProbe(worker.pid, worker.startToken) : false;
            if (!pidStillAlive) {
              deadReason = `systemd 유닛 종료됨 (ActiveState=${u.activeState}, SubState=${u.subState}, 결과 파일 없음)`;
            }
          }
        } else if (worker.pid && !pidProbe(worker.pid, worker.startToken)) {
          deadReason = `프로세스 종료됨 (pid=${worker.pid}, 결과 파일 없음)`;
        }
      } else if (worker.pid && !pidProbe(worker.pid, worker.startToken)) {
        deadReason = `프로세스 종료됨 (pid=${worker.pid}, 결과 파일 없음)`;
      }

      if (deadReason) {
        worker.status = 'dead';
        worker.deadAt = new Date(now).toISOString();
        worker.deadReason = deadReason;
        dirty = true;
        dead.push(worker.id);
        if (!worker.alerts?.deadAt) {
          const wakeFile = await writeRoleWakeFile(
            worker.wakeDir,
            worker.role,
            worker.id,
            'dead',
            `[일꾼 감시] 유닛 죽음: ${worker.id}`,
            [
              `역할: ${worker.role}`,
              worker.unit ? `유닛: ${worker.unit}` : null,
              worker.pid ? `PID: ${worker.pid}` : null,
              `원인: ${deadReason}`,
              `기대 결과 파일: ${worker.resultFile} (없음/비어 있음)`,
              `감시 폴더: ${(worker.watchDirs || []).join(', ')}`,
            ],
            now,
            seq++,
          );
          worker.alerts = { ...(worker.alerts || {}), deadAt: now };
          wakes.push({ role: worker.role, id: worker.id, reason: 'dead', wakeFile });
        }
        continue;
      }

      // 3. Output artifact progress check (N분 진도 없음).
      const progress = scanProgressSignatureSync(worker.watchDirs || [], [
        worker.resultFile,
        worker.doneFile,
      ]);
      const progressed =
        progress.signature !== worker.lastProgressSig ||
        (progress.maxMtimeMs > 0 && progress.maxMtimeMs > (worker.lastProgressAt || 0));

      if (progressed) {
        worker.lastProgressSig = progress.signature;
        worker.lastProgressAt = Math.max(now, progress.maxMtimeMs);
        if (worker.stalled) worker.stalled = false;
        dirty = true;
        continue;
      }

      const stallMs = (worker.stallMinutes || 15) * 60_000;
      const idleMs = now - (worker.lastProgressAt || worker.startedAtMs || now);
      if (idleMs >= stallMs) {
        worker.stalled = true;
        dirty = true;
        stalled.push(worker.id);
        const lastAlertAt = worker.alerts?.stallAt ?? -Infinity;
        if (now - lastAlertAt >= repeatMinutes * 60_000) {
          const idleMin = Math.floor(idleMs / 60_000);
          const wakeFile = await writeRoleWakeFile(
            worker.wakeDir,
            worker.role,
            worker.id,
            'stall',
            `[일꾼 감시] 진도 없음: ${worker.id} (${idleMin}분째 산출물 변화 없음)`,
            [
              `역할: ${worker.role}`,
              worker.unit ? `유닛: ${worker.unit}` : null,
              worker.pid ? `PID: ${worker.pid}` : null,
              `기준: ${worker.stallMinutes}분 동안 감시 폴더·결과 파일 변화 없음`,
              `기대 결과 파일: ${worker.resultFile}`,
              `감시 폴더: ${(worker.watchDirs || []).join(', ')}`,
            ],
            now,
            seq++,
          );
          worker.alerts = { ...(worker.alerts || {}), stallAt: now };
          wakes.push({ role: worker.role, id: worker.id, reason: 'stall', wakeFile });
        }
      }
    }

    // Bounded retention for terminal workers.
    const running = doc.workers.filter((w) => w.status === 'running');
    const terminal = doc.workers
      .filter((w) => w.status !== 'running')
      .filter((w) => {
        const endedMs = Date.parse(w.completedAt || w.deadAt || w.startedAt || '');
        return !Number.isFinite(endedMs) || now - endedMs < TERMINAL_RETENTION_MS;
      })
      .sort(
        (a, b) =>
          Date.parse(b.completedAt || b.deadAt || b.startedAt || 0) -
          Date.parse(a.completedAt || a.deadAt || a.startedAt || 0),
      )
      .slice(0, MAX_TERMINAL_WORKERS);

    if (running.length + terminal.length !== doc.workers.length) {
      dirty = true;
    }
    doc.workers = [...running, ...terminal];

    if (dirty) {
      await writeRegistryUnlocked(registryFile, doc);
    }

    return {
      checked: activeWorkers.length,
      completed,
      dead,
      stalled,
      wakes,
    };
  }, { nowMs: now });
}

function parseCliArgs(argv) {
  const args = [...argv];
  const sub = args[0] && !args[0].startsWith('--') ? args.shift() : 'watch';
  const opts = { watchDirs: [], command: [] };
  while (args.length) {
    const key = args.shift();
    if (key === '--') {
      opts.command = args.splice(0);
      break;
    }
    if (!key.startsWith('--')) {
      throw new Error(`Unexpected argument: ${key}`);
    }
    const name = key.slice(2);
    if (!args.length || args[0].startsWith('--')) {
      opts[name] = true;
      continue;
    }
    const val = args.shift();
    if (name === 'watch-dir') {
      opts.watchDirs.push(val);
    } else {
      opts[name] = val;
    }
  }
  return { sub, opts };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const { sub, opts } = parseCliArgs(argv);
  const root = path.resolve(opts.root || process.cwd());
  const registryFile = opts.registry ? path.resolve(root, opts.registry) : undefined;

  if (sub === 'register') {
    const entry = await registerWorker({
      root,
      registryFile,
      id: opts.id,
      unit: opts.unit,
      role: opts.role,
      wakeDir: opts['wake-dir'],
      resultFile: opts['result-file'],
      doneFile: opts['done-file'],
      watchDirs: opts.watchDirs,
      stallMinutes: opts['stall-min'] !== undefined ? Number(opts['stall-min']) : 15,
      pid: opts.pid !== undefined ? Number(opts.pid) : undefined,
      command: opts.command,
      now: deps.now,
    });
    console.log(JSON.stringify({ event: 'work-watch-registered', worker: entry }));
    return entry;
  }

  if (sub === 'status') {
    const target = registryFile || defaultRegistryPath(root);
    const doc = await readRegistryUnlocked(target);
    console.log(JSON.stringify(doc, null, 2));
    return doc;
  }

  if (sub === 'watch') {
    const res = await watchWorkers({
      root,
      registryFile,
      repeatMinutes: opts['repeat-min'] !== undefined ? Number(opts['repeat-min']) : 30,
      now: deps.now,
      unitProbe: deps.unitProbe,
      pidProbe: deps.pidProbe,
    });
    console.log(JSON.stringify({ event: 'work-watch', ...res }));
    return res;
  }

  throw new Error(`Usage: work-watch.mjs [watch|register|status] [options]`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`work-watch failed: ${error.message}`);
    process.exitCode = 1;
  });
}
