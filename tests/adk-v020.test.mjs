import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  VALID_KINDS,
  VALID_ACTIONS,
  validateAdkManifest,
  validateAdkPath,
  linkAdkInstances,
  checkAdkInstance,
} from '../scripts/adk-link.mjs';
import { scaffoldProjectAdk, scaffoldAdkInstance } from '../scripts/adk-scaffold-project.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const naiaAdkRoot = path.resolve(__dirname, '..');
const adkLinkCli = path.join(naiaAdkRoot, 'scripts', 'adk-link.mjs');
const adkScaffoldCli = path.join(naiaAdkRoot, 'scripts', 'adk-scaffold-project.mjs');

test('1. naia-adk v0.2.0 root manifest, package.json, CHANGELOG.md, and schema integrity', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(naiaAdkRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.2.0');

  const rootManifestCheck = checkAdkInstance(naiaAdkRoot);
  assert.equal(rootManifestCheck.ok, true, `Root adk.json check failed: ${rootManifestCheck.errors.join('; ')}`);
  assert.equal(rootManifestCheck.manifest.adk_version, '0.2.0');

  const changelog = fs.readFileSync(path.join(naiaAdkRoot, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /\[0\.2\.0\]/);
  assert.match(changelog, /\[0\.1\.0\]/);

  const schema = JSON.parse(
    fs.readFileSync(path.join(naiaAdkRoot, 'schemas', 'adk-manifest.schema.json'), 'utf8'),
  );
  assert.deepEqual(schema.properties.kind.enum, ['user', 'agent', 'project', 'org']);
  assert.ok(schema.required.includes('owner'));
  assert.ok(schema.required.includes('responsible_human'));
  assert.ok(schema.required.includes('links'));
  assert.ok(schema.required.includes('permissions'));
  assert.deepEqual(schema.properties.permissions.properties.actions.items.enum, ['read', 'write', 'export']);
});

test('2. 4-kind ADK (user, agent, project, org) scaffolding, relative symlink linking, and validate-spec-chain', (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'naia-adk-v020-'));
  t.after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  const userDir = path.join(tmpRoot, 'luke-user-adk');
  const agentDir = path.join(tmpRoot, 'naia-agent-adk');
  const orgDir = path.join(tmpRoot, 'nextain-org-adk');
  const projectDir = path.join(tmpRoot, 'naia-arcade-project');

  // 1) Create user, agent, and org ADK instances
  scaffoldAdkInstance({
    targetDir: userDir,
    kind: 'user',
    id: 'luke-user-adk',
    name: 'Luke Personal ADK',
    owner: 'luke',
    responsibleHuman: 'luke',
  });
  scaffoldAdkInstance({
    targetDir: agentDir,
    kind: 'agent',
    id: 'naia-agent-adk',
    name: 'Naia Agent ADK',
    owner: 'luke',
    responsibleHuman: 'luke',
  });
  scaffoldAdkInstance({
    targetDir: orgDir,
    kind: 'org',
    id: 'nextain-org-adk',
    name: 'Nextain Org ADK',
    owner: 'nextain',
    responsibleHuman: 'luke',
  });

  // 2) Scaffold project ADK via CLI command
  execFileSync(
    process.execPath,
    [
      adkScaffoldCli,
      '--target',
      projectDir,
      '--name',
      'Naia Tactical Studio',
      '--id',
      'naia-arcade-project',
      '--owner',
      'nextain',
      '--responsible',
      'luke',
    ],
    { encoding: 'utf8' },
  );

  // 3) Put private secret files inside each ADK's isolated keys/ directory
  fs.writeFileSync(path.join(userDir, 'keys', 'user.key'), 'USER_SECRET', 'utf8');
  fs.writeFileSync(path.join(agentDir, 'keys', 'bot.token'), 'AGENT_BOT_TOKEN', 'utf8');
  fs.writeFileSync(path.join(orgDir, 'keys', 'org.key'), 'ORG_SERVER_KEY', 'utf8');
  fs.writeFileSync(path.join(projectDir, 'keys', 'project.key'), 'PROJECT_KEY', 'utf8');

  // 4) Link user -> agent, user -> project, user -> org, and org -> agent, org -> project via CLI
  execFileSync(process.execPath, [adkLinkCli, '--link', '--from', userDir, '--to', agentDir], { encoding: 'utf8' });
  execFileSync(process.execPath, [adkLinkCli, '--link', '--from', userDir, '--to', projectDir], { encoding: 'utf8' });
  execFileSync(process.execPath, [adkLinkCli, '--link', '--from', userDir, '--to', orgDir], { encoding: 'utf8' });
  execFileSync(process.execPath, [adkLinkCli, '--link', '--from', orgDir, '--to', agentDir], { encoding: 'utf8' });
  execFileSync(process.execPath, [adkLinkCli, '--link', '--from', orgDir, '--to', projectDir], { encoding: 'utf8' });

  // 5) Verify symlinks are strictly relative
  const userAgentMount = path.join(userDir, 'agents', 'naia-agent-adk');
  assert.equal(fs.lstatSync(userAgentMount).isSymbolicLink(), true);
  assert.equal(path.isAbsolute(fs.readlinkSync(userAgentMount)), false);
  assert.equal(fs.realpathSync(userAgentMount), fs.realpathSync(agentDir));

  // 6) Run adk-link.mjs --check across all 4 ADKs
  const checkOut = execFileSync(
    process.execPath,
    [adkLinkCli, '--check', userDir, agentDir, orgDir, projectDir],
    { encoding: 'utf8' },
  );
  assert.match(checkOut, /user:luke-user-adk/);
  assert.match(checkOut, /agent:naia-agent-adk/);
  assert.match(checkOut, /org:nextain-org-adk/);
  assert.match(checkOut, /project:naia-arcade-project/);

  // 7) Run validate-spec-chain.mjs on the scaffolded project ADK
  const validateScript = path.join(projectDir, 'scripts', 'validate-spec-chain.mjs');
  const specOut = execFileSync(process.execPath, [validateScript], { encoding: 'utf8' });
  assert.match(specOut, /1\/4 Project ADK manifest & keys\/ isolation verified/);
  assert.match(specOut, /2\/4 Bidirectional traceability/);
  assert.match(specOut, /3\/4 Markdown internal link integrity verified/);
  assert.match(specOut, /4\/4 Structured Debug Logger \(MAX=200\) & Interactive Mermaid Viewer client verified/);
});

