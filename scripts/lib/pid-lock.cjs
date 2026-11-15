'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_LINUX_PID = 2147483647;
const DEFAULT_ORPHAN_GRACE_MS = 30_000;
const DEFAULT_UNVERIFIED_MAX_AGE_MS = 3_600_000;
const MAX_QUARANTINE_FILES = 20;
const MAX_RECOVERY_LOG_LINES = 100;

function readBootIdSync(fsImpl = fs) {
  try {
    return fsImpl.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function readProcStatSync(pid, fsImpl = fs) {
  if (!Number.isInteger(pid) || pid <= 0 || pid > MAX_LINUX_PID) return null;
  try {
    const raw = fsImpl.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closeParen = raw.lastIndexOf(')');
    if (closeParen < 0) return null;
    const fields = raw.slice(closeParen + 2).trim().split(/\s+/);
    if (fields.length < 20) return null;
    return {
      state: fields[0],
      start: fields[19],
    };
  } catch {
    return null;
  }
}

function parseLockRecord(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) {
    return { pid: null, hasPidField: false, invalidPid: false, start: null, boot: null, startedMs: null };
  }
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const hasPidField = Object.hasOwn(parsed, 'pid');
        const rawPid = parsed.pid;
        const validPid =
          typeof rawPid === 'number' &&
          Number.isInteger(rawPid) &&
          rawPid >= 1 &&
          rawPid <= MAX_LINUX_PID;
        const startedMs =
          typeof parsed.started === 'number' && Number.isFinite(parsed.started)
            ? parsed.started
            : typeof parsed.started === 'string' && Number.isFinite(Date.parse(parsed.started))
              ? Date.parse(parsed.started)
              : null;
        return {
          pid: validPid ? rawPid : null,
          hasPidField,
          invalidPid: hasPidField && !validPid,
          start: typeof parsed.start === 'string' && parsed.start ? parsed.start : null,
          boot: typeof parsed.boot === 'string' && parsed.boot ? parsed.boot : null,
          startedMs,
        };
      }
    } catch {
      return { pid: null, hasPidField: false, invalidPid: false, start: null, boot: null, startedMs: null, corrupt: true };
    }
  }
  const parts = text.split(/\s+/);
  if (/^-?\d+$/.test(parts[0])) {
    const num = Number(parts[0]);
    // Epoch millisecond timestamps (> 2^31-1) from legacy timestamp-only locks are not PIDs.
    if (num > MAX_LINUX_PID) {
      return { pid: null, hasPidField: false, invalidPid: false, start: null, boot: null, startedMs: num };
    }
    if (Number.isInteger(num) && num >= 1 && num <= MAX_LINUX_PID) {
      return {
        pid: num,
        hasPidField: true,
        invalidPid: false,
        start: parts[1] || null,
        boot: parts[2] || null,
        startedMs: null,
      };
    }
    return { pid: null, hasPidField: true, invalidPid: true, start: null, boot: null, startedMs: null };
  }
  return { pid: null, hasPidField: false, invalidPid: false, start: null, boot: null, startedMs: null };
}

function inspectLockOwner(parsed, mtimeMs, options = {}) {
  const {
    nowMs = Date.now(),
    orphanGraceMs = DEFAULT_ORPHAN_GRACE_MS,
    unverifiedMaxAgeMs = DEFAULT_UNVERIFIED_MAX_AGE_MS,
    killImpl = process.kill.bind(process),
    procStatImpl = readProcStatSync,
    bootId = readBootIdSync(),
  } = options;

  const ageMs = Number.isFinite(mtimeMs) ? Math.max(0, nowMs - mtimeMs) : Infinity;

  if (parsed.invalidPid) {
    return { alive: false, reason: 'invalid-pid', pid: null };
  }

  if (parsed.pid !== null) {
    if (parsed.boot && bootId && parsed.boot !== bootId) {
      return { alive: false, reason: 'boot-mismatch', pid: parsed.pid };
    }
    let exists = false;
    try {
      killImpl(parsed.pid, 0);
      exists = true;
    } catch (error) {
      if (error && error.code === 'EPERM') {
        exists = true;
      } else if (error && error.code === 'ESRCH') {
        return { alive: false, reason: 'dead-pid', pid: parsed.pid };
      } else {
        throw error;
      }
    }
    if (!exists) {
      return { alive: false, reason: 'dead-pid', pid: parsed.pid };
    }
    const stat = procStatImpl(parsed.pid);
    if (stat?.state === 'Z') {
      return { alive: false, reason: 'zombie-pid', pid: parsed.pid };
    }
    if (parsed.start && stat?.start && parsed.start !== stat.start) {
      return { alive: false, reason: 'pid-recycled', pid: parsed.pid };
    }
    if (!parsed.start && unverifiedMaxAgeMs > 0 && ageMs >= unverifiedMaxAgeMs) {
      return { alive: false, reason: 'unverified-stale-pid', pid: parsed.pid };
    }
    return { alive: true, reason: 'live-pid', pid: parsed.pid };
  }

  if (ageMs < orphanGraceMs) {
    return { alive: true, reason: 'recent-unattributed-lock', pid: null };
  }
  return { alive: false, reason: 'stale-pidless-lock', pid: null };
}

