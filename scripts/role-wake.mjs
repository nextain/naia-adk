#!/usr/bin/env node
// Role wake single source. One instance file names the live workspace, the wake
// boxes and every role; delivery, consumer checks, the role-session table and
// wake-box retention all read that file. See docs/guides/role-wake-registry.md.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh']);
const WRAPPERS = new Set(['sudo', 'env', 'nice', 'setsid', 'stdbuf', 'timeout']);
const INTERPRETERS = new Set(['node', 'python3', 'python']);
const VIEW_KINDS = new Set(['l4-roles', 'wake-routes', 'liveness', 'session-health', 'bot-mention-wake']);
const DEFAULTS = { heartbeatMaxAge: 300, maxPerRun: 50, lagSeconds: 600, retryMaxSeconds: 300, deliveredDays: 3, maxBoxFiles: 500, repeatSeconds: 3600, dmBackupMaxAge: 900 };
const FALLBACK_TOOL_CAPS = Object.freeze({ bgNotify: false, submitKeys: Object.freeze(['Enter']) });
const TOOL_CAPS_DEFAULTS = Object.assign(Object.create(null), {
  claude: { bgNotify: true, submitKeys: ['Enter'] },
  codex: { bgNotify: false, submitKeys: ['Enter', 'Tab'] },
  // agy matches the instance configuration; muse has no instance override and
  // keeps the existing conservative false/Enter fallback.
  agy: { bgNotify: false, submitKeys: ['Enter'] },
  muse: { bgNotify: false, submitKeys: ['Enter'] },
  opencode: { bgNotify: false, submitKeys: ['Enter'] },
});
const KNOWN_TOOL_NAMES = Object.keys(TOOL_CAPS_DEFAULTS);
// A role whose session is down fails every file; stop that role for the run after this many in a row.
const FAIL_STREAK = 3;
// One run is bounded by max_per_run and the command timeouts; a lock older than this has no running owner.
const LOCK_UNVERIFIED_MAX_MS = 30 * 60_000;
const SNOWFLAKE = /^\d{17,20}$/;
const ROLE_ID = /^[a-zA-Z0-9_-]+$/;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(message); };
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const positive = (value, fallback, name) => value === undefined ? fallback : Number.isFinite(value) && value > 0 ? value : fail(`${name} must be a positive number`);

function editDistance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(current[column - 1] + 1, previous[column] + 1, previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[right.length];
}

function toolTypo(value) {
  if (KNOWN_TOOL_NAMES.includes(value)) return null;
  const limit = value.length < 4 ? 1 : 2;
  const matches = KNOWN_TOOL_NAMES.map(name => [name, editDistance(value, name)]).filter(([, distance]) => distance <= limit).sort((left, right) => left[1] - right[1]);
  return matches[0]?.[0] ?? null;
}

function normalizedToolName(value, label) {
  if (typeof value !== 'string' || !ROLE_ID.test(value)) fail(`${label} has invalid tool ${value}`);
  const normalized = value.toLowerCase();
  const suggestion = toolTypo(normalized);
  if (suggestion) fail(`${label} tool ${value} looks like a typo of known tool ${suggestion}`);
  return normalized;
}

function validateToolCaps(value) {
  if (value === undefined) return { bg_notify: {}, submit_keys: {} };
  if (!isObject(value)) fail('tool_caps must be an object');
  if (Object.keys(value).some(key => !['bg_notify', 'submit_keys'].includes(key))) fail('tool_caps has an unsupported capability');
  const bgNotify = value.bg_notify === undefined ? {} : value.bg_notify;
  const submitKeys = value.submit_keys === undefined ? {} : value.submit_keys;
  if (!isObject(bgNotify)) fail('tool_caps.bg_notify must be an object');
  if (!isObject(submitKeys)) fail('tool_caps.submit_keys must be an object');
  const normalizeEntries = (entries, capability) => {
    const normalized = Object.create(null);
    for (const [tool, setting] of Object.entries(entries)) {
      const name = normalizedToolName(tool, `tool_caps.${capability}`);
      if (Object.hasOwn(normalized, name)) fail(`tool_caps.${capability} has duplicate tool ${name} after lowercase normalization`);
      if (capability === 'bg_notify' && typeof setting !== 'boolean') fail(`tool_caps.bg_notify.${tool} must be a boolean`);
      if (capability === 'submit_keys' && (!Array.isArray(setting) || !setting.length || setting.some(key => typeof key !== 'string' || !key.trim()))) {
        fail(`tool_caps.submit_keys.${tool} must be a non-empty string array`);
      }
      normalized[name] = capability === 'submit_keys' ? [...setting] : setting;
    }
    return normalized;
  };
  const normalizedBgNotify = normalizeEntries(bgNotify, 'bg_notify');
  const normalizedSubmitKeys = normalizeEntries(submitKeys, 'submit_keys');
  return { bg_notify: normalizedBgNotify, submit_keys: normalizedSubmitKeys };
}

function configuredToolCap(map, tool) {
  if (!isObject(map)) return { found: false };
  const key = Object.keys(map).find(name => name.toLowerCase() === tool);
  return key === undefined ? { found: false } : { found: true, value: map[key] };
}

export function resolveToolCaps(config, role) {
  const requestedTool = role?.tool ?? role?.tools?.[0];
  if (typeof requestedTool !== 'string' || !requestedTool) fail('role tool is required to resolve tool_caps');
  const tool = requestedTool.toLowerCase();
  const defaults = Object.hasOwn(TOOL_CAPS_DEFAULTS, tool) ? TOOL_CAPS_DEFAULTS[tool] : FALLBACK_TOOL_CAPS;
  const configured = config?.tool_caps ?? {};
  const bgOverride = configuredToolCap(configured.bg_notify, tool);
  const keysOverride = configuredToolCap(configured.submit_keys, tool);
  const bgNotify = bgOverride.found ? bgOverride.value : defaults.bgNotify;
  const submitKeys = keysOverride.found ? keysOverride.value : defaults.submitKeys;
  return { bgNotify, submitKeys: [...submitKeys] };
}

function rejectUnusedToolCaps(toolCaps, usedTools) {
  for (const capability of ['bg_notify', 'submit_keys']) {
    for (const tool of Object.keys(toolCaps[capability])) {
      if (!usedTools.has(tool)) fail(`tool_caps.${capability}.${tool} is unused; no role declares this tool`);
    }
  }
}

function atomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function loadRegistry(file) {
  const doc = readJson(file);
  if (!isObject(doc) || doc.schema_version !== 1) fail('schema_version must be 1');
  if (typeof doc.root !== 'string' || !path.isAbsolute(doc.root)) fail('root must be an absolute path');
  if (typeof doc.state_dir !== 'string' || !path.isAbsolute(doc.state_dir)) fail('state_dir must be an absolute path');
  const root = path.resolve(doc.root);
  const inRoot = (value, name) => {
    if (typeof value !== 'string' || !value) fail(`${name} must be a path`);
    const resolved = path.resolve(root, value);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) fail(`${name} must stay inside root`);
    return resolved;
  };
  const wakeRoot = inRoot(doc.wake_root, 'wake_root');
  const toolCaps = validateToolCaps(doc.tool_caps);
  const retiredRoots = (doc.retired_roots ?? []).map(value => typeof value === 'string' && path.isAbsolute(value) ? path.resolve(value) : fail('retired_roots must be absolute paths'));
  if (retiredRoots.some(value => value === root || root.startsWith(value + path.sep))) fail('root is inside a retired root');
  const delivery = doc.delivery === undefined ? null : {
    command: Array.isArray(doc.delivery?.command) && doc.delivery.command.length && doc.delivery.command.every(part => typeof part === 'string') ? doc.delivery.command : fail('delivery.command must be a string array'),
    heartbeatMaxAge: positive(doc.delivery.heartbeat_max_age_seconds, DEFAULTS.heartbeatMaxAge, 'delivery.heartbeat_max_age_seconds'),
    maxPerRun: positive(doc.delivery.max_per_run, DEFAULTS.maxPerRun, 'delivery.max_per_run'),
    lagSeconds: positive(doc.delivery.lag_seconds, DEFAULTS.lagSeconds, 'delivery.lag_seconds'),
    retryMaxSeconds: positive(doc.delivery.retry_max_seconds, DEFAULTS.retryMaxSeconds, 'delivery.retry_max_seconds'),
    baselineSeenFile: doc.delivery.baseline_seen_file === undefined ? null : typeof doc.delivery.baseline_seen_file === 'string' && path.isAbsolute(doc.delivery.baseline_seen_file) ? doc.delivery.baseline_seen_file : fail('delivery.baseline_seen_file must be an absolute path'),
  };
  if (delivery && !delivery.command.some(part => part.includes('{file}'))) fail('delivery.command needs a {file} placeholder');
  const retention = {
    deliveredDays: positive(doc.retention?.delivered_days, DEFAULTS.deliveredDays, 'retention.delivered_days'),
    maxBoxFiles: positive(doc.retention?.max_box_files, DEFAULTS.maxBoxFiles, 'retention.max_box_files'),
    archiveDir: inRoot(doc.retention?.archive_dir ?? `${doc.wake_root}-archive`, 'retention.archive_dir'),
  };
  if (retention.archiveDir === wakeRoot || retention.archiveDir.startsWith(wakeRoot + path.sep)) fail('retention.archive_dir must be outside wake_root');
  if (doc.role_views !== undefined && !Array.isArray(doc.role_views)) fail('role_views must be an array');
  const roleViews = (doc.role_views ?? []).map(view => {
    if (!isObject(view) || !VIEW_KINDS.has(view.kind) || typeof view.path !== 'string' || !path.isAbsolute(view.path)) fail('invalid role_views entry');
    if (view.roles !== undefined && (!Array.isArray(view.roles) || !view.roles.length || view.roles.some(id => typeof id !== 'string' || !id.trim()))) fail('role_views roles must be a non-empty string array');
    return { kind: view.kind, path: view.path, roles: view.roles === undefined ? null : [...new Set(view.roles)] };
  });
  if (!isObject(doc.roles) || !Object.keys(doc.roles).length) fail('roles must be a non-empty object');
  const bots = new Set(), dirs = new Set(), panes = new Set();
  const roles = Object.entries(doc.roles).map(([id, role]) => {
    if (!ROLE_ID.test(id) || !isObject(role)) fail(`invalid role ${id}`);
    const declaredTools = role.tools ?? (role.tool ? [role.tool] : []);
    if (!Array.isArray(declaredTools) || !declaredTools.length || declaredTools.some(name => typeof name !== 'string' || !ROLE_ID.test(name))) fail(`role ${id}: tools must list at least one tool`);
    const tools = declaredTools.map(name => normalizedToolName(name, `role ${id}`));
    let tool = tools[0];
    if (role.tool !== undefined) {
      const normalizedPrimary = normalizedToolName(role.tool, `role ${id}`);
      if (normalizedPrimary !== tools[0]) fail(`role ${id}: tool must equal tools[0] after lowercase normalization`);
      tool = normalizedPrimary;
    }
    const caps = resolveToolCaps({ tool_caps: toolCaps }, { tool });
    if (typeof role.wake_subdir !== 'string' || role.wake_subdir.includes('/') || role.wake_subdir.startsWith('.')) fail(`role ${id}: wake_subdir must be one folder name or ""`);
    const wakeDir = path.join(wakeRoot, role.wake_subdir);
    const paneId = role.find?.pane_id;
    if (typeof paneId !== 'string' || !paneId) fail(`role ${id}: find.pane_id is required`);
    if (role.bot_id !== undefined && !SNOWFLAKE.test(role.bot_id)) fail(`role ${id}: invalid bot_id`);
    if (dirs.has(wakeDir) || panes.has(paneId) || (role.bot_id && bots.has(role.bot_id))) fail(`role ${id}: duplicate wake_subdir, pane or bot_id`);
    dirs.add(wakeDir); panes.add(paneId); if (role.bot_id) bots.add(role.bot_id);
    // A box another account owns, outside root. `via` is the command prefix that can read it.
    const extraBoxes = (role.extra_boxes ?? []).map(box => {
      if (!isObject(box) || typeof box.path !== 'string' || !path.isAbsolute(box.path)) fail(`role ${id}: extra_boxes path must be absolute`);
      if (box.via !== undefined && !(Array.isArray(box.via) && box.via.length && box.via.every(part => typeof part === 'string' && part))) fail(`role ${id}: extra_boxes via must be a command prefix`);
      const dir = path.resolve(box.path);
      if (dirs.has(dir)) fail(`role ${id}: duplicate wake box ${dir}`);
      dirs.add(dir);
      return { dir, via: box.via ?? null };
    });
    const dmChannels = role.dm_channels ?? [];
    if (!Array.isArray(dmChannels) || dmChannels.some(channel => typeof channel !== 'string' || !SNOWFLAKE.test(channel))) fail(`role ${id}: dm_channels must be channel ids`);
    // A DM room known only by the person on the other side; the gateway tool finds the room.
    const dmUsers = role.dm_users ?? [];
    if (!Array.isArray(dmUsers) || dmUsers.some(user => typeof user !== 'string' || !SNOWFLAKE.test(user))) fail(`role ${id}: dm_users must be user ids`);
    let wait = null;
    if (role.wait !== undefined) {
      if (!isObject(role.wait) || typeof role.wait.script !== 'string' || !path.isAbsolute(role.wait.script)) fail(`role ${id}: wait.script must be an absolute path`);
      wait = { script: role.wait.script, mode: role.wait.mode ?? 'nudge' };
    }
    if (!wait && !delivery) fail(`role ${id}: no wake consumer (declare delivery or wait)`);
    if (tools.some(candidate => !resolveToolCaps({ tool_caps: toolCaps }, { tool: candidate }).bgNotify) && !delivery) {
      fail(`role ${id}: bg_notify=false tool requires delivery.command as a direct pane consumer`);
    }
    return { id, names: Array.isArray(role.names) && role.names.length ? role.names : [id], botId: role.bot_id ?? null, user: role.user ?? null, paneId, cwd: role.find.cwd ?? null, tool, tools, bgNotify: caps.bgNotify, submitKeys: caps.submitKeys, wakeSubdir: role.wake_subdir, wakeDir, extraBoxes, dmChannels, dmUsers, wait };
  });
  rejectUnusedToolCaps(toolCaps, new Set(roles.flatMap(role => role.tools)));
  const paneBin = doc.pane?.bin;
  if (doc.pane?.kind !== 'herdr' || typeof paneBin !== 'string' || !path.isAbsolute(paneBin)) fail('pane must be {"kind":"herdr","bin":"/abs/path"}');
  const notify = doc.notify === undefined ? null : {
    command: Array.isArray(doc.notify?.command) && doc.notify.command.some(part => typeof part === 'string' && part.includes('{text}')) ? doc.notify.command : fail('notify.command needs a {text} placeholder'),
    repeatSeconds: positive(doc.notify.repeat_seconds, DEFAULTS.repeatSeconds, 'notify.repeat_seconds'),
  };
  const unitDirs = (doc.unit_dirs ?? []).map(value => typeof value === 'string' && path.isAbsolute(value) ? value : fail('unit_dirs must be absolute paths'));
  const dmBackupMaxAge = positive(doc.dm_backup?.max_age_seconds, DEFAULTS.dmBackupMaxAge, 'dm_backup.max_age_seconds');
  return { file: path.resolve(file), root, wakeRoot, stateDir: path.resolve(doc.state_dir), retiredRoots, unitDirs, paneBin, delivery, retention, roleViews, notify, dmBackupMaxAge, toolCaps, roles };
}

