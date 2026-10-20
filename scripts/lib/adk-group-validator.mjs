/**
 * Naia ADK v2.0.0 — Group & User-Group Validator
 *
 * Validates `group_config` (and legacy `org_config`) for kind="group",
 * and `user_config.groups` for kind="user".
 */
import fs from 'node:fs';
import path from 'node:path';
import { isValidCalendarDate } from './adk-schedule.mjs';
import { validateAdkManifest } from './adk-manifest-validator.mjs';

export const VALID_ACCESS_LEVELS = ['owner', 'admin', 'member', 'viewer', 'unset'];
export const VALID_REPO_STATUSES = ['canonical', 'undecided'];
export const VALID_BOT_STATUSES = ['planned', 'active', 'none'];
export const FORBIDDEN_SECRET_KEYS = new Set(['token', 'secret', 'password', 'api_key', 'bot_token']);

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function isNonEmptyString(val) {
  return typeof val === 'string' && val.trim().length > 0;
}

export function isValidIdentifier(val) {
  return isNonEmptyString(val) && ID_PATTERN.test(val);
}

export function isKeysSegment(relPath) {
  if (!isNonEmptyString(relPath)) return false;
  const parts = relPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').split('/');
  return parts.includes('keys') || parts.includes('.keys');
}

function validateSafeRelFile(relPath, fieldPath, adkDir, errors, { checkExists = true } = {}) {
  if (!isNonEmptyString(relPath)) {
    errors.push(`${fieldPath} must be a non-empty relative path string`);
    return false;
  }
  if (path.isAbsolute(relPath)) {
    errors.push(`${fieldPath} must be a relative path (got absolute: ${relPath})`);
    return false;
  }
  if (relPath.split(/[\\/]/).includes('..')) {
    errors.push(`${fieldPath} must not contain ".." path traversal (got: ${relPath})`);
    return false;
  }
  if (isKeysSegment(relPath)) {
    errors.push(`${fieldPath} must NEVER reference keys/ directory (got: ${relPath})`);
    return false;
  }
  if (adkDir && checkExists) {
    const abs = path.join(adkDir, relPath);
    if (!fs.existsSync(abs)) {
      errors.push(`${fieldPath} references missing file "${relPath}" at ${abs}`);
      return false;
    }
  }
  return true;
}

function scanForForbiddenSecretFields(node, curPath, errors) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((item, i) => scanForForbiddenSecretFields(item, `${curPath}[${i}]`, errors));
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    const fieldPath = `${curPath}.${k}`;
    if ((FORBIDDEN_SECRET_KEYS.has(k) || FORBIDDEN_SECRET_KEYS.has(k.toLowerCase())) && isNonEmptyString(v)) {
      errors.push(
        `${fieldPath}: secret-like field "${k}" is forbidden in manifest; store secrets in isolated keys/ and use credential_ref`,
      );
    }
    if (v && typeof v === 'object') scanForForbiddenSecretFields(v, fieldPath, errors);
  }
}

