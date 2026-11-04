#!/usr/bin/env node
import { loadConfig, consume } from './lib/security-advisory.mjs';
const args=process.argv.slice(2);
try {
  const dry=args.includes('--dry'); const rest=args.filter(a=>a!=='--dry');
  if(rest.length!==2 || rest[0]!=='--config') throw Error('usage: security-advisory-consume.mjs --config CONFIG [--dry]');
  console.log(JSON.stringify(await consume(await loadConfig(rest[1]),{dry}),null,2));
} catch(e) { console.error(e.message); process.exitCode=1; }