// Wake files of one role across its boxes, in arrival order (mtime, then name):
// box names mix clocks and free titles, so name order is not time order. A box
// that cannot be read is an error for the caller to report, never an empty box
// (`unreadable` lists those boxes). `key` is the ledger name: the bare file name
// in the role's own box, the full path in an extra box.
export function boxEntries(role, deps = defaultDeps()) {
  const entries = [], errors = [], unreadable = [];
  const missed = (dir, error) => { unreadable.push(dir); errors.push(`${dir}: ${error?.code === 'ENOENT' ? 'not found' : 'unreadable'}`); };
  try {
    for (const entry of fs.readdirSync(role.wakeDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const file = path.join(role.wakeDir, entry.name);
      let mtimeMs;
      try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
      entries.push({ key: entry.name, name: entry.name, file, mtimeMs, box: null });
    }
  } catch (error) { missed(role.wakeDir, error); }
  for (const box of role.extraBoxes) {
    try {
      if (box.via) {
        const [command, ...prefix] = box.via;
        const listing = deps.run(command, [...prefix, 'find', box.dir, '-maxdepth', '1', '-type', 'f', '-name', '*.md', '-printf', '%T@\\t%f\\n']);
        for (const line of listing.split('\n')) {
          const match = /^(\d+(?:\.\d+)?)\t(.+\.md)$/.exec(line);
          if (match) entries.push({ key: path.join(box.dir, match[2]), name: match[2], file: path.join(box.dir, match[2]), mtimeMs: Number(match[1]) * 1000, box });
        }
      } else {
        for (const entry of fs.readdirSync(box.dir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
          const file = path.join(box.dir, entry.name);
          let mtimeMs;
          try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
          entries.push({ key: file, name: entry.name, file, mtimeMs, box });
        }
      }
    } catch (error) { missed(box.dir, error); }
  }
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { entries, errors, unreadable };
}

// The words that name what a process runs: the command after wrappers, and for a
// shell or interpreter the script it was given. Arguments of any other program
// (`vim claude.log`) say nothing about the program.
function programWords(argv) {
  const words = [];
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index];
    const base = path.basename(word).replace(/^-/, '');
    if (!base) continue;
    if (WRAPPERS.has(base)) {
      // Skip the wrapper's own options, `VAR=value` and numeric operands; `sudo -iu <user>` takes a value.
      while (index + 1 < argv.length && (argv[index + 1].startsWith('-') || /^\w+=/.test(argv[index + 1]) || /^\d+(\.\d+)?[smhd]?$/.test(argv[index + 1]))) {
        index += 1;
        if ((base === 'sudo' && /^-[a-zA-Z]*[ugCDhpRrTt]$/.test(argv[index])) || (base === 'env' && argv[index] === '-u')) index += 1;
      }
      continue;
    }
    words.push(base);
    if (SHELLS.has(base) || INTERPRETERS.has(base)) {
      const script = argv.slice(index + 1).find(next => !next.startsWith('-'));
      if (script) words.push(path.basename(script.trim().split(/\s+/)[0]));
    }
    break;
  }
  return words;
}

