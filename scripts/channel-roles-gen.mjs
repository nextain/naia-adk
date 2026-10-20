#!/usr/bin/env node
/**
 * Naia ADK v0.2.0 — Organization Channel & Role Table Generator (channel-roles-gen.mjs)
 *
 * Usage:
 *   node projects/naia-adk/scripts/channel-roles-gen.mjs \
 *     --table <channels.yaml>... --ids <channel-ids.json> [--out-dir <dir>] [--write] [--init-instances]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseChannelsYaml, renderChannelsMarkdown } from './lib/channel-roles-yaml.mjs';
import {
  resolveWatchConfigPath,
  validateGeneratedWatchConfig,
  validateAndResolveTables,
} from './lib/channel-roles-validator.mjs';

export { parseChannelsYaml, renderChannelsMarkdown, validateGeneratedWatchConfig };

function dayStamp(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function resolveMarkdownPath(outDir) {
  const docsCandidate = path.join(outDir, 'docs', 'common', 'team', 'channels-and-wake.md');
  if (fs.existsSync(docsCandidate)) return docsCandidate;
  return path.join(outDir, 'channels-and-wake.md');
}

export function generateChannelRolesArtifacts({
  tables,
  channelIds,
  outDir = null,
  initInstances = false,
  targetTransform = null,
}) {
  const resolved = validateAndResolveTables({ tables, channelIds, outDir, initInstances });
  if (!resolved.ok) {
    return { ok: false, errors: resolved.errors, skippedServers: resolved.skippedServers };
  }

  const {
    skippedServers,
    allRoles,
    allowedUserIds,
    teamMessengerChannelId,
    existingWatch,
    archivedChannelIds,
    resolvedCompanies,
    roleConfigs,
  } = resolved;

  // Output 1: Role bot bindings (preserving manual bindings without generatedBy: "channel-roles")
  const generatedBindingsByRole = new Map();
  for (const [role, entry] of roleConfigs.entries()) {
    const existingBindings = Array.isArray(entry.config.discord?.bindings)
      ? entry.config.discord.bindings
      : [];
    const manualBindings = existingBindings.filter((b) => b?.generatedBy !== 'channel-roles');
    const manualChannelKeys = new Set(
      manualBindings.map((b) => `${b.guildId || ''}:${b.channelId || ''}`),
    );
    const effectiveAllowedUsers =
      allowedUserIds.length > 0 ? allowedUserIds : entry.config.discord?.operatorUserIds || [];

    const roleGenerated = [];
    for (const comp of resolvedCompanies) {
      if (!comp.roles.includes(role)) continue;
      for (const srv of comp.servers) {
        if (srv.skipped) continue;
        for (const ch of srv.channels) {
          if (!ch.wakeRoles.includes(role)) continue;
          if (manualChannelKeys.has(`${ch.guildId}:${ch.channelId}`)) continue;
          roleGenerated.push({
            kind: 'guild_channel',
            guildId: ch.guildId,
            channelId: ch.channelId,
            respondWhen: 'mentioned',
            allowedUserIds: [...effectiveAllowedUsers],
            canStartConversation: false,
            operatorActions: ch.archived ? false : true,
            historyVisibility: 'shared',
            ...(ch.archived ? { readOnly: true, archived: true } : {}),
            generatedBy: 'channel-roles',
          });
        }
      }
    }

    generatedBindingsByRole.set(role, {
      path: entry.path,
      existed: entry.existed,
      manualCount: manualBindings.length,
      generatedCount: roleGenerated.length,
      config: {
        ...entry.config,
        discord: {
          ...entry.config.discord,
          bindings: [...manualBindings, ...roleGenerated],
        },
      },
    });
  }

  // Output 2: Layer-4 watch targets (discord-watch.json)
  const readerInstance = channelIds.readerInstance;
  const baseWatch = existingWatch || {
    schemaVersion: 1,
    instance: 'onmam',
    targets: [],
    ...(teamMessengerChannelId ? { teamMessengerChannelId } : {}),
    lukeUserIds: [...allowedUserIds],
    discordFailWakeAfter: 5,
  };
  const preservedTargets = (Array.isArray(baseWatch.targets) ? baseWatch.targets : []).filter(
    (t) => t?.generatedBy !== 'channel-roles',
  );
  const generatedTargets = [];
  for (const comp of resolvedCompanies) {
    for (const srv of comp.servers) {
      if (srv.skipped) continue;
      for (const ch of srv.channels) {
        if (ch.archived) continue;
        let targetObj = {
          name: ch.name,
          channelId: ch.channelId,
          kind: 'channel',
          enabled: true,
          guildId: ch.guildId,
          includeThreads: true,
          readerInstance,
          wakeRoles: [...ch.wakeRoles],
          primaryRole: ch.primaryRole,
          outsideCall: ch.outsideCall,
          generatedBy: 'channel-roles',
        };
        if (typeof targetTransform === 'function') {
          targetObj = targetTransform(targetObj, ch);
        }
        generatedTargets.push(targetObj);
      }
    }
  }

  const nextWatchConfig = {
    ...baseWatch,
    ...(teamMessengerChannelId ? { teamMessengerChannelId } : {}),
    targets: [...preservedTargets, ...generatedTargets],
  };

  // Check 7: Verify generated & merged watch config integrity
  const check7Errors = validateGeneratedWatchConfig(nextWatchConfig, allRoles, archivedChannelIds);
  if (check7Errors.length > 0) {
    return { ok: false, errors: check7Errors, skippedServers };
  }

  // Output 3: Markdown table & descriptions
  const markdownContent = renderChannelsMarkdown({ resolvedCompanies, skippedServers });

  return {
    ok: true,
    errors: [],
    skippedServers,
    resolvedCompanies,
    roleBindings: generatedBindingsByRole,
    watchConfig: nextWatchConfig,
    preservedWatchTargetsCount: preservedTargets.length,
    generatedWatchTargetsCount: generatedTargets.length,
    markdownContent,
  };
}

function writeWithBackup(filePath, content, stamp) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let backupPath = null;
  if (fs.existsSync(filePath)) {
    backupPath = `${filePath}.bak-${stamp}`;
    fs.copyFileSync(filePath, backupPath);
  }
  fs.writeFileSync(filePath, content, 'utf8');
  return backupPath;
}

export function runChannelRolesGenerator({
  tablePaths,
  idsPath,
  outDir = null,
  write = false,
  initInstances = false,
  dateStamp = dayStamp(),
}) {
  const tables = tablePaths.map((p) => {
    const abs = path.resolve(p);
    return parseChannelsYaml(fs.readFileSync(abs, 'utf8'), path.basename(abs));
  });
  const idsAbs = path.resolve(idsPath);
  const channelIds = JSON.parse(fs.readFileSync(idsAbs, 'utf8'));
  const resolvedOutDir = outDir ? path.resolve(outDir) : path.dirname(idsAbs);

  const result = generateChannelRolesArtifacts({
    tables,
    channelIds,
    outDir: resolvedOutDir,
    initInstances,
  });
  if (!result.ok) return result;

  const watchPath = resolveWatchConfigPath(resolvedOutDir);
  const markdownPath = resolveMarkdownPath(resolvedOutDir);
  const writtenFiles = [];
  const backups = [];

  if (write) {
    for (const [, roleEntry] of result.roleBindings.entries()) {
      const bak = writeWithBackup(roleEntry.path, JSON.stringify(roleEntry.config, null, 2) + '\n', dateStamp);
      writtenFiles.push(roleEntry.path);
      if (bak) backups.push(bak);
    }
    const watchBak = writeWithBackup(watchPath, JSON.stringify(result.watchConfig, null, 2) + '\n', dateStamp);
    writtenFiles.push(watchPath);
    if (watchBak) backups.push(watchBak);

    const mdBak = writeWithBackup(markdownPath, result.markdownContent, dateStamp);
    writtenFiles.push(markdownPath);
    if (mdBak) backups.push(mdBak);
  }

  return {
    ...result,
    mode: write ? 'write' : 'preview',
    outDir: resolvedOutDir,
    watchPath,
    markdownPath,
    writtenFiles,
    backups,
  };
}

function parseCliArgs(argv) {
  const opts = { tablePaths: [], idsPath: null, outDir: null, write: false, initInstances: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--table') {
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts.tablePaths.push(argv[++i]);
    } else if (arg === '--ids') opts.idsPath = argv[++i];
    else if (arg === '--out-dir') opts.outDir = argv[++i];
    else if (arg === '--write') opts.write = true;
    else if (arg === '--init-instances') opts.initInstances = true;
  }
  return opts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const opts = parseCliArgs(process.argv.slice(2));
    if (opts.tablePaths.length === 0 || !opts.idsPath) {
      console.error('Usage: channel-roles-gen.mjs --table <channels.yaml>... --ids <channel-ids.json> [--out-dir <dir>] [--write] [--init-instances]');
      process.exit(1);
    }
    const res = runChannelRolesGenerator(opts);
    for (const s of res.skippedServers || []) {
      console.log(`ℹ [skip] 미생성 서버 건너뜀 (guildId: null): ${s.company}/${s.serverKey}`);
    }
    if (!res.ok) {
      console.error(`✗ [channel-roles-gen] 검증 실패 (${res.errors.length}건):`);
      for (const err of res.errors) console.error(`  - ${err}`);
      process.exit(1);
    }
    console.log(
      `✓ [channel-roles-gen] mode=${res.mode} | companies=${res.resolvedCompanies.length} | watchTargets=${res.generatedWatchTargetsCount} (preserved=${res.preservedWatchTargetsCount}) | skippedServers=${res.skippedServers.length}`,
    );
    for (const [role, info] of res.roleBindings.entries()) {
      console.log(`  - role=${role}: generated=${info.generatedCount}, manualPreserved=${info.manualCount} (${info.path})`);
    }
    if (res.mode === 'write') {
      console.log(`  - written=${res.writtenFiles.length} file(s), backups=${res.backups.length}`);
    } else {
      console.log('  - 미리보기(preview) 모드이므로 파일을 수정하지 않았습니다. 실제 반영하려면 --write를 추가하세요.');
    }
  } catch (err) {
    console.error(`✗ [channel-roles-gen] 오류: ${err.message}`);
    process.exit(1);
  }
}
