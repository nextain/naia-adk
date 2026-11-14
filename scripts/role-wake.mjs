#!/usr/bin/env node
// Role wake single source. One instance file names the live workspace, the wake
// boxes and every role; delivery, consumer checks, the role-session table and
// wake-box retention all read that file. See docs/guides/role-wake-registry.md.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh']);
const WRAPPERS = new Set(['sudo', 'env', 'nice', 'setsid', 'stdbuf', 'timeout', 'node', 'python3', 'python']);
const VIEW_KINDS = new Set(['l4-roles', 'wake-routes', 'liveness', 'session-health', 'bot-mention-wake']);
const DEFAULTS = { heartbeatMaxAge: 300, maxPerRun: 50, lagSeconds: 600, deliveredDays: 3, maxBoxFiles: 500, repeatSeconds: 3600 };
const ROLE_ID = /^[a-zA-Z0-9_-]+$/;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(message); };
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const positive = (value, fallback, name) => value === undefined ? fallback : Number.isFinite(value) && value > 0 ? value : fail(`${name} must be a positive number`);

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
  const retiredRoots = (doc.retired_roots ?? []).map(value => typeof value === 'string' && path.isAbsolute(value) ? path.resolve(value) : fail('retired_roots must be absolute paths'));
  if (retiredRoots.some(value => value === root || root.startsWith(value + path.sep))) fail('root is inside a retired root');
  const delivery = doc.delivery === undefined ? null : {
    command: Array.isArray(doc.delivery?.command) && doc.delivery.command.length && doc.delivery.command.every(part => typeof part === 'string') ? doc.delivery.command : fail('delivery.command must be a string array'),
    heartbeatMaxAge: positive(doc.delivery.heartbeat_max_age_seconds, DEFAULTS.heartbeatMaxAge, 'delivery.heartbeat_max_age_seconds'),
    maxPerRun: positive(doc.delivery.max_per_run, DEFAULTS.maxPerRun, 'delivery.max_per_run'),
    lagSeconds: positive(doc.delivery.lag_seconds, DEFAULTS.lagSeconds, 'delivery.lag_seconds'),
  };
  if (delivery && !delivery.command.some(part => part.includes('{file}'))) fail('delivery.command needs a {file} placeholder');
  const retention = {
    deliveredDays: positive(doc.retention?.delivered_days, DEFAULTS.deliveredDays, 'retention.delivered_days'),
    maxBoxFiles: positive(doc.retention?.max_box_files, DEFAULTS.maxBoxFiles, 'retention.max_box_files'),
    archiveDir: inRoot(doc.retention?.archive_dir ?? `${doc.wake_root}-archive`, 'retention.archive_dir'),
  };
  if (retention.archiveDir === wakeRoot || retention.archiveDir.startsWith(wakeRoot + path.sep)) fail('retention.archive_dir must be outside wake_root');
  const roleViews = (doc.role_views ?? []).map(view => VIEW_KINDS.has(view?.kind) && typeof view.path === 'string' && path.isAbsolute(view.path) ? { kind: view.kind, path: view.path } : fail('invalid role_views entry'));
  if (!isObject(doc.roles) || !Object.keys(doc.roles).length) fail('roles must be a non-empty object');
  const bots = new Set(), dirs = new Set(), panes = new Set();
  const roles = Object.entries(doc.roles).map(([id, role]) => {
    if (!ROLE_ID.test(id) || !isObject(role)) fail(`invalid role ${id}`);
    const tools = role.tools ?? (role.tool ? [role.tool] : []);
    if (!Array.isArray(tools) || !tools.length || tools.some(tool => typeof tool !== 'string' || !ROLE_ID.test(tool))) fail(`role ${id}: tools must list at least one tool`);
    if (role.tool !== undefined && role.tool !== tools[0]) fail(`role ${id}: tool must equal tools[0]`);
    if (typeof role.wake_subdir !== 'string' || role.wake_subdir.includes('/') || role.wake_subdir.startsWith('.')) fail(`role ${id}: wake_subdir must be one folder name or ""`);
    const wakeDir = path.join(wakeRoot, role.wake_subdir);
    const paneId = role.find?.pane_id;
    if (typeof paneId !== 'string' || !paneId) fail(`role ${id}: find.pane_id is required`);
    if (role.bot_id !== undefined && !/^\d{17,20}$/.test(role.bot_id)) fail(`role ${id}: invalid bot_id`);
    if (dirs.has(wakeDir) || panes.has(paneId) || (role.bot_id && bots.has(role.bot_id))) fail(`role ${id}: duplicate wake_subdir, pane or bot_id`);
    dirs.add(wakeDir); panes.add(paneId); if (role.bot_id) bots.add(role.bot_id);
    let wait = null;
    if (role.wait !== undefined) {
      if (!isObject(role.wait) || typeof role.wait.script !== 'string' || !path.isAbsolute(role.wait.script)) fail(`role ${id}: wait.script must be an absolute path`);
      wait = { script: role.wait.script, mode: role.wait.mode ?? 'nudge' };
    }
    if (!wait && !delivery) fail(`role ${id}: no wake consumer (declare delivery or wait)`);
    return { id, names: Array.isArray(role.names) && role.names.length ? role.names : [id], botId: role.bot_id ?? null, user: role.user ?? null, paneId, cwd: role.find.cwd ?? null, tools, wakeSubdir: role.wake_subdir, wakeDir, wait };
  });
  const paneBin = doc.pane?.bin;
  if (doc.pane?.kind !== 'herdr' || typeof paneBin !== 'string' || !path.isAbsolute(paneBin)) fail('pane must be {"kind":"herdr","bin":"/abs/path"}');
  const notify = doc.notify === undefined ? null : {
    command: Array.isArray(doc.notify?.command) && doc.notify.command.some(part => typeof part === 'string' && part.includes('{text}')) ? doc.notify.command : fail('notify.command needs a {text} placeholder'),
    repeatSeconds: positive(doc.notify.repeat_seconds, DEFAULTS.repeatSeconds, 'notify.repeat_seconds'),
  };
  const unitDirs = (doc.unit_dirs ?? []).map(value => typeof value === 'string' && path.isAbsolute(value) ? value : fail('unit_dirs must be absolute paths'));
  return { file: path.resolve(file), root, wakeRoot, stateDir: path.resolve(doc.state_dir), retiredRoots, unitDirs, paneBin, delivery, retention, roleViews, notify, roles };
}

