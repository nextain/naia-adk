#!/usr/bin/env node
// Install the reply command and preserve the relative layout of its dependencies.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const guardDir = resolve(scriptsDir, '../.agents/skills/manage-discord-sessions/helper');
export function installClient(destination = join(homedir(), '.local/lib/naia-messenger')) {
  const target = resolve(destination);
  mkdirSync(join(target, 'messenger'), { recursive: true });
  mkdirSync(join(target, 'lib'), { recursive: true });
  for (const name of ['message-guard.mjs', 'message-guard-patterns.json'])
    copyFileSync(join(guardDir, name), join(target, 'lib', name));
  copyFileSync(join(scriptsDir, 'messenger/msg.mjs'), join(target, 'messenger/msg.mjs'));
  writeFileSync(join(target, 'msg.mjs'), "#!/usr/bin/env node\nimport { main } from './messenger/msg.mjs';\nmain().catch(error => { console.error(error.message); process.exitCode = 1; });\n");
  return join(target, 'msg.mjs');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length > 3) { console.error('install-client.mjs [설치 폴더]'); process.exitCode = 1; }
  else console.log(installClient(process.argv[2]));
}
