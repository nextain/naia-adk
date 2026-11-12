#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { realpath, readFile, mkdir, writeFile, readdir, stat, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, safeName, validDate, ledgerPath, readLedger, withLock, atomicJson } from './ledger.mjs';

const HOUR = 60 * 60 * 1000;
const hash = value => createHash('sha256').update(value).digest('hex');
export const canonicalRoot = root => realpath(path.resolve(root));
export const rootPrefix = root => `adk-due-${hash(root).slice(0, 8)}-`;
// The role hash makes ownership unambiguous even when role and id contain '-'.
export function rolePrefix(root, role) {
  return `${rootPrefix(root)}${hash(safeName(role)).slice(0, 16)}-`;
}
export function unitName(root, role, id) {
  safeName(role); safeName(id);
  const prefix = rolePrefix(root, role);
  const suffix = hash(JSON.stringify([role, id])).slice(0, 16);
  let name = `${prefix}${role}-${id}-${suffix}`;
  if (name.length + 6 > 200) name = `${prefix}${suffix}-${hash(id)}`;
  return `${name}.timer`;
}
function calendarDate(due) {
  if (!validDate(due)) throw new Error('Invalid due date (UTC ISO required)');
  // systemd calendar accepts seconds; never round the trigger before the due time.
  return new Date(Math.ceil(Date.parse(due) / 1000) * 1000).toISOString();
}
export function calendarSpec(due) {
  return calendarDate(due).replace('T', ' ').replace('.000Z', ' UTC');
}

/** Pure comparison. Only supplied roles are owned; other roles are untouched. */
export function plan({ root, ledgers, timers, now = Date.now(), horizonMs = 24 * HOUR, limit = 200, onlyUnits, configTag, pruneUnknownRoles = false, configuredRoles = [] }) {
  if (!Number.isFinite(now) || !Number.isFinite(horizonMs) || horizonMs < 0 || !Number.isInteger(limit) || limit < 0) throw new Error('Invalid planning options');
  if (!Array.isArray(ledgers) || !Array.isArray(timers)) throw new Error('Invalid planning input');
  const owned = new Map();
  const desired = new Map();
  for (const ledger of ledgers) {
    const role = safeName(ledger.role);
    if (role.length > 240) throw new Error('Role too long for wake routing (maximum 240 characters)');
    if (!Array.isArray(ledger.items) || owned.has(role)) throw new Error('Invalid ledger list');
    owned.set(role, rolePrefix(root, role));
    for (const item of ledger.items) {
      safeName(item.id);
      if (!validDate(item.due)) throw new Error('Invalid due date (UTC ISO required)');
      if (item.status !== 'open') continue;
      const unit = unitName(root, role, item.id);
      if (desired.has(unit)) throw new Error('Duplicate timer identity');
      desired.set(unit, { unit, role, id: item.id, due: item.due });
    }
  }
  const existing = new Map();
  for (const timer of timers) {
    if (!timer || typeof timer.unit !== 'string' || existing.has(timer.unit)) throw new Error('Invalid timer list');
    if (timer.unit.startsWith(rootPrefix(root)) && timer.unit.endsWith('.timer')) existing.set(timer.unit, timer);
  }
  const actions = [];
  const occupied = new Set(existing.keys());
  for (const [unit] of existing) {
    const known = [...owned.values()].some(prefix => unit.startsWith(prefix));
    const configured = configuredRoles.some(role => unit.startsWith(rolePrefix(root, role)));
    if ((known || (pruneUnknownRoles && !configured)) && !desired.has(unit) && (!onlyUnits || onlyUnits.has(unit))) {
      actions.push({ type: 'disarm', unit });
      occupied.delete(unit);
    }
  }
  let warned = false;
  for (const entry of desired.values()) {
    const current = existing.get(entry.unit);
    const remaining = Date.parse(entry.due) - now;
    if (remaining > horizonMs || remaining <= 5000) {
      if (current) { actions.push({ type: 'disarm', unit: entry.unit }); occupied.delete(entry.unit); }
      if (remaining <= 5000) actions.push({ type: 'fire', ...entry });
      continue;
    }
    if (current && current.due === calendarDate(entry.due) && current.originalDue === entry.due && (configTag === undefined || current.configTag === configTag)) continue;
    if (current) { actions.push({ type: 'disarm', unit: entry.unit }); occupied.delete(entry.unit); }
    if (occupied.size >= limit) {
      if (!warned) { actions.push({ type: 'warning', message: `Timer limit ${limit} reached` }); warned = true; }
      continue;
    }
    actions.push({ type: 'arm', ...entry });
    occupied.add(entry.unit);
  }
  return actions;
}

