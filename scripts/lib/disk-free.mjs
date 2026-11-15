import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function existingAncestor(targetPath, fsImpl = fs) {
  let cur = path.resolve(String(targetPath || '/'));
  for (;;) {
    try {
      if (fsImpl.existsSync(cur)) return cur;
    } catch {
      // Walk upward if intermediate stat fails.
    }
    const parent = path.dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
}

export function parseDiskPathList(raw) {
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (typeof raw === 'string' && raw.trim()) {
    return raw
      .split(/[,:]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

export function collectWorkerDiskPaths(
  primaryPaths = [],
  {
    homeDir = os.homedir(),
    tmpDir = os.tmpdir(),
    env = process.env,
    explicitPaths,
    fsImpl = fs,
  } = {},
) {
  const configured = parseDiskPathList(
    explicitPaths !== undefined ? explicitPaths : env?.WORKER_RUNNER_DISK_PATHS,
  );
  const candidates = configured.length
    ? configured
    : [
        ...(Array.isArray(primaryPaths) ? primaryPaths : [primaryPaths]).filter(Boolean),
        path.parse(homeDir || '/').root || '/',
        homeDir,
        homeDir ? path.join(homeDir, '.gemini') : '',
        homeDir ? path.join(homeDir, '.claude') : '',
        env?.XDG_CACHE_HOME || (homeDir ? path.join(homeDir, '.cache') : ''),
        env?.TMPDIR || tmpDir,
        '/tmp',
      ].filter(Boolean);

  const seen = new Set();
  const resolved = [];
  for (const candidate of candidates) {
    const target = existingAncestor(candidate, fsImpl);
    if (!seen.has(target)) {
      seen.add(target);
      resolved.push(target);
    }
  }
  return resolved.length ? resolved : ['/'];
}

export function parseDfOutput(stdout) {
  const lines = String(stdout ?? '')
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    throw new Error('Cannot read disk free space');
  }
  const rows = [];
  let minRow = null;
  for (const line of lines.slice(1)) {
    const cols = line.split(/\s+/);
    if (cols.length < 4) {
      throw new Error('Cannot read disk free space');
    }
    const availKb = Number(cols[3]);
    if (!Number.isFinite(availKb) || availKb < 0) {
      throw new Error('Cannot read disk free space');
    }
    const bytes = availKb * 1024;
    const mount = cols.slice(5).join(' ') || cols.at(-1) || '';
    const entry = { filesystem: cols[0], bytes, mount };
    rows.push(entry);
    if (!minRow || entry.bytes < minRow.bytes) {
      minRow = entry;
    }
  }
  if (!minRow) {
    throw new Error('Cannot read disk free space');
  }
  return {
    bytes: minRow.bytes,
    bottleneckMount: minRow.mount,
    rows,
  };
}

export function measureMinFreeBytesSync(primaryPaths = [], options = {}) {
  const targets = collectWorkerDiskPaths(primaryPaths, options);
  const execImpl = options.execFileSyncImpl || execFileSync;
  const stdout = execImpl('df', ['-Pk', ...targets], {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 1500,
    stdio: ['ignore', 'pipe', 'ignore'],
    ...(options.env ? { env: options.env } : {}),
  });
  const parsed = parseDfOutput(stdout);
  return { ...parsed, targets };
}

export async function measureMinFreeBytes(primaryPaths = [], options = {}) {
  const targets = collectWorkerDiskPaths(primaryPaths, options);
  const statfsImpl = options.statfsImpl || fsPromises.statfs;
  const rows = await Promise.all(
    targets.map(async (target) => {
      const info = await statfsImpl(target);
      const bytes = Number(info.bavail) * Number(info.bsize);
      if (!Number.isFinite(bytes) || bytes < 0) {
        throw new Error(`Cannot read disk free space for ${target}`);
      }
      return { target, bytes };
    }),
  );
  let minRow = rows[0];
  for (const row of rows.slice(1)) {
    if (row.bytes < minRow.bytes) minRow = row;
  }
  return {
    bytes: minRow.bytes,
    bottleneckPath: minRow.target,
    rows,
    targets,
  };
}

export async function measureMinFreeGb(primaryPaths = [], options = {}) {
  const { bytes } = await measureMinFreeBytes(primaryPaths, options);
  return bytes / 1024 ** 3;
}
