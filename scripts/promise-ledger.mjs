#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { addPromise, readWorkLedger, validateWorkLedger } from './lib/ledger.mjs';

// These expressions recognize common forms, not the full meaning of language.
const defaults = [
  String.raw`(?:\d{1,2}(?::\d{2})?\s*(?:KST|UTC|시)|\d{1,2}\/\d{1,2}|오늘|내일|아침|저녁|밤)[^.\n]{0,40}?까지[^.\n]{0,60}?(?:겠습니다|드리겠|하겠|할게요)`,
  String.raw`(?:\b(?:I|we)\s+(?:will|shall)\b|\b(?:I'll|we'll)\b)[^.\n]{0,100}?\b(?:by|before)\s+(?:today|tomorrow|tonight|noon|midnight|\d{1,4}(?:[:/.-]\d{1,2})*(?:\s*(?:am|pm|UTC|KST))?)\b`,
  String.raw`\b(?:by|before)\s+(?:today|tomorrow|tonight|noon|midnight|\d{1,4}(?:[:/.-]\d{1,2})*(?:\s*(?:am|pm|UTC|KST))?)[^.\n]{0,100}?\b(?:I|we)\s+(?:will|shall)\b`
];
export function containsPromise(text, patterns = defaults) {
  if (typeof text !== 'string' || !Array.isArray(patterns) || !patterns.length || patterns.some(p => typeof p !== 'string' || !p)) throw Error('invalid text or patterns');
  const expressions = patterns.map(pattern => new RegExp(pattern, 'iu'));
  return expressions.some(expression => expression.test(text));
}
export function checkPromise(text, channel, ledger, { now = Date.now(), patterns = defaults } = {}) {
  if (typeof channel !== 'string' || !channel.trim() || /[\r\n]/.test(channel)) throw Error('channel required');
  const promise = containsPromise(text, patterns);
  validateWorkLedger(ledger, now);
  if (!promise) return { allowed: true, reason: 'no time promise detected' };
  const backed = ledger.work.some(row => row.status === '진행 중' && row.source_channel === channel && row.due_at !== null && Date.parse(row.due_at) > now);
  return { allowed: backed, reason: backed ? 'open future work row for channel' : 'time promise requires an open future work row for channel' };
}
function argsToOptions(args) {
  const [command, ...rest] = args, options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (!key?.startsWith('--') || !rest[i + 1] || rest[i + 1].startsWith('--') || Object.hasOwn(options, key)) throw Error('invalid arguments');
    options[key] = rest[i + 1];
  }
  const allowed = command === 'check' ? ['--ledger', '--channel', '--text-file', '--patterns-file'] : command === 'add' ? ['--ledger', '--channel', '--role', '--title', '--due', '--message', '--id'] : [];
  if (!allowed.length || Object.keys(options).some(k => !allowed.includes(k))) throw Error('usage: promise-ledger.mjs check|add with named options; see docs/guides/work-ledger.md');
  for (const key of command === 'check' ? ['--ledger', '--channel', '--text-file'] : ['--ledger', '--channel', '--role', '--title', '--due', '--message']) if (!options[key]) throw Error(`missing ${key}`);
  return { command, options };
}
export async function main(args) {
  const { command, options: o } = argsToOptions(args);
  if (command === 'add') return addPromise(o['--ledger'], { role: o['--role'], title: o['--title'], due: o['--due'], channel: o['--channel'], message: o['--message'], ...(o['--id'] ? { id: o['--id'] } : {}) });
  const text = await readFile(o['--text-file'], 'utf8');
  const patterns = o['--patterns-file'] ? JSON.parse(await readFile(o['--patterns-file'], 'utf8')) : defaults;
  const work = await readWorkLedger(o['--ledger']);
  return checkPromise(text, o['--channel'], { version: 1, work }, { patterns });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const result = await main(process.argv.slice(2)); console.log(JSON.stringify(result)); if (result.allowed === false) process.exitCode = 2; }
  catch (error) { console.error(JSON.stringify({ allowed: false, reason: error.message })); process.exitCode = 1; }
}