// A pane whose foreground is only a shell has no agent, whatever tool the registry names.
export function detectTool(processes, knownTools) {
  let sawProgram = false;
  for (const proc of processes ?? []) {
    const argv = Array.isArray(proc.argv) && proc.argv.length ? proc.argv : String(proc.cmdline ?? proc.name ?? '').split(/\s+/).filter(Boolean);
    const words = programWords(argv);
    for (const word of words) {
      const normalizedWord = word.toLowerCase();
      const tool = knownTools.find(name => normalizedWord === name.toLowerCase() || normalizedWord.startsWith(`${name.toLowerCase()}-`) || normalizedWord.startsWith(`${name.toLowerCase()}.`));
      if (tool) return { alive: true, tool: tool.toLowerCase() };
    }
    if (words.some(word => !SHELLS.has(word) && !INTERPRETERS.has(word))) sawProgram = true;
  }
  return sawProgram ? { alive: true, tool: 'unknown' } : { alive: false, tool: 'shell' };
}

function knownToolsFor(registry) {
  return [...new Set([...registry.roles.flatMap(role => role.tools), 'claude', 'codex', 'agy', 'muse', 'opencode'])].sort((left, right) => right.length - left.length);
}

function runningToolCaps(registry, role, deps) {
  const foreground = deps.paneProcesses(registry.paneBin, role.paneId);
  const running = detectTool(foreground, knownToolsFor(registry));
  if (!running.alive) fail(`role ${role.id}: pane ${role.paneId} runs only a shell`);
  if (!role.tools.includes(running.tool)) fail(`role ${role.id}: pane runs ${running.tool}, registry allows ${role.tools.join(', ')}`);
  return { tool: running.tool, ...resolveToolCaps({ tool_caps: registry.toolCaps }, { tool: running.tool }) };
}

export function defaultDeps() {
  const run = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', timeout: 20_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  return {
    now: () => Date.now(),
    run,
    paneProcesses: (bin, paneId) => JSON.parse(run(bin, ['pane', 'process-info', '--pane', paneId])).result.process_info.foreground_processes,
    processes: () => run('ps', ['-ww', '-eo', 'pid=,ppid=,args=']).split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean).map(match => ({ pid: Number(match[1]), ppid: Number(match[2]), args: match[3] })),
    crontab: () => run('crontab', ['-l']),
  };
}

// Same rule as the existing pane liveness tool: a wait script counts only when the
// pane's agent started it; a leftover from a dead session has no reader. Without
// the pane's own pids that cannot be shown, so the answer is no.
export function waitRunning(processes, script, rootPids) {
  const byPid = new Map(processes.map(proc => [proc.pid, proc]));
  const roots = new Set(rootPids.filter(pid => byPid.has(pid)));
  return processes.some(proc => {
    const words = proc.args.split(/\s+/);
    if (!SHELLS.has(path.basename(words[0] ?? '').replace(/^-/, ''))) return false;
    const target = words.slice(1).find(word => !word.startsWith('-'));
    if (target !== script) return false;
    if (!roots.size) return false;
    for (let pid = proc.ppid, hops = 0; byPid.has(pid) && hops < 64; pid = byPid.get(pid).ppid, hops += 1) if (roots.has(pid)) return true;
    return false;
  });
}

const ledgerFile = (registry, role) => path.join(registry.stateDir, `delivered-${role.id}.jsonl`);
const heartbeatFile = registry => path.join(registry.stateDir, 'deliver-heartbeat.json');
export function readLedger(registry, role) {
  let text;
  try { text = fs.readFileSync(ledgerFile(registry, role), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const names = new Set();
  for (const line of text.split('\n')) { if (!line) continue; try { names.add(JSON.parse(line).file); } catch { /* a torn last line is retried */ } }
  return names;
}

const failureFile = (registry, role) => path.join(registry.stateDir, `failed-${role.id}.json`);
export function readFailures(registry, role) {
  try { const doc = readJson(failureFile(registry, role)); return isObject(doc) ? doc : {}; } catch { return {}; }
}

// Start time of a process, so a recycled pid is not mistaken for the lock owner.
function processStart(pid) {
  try { const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null; } catch { return null; }
}

// A lock is stale when it names no process (empty or damaged file), a dead
// process, or a pid that now belongs to a process started at another time. A
// live pid whose start time cannot be compared (the lock does not carry one, or
// the process table cannot be read) holds the lock only while the lock is recent.
function lockIsStale(text, ageMs) {
  let owner = null;
  try { owner = JSON.parse(text); } catch { /* damaged */ }
  const pid = Number.isSafeInteger(owner) ? owner : owner?.pid;
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return true; }
  const start = processStart(pid);
  if (typeof owner?.start !== 'string' || start === null) return ageMs > LOCK_UNVERIFIED_MAX_MS;
  return start !== owner.start;
}

function acquireLock(registry) {
  fs.mkdirSync(registry.stateDir, { recursive: true, mode: 0o700 });
  const lock = path.join(registry.stateDir, 'deliver.lock');
  const mine = JSON.stringify({ pid: process.pid, start: processStart(process.pid), at: new Date().toISOString() });
  const release = () => { try { if (fs.readFileSync(lock, 'utf8') === mine) fs.rmSync(lock, { force: true }); } catch { /* already gone */ } };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // Written in full, then linked: the lock never exists half-written.
    const temp = `${lock}.${process.pid}.tmp`;
    fs.writeFileSync(temp, mine, { mode: 0o600 });
    try { fs.linkSync(temp, lock); return release; } catch (error) { if (error.code !== 'EEXIST') throw error; } finally { fs.rmSync(temp, { force: true }); }
    let text, ageMs;
    try { text = fs.readFileSync(lock, 'utf8'); ageMs = Date.now() - fs.statSync(lock).mtimeMs; } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!lockIsStale(text, ageMs)) return null;
    // Take the stale lock aside; if another run replaced it meanwhile, put that one back.
    const aside = `${lock}.stale.${process.pid}`;
    try { fs.renameSync(lock, aside); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const taken = fs.readFileSync(aside, 'utf8');
    if (taken !== text) { try { fs.linkSync(aside, lock); } catch { /* a newer lock exists */ } fs.rmSync(aside, { force: true }); return null; }
    fs.rmSync(aside, { force: true });
  }
  return null;
}

