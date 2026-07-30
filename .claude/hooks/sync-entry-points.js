#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const ENTRY_POINTS = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];

function findRepoRoot(start) {
  let current = path.resolve(start || process.cwd());
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function eventFilePath(event) {
  return event?.tool_response?.filePath || event?.tool_response?.file_path ||
    event?.tool_input?.file_path || event?.tool_input?.path || String();
}

function atomicCopy(source, destination) {
  const temp = `${destination}.sync-${process.pid}.tmp`;
  fs.copyFileSync(source, temp);
  fs.renameSync(temp, destination);
}

function syncEntryPoints(root, changed) {
  const changedName = path.basename(changed);
  if (!ENTRY_POINTS.includes(changedName) || path.dirname(path.resolve(changed)) !== path.resolve(root)) return [];
  // AGENTS.md is the only source of truth. Editing a tool-specific mirror must
  // never overwrite the canonical contract; restore all mirrors from AGENTS.
  const source = path.join(root, 'AGENTS.md');
  if (!fs.existsSync(source)) return [];
  const sourceBytes = fs.readFileSync(source);
  const updated = [];
  for (const name of ENTRY_POINTS.slice(1)) {
    const target = path.join(root, name);
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(sourceBytes)) {
      atomicCopy(source, target);
      updated.push(name);
    }
  }
  return updated;
}

function checkEntryPoints(root) {
  const canonical = fs.readFileSync(path.join(root, 'AGENTS.md'));
  return ENTRY_POINTS.slice(1).filter((name) =>
    !fs.existsSync(path.join(root, name)) || !fs.readFileSync(path.join(root, name)).equals(canonical));
}

function readHookInput() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return {}; }
}

function runHook() {
  const root = findRepoRoot(process.cwd());
  if (!root) return 0;
  if (process.argv.includes('--check')) return checkEntryPoints(root).length ? 1 : 0;
  const inputPath = eventFilePath(readHookInput());
  if (!inputPath) return 0;
  const changed = path.isAbsolute(inputPath) ? inputPath : path.resolve(root, inputPath);
  const updated = syncEntryPoints(root, changed);
  if (updated.length) console.log('[entry-sync] updated ' + updated.join(', '));
  return 0;
}

if (require.main === module) process.exitCode = runHook();
module.exports = { ENTRY_POINTS, checkEntryPoints, eventFilePath, findRepoRoot, syncEntryPoints };