function makeBusyError(lockPath, detail = '') {
  const suffix = detail ? ` (${detail})` : '';
  const err = new Error(`EEXIST: lock already held: ${lockPath}${suffix}`);
  err.code = 'EEXIST';
  err.syscall = 'open';
  err.path = lockPath;
  return err;
}

function buildLockPayload(nowMs = Date.now(), fsImpl = fs) {
  const stat = readProcStatSync(process.pid, fsImpl);
  const boot = readBootIdSync(fsImpl);
  return `${JSON.stringify({
    pid: process.pid,
    ...(stat?.start ? { start: stat.start } : {}),
    ...(boot ? { boot } : {}),
    started: nowMs,
  })}\n`;
}

function pruneQuarantineSync(quarantineDir, fsImpl = fs) {
  try {
    const entries = fsImpl
      .readdirSync(quarantineDir)
      .filter((name) => name !== 'recovery.jsonl')
      .flatMap((name) => {
        const full = path.join(quarantineDir, name);
        try {
          return [{ name, full, mtimeMs: fsImpl.lstatSync(full).mtimeMs }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const old of entries.slice(MAX_QUARANTINE_FILES)) {
      try {
        fsImpl.rmSync(old.full, { recursive: true, force: true });
      } catch {
        // Best-effort retention pruning.
      }
    }
  } catch {
    // Ignore pruning errors.
  }
}

function appendRecoveryRecordSync(quarantineDir, record, onRecover, fsImpl = fs) {
  try {
    const logFile = path.join(quarantineDir, 'recovery.jsonl');
    let lines = [];
    try {
      lines = fsImpl.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean);
    } catch {
      lines = [];
    }
    lines.push(JSON.stringify(record));
    if (lines.length > MAX_RECOVERY_LOG_LINES) {
      lines = lines.slice(-MAX_RECOVERY_LOG_LINES);
    }
    const tmp = `${logFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fsImpl.writeFileSync(tmp, `${lines.join('\n')}\n`, { mode: 0o600 });
    fsImpl.renameSync(tmp, logFile);
  } catch {
    // Best-effort audit record; never block lock recovery if disk metadata logging fails.
  }
  if (typeof onRecover === 'function') {
    try {
      onRecover(record);
    } catch {
      // Ignore observer error.
    }
  }
}

function writeAtomicLinkSync(lockPath, payload, fsImpl = fs) {
  const tmp = `${lockPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.lktmp`;
  let stat = null;
  fsImpl.writeFileSync(tmp, payload, { flag: 'wx', mode: 0o600 });
  try {
    fsImpl.linkSync(tmp, lockPath);
    stat = fsImpl.lstatSync(lockPath);
  } finally {
    try {
      fsImpl.unlinkSync(tmp);
    } catch {
      // Ignore cleanup race.
    }
  }
  return stat;
}

function recoverStaleLockSync(lockPath, inspectOpts = {}, fsImpl = fs) {
  const reclaimPath = `${lockPath}.reclaim`;
  const nowMs = inspectOpts.nowMs ?? Date.now();
  const guardPayload = buildLockPayload(nowMs, fsImpl);
  let guardStat = null;

  try {
    guardStat = writeAtomicLinkSync(reclaimPath, guardPayload, fsImpl);
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      // Check if the reclaim guard itself was left by a dead process.
      try {
        const gStat = fsImpl.lstatSync(reclaimPath);
        const gRaw = gStat.isFile() ? fsImpl.readFileSync(reclaimPath, 'utf8') : '';
        const gStatus = inspectLockOwner(parseLockRecord(gRaw), gStat.mtimeMs, inspectOpts);
        if (!gStatus.alive) {
          fsImpl.rmSync(reclaimPath, { recursive: true, force: true });
          guardStat = writeAtomicLinkSync(reclaimPath, guardPayload, fsImpl);
        } else {
          throw makeBusyError(lockPath, 'reclaim-in-progress');
        }
      } catch (inner) {
        if (inner && inner.code === 'EEXIST') throw makeBusyError(lockPath, 'reclaim-in-progress');
        throw inner;
      }
    } else {
      throw err;
    }
  }

  try {
    let lockStat;
    try {
      lockStat = fsImpl.lstatSync(lockPath);
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      throw err;
    }

    let raw = '';
    if (lockStat.isFile()) {
      try {
        raw = fsImpl.readFileSync(lockPath, 'utf8');
      } catch (err) {
        if (err && err.code === 'ENOENT') return null;
        throw err;
      }
    }

    const parsed = lockStat.isDirectory()
      ? { pid: null, hasPidField: false, invalidPid: false, start: null, boot: null, startedMs: null }
      : parseLockRecord(raw);
    const status = inspectLockOwner(parsed, lockStat.mtimeMs, inspectOpts);
    if (status.alive) {
      throw makeBusyError(lockPath, status.pid ? `pid ${status.pid}` : status.reason);
    }

    const quarantineDir =
      inspectOpts.quarantineDir || path.join(path.dirname(lockPath), '.recovered-locks');
    fsImpl.mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
    const tag = status.pid ?? 'nopid';
    const stamp = `${nowMs}-${crypto.randomBytes(3).toString('hex')}`;
    const quarantinedTo = path.join(quarantineDir, `${path.basename(lockPath)}.dead-${tag}-${stamp}`);
    fsImpl.renameSync(lockPath, quarantinedTo);
    pruneQuarantineSync(quarantineDir, fsImpl);

    const record = {
      event: 'pid_lock_recovered',
      lockPath,
      deadPid: status.pid,
      reason: status.reason,
      quarantinedTo,
      recoveredByPid: process.pid,
      at: new Date(nowMs).toISOString(),
    };
    appendRecoveryRecordSync(quarantineDir, record, inspectOpts.onRecover, fsImpl);
    return record;
  } finally {
    if (guardStat) {
      try {
        const cur = fsImpl.lstatSync(reclaimPath);
        if (cur.ino === guardStat.ino) {
          fsImpl.unlinkSync(reclaimPath);
        }
      } catch {
        // Guard already cleaned up.
      }
    }
  }
}

function acquirePidLockSync(lockPath, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const resolved = path.resolve(lockPath);
  if (options.createParent !== false) {
    fsImpl.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  }
  const nowMs = options.nowMs ?? Date.now();
  const payload = buildLockPayload(nowMs, fsImpl);

  let recovered = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const stat = writeAtomicLinkSync(resolved, payload, fsImpl);
      let released = false;
      return {
        lockPath: resolved,
        pid: process.pid,
        ino: stat.ino,
        recovered,
        release() {
          if (released) return;
          released = true;
          try {
            const cur = fsImpl.lstatSync(resolved);
            if (cur.ino === stat.ino) {
              fsImpl.unlinkSync(resolved);
            }
          } catch (err) {
            if (err && err.code !== 'ENOENT') throw err;
          }
        },
      };
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      recovered = recoverStaleLockSync(resolved, { ...options, nowMs }, fsImpl);
    }
  }
  throw makeBusyError(resolved, 'contention');
}

function withPidLockSync(lockPath, fn, options = {}) {
  const handle = acquirePidLockSync(lockPath, options);
  try {
    return fn(handle);
  } finally {
    handle.release();
  }
}

async function acquirePidLock(lockPath, options = {}) {
  const syncHandle = acquirePidLockSync(lockPath, options);
  let released = false;
  return {
    lockPath: syncHandle.lockPath,
    pid: syncHandle.pid,
    ino: syncHandle.ino,
    recovered: syncHandle.recovered,
    async release() {
      if (released) return;
      released = true;
      try {
        const cur = await fsp.lstat(syncHandle.lockPath);
        if (cur.ino === syncHandle.ino) {
          await fsp.unlink(syncHandle.lockPath);
        }
      } catch (err) {
        if (err && err.code !== 'ENOENT') throw err;
      }
    },
  };
}

async function withPidLock(lockPath, fn, options = {}) {
  const handle = await acquirePidLock(lockPath, options);
  try {
    return await fn(handle);
  } finally {
    await handle.release();
  }
}

module.exports = {
  MAX_LINUX_PID,
  DEFAULT_ORPHAN_GRACE_MS,
  DEFAULT_UNVERIFIED_MAX_AGE_MS,
  readBootIdSync,
  readProcStatSync,
  parseLockRecord,
  inspectLockOwner,
  acquirePidLockSync,
  withPidLockSync,
  acquirePidLock,
  withPidLock,
};
