#!/usr/bin/env node
import { readFile, writeFile, stat, readdir, mkdir, rename, open, unlink } from 'node:fs/promises';
import { resolve, dirname, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);
const hash = s => createHash('sha256').update(s).digest('hex');
const command = async (file, args = [], cwd) => (await exec(file, args, { cwd, timeout: 15000, maxBuffer: 4 * 1024 * 1024 })).stdout;
const git = (cwd, args) => command('git', ['-C', cwd, ...args]);
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const time = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const stamp = value => value == null ? 'unknown' : new Date(value).toISOString();
const signalFor = code => code === 'drift' ? 'rules' : code === 'stalled' ? 'progress' : 'window';
const cell = value => String(value).replace(/[|\r\n]/g, ' ').replace(/[<>]/g, '');
async function optionalStat(path) { try { return (await stat(path)).mtimeMs; } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }

export function validateConfig(c) {
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
  for (const [key, fallback] of [['idleMinutes', 30], ['staleHours', 2], ['escalateMinutes', 30]]) if (!(Number.isFinite(c[key] ?? fallback) && (c[key] ?? fallback) > 0)) throw Error('positive thresholds required');
  if (c.responseWatchState && !isAbsolute(c.responseWatchState)) throw Error('absolute response state required');
  if (c.notifications) for (const id of [c.notifications.nudgeChannelId, c.notifications.escalation?.channelId, c.notifications.escalation?.userId, ...c.roles.map(r => r.botId)]) if (!/^\d+$/.test(id ?? '')) throw Error('invalid notification id');
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
    if (alive !== 'alive') anomalies.push(alive);
    if (role.sessionLog) { try { compact = compactEvidence(await readFile(role.sessionLog, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  } catch { errors.push('window/session evidence unavailable'); }
  const evidence = [];
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
  if (tasks.length && now - (progress ?? record.firstAt) >= (config.staleHours ?? 2) * 3600000) anomalies.push('stalled');
  try { rules = await compareRules(config, role); if (rules.status === 'drift') anomalies.push('drift'); } catch { errors.push('rule evidence unavailable'); }
  return { record, role: role.id, alive, compact, tasks, progress, progressSources, rules, anomalies, errors };
}

const atomic = async (path, text) => { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); const tmp = `${path}.${process.pid}.tmp`; await writeFile(tmp, text, { mode: 0o600 }); await rename(tmp, path); };
export async function runHealth(config, { now = Date.now(), dry = false, fetchImpl = fetch, token, windowProbe, log = e => console.log(JSON.stringify(e)) } = {}) {
  validateConfig(config);
  if (config.notifications && !dry && !token) throw Error('notification token missing');
  let lock;
  if (!dry) { await mkdir(dirname(config.stateFile), { recursive: true, mode: 0o700 }); lock = await open(`${config.stateFile}.lock`, 'wx', 0o600); await lock.writeFile(JSON.stringify({ pid: process.pid, started: now })); }
  const started = Date.now(), trace = randomUUID();
  const emit = event => log({ trace, ...event });
  emit({ stage: 'start', dry });
  try {
    let state; try { state = await json(config.stateFile); } catch (e) { if (e.code !== 'ENOENT') throw Error('state unreadable; refusing reset'); state = { version: 1, roles: {} }; }
    if (state.version !== 1 || !state.roles || typeof state.roles !== 'object' || Array.isArray(state.roles)) throw Error('invalid state');
    let response = {}; let responseError = false;
    if (config.responseWatchState) try { response = await json(config.responseWatchState); } catch { responseError = true; }
    const save = () => dry ? Promise.resolve() : atomic(config.stateFile, JSON.stringify(state, null, 2));
    const rows = []; let previews = 0, degraded = responseError;
    for (const role of config.roles) {
      const previous = state.roles[role.id];
      const result = await observeRole(config, role, previous, now, response, windowProbe);
      if (responseError) result.errors.push('response evidence unavailable');
      rows.push(result); degraded ||= !!result.errors.length || !!result.anomalies.length;
      const rec = result.record; state.roles[role.id] = rec;
      const observed = { window: result.alive !== 'unknown', progress: result.progressSources.length > 0, rules: result.rules.status !== 'unknown' };
      const baselines = { ...rec.baselines };
      for (const [signal, known] of Object.entries(observed)) if (known) rec.baselines[signal] ??= now;
      // Unknown probes cannot prove recovery; retain episodes until a complete observation.
      for (const code of Object.keys(rec.episodes)) if (observed[signalFor(code)] && !(code === 'stalled' && result.errors.includes('work evidence unavailable')) && !result.anomalies.includes(code)) delete rec.episodes[code];
      for (const code of result.anomalies) {
        const episode = rec.episodes[code] ??= { at: now, sequence: ++rec.sequence, stages: {} };
        const signal = signalFor(code);
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
            const reply = await fetchImpl(`https://discord.com/api/v10/channels/${channel}/messages`, { method: 'POST', headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `<@${user}> Session health ${role.id}: ${code}`, allowed_mentions: { parse: [], users: [user] }, nonce: hash(`${role.id}/${code}/${episode.sequence}/${stage}/${episode.at}`).slice(0, 24), enforce_nonce: true }), signal: AbortSignal.timeout(15000) });
            if (!reply.ok) { episode.stages[stage].status = reply.status >= 400 && reply.status < 500 ? 'rejected' : 'uncertain'; degraded = true; }
            else { const data = await reply.json(); if (!data.id) throw Error('missing receipt'); episode.stages[stage] = { status: 'confirmed', at: now, id: data.id }; }
          } catch { episode.stages[stage].status = 'uncertain'; degraded = true; }
          await save();
        }
      }
      await save();
    }
    let report = `# Session health\n\nObserved: ${stamp(now)}\n\n| Role | Alive | Last activity | Assigned work | Progress | Last progress | Rules | Compact reread |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n`;
    for (const r of rows) {
      report += `| ${r.role} | ${r.alive} | ${stamp(r.record.lastActivity)} | ${cell(r.tasks.join('; ') || 'none observed')} | ${r.anomalies.includes('stalled') ? 'stalled' : r.errors.includes('work evidence unavailable') ? 'unknown' : r.tasks.length ? 'active' : 'no active task'} | ${stamp(r.progress)} (${r.progressSources.map(e => `${e.source}: ${stamp(e.at)}`).join('; ')}) | ${r.rules.status} | ${r.compact} |\n`;
      for (const d of r.rules.diffs) report += `\n${r.role}: ${d.path} lines ${d.lines.join(',')} (${d.allowed ? 'allowed' : 'unexpected'}); SHA256 ${d.expected} → ${d.actual}\n`;
      if (r.errors.length) report += `\n${r.role}: ${r.errors.join('; ')}\n`;
    }
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
