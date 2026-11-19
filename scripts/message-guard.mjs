#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { checkMessage } from './lib/message-guard.mjs';
try {
  const args = process.argv.slice(2);
  if (args.length > 1) throw Error('사용법: node scripts/message-guard.mjs [본문파일|-]');
  const body = readFileSync(!args[0] || args[0] === '-' ? 0 : args[0], 'utf8');
  const result = checkMessage(body);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 2; }
