/**
 * Naia ADK v0.2.0 — 7 Deterministic Validations for Organization Channel-Role Tables
 */
import fs from 'node:fs';
import path from 'node:path';

export const SNOWFLAKE_RE = /^\d{17,20}$/;
export const OUTSIDE_CALL_VALUES = new Set(['mention', 'mention-or-name']);

export function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

export function resolveRoleConfigPath(outDir, role) {
  const candidates = [
    path.join(outDir, 'instances', role, 'config.json'),
    path.join(outDir, 'naia-settings', 'messenger-sessions', 'instances', role, 'config.json'),
    path.join(outDir, 'messenger-sessions', 'instances', role, 'config.json'),
    path.join(outDir, 'agents', role, 'config.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}

export function resolveWatchConfigPath(outDir) {
  const l4Candidate = path.join(outDir, '.agents', 'work', 'l4', 'discord-watch.json');
  if (fs.existsSync(l4Candidate)) return l4Candidate;
  return path.join(outDir, 'discord-watch.json');
}

export function defaultRoleInstanceConfig(role, allowedUserIds) {
  return {
    schemaVersion: 2,
    enabled: true,
    workspaceId: `adk-${role}`,
    discord: {
      credentialRef: `discord-${role}-token`,
      operatorUserIds: [...allowedUserIds],
      bindings: [],
    },
  };
}

/**
 * Check 7: Deterministic self-verification of generated & merged Layer-4 watch targets.
 */
export function validateGeneratedWatchConfig(watchConfig, allowedRolesSet, archivedChannelIds = new Set()) {
  const errors = [];
  if (!watchConfig || typeof watchConfig !== 'object' || !Array.isArray(watchConfig.targets)) {
    errors.push('[검사 7] discord-watch.json targets 배열이 없습니다.');
    return errors;
  }

  for (const [idx, target] of watchConfig.targets.entries()) {
    const label = `targets[${idx}](${target?.name || target?.channelId || 'unknown'})`;
    if (!target || typeof target !== 'object') {
      errors.push(`[검사 7] ${label}: 대상이 객체가 아닙니다.`);
      continue;
    }
    if (archivedChannelIds.has(String(target.channelId || ''))) {
      errors.push(`[검사 7] ${label}: archived: true 채널(${target.channelId})이 4층 감시 대상에 포함되었습니다.`);
    }
    if (target.includeThreads !== undefined && typeof target.includeThreads !== 'boolean') {
      errors.push(`[검사 7] ${label}: includeThreads는 boolean이어야 합니다.`);
    }
    if (target.owner !== undefined && target.wakeRoles !== undefined) {
      errors.push(`[검사 7] ${label}: owner와 wakeRoles를 함께 쓸 수 없습니다.`);
    }
    if (target.generatedBy === 'channel-roles') {
      if (target.kind !== 'channel') {
        errors.push(`[검사 7] ${label}: kind는 "channel"이어야 합니다.`);
      }
      if (!isNonEmptyString(target.guildId) || !SNOWFLAKE_RE.test(target.guildId)) {
        errors.push(`[검사 7] ${label}: 유효한 Discord guildId(snowflake)가 필요합니다 (받은 값: ${String(target.guildId)}).`);
      }
      if (!isNonEmptyString(target.channelId) || !SNOWFLAKE_RE.test(target.channelId)) {
        errors.push(`[검사 7] ${label}: 유효한 Discord channelId(snowflake)가 필요합니다 (받은 값: ${String(target.channelId)}).`);
      }
      if (!Array.isArray(target.wakeRoles) || target.wakeRoles.length === 0 || new Set(target.wakeRoles).size !== target.wakeRoles.length) {
        errors.push(`[검사 7] ${label}: wakeRoles가 비어있거나 중복되었습니다.`);
      } else if (allowedRolesSet && !target.wakeRoles.every((r) => allowedRolesSet.has(r))) {
        errors.push(`[검사 7] ${label}: wakeRoles에 정의되지 않은 역할이 있습니다.`);
      }
      if (!isNonEmptyString(target.primaryRole) || !Array.isArray(target.wakeRoles) || !target.wakeRoles.includes(target.primaryRole)) {
        errors.push(`[검사 7] ${label}: primaryRole이 wakeRoles 안에 없습니다.`);
      }
      if (!OUTSIDE_CALL_VALUES.has(target.outsideCall)) {
        errors.push(`[검사 7] ${label}: outsideCall은 mention 또는 mention-or-name이어야 합니다.`);
      }
      if (target.includeThreads !== true) {
        errors.push(`[검사 7] ${label}: includeThreads는 반드시 true여야 합니다.`);
      }
      if (!isNonEmptyString(target.readerInstance)) {
        errors.push(`[검사 7] ${label}: readerInstance 필드가 비어있습니다.`);
      }
      if (watchConfig.teamMessengerChannelId && target.channelId === watchConfig.teamMessengerChannelId) {
        errors.push(`[검사 7] ${label}: 사내 공지 채널(${watchConfig.teamMessengerChannelId})은 채널 표 감시 대상에 넣을 수 없습니다.`);
      }
    }
  }
  return errors;
}

/**
 * Runs Checks 1 through 6 on tables, channelIds, and outDir.
 */
export function validateAndResolveTables({ tables, channelIds, outDir = null, initInstances = false }) {
  const errors = [];
  const skippedServers = [];

  if (!Array.isArray(tables) || tables.length === 0) {
    return { ok: false, errors: ['[검사 1] 최소 한 개 이상의 채널 표(--table)가 필요합니다.'], skippedServers };
  }
  if (!channelIds || typeof channelIds !== 'object' || !channelIds.companies) {
    return { ok: false, errors: ['[검사 3] channel-ids.json에 companies 객체가 없습니다.'], skippedServers };
  }

  let existingWatch = null;
  if (outDir) {
    const watchPath = resolveWatchConfigPath(outDir);
    if (fs.existsSync(watchPath)) {
      try {
        existingWatch = JSON.parse(fs.readFileSync(watchPath, 'utf8'));
      } catch (err) {
        return { ok: false, errors: [`[검사 7] 기존 discord-watch.json 파싱 실패: ${err.message}`], skippedServers };
      }
    }
  }

  const teamMessengerChannelId = channelIds.teamMessengerChannelId || existingWatch?.teamMessengerChannelId || null;

  // Check 4 pre-scan across all companies/servers in channel-ids.json
  const seenChannelIdsGlobal = new Map();
  for (const [compName, compObj] of Object.entries(channelIds.companies || {})) {
    for (const [srvKey, srvObj] of Object.entries(compObj?.servers || {})) {
      for (const [chKey, chId] of Object.entries(srvObj?.channels || {})) {
        const idStr = String(chId || '').trim();
        if (!idStr) continue;
        const loc = `${compName}/${srvKey}/${chKey}`;
        if (seenChannelIdsGlobal.has(idStr)) {
          errors.push(`[검사 4] 같은 실제 채널 번호(${idStr})가 중복 등장했습니다: ${seenChannelIdsGlobal.get(idStr)} 및 ${loc}`);
        } else {
          seenChannelIdsGlobal.set(idStr, loc);
        }
      }
    }
  }

  const allRoles = new Set();
  const seenCompanies = new Set();
  const usedChannelIdsInTables = new Map();
  const archivedChannelIds = new Set();
  const resolvedCompanies = [];

  for (const table of tables) {
    const company = String(table?.company || '').trim();
    if (!company) {
      errors.push('[검사 1] 채널 표에 company 이름이 없습니다.');
      continue;
    }
    if (seenCompanies.has(company)) {
      errors.push(`[검사 3] 같은 회사(${company}) 표가 중복 입력되었습니다.`);
      continue;
    }
    seenCompanies.add(company);

    if (!Array.isArray(table.roles) || table.roles.length === 0) {
      errors.push(`[검사 1] 회사(${company})의 roles 목록이 비어있습니다.`);
      continue;
    }
    const roleSet = new Set();
    for (const r of table.roles) {
      if (!isNonEmptyString(r) || roleSet.has(r)) {
        errors.push(`[검사 1] 회사(${company})의 roles에 빈 값 또는 중복 역할("${String(r)}")이 있습니다.`);
      }
      roleSet.add(r);
      allRoles.add(r);
    }

    const compIds = channelIds.companies?.[company];
    if (!compIds || typeof compIds !== 'object' || !compIds.servers) {
      errors.push(`[검사 3] channel-ids.json에 회사 "${company}"의 서버 번호 매핑이 없습니다.`);
      continue;
    }
    if (!Array.isArray(table.servers) || table.servers.length === 0) {
      errors.push(`[검사 3] 회사(${company})에 servers 목록이 없습니다.`);
      continue;
    }

    const seenChannelKeys = new Set();
    const seenServerKeys = new Set();
    const resolvedServers = [];

    for (const srv of table.servers) {
      const serverKey = String(srv?.key || '').trim();
      if (!serverKey || seenServerKeys.has(serverKey)) {
        errors.push(`[검사 3] 회사(${company}) 안에서 서버 열쇠("${serverKey}")가 비어있거나 중복되었습니다.`);
        continue;
      }
      seenServerKeys.add(serverKey);

      const srvIds = compIds.servers?.[serverKey];
      if (!srvIds || typeof srvIds !== 'object') {
        errors.push(`[검사 3] channel-ids.json에 "${company}/${serverKey}" 서버 설정이 없습니다.`);
        continue;
      }

      const guildId = srvIds.guildId ?? null;
      const isNullGuild = guildId === null;
      if (isNullGuild) skippedServers.push({ company, serverKey });

      const resolvedChannels = [];
      for (const ch of Array.isArray(srv.channels) ? srv.channels : []) {
        const chKey = String(ch?.key || '').trim();
        const chLabel = `${company}/${serverKey}/${chKey || '?'}`;
        if (!chKey || seenChannelKeys.has(chKey)) {
          errors.push(`[검사 3] 회사(${company}) 안에서 채널 열쇠("${chKey}")가 비어있거나 중복되었습니다.`);
          continue;
        }
        seenChannelKeys.add(chKey);

        if (!Array.isArray(ch.wakeRoles) || ch.wakeRoles.length === 0 || new Set(ch.wakeRoles).size !== ch.wakeRoles.length) {
          errors.push(`[검사 1] ${chLabel}: wakeRoles는 비어있거나 중복될 수 없습니다.`);
        } else if (!ch.wakeRoles.every((wr) => roleSet.has(wr))) {
          errors.push(`[검사 1] ${chLabel}: wakeRoles에 회사 roles 밖의 역할이 있습니다.`);
        }
        if (!isNonEmptyString(ch.primaryRole) || !roleSet.has(ch.primaryRole)) {
          errors.push(`[검사 1] ${chLabel}: primaryRole("${String(ch.primaryRole)}")이 회사 roles 목록에 없습니다.`);
        }
        if (Array.isArray(ch.wakeRoles) && !ch.wakeRoles.includes(ch.primaryRole)) {
          errors.push(`[검사 2] ${chLabel}: primaryRole("${String(ch.primaryRole)}")은 반드시 wakeRoles 안에 있어야 합니다.`);
        }
        const outsideCall = ch.outsideCall === undefined ? 'mention-or-name' : ch.outsideCall;
        if (!OUTSIDE_CALL_VALUES.has(outsideCall)) {
          errors.push(`[검사 2] ${chLabel}: outsideCall("${String(outsideCall)}")은 mention 또는 mention-or-name만 허용됩니다.`);
        }

        if (isNullGuild) continue;

        const rawChannelId = srvIds.channels?.[chKey];
        if (!isNonEmptyString(rawChannelId)) {
          errors.push(`[검사 3] ${chLabel}: guildId가 있는 서버(${guildId})의 채널 열쇠 "${chKey}" 번호가 channel-ids.json에 없습니다.`);
          continue;
        }
        const channelId = rawChannelId.trim();
        if (usedChannelIdsInTables.has(channelId)) {
          errors.push(`[검사 4] 같은 채널 번호(${channelId})가 두 곳(${usedChannelIdsInTables.get(channelId)}, ${chLabel})에 중복 등장했습니다.`);
        } else {
          usedChannelIdsInTables.set(channelId, chLabel);
        }
        if (teamMessengerChannelId && channelId === String(teamMessengerChannelId).trim()) {
          errors.push(`[검사 5] ${chLabel}: 사내 공지 채널(${teamMessengerChannelId})은 채널·담당 표에 넣을 수 없습니다.`);
        }

        const archived = ch.archived === true;
        if (archived) archivedChannelIds.add(channelId);
        resolvedChannels.push({
          key: chKey,
          name: String(ch.name || chKey).trim(),
          channelId,
          guildId: String(guildId).trim(),
          wakeRoles: [...(ch.wakeRoles || [])],
          primaryRole: ch.primaryRole,
          outsideCall,
          description: ch.description ? String(ch.description).trim() : '',
          archived,
        });
      }
      resolvedServers.push({ key: serverKey, guildId: isNullGuild ? null : String(guildId).trim(), skipped: isNullGuild, channels: resolvedChannels });
    }
    resolvedCompanies.push({ company, roles: [...roleSet], servers: resolvedServers });
  }

  // Check 6: Role bot binding files in outDir
  const allowedUserIds = Array.isArray(channelIds.allowedUserIds) ? channelIds.allowedUserIds : [];
  const roleConfigs = new Map();
  for (const role of allRoles) {
    if (outDir) {
      const cfgPath = resolveRoleConfigPath(outDir, role);
      if (!fs.existsSync(cfgPath)) {
        if (!initInstances) {
          errors.push(`[검사 6] 역할 "${role}"의 봇 묶음 설정 파일이 없습니다: ${cfgPath}`);
          continue;
        }
        roleConfigs.set(role, { path: cfgPath, existed: false, config: defaultRoleInstanceConfig(role, allowedUserIds) });
      } else {
        try {
          const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
          if (!parsed?.discord || !Array.isArray(parsed.discord.bindings)) {
            errors.push(`[검사 6] 역할 "${role}" 설정 파일(${cfgPath})에 discord.bindings 배열이 없습니다.`);
            continue;
          }
          roleConfigs.set(role, { path: cfgPath, existed: true, config: parsed });
        } catch (err) {
          errors.push(`[검사 6] 역할 "${role}" 설정 파일(${cfgPath}) 읽기 실패: ${err.message}`);
        }
      }
    } else {
      roleConfigs.set(role, { path: `instances/${role}/config.json`, existed: false, config: defaultRoleInstanceConfig(role, allowedUserIds) });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    skippedServers,
    allRoles,
    allowedUserIds,
    teamMessengerChannelId,
    existingWatch,
    archivedChannelIds,
    resolvedCompanies,
    roleConfigs,
  };
}