test('3. Negative cases: empty responsible_human, keys/ symlink violation, and broken markdown link rejection', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'naia-adk-neg-'));
  t.after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // Negative 1: Empty responsible_human must fail both validateAdkManifest and scaffoldProjectAdk
  assert.throws(
    () =>
      scaffoldProjectAdk({
        targetDir: path.join(tmpRoot, 'bad-proj'),
        name: 'Bad Project',
        owner: 'nextain',
        responsibleHuman: '   ',
      }),
    /responsible/,
  );

  const badManifestRes = validateAdkManifest({
    adk_version: '0.2.0',
    kind: 'user',
    id: 'bad-user',
    owner: 'luke',
    responsible_human: '',
    links: [],
    permissions: {
      allowed_roots: ['rules'],
      denied_roots: ['keys'],
      actions: ['read'],
    },
  });
  assert.equal(badManifestRes.ok, false);
  assert.ok(badManifestRes.errors.some((e) => e.includes('responsible_human')));

  // Negative 2: keys/ in allowed_roots or missing from denied_roots or symlinked keys/ must fail
  const keysAllowedRes = validateAdkManifest({
    adk_version: '0.2.0',
    kind: 'user',
    id: 'leak-user',
    owner: 'luke',
    responsible_human: 'luke',
    links: [],
    permissions: {
      allowed_roots: ['rules', 'keys'],
      denied_roots: ['keys'],
      actions: ['read', 'export'],
    },
  });
  assert.equal(keysAllowedRes.ok, false);
  assert.ok(keysAllowedRes.errors.some((e) => e.includes('NEVER include keys/')));

  const projDir = path.join(tmpRoot, 'test-proj');
  scaffoldProjectAdk({
    targetDir: projDir,
    name: 'Test Project',
    owner: 'nextain',
    responsibleHuman: 'luke',
  });

  // Replace keys/ with a symlink and verify checkAdkInstance fails
  fs.rmSync(path.join(projDir, 'keys'), { recursive: true, force: true });
  const externalKeys = path.join(tmpRoot, 'ext-keys');
  fs.mkdirSync(externalKeys, { recursive: true });
  fs.symlinkSync('../ext-keys', path.join(projDir, 'keys'), 'dir');

  const checkWithSymlinkKeys = checkAdkInstance(projDir);
  assert.equal(checkWithSymlinkKeys.ok, false);
  assert.ok(checkWithSymlinkKeys.errors.some((e) => e.includes('keys')));

  // Restore keys/ as normal directory
  fs.unlinkSync(path.join(projDir, 'keys'));
  fs.mkdirSync(path.join(projDir, 'keys'), { recursive: true });
  assert.equal(checkAdkInstance(projDir).ok, true);

  // Negative 3: Broken markdown link inside docs/specs/ must fail validate-spec-chain.mjs
  const pcFile = path.join(projDir, 'docs', 'specs', '01-PC-product-concept.ko.md');
  const origPc = fs.readFileSync(pcFile, 'utf8');
  fs.writeFileSync(pcFile, origPc + '\n\n[깨진 링크](docs/specs/99-MISSING-DOC.ko.md)\n', 'utf8');

  assert.throws(() => {
    execFileSync(process.execPath, [path.join(projDir, 'scripts', 'validate-spec-chain.mjs')], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
  }, /Broken markdown link/);

  // Restore PC file and verify it passes again
  fs.writeFileSync(pcFile, origPc, 'utf8');
  execFileSync(process.execPath, [path.join(projDir, 'scripts', 'validate-spec-chain.mjs')], {
    encoding: 'utf8',
  });
});