// The old deliverer's record (one delivered path per line), used once per role to
// take over without replaying what it delivered or swallowing what it did not.
function readSeenFile(file) {
  return new Set(fs.readFileSync(file, 'utf8').split('\n').map(line => line.trim()).filter(Boolean).map(line => path.resolve(line)));
}

// Runs the delivery command on one wake file. A file in a box read through `via`
// is copied to a private spool first and the copy is delivered.
function handOver(registry, role, entry, deps, caps) {
  let file = entry.file, spooled = null;
  try {
    if (entry.box?.via) {
      const [reader, ...prefix] = entry.box.via;
      const body = deps.run(reader, [...prefix, 'cat', entry.file]);
      spooled = path.join(registry.stateDir, 'spool', role.id, entry.name);
      fs.mkdirSync(path.dirname(spooled), { recursive: true, mode: 0o700 });
      fs.writeFileSync(spooled, body, { mode: 0o600 });
      file = spooled;
    }
    const [command, ...args] = registry.delivery.command.map(part => part.replaceAll('{role}', role.id).replaceAll('{file}', file));
    deps.run(command, args, {
      timeout: 60_000,
      env: {
        ...process.env,
        ROLE_WAKE_TOOL: caps.tool,
        ROLE_WAKE_SUBMIT_KEYS: JSON.stringify(caps.submitKeys),
        ROLE_WAKE_BG_NOTIFY: String(caps.bgNotify),
      },
    });
  } finally { if (spooled) fs.rmSync(spooled, { force: true }); }
}

const boxMark = box => `box:${box.dir}`;
function deliverRole(registry, role, deps, now, at) {
  const { entries, errors, unreadable } = boxEntries(role, deps);
  const append = (keys, status) => { if (keys.length) fs.appendFileSync(ledgerFile(registry, role), keys.map(file => `${JSON.stringify({ file, at, status })}\n`).join(''), { mode: 0o600 }); };
  const error = errors.length ? { error: errors.join('; ') } : {};
  let seen = readLedger(registry, role);
  // Boxes looked at for the first time: the role's own box while it has no
  // ledger, an extra box until the ledger carries its mark. Such a box is
  // recorded, not replayed; with the old deliverer's record, only what that
  // record lists is taken as delivered. A box that cannot be read stays new.
  const firstLook = [];
  if (seen === null) {
    if (unreadable.includes(role.wakeDir)) return { delivered: 0, failed: 0, pending: 0, ...error };
    firstLook.push(null);
  }
  for (const box of role.extraBoxes) if (!seen?.has(boxMark(box)) && !unreadable.includes(box.dir)) firstLook.push(box);
  let baseline = null;
  if (firstLook.length) {
    const old = registry.delivery.baselineSeenFile ? readSeenFile(registry.delivery.baselineSeenFile) : null;
    const known = entries.filter(entry => firstLook.includes(entry.box) && (!old || old.has(entry.file)));
    fs.writeFileSync(ledgerFile(registry, role), '', { flag: 'a', mode: 0o600 });
    append(known.map(entry => entry.key), 'baseline');
    append(firstLook.filter(Boolean).map(boxMark), 'box');
    baseline = known.length;
    seen = new Set([...(seen ?? []), ...known.map(entry => entry.key)]);
  }
  const fresh = entries.filter(entry => !seen.has(entry.key));
  const before = readFailures(registry, role);
  const failures = Object.fromEntries(Object.entries(before).filter(([key]) => fresh.some(entry => entry.key === key)));
  // New files first, then retries, fewest failures first: a file that keeps
  // failing never stands in front of the others. Later files may overtake it;
  // it is retried with backoff.
  const retries = fresh.filter(entry => failures[entry.key] && failures[entry.key].next <= now).sort((a, b) => failures[a.key].count - failures[b.key].count);
  const order = [...fresh.filter(entry => !failures[entry.key]), ...retries];
  const caps = order.length ? runningToolCaps(registry, role, deps) : null;
  let delivered = 0, attempts = 0, streak = 0;
  for (const entry of order) {
    if (attempts >= registry.delivery.maxPerRun || streak >= FAIL_STREAK) break;
    attempts += 1;
    let ok = true;
    try { handOver(registry, role, entry, deps, caps); } catch { ok = false; }
    if (ok) {
      append([entry.key], 'delivered');
      delete failures[entry.key];
      delivered += 1; streak = 0;
    } else {
      const count = (failures[entry.key]?.count ?? 0) + 1;
      failures[entry.key] = { count, first: failures[entry.key]?.first ?? at, last: at, next: now + Math.min(registry.delivery.retryMaxSeconds, 60 * 2 ** Math.min(count - 1, 20)) * 1000 };
      streak += 1;
    }
  }
  if (JSON.stringify(failures) !== JSON.stringify(before)) atomic(failureFile(registry, role), JSON.stringify(failures));
  return { ...(baseline === null ? {} : { baseline }), delivered, failed: Object.keys(failures).length, pending: fresh.length - delivered, ...error };
}

// Hands each new wake file to the instance delivery command, in arrival order. A
// box seen for the first time is recorded, not replayed. A failed file is kept
// for retry and reported; it stops neither the files behind it nor other roles.
export function deliver(registry, deps = defaultDeps(), { only = null } = {}) {
  if (!registry.delivery) fail('delivery is not configured');
  const release = acquireLock(registry);
  if (!release) return { skipped: 'locked' };
  try {
    const now = deps.now();
    const at = new Date(now).toISOString();
    const summary = {};
    for (const role of registry.roles) {
      if (only && role.id !== only) continue;
      try { summary[role.id] = deliverRole(registry, role, deps, now, at); } catch (error) { summary[role.id] = { delivered: 0, failed: 0, pending: 0, aborted: true, error: String(error?.code ?? error?.message ?? error).split('\n')[0] }; }
    }
    if (!only) {
      // `at` says the runner is alive; `ok_at` moves only on a run with nothing failing.
      const clean = Object.values(summary).every(role => !role.failed && !role.error);
      let okAt = null;
      try { okAt = readJson(heartbeatFile(registry)).ok_at ?? null; } catch { /* first run */ }
      atomic(heartbeatFile(registry), JSON.stringify({ at, ok_at: clean ? at : okAt, roles: summary }));
    }
    return { at, roles: summary };
  } finally { release(); }
}

