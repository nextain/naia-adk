#!/usr/bin/env node
import { readFixture, collectSignals } from './lib/audit-signals.mjs';
import { evaluate, initialState, priorityMismatch } from './lib/audit-rules.mjs';
import { readFile, mkdir, open, unlink, realpath, lstat, rename } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, sep, basename, join } from 'node:path';
import { createDiscordApi, postDiscord } from './response-watch.mjs';
import { deliverAudit, deliveryKey, validateDelivery } from './lib/audit-delivery.mjs';
import { buildBundle, judge, sha256, fixedTemplate, formatText } from './lib/audit-judge.mjs';
import { recordSchedule } from './schedule-record.mjs';

async function canonical(path) {
  if (typeof path !== 'string' || !path || !isAbsolute(path)) throw Error('absolute audit paths required');
  let current = resolve(path), missing = [];
  while (true) {
    try { return join(await realpath(current), ...missing); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A dangling symlink must not be mistaken for an absent path.
      try { await lstat(current); throw Error('unresolvable audit path'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const parent = dirname(current);
      if (parent === current) throw Error('unresolvable audit path');
      missing.unshift(basename(current)); current = parent;
    }
  }
}
const overlaps = (a, b) => { const r = relative(a, b); return !r || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r)); };
async function atomic(path, text) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`, handle = await open(tmp, 'wx', 0o600);
  try { await handle.writeFile(text); await handle.close(); await rename(tmp, path); }
  catch (error) { await handle.close().catch(() => {}); await unlink(tmp).catch(() => {}); throw error; }
}
export async function validateAuditPaths(config, extraSessionDirs = []) {
  if (!Array.isArray(config.roles) || !config.roles.length || config.roles.some(r => !Array.isArray(r.sessionDirs) || !r.sessionDirs.length)) throw Error('session directories required');
  if (typeof config.schedule?.id !== 'string' || !config.schedule.id) throw Error('schedule id required');
  const outputs = [config.stateFile, config.reportFile, config.schedule.file, ...config.roles.map(r => r.wakeDir)];
  const derived = [config.stateFile, config.reportFile, config.schedule.file].flatMap(p => typeof p === 'string' ? [`${p}.lock`, `${p}.${process.pid}.tmp`] : []);
  const roots = await Promise.all(outputs.map(canonical));
  const sessions = await Promise.all([...config.roles.flatMap(r => r.sessionDirs), ...extraSessionDirs].map(canonical));
  for (let i = 0; i < roots.length; i++) {
    if (sessions.some(s => overlaps(s, roots[i]) || overlaps(roots[i], s))) throw Error('audit output overlaps session directory');
    if (roots.some((p, j) => i !== j && (overlaps(p, roots[i]) || overlaps(roots[i], p)))) throw Error('audit outputs overlap');
  }
  for (let i = 0; i < derived.length; i++) {
    const p = await canonical(derived[i]);
    if (sessions.some(s => overlaps(s, p) || overlaps(p, s)) || roots.some((r, j) => j !== Math.floor(i / 2) && (overlaps(r, p) || overlaps(p, r)))) throw Error('audit temporary path overlaps protected path');
  }
}

export async function runFixture({ fixture, input: suppliedInput, from, to, step = 30 * 60000, evidence, verifyEvidence, config = { judge: { runner: 'none' } }, configBytes, executable, priority, role = 'role', state: previousState }) {
  const input = suppliedInput ?? await readFixture(fixture);
  const prompt = await readFile(new URL('../prompts/session-audit.md', import.meta.url), 'utf8');
  const configHash = sha256(configBytes ?? JSON.stringify(config)), promptHash = sha256(prompt);
  const header = { configHash: configHash.slice(0, 8), promptHash: promptHash.slice(0, 8) };
  const options = { ...(config.thresholds ?? {}), evidence: evidence ?? input.ledger?.evidence ?? [], verifyEvidence };
  let state = structuredClone(previousState ?? initialState()), last; const timeline = [], texts = [], outputs = [];
  for (let at = from; at <= to; at += step) {
    const signals = collectSignals(input, { now: at });
    const preliminary = evaluate(signals, state, at, options);
    const events = preliminary.events.filter(e => e.stage !== 'recovered');
    let judged;
    if (priority || events.length) {
      try {
        if (config.judge?.runner === 'none') judged = { failed: false, reason: 'none' };
        else {
          const bundle = buildBundle({ signals, firedCodes: preliminary.active.filter(e => e.code !== 'audit-degraded').map(e => e.code), configHash, promptHash, priority });
          judged = await judge({ bundle, config, prompt, executable });
        }
      } catch (error) { judged = { failed: true, reason: error.message }; }
      if (judged.failed) state.llmFailures = (state.llmFailures ?? 0) + 1;
      else if (config.judge?.runner !== 'none') state.llmFailures = 0;
    }
    signals.S9 = priorityMismatch(priority ? judged : null);
    const result = evaluate(signals, state, at, options); state = result.state; last = result;
    timeline.push(...result.events);
    for (const event of result.events.filter(e => e.stage !== 'recovered')) {
      const output = judged?.output?.code === event.code ? judged.output : fixedTemplate(event.code);
      texts.push(formatText({ role, output, configHash, promptHash }));
      outputs.push(output);
    }
    const summary = result.active.some(e => e.code !== 'audit-degraded') ? '신호 감지' : '신호 없음';
    if (from === to) return { ...result, summary, header, texts, outputs, timeline };
  }
  return { ...last, state, header, texts, outputs, timeline };
}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function validateState(state) {
  if (!record(state) || state.version !== 1 || !record(state.roles) || !record(state.delivery) || !record(state.delivery.days) || !record(state.delivery.episodes) || (state.pending !== undefined && !record(state.pending))) throw Error('invalid audit state');
  for (const role of Object.values(state.roles)) {
    if (!record(role) || !record(role.episodes) || !record(role.reviewFiles) || !record(role.lastCounts) || typeof role.initialized !== 'boolean' || !Number.isInteger(role.blindRuns) || role.blindRuns < 0 || !Number.isInteger(role.llmFailures) || role.llmFailures < 0) throw Error('invalid audit role state');
    for (const ep of Object.values(role.episodes)) if (!record(ep) || typeof ep.code !== 'string' || typeof ep.target !== 'string' || !Number.isFinite(ep.at) || typeof ep.warned !== 'boolean' || typeof ep.reported !== 'boolean' || !Array.isArray(ep.evidenceIds) || !Array.isArray(ep.claimIds) || !Number.isInteger(ep.deferrals)) throw Error('invalid audit episode');
    if (Object.values(role.reviewFiles).some(v => !Array.isArray(v) || v.some(n => typeof n !== 'string')) || Object.values(role.lastCounts).some(v => !Number.isInteger(v) || v < 0)) throw Error('invalid audit counters');
  }
  for (const d of Object.values(state.delivery.days)) if (!record(d) || !Number.isInteger(d.count) || d.count < 0 || typeof d.capReported !== 'boolean') throw Error('invalid audit day');
  for (const e of Object.values(state.delivery.episodes)) if (!record(e) || !['intent', 'confirmed', 'uncertain'].includes(e.status) || !Number.isFinite(e.at) || (e.status === 'confirmed' && typeof e.id !== 'string')) throw Error('invalid delivery receipt');
  for (const queue of Object.values(state.pending ?? {})) if (!Array.isArray(queue) || queue.some(e => !record(e) || !['warn', 'report'].includes(e.stage) || typeof e.code !== 'string' || typeof e.target !== 'string' || !Number.isFinite(e.at) || !Number.isFinite(e.episodeAt))) throw Error('invalid pending audit events');
}
// The delivery journal records intent before I/O so a crash cannot silently resend.
export async function runAudit({ config, role: roleId, fixture, input, now = Date.now(), sender, token, fetchImpl = fetch, channelMessages, verifyEvidence, priority, configBytes } = {}) {
  await validateAuditPaths(config, fixture ? [resolve(fixture)] : []);
  if (config.hold === true) throw Error('HOLD output is outside permitted audit paths');
  const role = config.roles?.find(r => r.id === roleId);
  if (!role || typeof config.stateFile !== 'string' || !config.stateFile || typeof config.reportFile !== 'string' || !config.reportFile) throw Error('missing audit role or files');
  const transport = sender ?? (token ? item => postDiscord(createDiscordApi(fetchImpl, token), item) : undefined);
  const dry = config.dry === true || !transport;
  let lock;
  try {
    if (!dry) {
      await mkdir(dirname(config.stateFile), { recursive: true, mode: 0o700 });
      lock = await open(`${config.stateFile}.lock`, 'wx', 0o600);
    }
    let persisted;
    try { persisted = JSON.parse(await readFile(config.stateFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw Error('state unreadable; refusing reset'); persisted = { version: 1, roles: {}, delivery: { days: {}, episodes: {} } }; }
    validateState(persisted);
    const dryBinding = sha256(`${sha256(configBytes ?? JSON.stringify(config))}:${sha256(JSON.stringify(persisted))}`);
    if (dry) {
      let previousReport;
      try { previousReport = await readFile(config.reportFile, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const marker = previousReport?.match(/<!-- audit-dry-state:([A-Za-z0-9+/=]+) -->/);
      if (marker) {
        let simulation;
        try { simulation = JSON.parse(Buffer.from(marker[1], 'base64').toString('utf8')); } catch { throw Error('invalid dry audit state'); }
        if (simulation.binding === dryBinding) { validateState(simulation.state); persisted = simulation.state; }
      } else if (previousReport?.includes('<!-- audit-dry-state:')) throw Error('invalid dry audit state');
    }
    validateDelivery(config, role, now, ['00000000', '00000000']);
    if (/[|\r\n@<>]/.test(config.reportFile)) throw Error('invalid report path');
    const result = await runFixture({ fixture, input, from: now, to: now, config, role: role.id, state: persisted.roles[role.id], verifyEvidence, priority, configBytes });
    let index = 0;
    const generated = result.events.map(event => {
      if (event.stage === 'recovered') return event;
      const id = event.target ? `${event.code}:${event.target}` : event.code;
      return { ...event, episodeAt: result.state.episodes[id]?.at ?? event.at, output: result.outputs[index++] };
    });
    persisted.pending ??= {};
    if (typeof persisted.pending !== 'object' || Array.isArray(persisted.pending)) throw Error('invalid pending audit state');
    if (!Array.isArray(persisted.pending[role.id] ?? [])) throw Error('invalid pending audit events');
    const recovered = generated.filter(e => e.stage === 'recovered');
    const pending = (persisted.pending[role.id] ?? []).filter(e => !recovered.some(r => r.code === e.code && r.target === e.target));
    const events = [...pending, ...generated];
    persisted.pending[role.id] = events.filter(e => e.stage !== 'recovered');
    persisted.roles[role.id] = result.state;
    const save = async delivery => {
      if (dry) return;
      persisted.delivery = delivery;
      persisted.pending[role.id] = persisted.pending[role.id].filter(event => !delivery.episodes[deliveryKey(role, event)]);
      await atomic(config.stateFile, `${JSON.stringify(persisted, null, 2)}\n`);
    };
    if (!dry && persisted.pending[role.id].length) await atomic(config.stateFile, `${JSON.stringify(persisted, null, 2)}\n`);
    const observedMessages = channelMessages ?? (config.channelReadFile ? JSON.parse(await readFile(config.channelReadFile, 'utf8')) : []);
    const delivered = await deliverAudit({ role, events, config, state: persisted.delivery, reportPath: config.reportFile, configHash: result.header.configHash, promptHash: result.header.promptHash, now, sender: dry ? undefined : transport, channelMessages: observedMessages, save });
    let report = [`prompt=${result.header.promptHash} config=${result.header.configHash}`, result.summary, `못 읽은 입력: ${result.unknown.join(', ') || '없음'}`, delivered.report].join('\n') + '\n';
    if (dry) {
      persisted.delivery = delivered.projectedState;
      persisted.pending[role.id] = persisted.pending[role.id].filter(event => !persisted.delivery.episodes[deliveryKey(role, event)]);
      const encoded = Buffer.from(JSON.stringify({ binding: dryBinding, state: persisted })).toString('base64');
      report += `<!-- audit-dry-state:${encoded} -->\n`;
    } else await save(delivered.state);
    await atomic(config.reportFile, report);
    return { ...result, ...delivered, report };
  } finally { if (lock) { await lock.close(); await unlink(`${config.stateFile}.lock`); } }
}
async function main(args) {
  const get = flag => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i+1]; };
  if (args.includes('--run')) {
    if (!get('--config') || !get('--fixture') || !get('--role')) throw Error('--config, --fixture and --role are required');
    const configBytes = await readFile(get('--config'), 'utf8'), config = JSON.parse(configBytes);
    const now = get('--at') ? Date.parse(get('--at')) : Date.now();
    if (args.includes('--dry')) config.dry = true;
    const token = config.sender?.tokenEnv ? process.env[config.sender.tokenEnv] : undefined;
    const result = await runAudit({ config, configBytes, role: get('--role'), fixture: get('--fixture'), now, token });
    console.log(result.report); return;
  }
  if (!args.includes('--dry') || !get('--fixture')) throw Error('--dry and --fixture are required');
  const replay = args.includes('--replay');
  const from = Date.parse(get(replay ? '--from' : '--at')), to = replay ? Date.parse(get('--to')) : from;
  const stepText = get('--step') ?? '30m', match = /^(\d+)m$/.exec(stepText), step = match ? Number(match[1])*60000 : NaN;
  if (![from,to,step].every(Number.isFinite) || from > to || step <= 0) throw Error('invalid time range or step');
  const configBytes = get('--config') ? await readFile(get('--config'), 'utf8') : undefined;
  const config = configBytes === undefined ? undefined : JSON.parse(configBytes);
  const priority = get('--priority') ? JSON.parse(await readFile(get('--priority'), 'utf8')) : undefined;
  const result = await runFixture({ fixture: get('--fixture'), from, to, step, config, configBytes, priority });
  if (replay) {
    console.log(`prompt=${result.header.promptHash} config=${result.header.configHash}`);
    for (const e of result.timeline) console.log(`${new Date(e.at).toISOString()} ${e.stage} ${e.code}${e.target ? `:${e.target}` : ''}`);
  } else console.log(JSON.stringify({ header: result.header, unreadableInputs: result.unknown.length, ...result }, null, 2));
}
async function recordedMain(args) {
  const index = args.indexOf('--config');
  let config;
  try {
    if (index < 0 || !args[index + 1]) throw Error('configuration required for schedule record');
    config = JSON.parse(await readFile(args[index + 1], 'utf8'));
    const fixtureIndex = args.indexOf('--fixture');
    await validateAuditPaths(config, fixtureIndex >= 0 && args[fixtureIndex + 1] ? [resolve(args[fixtureIndex + 1])] : []);
  } catch (error) { console.error(`schedule record unavailable: ${error.message}`); return 2; }
  let failed = false;
  try { await main(args); } catch (error) { failed = true; console.error(error.message); }
  try { await recordSchedule(config.schedule.file, config.schedule.id, failed ? 'failed' : 'success'); }
  catch (error) { console.error(`schedule record failed: ${error.message}`); return 2; }
  return failed ? 1 : 0;
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) recordedMain(process.argv.slice(2)).then(code => { process.exitCode = code; });