export function listBox(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return entries.filter(entry => entry.isFile() && entry.name.endsWith('.md')).map(entry => entry.name).sort();
}

// A pane whose foreground is only a shell has no agent, whatever tool the registry names.
export function detectTool(processes, knownTools) {
  let sawProgram = false;
  for (const proc of processes ?? []) {
    const argv = Array.isArray(proc.argv) && proc.argv.length ? proc.argv : String(proc.cmdline ?? proc.name ?? '').split(/\s+/).filter(Boolean);
    // `sudo -iu <user> bash`: the user name is an option value, not a program.
    const sudo = path.basename(argv[0] ?? '') === 'sudo';
    const words = argv.filter((word, index) => !word.startsWith('-') && !(sudo && /^-[a-zA-Z]*[ug]$/.test(argv[index - 1] ?? ''))).map(word => path.basename(word));
    for (const word of words) {
      const tool = knownTools.find(name => word === name || word.startsWith(`${name}-`) || word.startsWith(`${name}.`));
      if (tool) return { alive: true, tool };
    }
    if (words.some(word => !SHELLS.has(word) && !WRAPPERS.has(word))) sawProgram = true;
  }
  return sawProgram ? { alive: true, tool: 'unknown' } : { alive: false, tool: 'shell' };
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
// pane's agent started it; a leftover from a dead session has no reader.
export function waitRunning(processes, script, rootPids) {
  const byPid = new Map(processes.map(proc => [proc.pid, proc]));
  const roots = new Set(rootPids.filter(pid => byPid.has(pid)));
  return processes.some(proc => {
    const words = proc.args.split(/\s+/);
    if (!SHELLS.has(path.basename(words[0] ?? '').replace(/^-/, ''))) return false;
    const target = words.slice(1).find(word => !word.startsWith('-'));
    if (target !== script) return false;
    if (!roots.size) return true;
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

function acquireLock(registry) {
  fs.mkdirSync(registry.stateDir, { recursive: true, mode: 0o700 });
  const lock = path.join(registry.stateDir, 'deliver.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); return () => fs.rmSync(lock, { force: true }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const owner = Number(fs.readFileSync(lock, 'utf8'));
    try { process.kill(owner, 0); return null; } catch (error) { if (error.code !== 'ESRCH') return null; fs.rmSync(lock, { force: true }); }
  }
  return null;
}

// Hands each new wake file to the instance delivery command, in name order. A box
// seen for the first time is recorded, not replayed. A failed file stops that role
// for this run so later files cannot overtake it.
export function deliver(registry, deps = defaultDeps(), { only = null } = {}) {
  if (!registry.delivery) fail('delivery is not configured');
  const release = acquireLock(registry);
  if (!release) return { skipped: 'locked' };
  try {
    const at = new Date(deps.now()).toISOString();
    const summary = {};
    for (const role of registry.roles) {
      if (only && role.id !== only) continue;
      const files = listBox(role.wakeDir);
      const seen = readLedger(registry, role);
      const append = (names, status) => { if (names.length) fs.appendFileSync(ledgerFile(registry, role), names.map(file => `${JSON.stringify({ file, at, status })}\n`).join(''), { mode: 0o600 }); };
      if (seen === null) {
        fs.writeFileSync(ledgerFile(registry, role), '', { flag: 'a', mode: 0o600 });
        append(files, 'baseline');
        summary[role.id] = { baseline: files.length, delivered: 0, failed: 0, pending: 0 };
        continue;
      }
      const fresh = files.filter(name => !seen.has(name));
      let delivered = 0, failed = 0;
      for (const name of fresh.slice(0, registry.delivery.maxPerRun)) {
        const file = path.join(role.wakeDir, name);
        const [command, ...args] = registry.delivery.command.map(part => part.replaceAll('{role}', role.id).replaceAll('{file}', file));
        try { deps.run(command, args, { timeout: 60_000 }); } catch { failed = 1; break; }
        append([name], 'delivered');
        delivered += 1;
      }
      summary[role.id] = { delivered, failed, pending: fresh.length - delivered };
    }
    if (!only) atomic(heartbeatFile(registry), JSON.stringify({ at, roles: summary }));
    return { at, roles: summary };
  } finally { release(); }
}

const VIEW_READERS = {
  'l4-roles': doc => (doc.roles ?? []).map(role => ({ id: role.id, botId: role.botUserIds?.[0] })),
  'wake-routes': doc => Object.entries(doc.roles ?? {}).map(([id, role]) => ({ id, botId: role.bot_id, wakeSubdir: role.wake_subdir })),
  liveness: doc => Object.entries(doc.roles ?? {}).map(([id, role]) => ({ id, tool: role.tool, paneId: role.find?.pane_id })),
  'session-health': doc => (doc.roles ?? []).map(role => ({ id: role.id, botId: role.botId })),
  'bot-mention-wake': doc => (doc.roles ?? []).map(role => ({ id: role.id, botId: role.botUserId })),
};

// Other tools still keep their own role lists. Until each reads the registry, this
// names every list that disagrees with it.
export function compareViews(registry) {
  const findings = [];
  const byId = new Map(registry.roles.map(role => [role.id, role]));
  for (const view of registry.roleViews) {
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
      if (diffs.length) findings.push({ level: 'error', code: 'role-view-drift', role: row.id, detail: `${view.kind} ${view.path}: ${diffs.join(', ')} differ` });
    }
    for (const id of byId.keys()) if (!seen.has(id)) findings.push({ level: 'error', code: 'role-view-drift', role: id, detail: `${view.kind} ${view.path}: role is missing` });
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
  const known = [...new Set([...registry.roles.flatMap(role => role.tools), 'claude', 'codex', 'opencode'])];
  let heartbeat = null;
  try { heartbeat = Date.parse(readJson(heartbeatFile(registry)).at); } catch { /* never ran */ }
  const findings = [...retiredUse(registry, deps, processes), ...compareViews(registry)];
  const add = (level, code, role, detail) => findings.push({ level, code, role, detail });
  if (registry.delivery && !(Number.isFinite(heartbeat) && now - heartbeat <= registry.delivery.heartbeatMaxAge * 1000)) add('error', 'delivery-stale', null, Number.isFinite(heartbeat) ? `last delivery run ${Math.round((now - heartbeat) / 1000)}s ago` : 'delivery has never run');
  const rows = registry.roles.map(role => {
    const row = { id: role.id, name: role.names[0], paneId: role.paneId, registeredTools: role.tools, alive: null, tool: null, wait: role.wait ? 'unknown' : 'none', box: 0, pending: null, oldestPendingMs: null, newestMs: null };
    let pids = [];
    try {
      const fg = deps.paneProcesses(registry.paneBin, role.paneId);
      Object.assign(row, detectTool(fg, known));
      pids = fg.map(proc => proc.pid).filter(Number.isInteger);
    } catch { add('error', 'pane-unreadable', role.id, `pane ${role.paneId} could not be read`); }
    if (row.alive === false) add('error', 'session-down', role.id, `pane ${role.paneId} runs only a shell`);
    if (row.alive && !role.tools.includes(row.tool)) add('error', 'tool-drift', role.id, `pane runs ${row.tool}, registry allows ${role.tools.join(', ')}`);
    else if (row.alive && row.tool !== role.tools[0]) add('warn', 'tool-fallback', role.id, `pane runs ${row.tool}, first choice is ${role.tools[0]}`);
    if (role.wait) {
      if (!fs.existsSync(role.wait.script)) { row.wait = 'missing'; add('error', 'wait-script-missing', role.id, role.wait.script); }
      else if (!processes) add('warn', 'wait-unknown', role.id, 'process list could not be read');
      else if (waitRunning(processes, role.wait.script, pids)) row.wait = 'running';
      else { row.wait = 'down'; add(registry.delivery || role.wait.mode !== 'nudge' ? 'warn' : 'error', 'wait-down', role.id, `${role.wait.script} is not running under pane ${role.paneId}`); }
    }
    const files = listBox(role.wakeDir);
    row.box = files.length;
    const mtime = name => { try { return fs.statSync(path.join(role.wakeDir, name)).mtimeMs; } catch { return null; } };
    if (files.length) row.newestMs = mtime(files.at(-1));
    if (files.length > registry.retention.maxBoxFiles) add('warn', 'box-backlog', role.id, `${files.length} files in ${role.wakeDir} (limit ${registry.retention.maxBoxFiles})`);
    if (registry.delivery) {
      const seen = readLedger(registry, role);
      if (seen) {
        const pending = files.filter(name => !seen.has(name));
        row.pending = pending.length;
        if (pending.length) row.oldestPendingMs = mtime(pending[0]);
        if (row.oldestPendingMs && now - row.oldestPendingMs > registry.delivery.lagSeconds * 1000) add('error', 'delivery-lag', role.id, `${pending.length} undelivered, oldest ${Math.round((now - row.oldestPendingMs) / 60000)}m`);
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
    const seen = readLedger(registry, role);
    const files = listBox(role.wakeDir);
    if (!seen) { result[role.id] = { skipped: 'no delivery ledger', kept: files.length }; continue; }
    let moved = 0, undelivered = 0, recent = 0;
    for (const name of files) {
      if (!seen.has(name)) { undelivered += 1; continue; }
      const source = path.join(role.wakeDir, name);
      const mtime = fs.statSync(source).mtimeMs;
      if (mtime > cutoff) { recent += 1; continue; }
      if (apply) {
        const target = path.join(registry.retention.archiveDir, role.wakeSubdir || '_top', new Date(mtime).toISOString().slice(0, 10).replaceAll('-', ''), name);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        if (fs.existsSync(target)) fail(`archive target exists: ${target}`);
        fs.renameSync(source, target);
      }
      moved += 1;
    }
    result[role.id] = { [apply ? 'moved' : 'would_move']: moved, undelivered, recent };
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
    lines.push(`| ${[`${row.name} (${row.id})`, row.paneId, session, `${row.tool ?? '-'} (${row.registeredTools.join(' > ')})`, row.wait, row.box, pending, ago(row.newestMs, now)].map(cell).join(' | ')} |`);
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
  if (command === 'validate') { print({ ok: true, root: registry.root, roles: registry.roles.map(role => role.id) }); return 0; }
  if (command === 'check' || command === 'watch') {
    const report = command === 'watch' ? watch(registry, deps, { repair: flag('--repair') }) : inspect(registry, deps);
    if (flag('--json')) print(report); else out(boardSection(report));
    return report.findings.some(finding => finding.level === 'error') ? 1 : 0;
  }
  if (command === 'board') { out(boardSection(inspect(registry, deps))); return 0; }
  if (command === 'deliver') { const result = deliver(registry, deps, { only: value('--role') ?? null }); print(result); return Object.values(result.roles ?? {}).some(role => role.failed) ? 1 : 0; }
  if (command === 'sweep') { print(sweep(registry, deps, { apply: flag('--apply') })); return 0; }
  if (command === 'view') { print(legacyView(registry, value('--kind'))); return 0; }
  out('usage: role-wake.mjs <validate|check|watch [--repair]|board|deliver [--role id]|sweep [--apply]|view --kind l4-roles|wake-routes> [--config file] [--json]\n');
  return 2;
}

const direct = (() => { try { return process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (direct) {
  try { process.exitCode = main(); } catch (error) { process.stderr.write(`role-wake: ${String(error?.message ?? error).split('\n')[0]}\n`); process.exitCode = 2; }
}