test('4. Studio dev-server (/docs, /play, /api/docs) and modular mermaid-viewer-client.mjs HTTP verification', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'naia-adk-srv-'));
  t.after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  const projDir = path.join(tmpRoot, 'studio-proj');
  scaffoldProjectAdk({
    targetDir: projDir,
    name: 'Studio Server Test',
    owner: 'nextain',
    responsibleHuman: 'luke',
  });

  const { createStudioServer } = await import(path.join(projDir, 'scripts', 'dev-server.mjs'));
  const server = createStudioServer({ root: projDir });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const docsRes = await fetch(`${baseUrl}/docs`);
  assert.equal(docsRes.status, 200);
  const docsHtml = await docsRes.text();
  assert.match(docsHtml, /mermaid-viewer-client\.mjs/);
  assert.match(docsHtml, /mermaid-modal/);

  const playRes = await fetch(`${baseUrl}/play`);
  assert.equal(playRes.status, 200);
  const playHtml = await playRes.text();
  assert.match(playHtml, /debug-logger\.mjs/);

  const catalogRes = await fetch(`${baseUrl}/api/docs`);
  assert.equal(catalogRes.status, 200);
  const catalog = await catalogRes.json();
  assert.ok(Array.isArray(catalog) && catalog.length >= 2);

  const clientRes = await fetch(`${baseUrl}/scripts/lib/mermaid-viewer-client.mjs`);
  assert.equal(clientRes.status, 200);
  const clientCode = await clientRes.text();
  assert.match(clientCode, /export function wirePanZoom/);
  assert.match(clientCode, /export function openMermaidModal/);
});

