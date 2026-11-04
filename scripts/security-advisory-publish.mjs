#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { loadConfig, publish } from './lib/security-advisory.mjs';
const args=process.argv.slice(2);
try {
  const dry=args.includes('--dry'); const rest=args.filter(a=>a!=='--dry');
  if(rest.length!==4 || rest[0]!=='--config' || rest[2]!=='--input') throw Error('usage: security-advisory-publish.mjs --config CONFIG --input CURATED.json [--dry]');
  console.log(JSON.stringify(await publish(await loadConfig(rest[1]),JSON.parse(await readFile(rest[3],'utf8')),{dry}),null,2));
} catch(e) { console.error(e.message); process.exitCode=1; }
