#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { classifyComposerScreen } from './lib/composer-screen.mjs';

const index = process.argv.indexOf('--tool');
const tool = index < 0 ? '' : process.argv[index + 1];
try {
  const state = classifyComposerScreen(readFileSync(0, 'utf8'), tool);
  process.stdout.write(JSON.stringify({ tool, state }) + '\n');
} catch {
  process.stdout.write(JSON.stringify({ tool, state: 'unknown' }) + '\n');
  process.exitCode = 75;
}