function validateProjectLikeEntry(opts) {
  const { entry, prefix, isService, parentProjectId, seenProjectPaths, seenServiceIds, milestoneIds, adkDir, errors, undecidedRepos } = opts;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    errors.push(`${prefix} must be an object`);
    return { servicesCount: 0 };
  }

  const idLabel = isService ? `${parentProjectId}/${entry.id}` : entry.id;
  if (!isValidIdentifier(entry.id)) {
    errors.push(`${prefix}.id must be a valid identifier (got: ${String(entry.id)})`);
  } else if (isService) {
    if (seenProjectPaths.has(idLabel) || seenServiceIds.has(entry.id) || seenProjectPaths.has(entry.id)) {
      errors.push(`${prefix}.id duplicate service id "${entry.id}" (${idLabel})`);
    } else {
      seenProjectPaths.add(idLabel);
      seenServiceIds.add(entry.id);
    }
  } else if (seenProjectPaths.has(entry.id) || seenServiceIds.has(entry.id)) {
    errors.push(`${prefix}.id duplicate project id "${entry.id}"`);
  } else {
    seenProjectPaths.add(entry.id);
  }

  if (!isNonEmptyString(entry.name)) errors.push(`${prefix}.name must be a non-empty string`);
  if (entry.repo !== null && !isNonEmptyString(entry.repo)) {
    errors.push(`${prefix}.repo must be a non-empty string or null`);
  }

  if (!VALID_REPO_STATUSES.includes(entry.repo_status)) {
    errors.push(`${prefix}.repo_status must be one of: ${VALID_REPO_STATUSES.join(', ')}`);
  } else if (entry.repo === null && entry.repo_status !== 'undecided') {
    errors.push(`${prefix}: repo is null so repo_status must be "undecided" (got "${entry.repo_status}")`);
  }

  if ((entry.repo === null || entry.repo_status === 'undecided') && isValidIdentifier(entry.id)) {
    undecidedRepos.push(idLabel);
  }

  if (entry.milestones !== undefined) {
    if (!Array.isArray(entry.milestones)) {
      errors.push(`${prefix}.milestones must be an array of milestone id strings`);
    } else {
      for (const mId of entry.milestones) {
        if (!isNonEmptyString(mId)) {
          errors.push(`${prefix}.milestones entries must be non-empty strings`);
        } else if (!milestoneIds.has(mId)) {
          errors.push(`${prefix}.milestones references unknown milestone id "${mId}"`);
        }
      }
    }
  }

  if (entry.file !== undefined) validateSafeRelFile(entry.file, `${prefix}.file`, adkDir, errors);

  let servicesCount = 0;
  if (entry.services !== undefined) {
    if (isService) {
      errors.push(`${prefix}.services is not allowed (one nesting level only; services may not have services)`);
    } else if (!Array.isArray(entry.services)) {
      errors.push(`${prefix}.services must be an array`);
    } else {
      servicesCount = entry.services.length;
      for (const [sIdx, svc] of entry.services.entries()) {
        validateProjectLikeEntry({
          ...opts,
          entry: svc,
          prefix: `${prefix}.services[${sIdx}]`,
          isService: true,
          parentProjectId: entry.id || `project-${sIdx}`,
        });
      }
    }
  }
  return { servicesCount };
}

