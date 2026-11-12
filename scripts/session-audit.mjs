#!/usr/bin/env node
import { readFixture, collectSignals } from './lib/audit-signals.mjs';
import { evaluate, initialState, priorityMismatch } from './lib/audit-rules.mjs';
import { readFile } from 'node:fs/promises';
import { buildBundle, judge, sha256, fixedTemplate, formatText } from './lib/audit-judge.mjs';

export async function runFixture({ fixture, input: suppliedInput, from, to, step = 30 * 60000, evidence, verifyEvidence, config = { judge: { runner: 'none' } }, configBytes, executable, priority, role = 'role', state: previousState }) {
  const input = suppliedInput ?? await readFixture(fixture);
  const prompt = await readFile(new URL('../prompts/session-audit.md', import.meta.url), 'utf8');
  const configHash = sha256(configBytes ?? JSON.stringify(config)), promptHash = sha256(prompt);
  const header = { configHash: configHash.slice(0, 8), promptHash: promptHash.slice(0, 8) };
  const options = { evidence: evidence ?? input.ledger?.evidence ?? [], verifyEvidence };
  let state = structuredClone(previousState ?? initialState()), last; const timeline = [], texts = [];
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
    }
    const summary = result.active.some(e => e.code !== 'audit-degraded') ? '신호 감지' : '신호 없음';
    if (from === to) return { ...result, summary, header, texts, timeline };
  }
  return { ...last, state, header, texts, timeline };
}
async function main(args) {
  const get = flag => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i+1]; };
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
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