// The runner receives an argv array, never shell text. Tests inject a fake.
export function systemRunner(command, args, options = {}) {
  if (process.env.NODE_TEST_CONTEXT || process.env.ADK_FORBID_SYSTEM_RUNNER === '1') throw new Error('System runner forbidden in tests; inject a runner');
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `${command} exited ${code}`)));
  });
}
function runtimeEnv() {
  return { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? ''}` };
}
const enabled = config => config?.due_timer?.enabled === true;
function parseCalendar(value) {
  const matches = [...value.matchAll(/(?:OnCalendar=|^\s*)(?:[A-Za-z]{3}\s+)?(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) UTC(?=\s*(?:[;}]|$))/gm)];
  if (matches.length !== 1) throw new Error('Cannot determine timer calendar');
  const date = matches[0][1].replace(' ', 'T') + '.000Z';
  if (!validDate(date)) throw new Error('Invalid timer calendar');
  return date;
}
async function listNames({ root, runner }) {
  const output = await runner('systemctl', ['--user', 'list-units', '--all', '--type=timer', '--no-legend', '--plain', '--no-pager'], { env: runtimeEnv() });
  return String(output).split('\n').map(line => line.trim().split(/\s+/)[0]).filter(unit => unit.startsWith(rootPrefix(root)) && unit.endsWith('.timer'));
}
export async function list({ root, config, runner = systemRunner }) {
  if (!enabled(config)) return [];
  root = await canonicalRoot(root);
  const units = await listNames({ root, runner });
  const timers = [];
  for (const unit of units) {
    // An unknown or disappearing unit makes reconciliation fail safely. Never
    // infer absence from a failed show, which could otherwise cause deletion.
    const value = await runner('systemctl', ['--user', 'show', unit, '--property=TimersCalendar', '--value'], { env: runtimeEnv() });
    const service = unit.slice(0, -6) + '.service';
    const argv = await runner('systemctl', ['--user', 'show', service, '--property=ExecStart', '--value'], { env: runtimeEnv() });
    const tokens = String(argv).replace(/argv\[\]=/g, ' ').split(/[\s;{}]+/).filter(Boolean);
    const values = option => tokens.flatMap((token, index) => token === option && tokens[index + 1] ? [tokens[index + 1]] : []);
    const matches = values('--due');
    const originalDue = matches.length === 1 && validDate(matches[0]) ? matches[0] : null;
    const tags = values('--config-tag');
    timers.push({ unit, due: parseCalendar(String(value)), originalDue, configTag: tags.length === 1 && /^[a-f0-9]{64}$/.test(tags[0]) ? tags[0] : null });
  }
  return timers;
}
async function armUnit({ root, role, id, due, config, configPath, runner = systemRunner }) {
  const unit = unitName(root, role, id).slice(0, -6);
  configPath = await canonicalConfig(root, configPath);
  const options = ['--config', configPath];
  await runner('systemd-run', [ '--user', '--collect', `--unit=${unit}`, `--on-calendar=${calendarSpec(due)}`, '--timer-property=AccuracySec=1s', `--description=ADK ledger due ${role}/${id}`, process.execPath, path.join(root, 'scripts/work-ledger/due-timer.mjs'), 'fire', '--root', root, '--role', role, '--id', id, ...options, '--config-tag', hash(configPath || ''), '--due', due ], { env: runtimeEnv() });
  return true;
}
async function canonicalConfig(root, configPath) {
  const file = path.resolve(root, configPath || 'config/work-ledger.json');
  try { return await realpath(file); } catch (error) { if (error.code === 'ENOENT') return file; throw error; }
}
export const timerLockPath = root => path.join(root, '.agents/work/ledger/due-timer-reconcile');
export async function arm({ root, role, id, due, config, configPath, now, clock = now === undefined ? Date.now : () => now, runner = systemRunner, fire: fireHandler }) {
  if (!enabled(config)) return false;
  root = await canonicalRoot(root);
  configPath = await canonicalConfig(root, configPath);
  const at = clock();
  const unit = unitName(root, role, id);
  return withLock(timerLockPath(root), async () => {
    const timers = await list({ root, config, runner });
    const actions = plan({ root, ledgers: [{ role, items: [{ id, due, status: 'open' }] }], timers, now: at, horizonMs: (config.due_timer.horizon_hours ?? 24) * HOUR, onlyUnits: new Set([unit]), configTag: hash(configPath) });
    const warnings = await executePlan({ root, config, configPath, actions, runner, now: at, fire: fireHandler ?? (entry => fire({ root, config, runner, now: at, ...entry })) });
    if (warnings.length) throw new Error(warnings.join('; '));
    return actions.some(action => action.type === 'arm' || action.type === 'fire');
  });
}
async function stopUnit({ root, unit, config, runner = systemRunner }) {
  root = await canonicalRoot(root);
  if (typeof unit !== 'string' || !/^adk-due-[a-f0-9]{8}-[a-f0-9]{16}-[a-zA-Z0-9_-]+\.timer$/.test(unit) || !unit.startsWith(rootPrefix(root))) throw new Error('Timer outside root');
  await runner('systemctl', ['--user', 'stop', unit], { env: runtimeEnv() });
  return true;
}
export async function disarm({ root, unit, config, runner = systemRunner }) {
  root = await canonicalRoot(root);
  return withLock(timerLockPath(root), () => stopUnit({ root, unit, config, runner }));
}
export async function clear({ root, config, runner = systemRunner }) {
  root = await canonicalRoot(root);
  return withLock(timerLockPath(root), async () => {
    const units = await listNames({ root, runner });
    const errors = [];
    for (const unit of units) {
      try { await stopUnit({ root, unit, config, runner }); }
      catch (error) { errors.push(`${unit}: ${error.message}`); }
    }
    if (errors.length) throw new AggregateError(errors.map(message => new Error(message)), `Failed to clear ${errors.length} timer(s): ${errors.join('; ')}`);
    return units.length;
  });
}
export async function executePlan({ root, config, actions, runner = systemRunner, fire, configPath, now = Date.now() }) {
  if (!enabled(config)) return [];
  const warnings = [];
  for (const action of actions) {
    if (action.type === 'arm') {
      const remaining = Date.parse(action.due) - now;
      if (remaining <= 5000) {
        if (!fire) throw new Error('Fire handler unavailable');
        await fire(action);
      } else if (remaining <= (config.due_timer.horizon_hours ?? 24) * HOUR) {
        await armUnit({ root, config, configPath, runner, ...action });
      }
    }
    else if (action.type === 'disarm') await stopUnit({ root, config, runner, ...action });
    else if (action.type === 'fire') {
      if (!fire) throw new Error('Fire handler unavailable');
      await fire(action);
    } else if (action.type === 'warning') warnings.push(action.message);
    else throw new Error('Unknown timer action');
  }
  return warnings;
}
export async function reconcile({ root, config, ledgers, now, clock = now === undefined ? Date.now : () => now, runner = systemRunner, fire, configPath, pruneUnknownRoles = false, configuredRoles = [] }) {
  if (!enabled(config)) return [];
  root = await canonicalRoot(root);
  configPath = await canonicalConfig(root, configPath);
  const at = now ?? clock();
  const timers = await list({ root, config, runner });
  const actions = plan({ root, ledgers, timers, now: at, horizonMs: (config.due_timer.horizon_hours ?? 24) * HOUR, configTag: hash(configPath), pruneUnknownRoles, configuredRoles });
  return executePlan({ root, config, actions, runner, fire, configPath, now: at });
}

// Load the latest ledger snapshots only after acquiring the common scheduler lock.
export async function reconcileCurrent({ root, config, roles, now, clock = now === undefined ? Date.now : () => now, runner = systemRunner, configPath, overdueViaWatch = false, pruneUnknownRoles = false }) {
  if (!enabled(config)) return [];
  root = await canonicalRoot(root);
  const at = now ?? clock();
  return withLock(timerLockPath(root), async () => {
    const ledgers = [];
    const warnings = [];
    for (const role of new Set(roles)) {
      try { ledgers.push(await readLedger(root, safeName(role))); }
      catch (error) { warnings.push(`ledger:${role}: ${error.message}`); }
    }
    warnings.push(...await reconcile({ root, config, ledgers, now: at, runner, configPath, pruneUnknownRoles, configuredRoles: roles, fire: action => overdueViaWatch && Date.parse(action.due) < at ? false : fire({ root, config, now: at, runner, ...action }) }));
    return warnings;
  });
}

// The full identity is hashed to avoid filesystem name limits and delimiter ambiguity.
export function receiptPath(root, role, id, due) {
  safeName(role); safeName(id);
  if (!validDate(due)) throw new Error('Invalid due date (UTC ISO required)');
  return path.join(root, '.agents/work/ledger/due-fired', `${hash(JSON.stringify([role, id, due]))}.json`);
}
function receiptLock(root, file) {
  return path.join(root, '.agents/work/ledger/due-fired/.locks', path.basename(file).slice(0, 2));
}

// Both writers take the ledger lock before the receipt lock. Persist the
// receipt before emitting so a crash after delivery cannot duplicate the wake.
export async function dueWake({ root, role, id, due, now = Date.now(), source = 'timer', lastSent, emit }) {
  safeName(role); safeName(id);
  if (!validDate(due) || !Number.isFinite(now) || !['timer', 'watch'].includes(source)) throw new Error('Invalid due wake');
  const file = receiptPath(root, role, id, due);
  return withLock(ledgerPath(root, role), async () => {
    let ledger;
    try { ledger = await readLedger(root, role); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    const item = ledger.items.find(entry => entry.id === id);
    if (!item || item.status !== 'open' || item.due !== due) return false;
    return withLock(receiptLock(root, file), async () => {
      let receipt;
      try { receipt = JSON.parse(await readFile(file, 'utf8')); }
      catch (error) { if (error instanceof SyntaxError) receipt = { status: 'claimed' }; else if (error.code !== 'ENOENT') throw error; }
      if (source === 'timer' && receipt) return false;
      if (source === 'watch') {
        const sent = receipt?.status === 'sent' && Number.isFinite(receipt.at) ? receipt.at : undefined;
        const previous = Math.max(Number.isFinite(lastSent) ? lastSent : -Infinity, sent ?? -Infinity);
        if (now - previous < 30 * 60000) return false;
      }
      await atomicJson(file, { role, id, due, status: 'sent', at: now });
      await emit(item);
      return true;
    });
  });
}

export async function cleanReceipts(root, now = Date.now()) {
  const dir = path.join(root, '.agents/work/ledger/due-fired');
  let names;
  try { names = await readdir(dir); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const file = path.join(dir, name);
    // Recheck under the writer's lock so cleanup cannot delete an active claim.
    let info;
    try { info = await stat(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (now - info.mtimeMs <= 48 * HOUR) continue;
    await withLock(receiptLock(root, file), async () => {
      try { if (now - (await stat(file)).mtimeMs > 48 * HOUR) await unlink(file); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    });
  }
}

export async function fire({ root, role, id, due, now = Date.now(), config = {}, runner = systemRunner }) {
  if (!enabled(config)) return false;
  if (!validDate(due) || !Number.isFinite(now)) throw new Error('Invalid due wake');
  if (Date.parse(due) - now > 5000) return false;
  const sent = await dueWake({ root, role, id, due, now, emit: async item => {
    const dir = path.join(root, '.agents/work/l4/wake');
    await mkdir(dir, { recursive: true });
    const stamp = new Date(now).toISOString().replace(/\D/g, '');
    const route = `-route-${role}.md`;
    let base = `${stamp}-${hash(due).slice(0, 8)}-ledger-${id}${route}`;
    if (Buffer.byteLength(base) > 255) {
      const available = 255 - Buffer.byteLength(route);
      if (available < 5) throw new Error('Role too long for wake filename');
      base = `${hash(JSON.stringify([role, id, due, now])).slice(0, available)}${route}`;
    }
    const file = path.join(dir, base);
    const late = now - Date.parse(due);
    const lateText = late > 120000 ? `\n늦음 ${Math.floor(late / 60000)}분 (기계 꺼짐·잠듦)` : '';
    const body = `[장부] 정한 시각: ${item.title.replace(/[\r\n]/g, ' ')}\n출처: ${item.from.channel}/${item.from.msg_id}\n기한: ${item.due}\n결과: ${item.worker?.result || '(없음)'}${lateText}\n`;
    await writeFile(file, body, { flag: 'wx', mode: 0o600 });
  } });
  const command = config?.due_timer?.after_fire;
  if (sent && enabled(config) && command !== undefined) {
    if (!Array.isArray(command) || !command.length || command.some(arg => typeof arg !== 'string' || !arg)) throw new Error('Invalid after_fire command');
    await runner(command[0], command.slice(1), { env: process.env });
  }
  return sent;
}
export async function main(args = process.argv.slice(2), { runner, now } = {}) {
  const { opts, positional: [command] } = parseArgs(args);
  const root = await canonicalRoot(opts.root || process.cwd());
  let config;
  try { config = JSON.parse(await readFile(path.resolve(root, opts.config || 'config/work-ledger.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT' || opts.config) throw error; config = {}; }
  if (command === 'fire') return fire({ root, role: opts.role, id: opts.id, due: opts.due, config, runner, now });
  if (command === 'list') return list({ root, config, runner });
  if (command === 'clear') return clear({ root, config, runner });
  if (command === 'arm') return arm({ root, role: opts.role, id: opts.id, due: opts.due, config, configPath: opts.config ? path.resolve(root, opts.config) : undefined, runner, now });
  if (command === 'disarm') return disarm({ root, unit: unitName(root, opts.role, opts.id), config, runner });
  throw new Error('Commands: arm disarm list clear fire');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(value => console.log(JSON.stringify(value))).catch(error => { console.error(`timer: 못 걺 (${error.message})`); process.exitCode = 1; });
}