const VIEW_READERS = {
  'l4-roles': doc => (doc.roles ?? []).map(role => ({ id: role.id, botId: role.botUserIds?.[0] })),
  'wake-routes': doc => Object.entries(doc.roles ?? {}).map(([id, role]) => ({ id, botId: role.bot_id, wakeSubdir: role.wake_subdir })),
  liveness: doc => Object.entries(doc.roles ?? {}).map(([id, role]) => ({ id, tool: role.tool, paneId: role.find?.pane_id })),
  'session-health': doc => (doc.roles ?? []).map(role => ({ id: role.id, botId: role.botId })),
  'bot-mention-wake': doc => (doc.roles ?? []).map(role => ({ id: role.id, botId: role.botUserId, dmChannels: role.dmChannelIds ?? [], dmUsers: role.dmUserIds ?? [] })),
};

// Other tools still keep their own role lists. Until each reads the registry, this
// names every list that disagrees with it.
export function compareViews(registry) {
  const findings = [];
  const byId = new Map(registry.roles.map(role => [role.id, role]));
  for (const view of registry.roleViews) {
    const scoped = view.roles ? [...new Set(view.roles)] : null;
    for (const id of scoped ?? []) {
      if (!byId.has(id)) findings.push({ level: 'error', code: 'role-view-drift', role: id, detail: `${view.kind} ${view.path}: role in role_views is not in the registry` });
    }
    let rows;
    try { rows = VIEW_READERS[view.kind](readJson(view.path)); } catch (error) {
      findings.push({ level: 'error', code: 'role-view-missing', role: null, detail: `${view.kind} ${view.path}: ${error.code === 'ENOENT' ? 'file not found' : 'unreadable'}` });
      continue;
    }
    const seen = new Set();
    for (const row of rows) {
      seen.add(row.id);
      const role = byId.get(row.id);
      if (!role) { findings.push({ level: 'error', code: 'role-view-drift', role: row.id, detail: `${view.kind} ${view.path}: role is not in the registry` }); continue; }
      const diffs = [];
      if (row.botId && role.botId && row.botId !== role.botId) diffs.push('bot_id');
      if (row.wakeSubdir !== undefined && row.wakeSubdir !== role.wakeSubdir) diffs.push('wake_subdir');
      if (row.tool !== undefined && row.tool !== role.tools[0]) diffs.push('tool');
      if (row.paneId !== undefined && row.paneId !== role.paneId) diffs.push('pane_id');
      // Every DM room the registry wants backed up must be one the gateway tool catches up on.
      if (row.dmChannels !== undefined && role.dmChannels.some(channel => !row.dmChannels.includes(channel))) diffs.push('dm_channels');
      if (row.dmUsers !== undefined && role.dmUsers.some(user => !row.dmUsers.includes(user))) diffs.push('dm_users');
      if (diffs.length) findings.push({ level: 'error', code: 'role-view-drift', role: row.id, detail: `${view.kind} ${view.path}: ${diffs.join(', ')} differ` });
    }
    for (const id of scoped ?? byId.keys()) {
      if (byId.has(id) && !seen.has(id)) findings.push({ level: 'error', code: 'role-view-drift', role: id, detail: `${view.kind} ${view.path}: role is missing` });
    }
  }
  return findings;
}

