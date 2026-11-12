#!/usr/bin/env node
import { readFixture, collectSignals } from './lib/audit-signals.mjs';
import { evaluate, initialState } from './lib/audit-rules.mjs';

export async function runFixture({ fixture, from, to, step = 30 * 60000 }) {
  const input = await readFixture(fixture); let state = initialState(); const timeline = [];
  for (let at = from; at <= to; at += step) {
    const result = evaluate(collectSignals(input, { now: at }), state, at); state = result.state;
    timeline.push(...result.events);
    if (from === to) return { ...result, timeline };
  }
  return { state, timeline };
}
async function main(args) {
  const get = flag => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i+1]; };
  if (!args.includes('--dry') || !get('--fixture')) throw Error('--dry and --fixture are required');
  const replay = args.includes('--replay');
  const from = Date.parse(get(replay ? '--from' : '--at')), to = replay ? Date.parse(get('--to')) : from;
  const stepText = get('--step') ?? '30m', match = /^(\d+)m$/.exec(stepText), step = match ? Number(match[1])*60000 : NaN;
  if (![from,to,step].every(Number.isFinite) || from > to || step <= 0) throw Error('invalid time range or step');
  const result = await runFixture({ fixture: get('--fixture'), from, to, step });
  if (replay) for (const e of result.timeline) console.log(`${new Date(e.at).toISOString()} ${e.stage} ${e.code}${e.target ? `:${e.target}` : ''}`);
  else console.log(JSON.stringify({ summary: result.active.length ? '신호 감지' : '신호 없음', unreadableInputs: result.unknown.length, ...result }, null, 2));
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
