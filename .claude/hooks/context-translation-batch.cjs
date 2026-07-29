#!/usr/bin/env node
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function findRoot(start) {
  let current = path.resolve(start || process.cwd());
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function readInput() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return {}; }
}

function eventPaths(event) {
  const paths = [
    event?.tool_response?.filePath,
    event?.tool_response?.file_path,
    event?.tool_input?.file_path,
    event?.tool_input?.path,
  ].filter((value) => typeof value === 'string' && value);
  const patch = String(event?.tool_input?.patch ?? event?.tool_input?.command ?? '');
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s+(.+?)\s*$/gm)) paths.push(match[1]);
  for (const match of patch.matchAll(/^\*\*\* Move to:\s+(.+?)\s*$/gm)) paths.push(match[1]);
  return [...new Set(paths)];
}

function queuePath(root) {
  return path.join(root, '.agents', 'work', 'context-translation-queue.json');
}

function claimPath(root) {
  return path.join(root, '.agents', 'work', 'context-translation-claim.json');
}

function lockPath(root) {
  return path.join(root, '.agents', 'work', 'context-translation-queue.lock');
}

function flushLockPath(root) {
  return path.join(root, '.agents', 'work', 'context-translation-flush.lock');
}

function readFiles(target) {
  try {
    const value = JSON.parse(fs.readFileSync(target, 'utf8'));
    return Array.isArray(value.files) ? value.files.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}

function writeFiles(target, files) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = target + '.tmp-' + process.pid;
  fs.writeFileSync(temp, JSON.stringify({ schema_version: 1, files: [...new Set(files)].sort() }, null, 2) + '\n');
  fs.renameSync(temp, target);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function withQueueLock(root, fn) {
  const lock = lockPath(root);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
      try { return fn(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stale = Date.now() - fs.statSync(lock).mtimeMs > 60_000;
        let owner = null;
        try { owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')); } catch {}
        if (stale && (!owner || !processAlive(owner.pid))) {
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {}
      Atomics.wait(WAIT_ARRAY, 0, 0, 10);
    }
  }
  throw new Error('context translation queue lock timeout');
}

function withFlushLock(root, fn) {
  const lock = flushLockPath(root);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try {
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try {
      const stale = Date.now() - fs.statSync(lock).mtimeMs > 360_000;
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')); } catch {}
      if (stale && (!owner || !processAlive(owner.pid))) {
        fs.rmSync(lock, { recursive: true, force: true });
        return withFlushLock(root, fn);
      }
    } catch {}
    return 0;
  }
  try { return fn(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

function readQueue(root) {
  return withQueueLock(root, () => readFiles(queuePath(root)));
}

function writeQueue(root, files) {
  return withQueueLock(root, () => writeFiles(queuePath(root), files));
}

function queueChangedFile(root, changed) {
  const relative = path.relative(root, path.resolve(changed)).replaceAll('\\', '/');
  const match = relative.match(/^\.users\/context\/([^/]+)\.md$/);
  if (!match) return false;
  withQueueLock(root, () => writeFiles(queuePath(root), [...readFiles(queuePath(root)), match[1]]));
  return true;
}

function claimBatch(root) {
  return withQueueLock(root, () => {
    const files = [...new Set([...readFiles(claimPath(root)), ...readFiles(queuePath(root))])].sort();
    if (!files.length) return [];
    writeFiles(claimPath(root), files);
    writeFiles(queuePath(root), []);
    return files;
  });
}

function finishBatch(root, files, success) {
  withQueueLock(root, () => {
    if (!success) writeFiles(queuePath(root), [...readFiles(queuePath(root)), ...files]);
    try { fs.rmSync(claimPath(root), { force: true }); } catch {}
  });
}

function flush(root) {
  return withFlushLock(root, () => {
    while (true) {
      const files = claimBatch(root);
      if (!files.length) return 0;
      const python = process.platform === 'win32' ? 'python' : 'python3';
      const script = path.join(root, 'scripts', 'i18n', 'translate-ctx.py');
      const env = { ...process.env };
      if (process.platform === 'win32') {
        env.TEMP = env.I18N_TEMP_DIR || path.join(root, '.agents', 'work');
        env.TMP = env.TEMP;
      }
      const result = cp.spawnSync(python, [script, '--only', files.join(',')], {
        cwd: root, env, encoding: 'utf8', timeout: 300000,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      const success = !result.error && result.status === 0;
      finishBatch(root, files, success);
      if (!success) return result.status || 1;
    }
  });
}

function main() {
  const root = findRoot(process.cwd());
  if (!root) return 0;
  if (process.argv.includes('--flush')) return flush(root);
  const queued = eventPaths(readInput())
    .map((changed) => path.isAbsolute(changed) ? changed : path.resolve(root, changed))
    .filter((changed) => queueChangedFile(root, changed));
  if (queued.length) console.log('[context-translation] queued ' + queued.map((item) => path.basename(item)).join(', '));
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { claimBatch, eventPaths, findRoot, finishBatch, flush, queueChangedFile, readQueue, withFlushLock, withQueueLock, writeQueue };