const mentions = (text, root) => new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`).test(text);
function retiredUse(registry, deps, processes) {
  const findings = [];
  if (!registry.retiredRoots.length) return findings;
  const hit = (where, text) => { for (const root of registry.retiredRoots) if (mentions(text, root)) findings.push({ level: 'error', code: 'retired-root-in-use', role: null, detail: `${where} uses ${root}` }); };
  const walk = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name.endsWith('.d')) walk(full); continue; }
      if (!/\.(service|timer|conf|path|socket)$/.test(entry.name)) continue;
      try { hit(full, fs.readFileSync(full, 'utf8')); } catch { /* unreadable unit files are skipped */ }
    }
  };
  registry.unitDirs.forEach(walk);
  try { deps.crontab().split('\n').forEach((line, index) => { if (!line.trim().startsWith('#')) hit(`crontab line ${index + 1}`, line); }); } catch { /* no crontab */ }
  for (const proc of processes ?? []) hit(`process ${proc.pid}`, proc.args);
  return findings;
}

export function inspect(registry, deps = defaultDeps()) {
  const now = deps.now();
  let processes = null;
  try { processes = deps.processes(); } catch { /* reported per role below */ }
  const known = knownToolsFor(registry);
  let heartbeat = null, lastRun = {};
  try { const doc = readJson(heartbeatFile(registry)); heartbeat = Date.parse(doc.at); if (isObject(doc.roles)) lastRun = doc.roles; } catch { /* never ran */ }
  const findings = [...retiredUse(registry, deps, processes), ...compareViews(registry)];
  const add = (level, code, role, detail) => findings.push({ level, code, role, detail });
  if (registry.delivery && !(Number.isFinite(heartbeat) && now - heartbeat <= registry.delivery.heartbeatMaxAge * 1000)) add('error', 'delivery-stale', null, Number.isFinite(heartbeat) ? `last delivery run ${Math.round((now - heartbeat) / 1000)}s ago` : 'delivery has never run');
  const rows = registry.roles.map(role => {
    const row = { id: role.id, name: role.names[0], paneId: role.paneId, registeredTools: role.tools, alive: null, tool: null, wait: role.wait ? 'unknown' : 'none', box: 0, pending: null, oldestPendingMs: null, newestMs: null };
    let pids = [];
    try {
      const fg = deps.paneProcesses(registry.paneBin, role.paneId);
      Object.assign(row, detectTool(fg, known));
      if (row.alive) {
        const caps = resolveToolCaps({ tool_caps: registry.toolCaps }, { tool: row.tool });
        row.bgNotify = caps.bgNotify;
        row.submitKeys = caps.submitKeys;
      }
      pids = fg.map(proc => proc.pid).filter(Number.isInteger);
    } catch { add('error', 'pane-unreadable', role.id, `pane ${role.paneId} could not be read`); }
    if (row.alive === false) add('error', 'session-down', role.id, `pane ${role.paneId} runs only a shell`);
    if (row.alive && !role.tools.includes(row.tool)) add('error', 'tool-drift', role.id, `pane runs ${row.tool}, registry allows ${role.tools.join(', ')}`);
    else if (row.alive && row.tool !== role.tools[0]) add('warn', 'tool-fallback', role.id, `pane runs ${row.tool}, first choice is ${role.tools[0]}`);
    if (role.wait) {
      // A `nudge` wait script is one the role depends on (it may be the only reader
      // of the box, or the role's channel poller), so its stop is an error even
      // when delivery runs, and so is not being able to tell. `observe` is recorded only.
      const waitLevel = role.wait.mode === 'nudge' ? 'error' : 'warn';
      if (!fs.existsSync(role.wait.script)) { row.wait = 'missing'; add('error', 'wait-script-missing', role.id, role.wait.script); }
      else if (!processes) add(waitLevel, 'wait-unknown', role.id, 'process list could not be read');
      else if (!pids.length) add(waitLevel, 'wait-unknown', role.id, `pane ${role.paneId} foreground pids could not be read`);
      else if (waitRunning(processes, role.wait.script, pids)) row.wait = 'running';
      else { row.wait = 'down'; add(waitLevel, 'wait-down', role.id, `${role.wait.script} is not running under pane ${role.paneId}`); }
    }
    const { entries, errors } = boxEntries(role, deps);
    for (const detail of errors) add('error', 'box-unreadable', role.id, detail);
    row.box = errors.length && !entries.length ? null : entries.length;
    if (entries.length) row.newestMs = entries.at(-1).mtimeMs;
    if (entries.length > registry.retention.maxBoxFiles) add('warn', 'box-backlog', role.id, `${entries.length} files in ${role.wakeDir} (limit ${registry.retention.maxBoxFiles})`);
    if (registry.delivery) {
      // The heartbeat only says the runner ran; a role it could not work through is named here.
      if (lastRun[role.id]?.aborted) add('error', 'delivery-error', role.id, `last delivery run stopped on this role: ${String(lastRun[role.id].error ?? 'unknown')}`);
      const seen = readLedger(registry, role);
      if (seen) {
        const pending = entries.filter(entry => !seen.has(entry.key));
        row.pending = pending.length;
        if (pending.length) row.oldestPendingMs = pending[0].mtimeMs;
        if (row.oldestPendingMs && now - row.oldestPendingMs > registry.delivery.lagSeconds * 1000) add('error', 'delivery-lag', role.id, `${pending.length} undelivered, oldest ${Math.round((now - row.oldestPendingMs) / 60000)}m`);
        const failures = Object.entries(readFailures(registry, role)).filter(([key]) => pending.some(entry => entry.key === key));
        if (failures.length) add('error', 'delivery-failed', role.id, `${failures.length} file(s) failing, e.g. ${path.basename(failures[0][0])} (${failures[0][1].count} attempts)`);
      }
    }
    if (role.dmChannels.length || role.dmUsers.length) {
      // The gateway tool keeps its state in the role's box and records each DM room's last REST catch-up there.
      let rooms = {}, byUser = {};
      try { const state = readJson(path.join(role.wakeDir, '.bot-mention-wake-state.json')); rooms = state.dm ?? {}; byUser = state.dmUsers ?? {}; } catch { /* reported per room below */ }
      const wanted = new Set(role.dmChannels);
      for (const user of role.dmUsers) {
        if (SNOWFLAKE.test(byUser[user]?.channel ?? '')) wanted.add(byUser[user].channel);
        else add('error', 'dm-backup-stale', role.id, `DM room of user ${user} is not resolved${byUser[user]?.error ? `, last error ${String(byUser[user].error.status ?? 'unknown')}` : ''}`);
      }
      for (const channel of wanted) {
        const okAt = Date.parse(rooms[channel]?.okAt ?? '');
        if (Number.isFinite(okAt) && now - okAt <= registry.dmBackupMaxAge * 1000) continue;
        const why = rooms[channel]?.error ? `, last error ${String(rooms[channel].error.status ?? 'unknown')}` : '';
        add('error', 'dm-backup-stale', role.id, Number.isFinite(okAt) ? `DM room ${channel} last caught up ${Math.round((now - okAt) / 60000)}m ago${why}` : `DM room ${channel} has never been caught up${why}`);
      }
    }
    return row;
  });
  return { at: new Date(now).toISOString(), registry: registry.file, root: registry.root, rows, findings };
}

// Checks, then restarts what this layer owns: a delivery run that stopped is run
// here once, so a dead timer does not strand every role. Pane restart and the
// in-session wait nudge stay with the pane liveness tool.
export function watch(registry, deps = defaultDeps(), { repair = false } = {}) {
  let report = inspect(registry, deps);
  const actions = [];
  if (repair && report.findings.some(finding => finding.code === 'delivery-stale')) {
    const result = deliver(registry, deps);
    actions.push({ action: 'deliver', result });
    report = inspect(registry, deps);
  }
  const errors = report.findings.filter(finding => finding.level === 'error');
  if (repair && registry.notify && errors.length) {
    const stateFile = path.join(registry.stateDir, 'notified.json');
    let state = {};
    try { state = readJson(stateFile); } catch { /* first notice */ }
    const now = deps.now(), next = {};
    const due = [];
    for (const finding of errors) {
      const key = `${finding.code}:${finding.role ?? ''}:${finding.detail.replace(/\d+/g, '#')}`;
      next[key] = state[key] && now - state[key] < registry.notify.repeatSeconds * 1000 ? state[key] : (due.push(finding), now);
    }
    if (due.length) {
      const text = due.map(finding => `[role-wake] ${finding.code}${finding.role ? ` ${finding.role}` : ''}: ${finding.detail}`).join('\n');
      const [command, ...args] = registry.notify.command.map(part => part.replaceAll('{text}', text));
      try { deps.run(command, args, { timeout: 60_000 }); actions.push({ action: 'notify', count: due.length }); } catch { for (const key of Object.keys(next)) if (next[key] === now) delete next[key]; actions.push({ action: 'notify-failed', count: due.length }); }
    }
    atomic(stateFile, JSON.stringify(next));
  }
  return { ...report, actions };
}

// Retention: only files the delivery ledger records, older than delivered_days,
// move to archive_dir/<role>/<yyyymmdd>/. Nothing is deleted and undelivered files stay.
export function sweep(registry, deps = defaultDeps(), { apply = false } = {}) {
  const cutoff = deps.now() - registry.retention.deliveredDays * 86_400_000;
  const result = {};
  for (const role of registry.roles) {
    // One role's trouble (or one file's) must not stop the sweep of the rest.
    try {
      const seen = readLedger(registry, role);
      const { entries, errors } = boxEntries(role, deps);
      const own = entries.filter(entry => !entry.box);
      if (!seen) { result[role.id] = { skipped: 'no delivery ledger', kept: own.length }; continue; }
      let moved = 0, undelivered = 0, recent = 0, failed = 0;
      for (const entry of own) {
        if (!seen.has(entry.key)) { undelivered += 1; continue; }
        if (entry.mtimeMs > cutoff) { recent += 1; continue; }
        if (apply) {
          try {
            const folder = path.join(registry.retention.archiveDir, role.wakeSubdir || '_top', new Date(entry.mtimeMs).toISOString().slice(0, 10).replaceAll('-', ''));
            fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
            // A name already archived keeps both files: the newcomer gets a numbered name.
            let target = path.join(folder, entry.name);
            for (let copy = 1; fs.existsSync(target); copy += 1) target = path.join(folder, `${entry.name.slice(0, -3)}.dup${copy}.md`);
            fs.renameSync(entry.file, target);
          } catch { failed += 1; continue; }
        }
        moved += 1;
      }
      // Extra boxes belong to another owner and are never swept.
      const external = entries.length - own.length;
      result[role.id] = { [apply ? 'moved' : 'would_move']: moved, undelivered, recent, ...(external ? { external } : {}), ...(failed ? { failed } : {}), ...(errors.length ? { error: errors.join('; ') } : {}) };
    } catch (error) { result[role.id] = { skipped: 'error', error: String(error?.code ?? error?.message ?? error).split('\n')[0] }; }
  }
  return { apply, archiveDir: registry.retention.archiveDir, roles: result };
}

const ago = (ms, now) => { if (!ms) return '-'; const minutes = Math.max(0, Math.round((now - ms) / 60000)); return minutes < 60 ? `${minutes}m` : minutes < 2880 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`; };
export function boardSection(report) {
  const now = Date.parse(report.at);
  const cell = value => String(value).replace(/[|\r\n]/g, ' ');
  const lines = ['| role | pane | session | tool (registered) | wait | box | undelivered | newest wake |', '|---|---|---|---|---|---|---|---|'];
  for (const row of report.rows) {
    const session = row.alive === null ? 'unreadable' : row.alive ? 'alive' : 'down';
    const pending = row.pending === null ? '-' : row.pending ? `${row.pending} (oldest ${ago(row.oldestPendingMs, now)})` : '0';
    lines.push(`| ${[`${row.name} (${row.id})`, row.paneId, session, `${row.tool ?? '-'} (${row.registeredTools.join(' > ')})`, row.wait, row.box ?? 'unreadable', pending, ago(row.newestMs, now)].map(cell).join(' | ')} |`);
  }
  lines.push('', `registry: ${report.registry} · root: ${report.root} · checked: ${report.at}`);
  if (report.findings.length) lines.push('', ...report.findings.map(finding => `- ${finding.level} ${finding.code}${finding.role ? ` ${finding.role}` : ''}: ${cell(finding.detail)}`));
  return `${lines.join('\n')}\n`;
}