export function validateGroupManifestSection(manifest, adkDir = null, errors = [], warnings = []) {
  const fromLegacyOrgConfig = manifest.org_config !== undefined && manifest.group_config === undefined;
  if (manifest.org_config !== undefined) {
    warnings.push('org_config is deprecated; use group_config instead');
    if (manifest.group_config === undefined) {
      const cloned = { ...manifest.org_config };
      if (Array.isArray(cloned.members)) {
        cloned.members = cloned.members.map((m) => (typeof m === 'string' ? { user_id: m, access: 'owner' } : m));
      }
      manifest.group_config = cloned;
    }
  }
  if (fromLegacyOrgConfig && !manifest.group_config.members && isNonEmptyString(manifest.responsible_human)) {
    manifest.group_config.members = [{ user_id: manifest.responsible_human.trim(), access: 'owner' }];
  }

  const gc = manifest.group_config;
  if (!gc || typeof gc !== 'object' || Array.isArray(gc)) {
    errors.push('group_config object is required for kind "group"');
    return { groupSummary: null, milestoneIds: [], milestoneNames: [] };
  }

  scanForForbiddenSecretFields(gc, 'group_config', errors);

  // 1. Calendar & milestones
  const milestoneIds = new Set();
  const milestoneNames = new Set();
  let milestonesCount = 0;

  if (gc.calendar !== undefined) {
    if (!gc.calendar || typeof gc.calendar !== 'object' || Array.isArray(gc.calendar)) {
      errors.push('group_config.calendar must be an object');
    } else {
      const cal = gc.calendar;
      let rawMilestones = null;
      if (cal.milestones_file !== undefined) {
        const fileOk = validateSafeRelFile(cal.milestones_file, 'group_config.calendar.milestones_file', adkDir, errors);
        if (fileOk && adkDir && cal.milestones === undefined) {
          try {
            const parsed = JSON.parse(fs.readFileSync(path.join(adkDir, cal.milestones_file), 'utf8'));
            rawMilestones = Array.isArray(parsed) ? parsed : parsed?.milestones;
          } catch (err) {
            errors.push(`Failed to parse milestones_file "${cal.milestones_file}": ${err.message}`);
          }
        }
      }
      if (cal.milestones !== undefined) {
        if (!Array.isArray(cal.milestones)) errors.push('group_config.calendar.milestones must be an array');
        else rawMilestones = cal.milestones;
      }
      if (Array.isArray(rawMilestones)) {
        milestonesCount = rawMilestones.length;
        for (const [mIdx, ms] of rawMilestones.entries()) {
          const mPrefix = `group_config.calendar.milestones[${mIdx}]`;
          if (!ms || typeof ms !== 'object' || Array.isArray(ms)) {
            errors.push(`${mPrefix} must be an object`);
            continue;
          }
          if (!isValidIdentifier(ms.id)) errors.push(`${mPrefix}.id must be a valid identifier`);
          else if (milestoneIds.has(ms.id)) errors.push(`${mPrefix}.id duplicate milestone id "${ms.id}"`);
          else milestoneIds.add(ms.id);

          if (!isNonEmptyString(ms.name)) errors.push(`${mPrefix}.name must be a non-empty string`);
          else milestoneNames.add(ms.name.trim());

          if (ms.due === undefined || (ms.due !== null && !isValidCalendarDate(ms.due))) {
            errors.push(`${mPrefix}.due is required and must be a valid YYYY-MM-DD calendar date or null (got: ${String(ms.due)})`);
          }
          if (ms.done_when !== undefined && typeof ms.done_when !== 'string') {
            errors.push(`${mPrefix}.done_when must be a string`);
          }
        }
      }
      if (cal.work_docs_dir !== undefined) {
        validateSafeRelFile(cal.work_docs_dir, 'group_config.calendar.work_docs_dir', adkDir, errors, { checkExists: false });
      }
    }
  }

  // 2. Members
  const unsetAccess = [];
  const seenMemberIds = new Set();
  let membersCount = 0;

  if (!Array.isArray(gc.members) || gc.members.length === 0) {
    errors.push('group_config.members must be a non-empty array (at least one member required)');
  } else {
    membersCount = gc.members.length;
    for (const [idx, member] of gc.members.entries()) {
      const mPrefix = `group_config.members[${idx}]`;
      if (!member || typeof member !== 'object' || Array.isArray(member)) {
        errors.push(`${mPrefix} must be an object`);
        continue;
      }
      if (!isValidIdentifier(member.user_id)) {
        errors.push(`${mPrefix}.user_id must be a valid identifier (got: ${String(member.user_id)})`);
      } else if (seenMemberIds.has(member.user_id)) {
        errors.push(`${mPrefix}.user_id duplicate member user_id "${member.user_id}"`);
      } else {
        seenMemberIds.add(member.user_id);
      }

      if (member.display_name !== undefined && typeof member.display_name !== 'string') {
        errors.push(`${mPrefix}.display_name must be a string`);
      }
      if (!VALID_ACCESS_LEVELS.includes(member.access)) {
        errors.push(`${mPrefix}.access must be one of: ${VALID_ACCESS_LEVELS.join(', ')} (got: ${String(member.access)})`);
      } else if (member.access === 'unset' && isValidIdentifier(member.user_id)) {
        unsetAccess.push(member.user_id);
      }

      if (member.grant !== undefined && (!Array.isArray(member.grant) || member.grant.some((g) => !isNonEmptyString(g)))) {
        errors.push(`${mPrefix}.grant must be an array of non-empty strings`);
      }
      if (member.deny !== undefined && (!Array.isArray(member.deny) || member.deny.some((d) => !isNonEmptyString(d)))) {
        errors.push(`${mPrefix}.deny must be an array of non-empty strings`);
      }
      if (member.file !== undefined) validateSafeRelFile(member.file, `${mPrefix}.file`, adkDir, errors);
    }

    if (isNonEmptyString(manifest.responsible_human) && seenMemberIds.size > 0 && !seenMemberIds.has(manifest.responsible_human)) {
      warnings.push(`responsible_human "${manifest.responsible_human}" does not match any group_config.members[].user_id`);
    }
  }

  // 3. Projects & 1-level services
  const undecidedRepos = [];
  const seenProjectPaths = new Set();
  const seenServiceIds = new Set();
  let projectsCount = 0;
  let servicesCount = 0;

  if (gc.projects !== undefined) {
    if (!Array.isArray(gc.projects)) {
      errors.push('group_config.projects must be an array');
    } else {
      projectsCount = gc.projects.length;
      for (const [pIdx, proj] of gc.projects.entries()) {
        const res = validateProjectLikeEntry({
          entry: proj,
          prefix: `group_config.projects[${pIdx}]`,
          isService: false,
          parentProjectId: null,
          seenProjectPaths,
          seenServiceIds,
          milestoneIds,
          adkDir,
          errors,
          undecidedRepos,
        });
        servicesCount += res.servicesCount;
      }
    }
  }

  // 4. Agents & Seats
  const plannedBots = [];
  const seatsNotCreated = [];
  const seatsWithoutManifest = [];
  let seatsReadyCount = 0;
  const seenAgentIds = new Set();
  let agentsCount = 0;

  if (gc.agents !== undefined) {
    if (!Array.isArray(gc.agents)) {
      errors.push('group_config.agents must be an array');
    } else {
      agentsCount = gc.agents.length;
      for (const [aIdx, agent] of gc.agents.entries()) {
        const aPrefix = `group_config.agents[${aIdx}]`;
        if (!agent || typeof agent !== 'object' || Array.isArray(agent)) {
          errors.push(`${aPrefix} must be an object`);
          continue;
        }
        if (!isValidIdentifier(agent.id)) {
          errors.push(`${aPrefix}.id must be a valid identifier (got: ${String(agent.id)})`);
        } else if (seenAgentIds.has(agent.id)) {
          errors.push(`${aPrefix}.id duplicate agent id "${agent.id}"`);
        } else {
          seenAgentIds.add(agent.id);
        }

        if (!isNonEmptyString(agent.role) || /\s/.test(agent.role.trim())) {
          errors.push(`${aPrefix}.role must be a non-empty short role word without spaces`);
        }
        if (!isNonEmptyString(agent.description)) {
          errors.push(`${aPrefix}.description must be a non-empty string`);
        }

        if (!agent.bot || typeof agent.bot !== 'object' || Array.isArray(agent.bot)) {
          errors.push(`${aPrefix}.bot must be an object`);
        } else {
          const { status, name, credential_ref: credRef } = agent.bot;
          if (!VALID_BOT_STATUSES.includes(status)) {
            errors.push(`${aPrefix}.bot.status must be one of: ${VALID_BOT_STATUSES.join(', ')}`);
          } else if (status === 'planned' && isValidIdentifier(agent.id)) {
            plannedBots.push(agent.id);
          }
          if (name !== null && typeof name !== 'string') {
            errors.push(`${aPrefix}.bot.name must be a string or null`);
          }
          if (credRef !== undefined && credRef !== null) {
            if (!isNonEmptyString(credRef)) {
              errors.push(`${aPrefix}.bot.credential_ref must be a non-empty label string`);
            } else {
              if (isKeysSegment(credRef) || credRef.includes('/') || credRef.includes('\\')) {
                errors.push(
                  `${aPrefix}.bot.credential_ref must be a name/label only and must NEVER contain "/" path into keys/ (got: ${credRef})`,
                );
              }
              if (credRef.length > 40 && !/\s/.test(credRef)) {
                errors.push(`${aPrefix}.bot.credential_ref looks like a raw secret (length > 40); use a short reference label only`);
              }
            }
          }
        }

        const expectedSeat = isValidIdentifier(agent.id) ? `agents/${agent.id}-adk` : null;
        let effectiveSeat = expectedSeat;
        let seatPathOk = Boolean(expectedSeat);

        if (agent.seat !== undefined) {
          if (!isNonEmptyString(agent.seat)) {
            errors.push(`${aPrefix}.seat must be a non-empty relative path string`);
            seatPathOk = false;
          } else {
            const rawSeat = agent.seat.trim();
            const slashSeat = rawSeat.replace(/\\/g, '/').replace(/\/+$/, '');
            const normSeat = path.posix.normalize(slashSeat).replace(/\/+$/, '');
            seatPathOk = true;
            if (path.isAbsolute(rawSeat) || slashSeat.startsWith('/')) {
              errors.push(`${aPrefix}.seat must be a relative path (got absolute: ${rawSeat})`);
              seatPathOk = false;
            }
            if (slashSeat.split('/').includes('..') || normSeat.split('/').includes('..')) {
              errors.push(`${aPrefix}.seat must not contain ".." path traversal (got: ${rawSeat})`);
              seatPathOk = false;
            }
            if (isKeysSegment(slashSeat) || isKeysSegment(normSeat)) {
              errors.push(`${aPrefix}.seat must NEVER reference keys/ directory (got: ${rawSeat})`);
              seatPathOk = false;
            }
            if (!normSeat.startsWith('agents/') || normSeat === 'agents') {
              errors.push(`${aPrefix}.seat must start with "agents/" (got: ${rawSeat})`);
              seatPathOk = false;
            }
            if (seatPathOk) {
              effectiveSeat = normSeat;
              if (normSeat !== slashSeat) {
                warnings.push(`${aPrefix}.seat "${rawSeat}": seat normalized to ${normSeat}`);
              }
              if (expectedSeat && normSeat !== expectedSeat) {
                warnings.push(`${aPrefix}.seat "${rawSeat}" does not match default "${expectedSeat}"`);
              }
            }
          }
        }

        if (agent.file !== undefined) validateSafeRelFile(agent.file, `${aPrefix}.file`, adkDir, errors);

        if (adkDir && seatPathOk && effectiveSeat) {
          const seatAbs = path.join(adkDir, effectiveSeat);
          const seatStat = fs.statSync(seatAbs, { throwIfNoEntry: false });
          if (!seatStat) {
            if (isValidIdentifier(agent.id)) seatsNotCreated.push(agent.id);
            warnings.push(`${aPrefix}.seat "${effectiveSeat}" (${agent.id}): seat not created`);
          } else if (!seatStat.isDirectory()) {
            errors.push(`${aPrefix}.seat "${effectiveSeat}" must be a directory`);
          } else {
            if (isNonEmptyString(agent.file)) {
              const normFile = agent.file.trim().replace(/\\/g, '/').replace(/^\/+/, '');
              if (!normFile.startsWith(`${effectiveSeat}/`)) {
                warnings.push(
                  `${aPrefix}.file "${agent.file}" (${agent.id}): agent doc should live in its seat (${effectiveSeat}/index.md)`,
                );
              }
            }
            const seatManifestPath = path.join(seatAbs, 'adk.json');
            if (!fs.existsSync(seatManifestPath)) {
              if (isValidIdentifier(agent.id)) seatsWithoutManifest.push(agent.id);
              warnings.push(`${aPrefix}.seat "${effectiveSeat}" (${agent.id}): seat without manifest`);
            } else {
              let seatManifest = null;
              try {
                seatManifest = JSON.parse(fs.readFileSync(seatManifestPath, 'utf8'));
              } catch (err) {
                errors.push(`${aPrefix}.seat "${effectiveSeat}" has invalid JSON in adk.json: ${err.message}`);
              }
              if (seatManifest !== null) {
                const rawSeatKind = seatManifest?.kind;
                const seatVal = validateAdkManifest(seatManifest, seatAbs);
                const kindIsAgent =
                  seatManifest &&
                  typeof seatManifest === 'object' &&
                  !Array.isArray(seatManifest) &&
                  seatManifest.kind === 'agent';
                if (!kindIsAgent) {
                  errors.push(
                    `${aPrefix}.seat "${effectiveSeat}" adk.json must have kind "agent" (got: ${String(rawSeatKind)})`,
                  );
                }
                if (!seatVal.ok) {
                  errors.push(
                    `${aPrefix}.seat "${effectiveSeat}" adk.json failed validation: ${seatVal.errors.join('; ')}`,
                  );
                }
                if (kindIsAgent && seatVal.ok) {
                  seatsReadyCount += 1;
                  for (const sw of seatVal.warnings) {
                    warnings.push(`${aPrefix}.seat "${effectiveSeat}": ${sw}`);
                  }
                  if (
                    isValidIdentifier(agent.id) &&
                    seatManifest.id !== agent.id &&
                    seatManifest.id !== `${agent.id}-adk`
                  ) {
                    warnings.push(
                      `${aPrefix}.seat "${effectiveSeat}" adk.json id "${seatManifest.id}" should equal "${agent.id}" or "${agent.id}-adk"`,
                    );
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // 5. Channels
  if (gc.channels !== undefined) validateSafeRelFile(gc.channels, 'group_config.channels', adkDir, errors);

  // 6. Repository standard minimum (AGENTS.md entry & .agents/context/) in check mode
  const missingEntry = [];
  const missingContext = [];
  if (adkDir) {
    const entryPath = path.join(adkDir, 'AGENTS.md');
    if (!fs.existsSync(entryPath)) {
      missingEntry.push('AGENTS.md');
      warnings.push('entry AGENTS.md missing');
    }
    const requiredContextFiles = [
      '.agents/context/agents-rules.json',
      '.agents/context/project-index.yaml',
    ];
    for (const relCtx of requiredContextFiles) {
      if (!fs.existsSync(path.join(adkDir, relCtx))) {
        missingContext.push(relCtx);
        warnings.push(`context ${relCtx} missing`);
      }
    }
  }

  const summaryLine = `group ${manifest.id}: members ${membersCount} (unset access ${unsetAccess.length}), projects ${projectsCount} (+services ${servicesCount}), agents ${agentsCount} (bots planned ${plannedBots.length}, seats ready ${seatsReadyCount}/${agentsCount}), milestones ${milestonesCount}`;

  return {
    groupSummary: {
      id: manifest.id,
      members: membersCount,
      unsetAccessCount: unsetAccess.length,
      projects: projectsCount,
      services: servicesCount,
      undecidedReposCount: undecidedRepos.length,
      agents: agentsCount,
      plannedBotsCount: plannedBots.length,
      seatsReadyCount,
      seatsNotCreatedCount: seatsNotCreated.length,
      seatsWithoutManifestCount: seatsWithoutManifest.length,
      milestones: milestonesCount,
      open: {
        unset_access: unsetAccess,
        undecided_repos: undecidedRepos,
        planned_bots: plannedBots,
        seats_not_created: seatsNotCreated,
        seats_without_manifest: seatsWithoutManifest,
        missing_entry: missingEntry,
        missing_context: missingContext,
      },
      summaryLine,
    },
    milestoneIds: Array.from(milestoneIds),
    milestoneNames: Array.from(milestoneNames),
  };
}

export function validateUserGroupsSection(manifest, errors = []) {
  const uc = manifest.user_config;
  if (!uc || typeof uc !== 'object' || Array.isArray(uc) || uc.groups === undefined) return;
  if (!Array.isArray(uc.groups)) {
    errors.push('user_config.groups must be an array');
    return;
  }

  const seenGroupIds = new Set();
  for (const [idx, g] of uc.groups.entries()) {
    const prefix = `user_config.groups[${idx}]`;
    if (!g || typeof g !== 'object' || Array.isArray(g)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    if (!isValidIdentifier(g.group_id)) {
      errors.push(`${prefix}.group_id must be a valid identifier (got: ${String(g.group_id)})`);
    } else if (seenGroupIds.has(g.group_id)) {
      errors.push(`${prefix}.group_id duplicate group_id "${g.group_id}"`);
    } else {
      seenGroupIds.add(g.group_id);
    }

    if (g.local_path !== undefined) {
      if (!isNonEmptyString(g.local_path)) {
        errors.push(`${prefix}.local_path must be a non-empty relative path`);
      } else {
        if (path.isAbsolute(g.local_path)) errors.push(`${prefix}.local_path must be a relative path (got absolute: ${g.local_path})`);
        if (isKeysSegment(g.local_path)) errors.push(`${prefix}.local_path must NEVER reference keys/ directory`);
      }
    }
    if (g.access !== undefined && !VALID_ACCESS_LEVELS.includes(g.access)) {
      errors.push(`${prefix}.access must be one of: ${VALID_ACCESS_LEVELS.join(', ')} (got: ${String(g.access)})`);
    }
  }
}
