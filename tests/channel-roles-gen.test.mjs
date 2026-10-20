import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  parseChannelsYaml,
  generateChannelRolesArtifacts,
  validateGeneratedWatchConfig,
} from '../scripts/channel-roles-gen.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const naiaAdkRoot = path.resolve(__dirname, '..');
const genCli = path.join(naiaAdkRoot, 'scripts', 'channel-roles-gen.mjs');

function seedRoleInstances(outDir, roles, manualBinding = null) {
  for (const role of roles) {
    const cfgPath = path.join(outDir, 'instances', role, 'config.json');
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(
      cfgPath,
      JSON.stringify(
        {
          schemaVersion: 2,
          enabled: true,
          workspaceId: `test-${role}`,
          discord: {
            credentialRef: `discord-${role}-token`,
            operatorUserIds: ['9000000000000000001'],
            bindings: manualBinding ? [manualBinding] : [],
          },
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
  }
}

function makeTable(company, roles, channels, serverKey = 'internal') {
  return { schemaVersion: 1, company, roles, servers: [{ key: serverKey, channels }] };
}

test('1. schemas/channels.schema.json, templates/org-channels/*, and codesign v0.2.0 schema/rule alignment', () => {
  const channelsSchema = JSON.parse(fs.readFileSync(path.join(naiaAdkRoot, 'schemas', 'channels.schema.json'), 'utf8'));
  assert.ok(channelsSchema.$defs?.channelsTable && channelsSchema.$defs?.channelIds);

  const exampleYaml = fs.readFileSync(path.join(naiaAdkRoot, 'templates', 'org-channels', 'channels.example.yaml'), 'utf8');
  const parsedExample = parseChannelsYaml(exampleYaml, 'channels.example.yaml');
  assert.equal(parsedExample.schemaVersion, 1);
  assert.equal(parsedExample.company, 'nextain');
  assert.deepEqual(parsedExample.roles, ['minho', 'jina', 'alpha', 'naia']);
  assert.equal(parsedExample.servers.length, 2);

  const manifestSchema = JSON.parse(fs.readFileSync(path.join(naiaAdkRoot, 'schemas', 'adk-manifest.schema.json'), 'utf8'));
  assert.deepEqual(manifestSchema.properties.config_precedence.default, [
    'cli_args', 'project', 'agent', 'user', 'org', 'framework',
  ]);
  assert.deepEqual(manifestSchema.properties.work_ledger_policy.properties.allowed_kinds.default, [
    'user', 'project', 'org',
  ]);
  assert.equal(manifestSchema.properties.user_config.properties.shell.properties.set_workspace_target_kind.const, 'agent');
  assert.equal(manifestSchema.properties.org_config.properties.key_injection_policy.properties.method.const, 'env_only');

  const ruleDoc = fs.readFileSync(path.join(naiaAdkRoot, 'rules', 'discord-channel-roles-and-org-adk.md'), 'utf8');
  assert.match(ruleDoc, /SetWorkspace/);
  assert.match(ruleDoc, /channel-roles-gen\.mjs/);
});

test('2. Multi-company (nextain + onmam), multi-server (internal + customer guildId:null), manual preservation, archived:true, and .bak backup', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-roles-ok-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const nextainYamlPath = path.join(tmpDir, 'nextain-channels.yaml');
  const onmamYamlPath = path.join(tmpDir, 'onmam-channels.yaml');
  const idsPath = path.join(tmpDir, 'channel-ids.json');

  fs.writeFileSync(
    nextainYamlPath,
    [
      'schemaVersion: 1',
      'company: nextain',
      'roles: [minho, jina, alpha, naia]',
      'servers:',
      '  - key: internal',
      '    channels:',
      '      - key: studio',
      '        name: 나이아-스튜디오',
      '        wakeRoles: [minho, jina, alpha, naia]',
      '        primaryRole: minho',
      '        outsideCall: mention-or-name',
      '        description: 나이아 스튜디오 개발. 주 담당 민호.',
      '      - key: infra',
      '        name: 나이아-인프라',
      '        wakeRoles: [minho]',
      '        primaryRole: minho',
      '        outsideCall: mention',
      '        description: 서버·기기·배포.',
      '      - key: legacy-moved',
      '        name: 옛-고객채널',
      '        wakeRoles: [minho, alpha]',
      '        primaryRole: minho',
      '        outsideCall: mention',
      '        archived: true',
      '  - key: customer',
      '    channels:',
      '      - key: support',
      '        name: 고객지원',
      '        wakeRoles: [minho, jina]',
      '        primaryRole: jina',
      '        outsideCall: mention-or-name',
    ].join('\n') + '\n',
    'utf8',
  );

  fs.writeFileSync(
    onmamYamlPath,
    [
      'schemaVersion: 1',
      'company: onmam',
      'roles: [minho, alpha]',
      'servers:',
      '  - key: main',
      '    channels:',
      '      - key: onmam-dev',
      '        name: 온맘-개발',
      '        wakeRoles: [minho, alpha]',
      '        primaryRole: minho',
      '        outsideCall: mention-or-name',
      '        description: 온맘닷컴 개발 채널.',
    ].join('\n') + '\n',
    'utf8',
  );

  fs.writeFileSync(
    idsPath,
    JSON.stringify({
      schemaVersion: 1,
      companies: {
        nextain: {
          servers: {
            internal: {
              guildId: '1000000000000000001',
              channels: {
                studio: '2000000000000000001',
                infra: '2000000000000000002',
                'legacy-moved': '2000000000000000003',
              },
            },
            customer: { guildId: null, channels: {} },
          },
        },
        onmam: {
          servers: {
            main: {
              guildId: '1000000000000000002',
              channels: { 'onmam-dev': '2000000000000000004' },
            },
          },
        },
      },
      allowedUserIds: ['9000000000000000001'],
      readerInstance: 'minho',
      teamMessengerChannelId: '3000000000000000001',
    }, null, 2),
    'utf8',
  );

  const manualBinding = {
    kind: 'guild_channel',
    guildId: '1000000000000000001',
    channelId: '3000000000000000001',
    respondWhen: 'mentioned',
    allowedUserIds: ['9000000000000000001'],
    canStartConversation: false,
    operatorActions: true,
    historyVisibility: 'shared',
  };
  seedRoleInstances(tmpDir, ['minho', 'jina', 'alpha', 'naia'], manualBinding);

  const watchPath = path.join(tmpDir, 'discord-watch.json');
  fs.writeFileSync(
    watchPath,
    JSON.stringify({
      schemaVersion: 1,
      instance: 'onmam',
      targets: [{ name: '온맘 ADK 통합 쓰레드', channelId: '4000000000000000001', kind: 'thread', enabled: true }],
      teamMessengerChannelId: '3000000000000000001',
      lukeUserIds: ['9000000000000000001'],
      discordFailWakeAfter: 5,
    }, null, 2),
    'utf8',
  );

  // 1) Preview mode (without --write) does not write files
  const previewOut = execFileSync(
    process.execPath,
    [genCli, '--table', nextainYamlPath, onmamYamlPath, '--ids', idsPath, '--out-dir', tmpDir],
    { encoding: 'utf8' },
  );
  assert.match(previewOut, /mode=preview/);
  assert.match(previewOut, /nextain\/customer/);
  assert.equal(fs.existsSync(path.join(tmpDir, 'channels-and-wake.md')), false);

  // 2) Write mode (--write) creates .bak-<YYYYMMDD> and writes all 3 outputs
  const writeOut = execFileSync(
    process.execPath,
    [genCli, '--table', nextainYamlPath, onmamYamlPath, '--ids', idsPath, '--out-dir', tmpDir, '--write'],
    { encoding: 'utf8' },
  );
  assert.match(writeOut, /mode=write/);

  const updatedWatch = JSON.parse(fs.readFileSync(watchPath, 'utf8'));
  assert.equal(updatedWatch.targets.length, 4);
  assert.equal(updatedWatch.targets[0].channelId, '4000000000000000001');
  assert.equal(updatedWatch.targets[0].generatedBy, undefined);
  const generatedTargets = updatedWatch.targets.filter((x) => x.generatedBy === 'channel-roles');
  assert.equal(generatedTargets.length, 3);
  assert.equal(generatedTargets.some((x) => x.channelId === '2000000000000000003'), false);

  const minhoCfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'instances', 'minho', 'config.json'), 'utf8'));
  assert.equal(minhoCfg.discord.bindings.length, 5);
  assert.equal(minhoCfg.discord.bindings[0].generatedBy, undefined);
  const archivedBinding = minhoCfg.discord.bindings.find((b) => b.channelId === '2000000000000000003');
  assert.ok(archivedBinding && archivedBinding.operatorActions === false && archivedBinding.readOnly === true && archivedBinding.archived === true);

  const jinaCfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'instances', 'jina', 'config.json'), 'utf8'));
  assert.equal(jinaCfg.discord.bindings.length, 2);

  assert.ok(fs.readdirSync(tmpDir).some((f) => f.startsWith('discord-watch.json.bak-')));
  const mdText = fs.readFileSync(path.join(tmpDir, 'channels-and-wake.md'), 'utf8');
  assert.match(mdText, /나이아-스튜디오/);
  assert.match(mdText, /온맘-개발/);
  assert.match(mdText, /nextain\/customer/);
});