export function legacyView(registry, kind) {
  if (kind === 'l4-roles') return { schemaVersion: 1, roles: registry.roles.map(role => ({ id: role.id, names: role.names, wakeDir: path.relative(registry.root, role.wakeDir), ...(role.botId ? { botUserIds: [role.botId] } : {}) })) };
  if (kind === 'wake-routes') return { roles: Object.fromEntries(registry.roles.map(role => [role.id, { name: role.names[0], bot_id: role.botId, wake_subdir: role.wakeSubdir }])) };
  return fail(`no generated view for ${kind}`);
}

export function main(argv = process.argv.slice(2), env = process.env, deps = defaultDeps(), out = text => process.stdout.write(text)) {
  const [command, ...rest] = argv;
  const flag = name => rest.includes(name);
  const value = name => { const index = rest.indexOf(name); return index >= 0 ? rest[index + 1] : undefined; };
  const file = value('--config') ?? env.ADK_ROLE_WAKE_CONFIG ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../config/role-wake.json');
  const registry = loadRegistry(file);
  const print = data => out(`${JSON.stringify(data, null, 2)}\n`);
  if (command === 'validate') {
    const rows = registry.roles.map(role => ({ id: role.id, tool: role.tool, bg_notify: role.bgNotify, submit_keys: role.submitKeys }));
    const lines = [
      '{',
      '  "ok": true,',
      `  "root": ${JSON.stringify(registry.root)},`,
      `  "roles": ${JSON.stringify(registry.roles.map(role => role.id))},`,
      '  "tool_caps": [',
      ...rows.map((row, index) => `    ${JSON.stringify(row)}${index + 1 < rows.length ? ',' : ''}`),
      '  ]',
      '}',
      '',
    ];
    out(lines.join('\n'));
    return 0;
  }
  if (command === 'check' || command === 'watch') {
    const report = command === 'watch' ? watch(registry, deps, { repair: flag('--repair') }) : inspect(registry, deps);
    if (flag('--json')) print(report); else out(boardSection(report));
    return report.findings.some(finding => finding.level === 'error') ? 1 : 0;
  }
  if (command === 'board') { out(boardSection(inspect(registry, deps))); return 0; }
  if (command === 'deliver') { const result = deliver(registry, deps, { only: value('--role') ?? null }); print(result); return Object.values(result.roles ?? {}).some(role => role.failed || role.error) ? 1 : 0; }
  if (command === 'sweep') { print(sweep(registry, deps, { apply: flag('--apply') })); return 0; }
  if (command === 'view') { print(legacyView(registry, value('--kind'))); return 0; }
  out('usage: role-wake.mjs <validate|check|watch [--repair]|board|deliver [--role id]|sweep [--apply]|view --kind l4-roles|wake-routes> [--config file] [--json]\n');
  return 2;
}

const direct = (() => { try { return process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (direct) {
  try { process.exitCode = main(); } catch (error) { process.stderr.write(`role-wake: ${String(error?.message ?? error).split('\n')[0]}\n`); process.exitCode = 2; }
}
