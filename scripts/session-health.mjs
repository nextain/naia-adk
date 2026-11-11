#!/usr/bin/env node
import { readFile, writeFile, stat, readdir, mkdir, rename, open, unlink } from 'node:fs/promises';
import { resolve, dirname, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createNotifier, validateNotify, recipientOk, notifyKind } from './notify.mjs';
import { readWorkLedger, readScheduleLedger, scheduleStatus } from './lib/ledger.mjs';
const exec = promisify(execFile);
const hash = s => createHash('sha256').update(s).digest('hex');
const command = async (file, args = [], cwd) => (await exec(file, args, { cwd, timeout: 15000, maxBuffer: 4 * 1024 * 1024 })).stdout;
const git = (cwd, args) => command('git', ['-C', cwd, ...args]);
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const time = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const stamp = value => value == null ? 'unknown' : new Date(value).toISOString();
const signalFor = (code, config) => code.startsWith('schedule-missed:') ? 'schedule' : code === 'drift' ? 'rules' : code === 'stalled' ? (config.workLedger ? 'ledger' : 'progress') : 'window';
const cell = value => String(value).replace(/[|\r\n]/g, ' ').replace(/[<>]/g, '');
async function optionalStat(path) { try { return (await stat(path)).mtimeMs; } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }

const messageKeys = new Set(['user', 'role', 'code', 'codeText', 'report']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function notificationMessage(config, stage, user, role, code) {
  const descriptions = config.codeText ?? {};
  const family = code.startsWith('schedule-missed:') ? 'schedule-missed' : code;
  const codeText = Object.hasOwn(descriptions, code) ? descriptions[code] : Object.hasOwn(descriptions, family) ? descriptions[family] : code;
  const values = { user, role, code, codeText, report: config.reportFile };
  return (config.messages?.[stage] ?? '<@{user}> Session health {role}: {code}')
    .replace(/\{(\w+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
}

export function validateConfig(c) {
  if (c.stoppedRequiresWork !== undefined && typeof c.stoppedRequiresWork !== 'boolean') throw Error('stoppedRequiresWork must be a boolean');
  if (c.messages !== undefined) {
    if (!isObject(c.messages)) throw Error('messages must be an object');
    for (const [stage, template] of Object.entries(c.messages)) {
      if (!['nudge', 'escalate'].includes(stage) || typeof template !== 'string' || !template.trim()) throw Error('invalid message template');
      for (const match of template.matchAll(/\{([^{}]*)\}/g)) if (!messageKeys.has(match[1])) throw Error('unknown message placeholder');
    }
  }
  if (c.codeText !== undefined && (!isObject(c.codeText) || Object.entries(c.codeText).some(([code, text]) => !code.trim() || typeof text !== 'string' || !text.trim()))) throw Error('codeText must map codes to non-empty strings');
  for (const key of ['stateFile', 'reportFile', 'baselineRepo']) if (!isAbsolute(c[key] ?? '')) throw Error('absolute paths required');
  if (c.stateFile === c.reportFile || !/^[a-f0-9]{40}$/.test(c.baselineSha ?? '')) throw Error('distinct paths and full baseline SHA required');
  if (!Array.isArray(c.roles) || !c.roles.length) throw Error('roles required');
  const ids = new Set();
  for (const r of c.roles) {
    if (!/^[a-zA-Z0-9_-]+$/.test(r.id) || ids.has(r.id)) throw Error('unique safe role id required');
    ids.add(r.id);
    if (!isAbsolute(r.workspace ?? '') || !r.window || !['tmux', 'herdr', 'snapshot'].includes(r.adapter?.kind)) throw Error('invalid role adapter');
    for (const p of [...(r.workFiles ?? []), ...(r.sessionLog ? [r.sessionLog] : [])]) if (!isAbsolute(p)) throw Error('absolute evidence path required');
    if (r.adapter.kind === 'snapshot' && !isAbsolute(r.adapter.path ?? '')) throw Error('absolute snapshot path required');
    if (r.adapter.kind === 'herdr' && (!Array.isArray(r.adapter.command) || !r.adapter.command.length || r.adapter.command.some(x => typeof x !== 'string'))) throw Error('herdr command argv required');
  }
  for (const [key, fallback] of [['idleMinutes', 30], ['staleHours', 2], ['escalateMinutes', 30], ['waitMaxHours', 24]]) if (!(Number.isFinite(c[key] ?? fallback) && (c[key] ?? fallback) > 0)) throw Error('positive thresholds required');
  for (const key of ['workLedger', 'regularSchedule']) if (c[key] != null && !isAbsolute(c[key])) throw Error('absolute ledger path required');
  if (c.responseWatchState && !isAbsolute(c.responseWatchState)) throw Error('absolute response state required');
  validateNotify(c.notify);
  // In messenger mode alerts go to notify.channel, and the escalation user may be a messenger name.
  if (c.notifications) for (const id of [...(notifyKind(c.notify) === 'messenger' ? [] : [c.notifications.nudgeChannelId, c.notifications.escalation?.channelId]), ...c.roles.map(r => r.botId)]) if (!/^\d+$/.test(id ?? '')) throw Error('invalid notification id');
  if (c.notifications && !recipientOk(c.notify, c.notifications.escalation?.userId)) throw Error('invalid notification id');
}

// A configured watcher must be readable before absence of requests proves idle.
function pendingWork(config, role, response) {
  if (!config.responseWatchState) return false;
  if (!isObject(response?.channels) || !/^\d+$/.test(role.botId ?? '')) return null;
  if (response.errors !== undefined && (!isObject(response.errors) || Object.keys(response.errors).length)) return null;
  let pending = false;
  for (const channel of Object.values(response.channels)) {
    if (!isObject(channel) || channel.error || !isObject(channel.pending)) return null;
    for (const request of Object.values(channel.pending)) {
      if (!isObject(request) || !/^\d+$/.test(request.botId ?? '')) return null;
      if (request.botId === role.botId) pending = true;
    }
  }
  return pending;
}

export async function collectWindow(role) {
  const a = role.adapter;
  if (a.kind !== 'tmux') {
    const data = a.kind === 'snapshot' ? await json(a.path) : JSON.parse(await command(a.command[0], a.command.slice(1)));
    if (!Array.isArray(data.windows)) throw Error('invalid adapter snapshot');
    const matches = data.windows.filter(w => w.name === role.window);
    if (matches.length > 1) throw Error('ambiguous window');
    const w = matches[0];
    if (w && (typeof w.aiRunning !== 'boolean' || typeof w.output !== 'string')) throw Error('invalid window evidence');
    return w;
  }
  let listing;
  try { listing = await command('tmux', ['list-panes', '-a', '-F', '#{session_name}:#{window_index}.#{pane_index}\t#{pane_pid}']); }
  catch (e) { if (/no server running|no sessions|error connecting to .*No such file or directory/.test(e.stderr ?? '')) return undefined; throw e; }
  const rows = listing.trim().split('\n');
  const row = rows.find(x => x.split('\t')[0] === role.window);
  if (!row) return undefined;
  const pid = Number(row.split('\t')[1]);
  const processes = (await command('ps', ['-eo', 'pid=,ppid=,comm='])).trim().split('\n').map(x => x.trim().split(/\s+/));
  const descendants = new Set([pid]);
  for (let changed = true; changed;) { changed = false; for (const [p, parent] of processes) if (descendants.has(Number(parent)) && !descendants.has(Number(p))) { descendants.add(Number(p)); changed = true; } }
  const aiRunning = processes.some(([p, , comm]) => descendants.has(Number(p)) && (role.aiPrograms ?? ['claude', 'codex', 'opencode']).includes(comm));
  return { aiRunning, output: await command('tmux', ['capture-pane', '-p', '-t', role.window]) };
}

export function compactEvidence(text) {
  let compact, read;
  for (const line of text.split('\n').filter(Boolean)) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    const at = time(e.at);
    if (at == null) continue;
    if (e.type === 'compact') compact = Math.max(compact ?? 0, at);
    if (e.type === 'entry_read' && e.path === 'AGENTS.md') read = Math.max(read ?? 0, at);
  }
  return compact == null ? 'unknown' : read > compact ? 'confirmed' : 'not observed';
}

export async function compareRules(config, role) {
  const fixed = ['AGENTS.md', '.claude/settings.json'];
  const tracked = (await git(config.baselineRepo, ['ls-tree', '-r', '--name-only', config.baselineSha, '--', '.agents/context'])).split('\n');
  let local = [];
  try { local = (await readdir(resolve(role.workspace, '.agents/context'))).map(n => `.agents/context/${n}`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const paths = [...new Set([...fixed, ...tracked, ...local].filter(p => fixed.includes(p) || /^\.agents\/context\/agents-rules[^/]*\.json$/.test(p)))];
  const diffs = [];
  for (const path of paths) {
    // Verify baseline membership before show: a missing baseline file is distinct from a bad SHA.
    const exists = (await git(config.baselineRepo, ['ls-tree', '--name-only', config.baselineSha, '--', path])).trim();
    let expected = exists ? await git(config.baselineRepo, ['show', `${config.baselineSha}:${path}`]) : null;
    let actual; try { actual = await readFile(resolve(role.workspace, path), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; actual = null; }
    if (path === '.claude/settings.json') {
      const canonical = v => v === null ? null : JSON.stringify(JSON.parse(v).hooks ?? {}, null, 2);
      expected = canonical(expected); actual = canonical(actual);
    }
    if (expected !== actual) {
      const a = expected?.split('\n') ?? [], b = actual?.split('\n') ?? [];
      const lines = Array.from({ length: Math.max(a.length, b.length) }, (_, i) => i + 1).filter(i => a[i - 1] !== b[i - 1]);
      diffs.push({ path, lines, expected: expected === null ? 'missing' : hash(expected), actual: actual === null ? 'missing' : hash(actual), allowed: (role.allowedOverrides ?? []).includes(path) });
    }
  }
  if (!tracked.some(p => /^\.agents\/context\/agents-rules[^/]*\.json$/.test(p)) || !(await git(config.baselineRepo, ['ls-tree', '--name-only', config.baselineSha, '--', 'AGENTS.md'])).trim()) throw Error('incomplete baseline');
  return { status: diffs.some(d => !d.allowed) ? 'drift' : 'match', diffs };
}

// A role waiting on a human may declare it in a work file: a line starting with
// "기다림" or "Waiting" that holds "다음 확인" / "next check" and a time, either ISO
// with offset or "M/D HH:MM KST|UTC". Until that time, and only within
// waitMaxHours (default 24), a quiet session is "waiting" instead of "stopped".
const WAIT_LINE = /^\s*(?:기다림|waiting\b).*?(?:다음\s*확인|next\s+check)\s*:?\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})|(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})\s*(KST|UTC))/i;
export function waitUntil(text, now) {
  for (const line of String(text).split('\n')) {
    const m = line.match(WAIT_LINE);
    if (!m) continue;
    if (!m[2]) return time(m[1]);
    const offset = m[6].toUpperCase() === 'KST' ? 9 : 0, year = new Date(now).getUTCFullYear();
    const at = y => Date.UTC(y, Number(m[2]) - 1, Number(m[3]), Number(m[4]) - offset, Number(m[5]));
    const candidates = [year - 1, year, year + 1].map(at);
    return candidates.reduce((a, b) => Math.abs(b - now) < Math.abs(a - now) ? b : a);
  }
  return null;
}

export async function observeRole(config, role, previous, now, response, windowProbe = collectWindow) {
  const record = { firstAt: previous?.firstAt ?? now, lastActivity: previous?.lastActivity ?? null, outputHash: previous?.outputHash, episodes: previous?.episodes ?? {}, sequence: previous?.sequence ?? 0, baselines: previous?.baselines ?? {} };
  const anomalies = [], errors = [];
  let alive = 'unknown', compact = 'unknown', tasks = [], progress = null, progressSources = [], rules = { status: 'unknown', diffs: [] };
  try {
    const w = await windowProbe(role);
    const logAt = role.sessionLog ? await optionalStat(role.sessionLog) : null;
    if (logAt != null && logAt <= now) record.lastActivity = Math.max(record.lastActivity ?? 0, logAt);
    if (w) { const h = hash(w.output); if (h !== record.outputHash) record.lastActivity = now; record.outputHash = h; }
    alive = !w ? 'missing' : !w.aiRunning ? 'empty' : now - (record.lastActivity ?? record.firstAt) >= (config.idleMinutes ?? 30) * 60000 ? 'stopped' : 'alive';
    if (role.sessionLog) { try { compact = compactEvidence(await readFile(role.sessionLog, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  } catch { errors.push('window/session evidence unavailable'); }
  const evidence = [];
  let ledgerKnown = !config.workLedger, ledgerTasks = [], schedules = null;
  if (config.workLedger) {
    try {
      ledgerTasks = (await readWorkLedger(config.workLedger, now)).filter(row => row.role === role.id && row.status === '진행 중');
      tasks.push(...ledgerTasks.map(row => `${row.id}: ${row.task}`));
      ledgerKnown = true;
    } catch { errors.push('work ledger unavailable'); }
  }
  if (config.stoppedRequiresWork) {
    const pending = pendingWork(config, role, response);
    if (pending === null) errors.push('response evidence unavailable');
    if (alive === 'stopped' && config.workLedger && ledgerKnown && !ledgerTasks.length && pending === false) alive = 'idle';
  }
  if (alive === 'stopped') {
    const limit = (config.waitMaxHours ?? 24) * 3600000;
    for (const path of role.workFiles ?? []) {
      const until = waitUntil(await readFile(path, 'utf8').catch(() => ''), now);
      if (Number.isFinite(until) && until > now && until - now <= limit) { alive = 'waiting'; break; }
    }
  }
  if (!['alive', 'idle', 'waiting', 'unknown'].includes(alive)) anomalies.push(alive);
  if (config.regularSchedule) {
    try {
      schedules = scheduleStatus(await readScheduleLedger(config.regularSchedule, now), role.id, now);
      for (const row of schedules) if (row.status === 'missed') anomalies.push(`schedule-missed:${row.occurrence}`);
    } catch { errors.push('schedule ledger unavailable'); }
  }
  const legacyStart = tasks.length;
  for (const path of role.workFiles ?? []) {
    try {
      const text = await readFile(path, 'utf8');
      tasks.push(...text.split('\n').filter(line => /진행\s*중|in progress/i.test(line)));
      evidence.push({ source: 'work document', at: await optionalStat(path) });
    } catch { errors.push('work evidence unavailable'); }
  }
  try {
    const commit = (await git(role.workspace, ['log', '-1', '--format=%cI'])).trim();
    evidence.push({ source: 'commit', at: time(commit) });
  } catch { errors.push('commit evidence unavailable'); }
  evidence.push({ source: 'confirmed reply', at: response?.replies?.[role.botId]?.at });
  progressSources = evidence.filter(e => Number.isFinite(e.at) && e.at <= now);
  progress = progressSources.length ? Math.max(...progressSources.map(e => e.at)) : null;
  const staleMs = (config.staleHours ?? 2) * 3600000;
  const ledgerProgress = ledgerTasks.map(row => ({ source: `work ${row.id}`, at: time(row.updated_at) }));
  if (ledgerTasks.some(row => now - time(row.updated_at) >= staleMs) ||
      (tasks.length > legacyStart && now - (progress ?? record.firstAt) >= staleMs)) anomalies.push('stalled');
  progressSources.push(...ledgerProgress);
  progress = progressSources.length ? Math.max(...progressSources.map(e => e.at)) : null;
  try { rules = await compareRules(config, role); if (rules.status === 'drift') anomalies.push('drift'); } catch { errors.push('rule evidence unavailable'); }
  return { record, role: role.id, alive, compact, tasks, progress, progressSources, rules, anomalies, errors, ledgerKnown, schedules };
}

const atomic = async (path, text) => { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); const tmp = `${path}.${process.pid}.tmp`; await writeFile(tmp, text, { mode: 0o600 }); await rename(tmp, path); };
export async function runHealth(config, { now = Date.now(), dry = false, fetchImpl = fetch, token, windowProbe, log = e => console.log(JSON.stringify(e)), notifier, env = process.env } = {}) {
  validateConfig(config);
  if (config.notifications && !dry && !notifier && (notifyKind(config.notify) === 'discord' ? !token : !env[config.notify.tokenEnv ?? 'NAIA_MESSENGER_TOKEN'])) throw Error('notification token missing');
  notifier ??= createNotifier(config.notify, { token, env, fetchImpl, names: Object.fromEntries(config.roles.map(r => [r.botId, r.id])) });
  let lock;
  if (!dry) { await mkdir(dirname(config.stateFile), { recursive: true, mode: 0o700 }); lock = await open(`${config.stateFile}.lock`, 'wx', 0o600); await lock.writeFile(JSON.stringify({ pid: process.pid, started: now })); }
  const started = Date.now(), trace = randomUUID();
  const emit = event => log({ trace, ...event });
  emit({ stage: 'start', dry });
  try {
    let state; try { state = await json(config.stateFile); } catch (e) { if (e.code !== 'ENOENT') throw Error('state unreadable; refusing reset'); state = { version: 1, roles: {} }; }
    if (state.version !== 1 || !state.roles || typeof state.roles !== 'object' || Array.isArray(state.roles)) throw Error('invalid state');
    let response = {}; let responseError = false;
    if (config.responseWatchState) try { response = await json(config.responseWatchState); } catch { response = null; responseError = true; }
    const save = () => dry ? Promise.resolve() : atomic(config.stateFile, JSON.stringify(state, null, 2));
    const rows = []; let previews = 0, degraded = responseError;
    for (const role of config.roles) {
      const previous = state.roles[role.id];
      const result = await observeRole(config, role, previous, now, response, windowProbe);
      if (responseError && !result.errors.includes('response evidence unavailable')) result.errors.push('response evidence unavailable');
      rows.push(result); degraded ||= !!result.errors.length || !!result.anomalies.length;
      const rec = result.record; state.roles[role.id] = rec;
      const observed = { ledger: Boolean(config.workLedger) && result.ledgerKnown, window: result.alive !== 'unknown', progress: result.progressSources.length > 0 || (Boolean(config.workLedger) && result.ledgerKnown), schedule: result.schedules !== null, rules: result.rules.status !== 'unknown' };
      const baselines = { ...rec.baselines };
      for (const [signal, known] of Object.entries(observed)) if (known) rec.baselines[signal] ??= now;
      // Unknown probes cannot prove recovery; retain episodes until a complete observation.
      for (const code of Object.keys(rec.episodes)) if (observed[signalFor(code, config)] && !(code === 'stalled' && (result.errors.includes('work evidence unavailable') || !result.ledgerKnown)) && !result.anomalies.includes(code)) delete rec.episodes[code];
      for (const code of result.anomalies) {
        const episode = rec.episodes[code] ??= { at: now, sequence: ++rec.sequence, stages: {} };
        const signal = signalFor(code, config);
        if (baselines[signal] == null || !config.notifications) continue;
        for (const stage of ['nudge', 'escalate']) {
          if (stage === 'escalate' && now - episode.at < (config.escalateMinutes ?? 30) * 60000) continue;
          const receipt = episode.stages[stage];
          if (receipt && receipt.status !== 'rejected') { if (receipt.status !== 'confirmed') degraded = true; continue; }
          previews++; if (dry) continue;
          episode.stages[stage] = { status: 'intent', at: now }; await save();
          const n = config.notifications, user = stage === 'nudge' ? role.botId : n.escalation.userId;
          const channel = stage === 'nudge' ? n.nudgeChannelId : n.escalation.channelId;
          try {
            const sent = await notifier.send({ stage, channelId: channel, content: notificationMessage(config, stage, user, role.id, code), mentions: [user], people: stage === 'escalate' ? [user] : [], nonce: hash(`${role.id}/${code}/${episode.sequence}/${stage}/${episode.at}`).slice(0, 24) });
            episode.stages[stage] = { status: 'confirmed', at: now, id: sent.id };
          } catch (e) { episode.stages[stage].status = e.uncertain === false ? 'rejected' : 'uncertain'; degraded = true; }
          await save();
        }
      }
      await save();
    }
    let report = `# Session health\n\nObserved: ${stamp(now)}\n\n| Role | Alive | Last activity | Assigned work | Progress | Last progress | Rules | Compact reread |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n`;
    const details = [];
    for (const r of rows) {
      report += `| ${r.role} | ${r.alive} | ${stamp(r.record.lastActivity)} | ${cell(r.tasks.join('; ') || (!r.ledgerKnown ? 'unknown (ledger unavailable)' : 'none observed'))} | ${r.anomalies.includes('stalled') ? 'stalled' : (r.errors.includes('work evidence unavailable') || !r.ledgerKnown) ? 'unknown' : r.tasks.length ? 'active' : 'no active task'} | ${stamp(r.progress)} (${r.progressSources.map(e => `${e.source}: ${stamp(e.at)}`).join('; ')}) | ${r.rules.status} | ${r.compact} |\n`;
      if (config.regularSchedule) details.push(`\n${r.role} regular schedule: ${r.schedules === null ? 'unknown' : r.schedules.map(s => `${cell(s.id)}: ${s.status === 'missed' ? '안 돎 (missed)' : s.status} (due ${stamp(s.dueAt)})`).join('; ') || 'no installed schedule'}\n`);
      for (const d of r.rules.diffs) details.push(`\n${r.role}: ${d.path} lines ${d.lines.join(',')} (${d.allowed ? 'allowed' : 'unexpected'}); SHA256 ${d.expected} → ${d.actual}\n`);
      if (r.errors.length) details.push(`\n${r.role}: ${r.errors.join('; ')}\n`);
    }
    report += details.join('');
    if (!dry) await atomic(config.reportFile, report);
    emit({ stage: 'end', result: degraded ? 'degraded' : 'complete', previews, durationMs: Date.now() - started });
    return { rows, report, degraded, previews };
  } catch (error) { emit({ stage: 'end', result: 'failed', durationMs: Date.now() - started }); throw error; } finally { if (lock) { await lock.close(); await unlink(`${config.stateFile}.lock`); } }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), at = args.indexOf('--config');
    if (at < 0 || !args[at + 1] || args.some((x, i) => !['--config', '--dry'].includes(x) && i !== at + 1)) throw Error('usage: session-health.mjs --config <file> [--dry]');
    const c = await json(args[at + 1]);
    const result = await runHealth(c, { dry: args.includes('--dry') || process.env.DRY_RUN === '1', token: process.env[c.tokenEnv ?? 'DISCORD_BOT_TOKEN'] });
    process.exitCode = result.degraded ? 2 : 0;
  } catch { console.error(JSON.stringify({ stage: 'fatal', result: 'failed' })); process.exitCode = 1; }
}