test('3. All 7 deterministic rejection rules exit with non-zero and write zero files', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-roles-neg-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const baseIds = {
    schemaVersion: 1,
    companies: {
      nextain: { servers: { internal: { guildId: '1000000000000000001', channels: { studio: '2000000000000000001', infra: '2000000000000000002' } } } },
      onmam: { servers: { main: { guildId: '1000000000000000002', channels: { dev: '2000000000000000009' } } } },
    },
    allowedUserIds: ['9000000000000000001'],
    readerInstance: 'minho',
    teamMessengerChannelId: '3000000000000000001',
  };

  // Rejection 1: wakeRoles contains unknown role
  const r1 = generateChannelRolesArtifacts({
    tables: [makeTable('nextain', ['minho', 'jina'], [{ key: 'studio', name: '스튜디오', wakeRoles: ['minho', 'ghost'], primaryRole: 'minho' }])],
    channelIds: baseIds,
  });
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => e.includes('[검사 1]')));

  // Rejection 2: primaryRole not in wakeRoles OR invalid outsideCall
  const r2 = generateChannelRolesArtifacts({
    tables: [makeTable('nextain', ['minho', 'jina'], [{ key: 'studio', name: '스튜디오', wakeRoles: ['minho'], primaryRole: 'jina', outsideCall: 'always' }])],
    channelIds: baseIds,
  });
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => e.includes('[검사 2]')));

  // Rejection 3: Duplicate channel key in company OR missing channel ID in channel-ids.json
  const r3 = generateChannelRolesArtifacts({
    tables: [makeTable('nextain', ['minho'], [
      { key: 'studio', name: '스튜디오', wakeRoles: ['minho'], primaryRole: 'minho' },
      { key: 'studio', name: '스튜디오2', wakeRoles: ['minho'], primaryRole: 'minho' },
      { key: 'unmapped', name: '미매핑', wakeRoles: ['minho'], primaryRole: 'minho' },
    ])],
    channelIds: baseIds,
  });
  assert.equal(r3.ok, false);
  assert.ok(r3.errors.some((e) => e.includes('[검사 3]')));

  // Rejection 4: Duplicate Discord channel ID across two keys or two companies
  const dupIds = structuredClone(baseIds);
  dupIds.companies.onmam.servers.main.channels.dev = '2000000000000000001';
  const r4 = generateChannelRolesArtifacts({
    tables: [
      makeTable('nextain', ['minho'], [{ key: 'studio', name: '스튜디오', wakeRoles: ['minho'], primaryRole: 'minho' }]),
      makeTable('onmam', ['minho'], [{ key: 'dev', name: '온맘개발', wakeRoles: ['minho'], primaryRole: 'minho' }], 'main'),
    ],
    channelIds: dupIds,
  });
  assert.equal(r4.ok, false);
  assert.ok(r4.errors.some((e) => e.includes('[검사 4]')));

  // Rejection 5: teamMessengerChannelId included in channel table
  const teamCollisionIds = structuredClone(baseIds);
  teamCollisionIds.companies.nextain.servers.internal.channels.studio = '3000000000000000001';
  const r5 = generateChannelRolesArtifacts({
    tables: [makeTable('nextain', ['minho'], [{ key: 'studio', name: '사내공지충돌', wakeRoles: ['minho'], primaryRole: 'minho' }])],
    channelIds: teamCollisionIds,
  });
  assert.equal(r5.ok, false);
  assert.ok(r5.errors.some((e) => e.includes('[검사 5]')));

  // Rejection 6: Missing role instance config file in --out-dir when --write is executed
  const emptyOutDir = path.join(tmpDir, 'empty-out');
  fs.mkdirSync(emptyOutDir, { recursive: true });
  const tablePath = path.join(emptyOutDir, 'channels.yaml');
  const idsFilePath = path.join(emptyOutDir, 'channel-ids.json');
  fs.writeFileSync(
    tablePath,
    'schemaVersion: 1\ncompany: nextain\nroles: [minho]\nservers:\n  - key: internal\n    channels:\n      - key: studio\n        name: 스튜디오\n        wakeRoles: [minho]\n        primaryRole: minho\n',
    'utf8',
  );
  fs.writeFileSync(idsFilePath, JSON.stringify(baseIds, null, 2), 'utf8');
  const proc = spawnSync(process.execPath, [genCli, '--table', tablePath, '--ids', idsFilePath, '--out-dir', emptyOutDir, '--write'], { encoding: 'utf8' });
  assert.equal(proc.status, 1);
  assert.match(proc.stderr, /\[검사 6\]/);
  assert.equal(fs.existsSync(path.join(emptyOutDir, 'discord-watch.json')), false);

  // Rejection 7: Generated watch target fails self-verification (missing readerInstance / includeThreads false)
  const badWatchIds = structuredClone(baseIds);
  badWatchIds.readerInstance = '';
  const r7 = generateChannelRolesArtifacts({
    tables: [makeTable('nextain', ['minho'], [{ key: 'studio', name: '스튜디오', wakeRoles: ['minho'], primaryRole: 'minho' }])],
    channelIds: badWatchIds,
  });
  assert.equal(r7.ok, false);
  assert.ok(r7.errors.some((e) => e.includes('[검사 7]')));

  const directErrs = validateGeneratedWatchConfig({
    targets: [{
      name: 'broken', kind: 'channel', guildId: '1000000000000000001', channelId: '2000000000000000001',
      wakeRoles: ['minho'], primaryRole: 'minho', outsideCall: 'mention', includeThreads: false,
      readerInstance: 'minho', generatedBy: 'channel-roles',
    }],
  }, new Set(['minho']));
  assert.ok(directErrs.some((e) => e.includes('[검사 7]')));
});
