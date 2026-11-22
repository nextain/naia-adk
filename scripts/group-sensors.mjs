#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadGroup, pollGroup, diagnoseGroup, recoverGroup } from './lib/group-sensors.mjs';

const [command, rootArg, adapterArg, instance, session, action, apply] = process.argv.slice(2);
try {
  if (!['poll', 'diagnose', 'recover'].includes(command) || !rootArg || !adapterArg) throw new Error('Usage: group-sensors.mjs poll|diagnose|recover GROUP_ROOT TRUSTED_ADAPTER_MODULE [INSTANCE [SESSION ACTION --apply]]');
  const root = path.resolve(rootArg);
  const config = loadGroup(root);
  // The operator selects trusted local executable code; config cannot select it.
  const adapter = (await import(pathToFileURL(path.resolve(adapterArg)).href)).default;
  const result = command === 'poll' ? await pollGroup(root, config, instance, adapter)
    : command === 'diagnose' ? await diagnoseGroup(root, config, adapter)
      : await recoverGroup(root, config, instance, adapter, session, action, apply === '--apply');
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  // Adapter exceptions can contain private source data. Keep CLI output bounded.
  process.stderr.write('Group sensor operation failed; inspect trusted adapter locally.\n');
  process.exitCode = 1;
}
