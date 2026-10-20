/**
 * Naia ADK v2.0.0 — Manifest Validator Library (user, group, agent, project)
 * Validates adk.json schema rules, owner/responsible_human presence, keys/ isolation,
 * group_config, user_config.groups, and legacy "org" alias compatibility.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  isNonEmptyString,
  isValidIdentifier,
  isKeysSegment,
  validateGroupManifestSection,
  validateUserGroupsSection,
} from './adk-group-validator.mjs';

export const VALID_KINDS = ['user', 'agent', 'project', 'group'];
export const LEGACY_KIND_ALIASES = { org: 'group' };
export const VALID_ACTIONS = ['read', 'write', 'export'];

const ADK_VERSION_PATTERN = /^(?:0\.2\.\d+|2\.\d+(?:\.\d+)?)(?:-[A-Za-z0-9.-]+)?$/;

export { isNonEmptyString, isValidIdentifier, isKeysSegment };

export function normalizeKind(kind) {
  if (typeof kind === 'string' && Object.prototype.hasOwnProperty.call(LEGACY_KIND_ALIASES, kind)) {
    return LEGACY_KIND_ALIASES[kind];
  }
  return kind;
}

export function defaultMountForKind(kind, id) {
  const normalized = normalizeKind(kind);
  const folderMap = {
    agent: 'agents',
    project: 'projects',
    group: 'groups',
    user: 'users',
  };
  return `${folderMap[normalized] || 'links'}/${id}`;
}

export function resolveAdkManifestPath(inputPath) {
  const abs = path.resolve(inputPath);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    return { adkDir: abs, manifestPath: path.join(abs, 'adk.json') };
  }
  return { adkDir: path.dirname(abs), manifestPath: abs };
}

export function validateAdkManifest(manifest, adkDir = null) {
  const errors = [];
  const warnings = [];

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: ['adk.json must be a JSON object'], warnings };
  }

  if (!isNonEmptyString(manifest.adk_version) || !ADK_VERSION_PATTERN.test(manifest.adk_version.trim())) {
    errors.push('adk_version must be a valid 2.x or legacy 0.2.x version string (e.g. "2.0.0" or "0.2.0")');
  }

  const rawKind = manifest.kind;
  if (typeof rawKind === 'string' && Object.prototype.hasOwnProperty.call(LEGACY_KIND_ALIASES, rawKind)) {
    const mapped = LEGACY_KIND_ALIASES[rawKind];
    warnings.push(`kind "${rawKind}" is deprecated; normalizing to "${mapped}"`);
    manifest.kind = mapped;
  }

  if (!VALID_KINDS.includes(manifest.kind)) {
    errors.push(`kind must be one of: ${VALID_KINDS.join(', ')} (got: ${String(rawKind)})`);
  }

  if (manifest.supported_kinds !== undefined) {
    if (
      !Array.isArray(manifest.supported_kinds) ||
      manifest.supported_kinds.some((k) => !VALID_KINDS.includes(normalizeKind(k)))
    ) {
      errors.push(`supported_kinds must be an array of valid kinds (${VALID_KINDS.join(', ')})`);
    } else if (manifest.supported_kinds.includes('org')) {
      warnings.push('supported_kinds contains deprecated kind "org"; use "group" instead');
    }
  }

  if (!isValidIdentifier(manifest.id)) {
    errors.push('id must be a non-empty alphanumeric/kebab/underscore identifier');
  }

  if (!isNonEmptyString(manifest.owner)) {
    errors.push('owner is required and must be a non-empty string');
  }

  if (!isNonEmptyString(manifest.responsible_human)) {
    errors.push('responsible_human is required and must not be empty ("무조건 사람이 주인이어야 합니다")');
  }

  if (!Array.isArray(manifest.links)) {
    errors.push('links must be an array');
  } else {
    const seenLinkIds = new Set();
    for (const [idx, link] of manifest.links.entries()) {
      const prefix = `links[${idx}]`;
      if (!link || typeof link !== 'object') {
        errors.push(`${prefix} must be an object`);
        continue;
      }
      if (typeof link.kind === 'string' && Object.prototype.hasOwnProperty.call(LEGACY_KIND_ALIASES, link.kind)) {
        const mapped = LEGACY_KIND_ALIASES[link.kind];
        warnings.push(`${prefix}.kind "${link.kind}" is deprecated; normalizing to "${mapped}"`);
        link.kind = mapped;
      }
      if (!isNonEmptyString(link.id)) {
        errors.push(`${prefix}.id must be a non-empty string`);
      } else if (seenLinkIds.has(`${link.kind}:${link.id}`)) {
        errors.push(`${prefix} duplicate link for ${link.kind}:${link.id}`);
      } else {
        seenLinkIds.add(`${link.kind}:${link.id}`);
      }
      if (!VALID_KINDS.includes(link.kind)) {
        errors.push(`${prefix}.kind must be one of ${VALID_KINDS.join(', ')}`);
      }
      if (!isNonEmptyString(link.local_path)) {
        errors.push(`${prefix}.local_path must be a non-empty relative path`);
      } else {
        if (path.isAbsolute(link.local_path)) {
          errors.push(`${prefix}.local_path must be a relative path on the same machine (got absolute: ${link.local_path})`);
        }
        if (isKeysSegment(link.local_path)) {
          errors.push(`${prefix}.local_path must NEVER reference keys/ directory`);
        }
      }
      if (link.mount_path !== undefined) {
        if (!isNonEmptyString(link.mount_path) || path.isAbsolute(link.mount_path) || link.mount_path.split(/[\\/]/).includes('..')) {
          errors.push(`${prefix}.mount_path must be a safe relative path inside the ADK`);
        }
        if (isKeysSegment(link.mount_path)) {
          errors.push(`${prefix}.mount_path must NEVER reference keys/`);
        }
      }
      if (Array.isArray(link.shared_folders)) {
        for (const sf of link.shared_folders) {
          if (!sf || !isNonEmptyString(sf.folder) || isKeysSegment(sf.folder)) {
            errors.push(`${prefix}.shared_folders must never expose keys/`);
          }
          if (!['read', 'write'].includes(sf?.mode)) {
            errors.push(`${prefix}.shared_folders mode must be "read" or "write"`);
          }
        }
      }
    }
  }

  const perms = manifest.permissions;
  if (!perms || typeof perms !== 'object' || Array.isArray(perms)) {
    errors.push('permissions object is required');
  } else {
    if (!Array.isArray(perms.allowed_roots)) {
      errors.push('permissions.allowed_roots must be an array');
    } else {
      for (const rootEntry of perms.allowed_roots) {
        if (!isNonEmptyString(rootEntry) || path.isAbsolute(rootEntry) || rootEntry.split(/[\\/]/).includes('..')) {
          errors.push(`permissions.allowed_roots contains invalid path: ${String(rootEntry)}`);
        }
        if (isKeysSegment(rootEntry)) {
          errors.push(`permissions.allowed_roots must NEVER include keys/ (got: ${rootEntry})`);
        }
      }
    }

    if (!Array.isArray(perms.denied_roots) || perms.denied_roots.length === 0) {
      errors.push('permissions.denied_roots must be a non-empty array');
    } else {
      const hasKeysDenied = perms.denied_roots.some(
        (d) => isNonEmptyString(d) && (d === 'keys' || d === 'keys/' || isKeysSegment(d)),
      );
      if (!hasKeysDenied) {
        errors.push('permissions.denied_roots must explicitly include "keys" to enforce key isolation');
      }
    }

    if (!Array.isArray(perms.actions) || perms.actions.length === 0) {
      errors.push('permissions.actions must be a non-empty array');
    } else {
      for (const act of perms.actions) {
        if (!VALID_ACTIONS.includes(act)) {
          errors.push(`permissions.actions contains invalid action "${act}" (allowed: ${VALID_ACTIONS.join(', ')})`);
        }
      }
    }
  }

  if (manifest.kind === 'user' || manifest.user_config !== undefined) {
    validateUserGroupsSection(manifest, errors);
  }

  if (manifest.kind === 'agent' || manifest.agent_config !== undefined) {
    const ac = manifest.agent_config || {};
    if (ac.organizations !== undefined) {
      if (!Array.isArray(ac.organizations) || ac.organizations.some((o) => !isNonEmptyString(o) || o.includes('/') || o.includes('\\'))) {
        errors.push('agent_config.organizations must be an array of organization name strings (never paths/links)');
      } else if (ac.organizations.length > 0) {
        warnings.push('agent_config.organizations is deprecated; use agent_config.groups instead');
      }
    }
    if (ac.groups !== undefined) {
      if (!Array.isArray(ac.groups) || ac.groups.some((g) => !isValidIdentifier(g) || g.includes('/') || g.includes('\\'))) {
        errors.push('agent_config.groups must be an array of group id strings (never paths/links)');
      }
    }
    if (adkDir) {
      const agentJsonPath = path.join(adkDir, ac.agent_json_path || 'agent.json');
      if (fs.existsSync(agentJsonPath)) {
        try {
          const agentJson = JSON.parse(fs.readFileSync(agentJsonPath, 'utf8'));
          if (!isNonEmptyString(agentJson.owner)) errors.push('agent.json must declare a non-empty owner');
          if (!isNonEmptyString(agentJson.responsible_human)) errors.push('agent.json must declare a non-empty responsible_human');
        } catch (err) {
          errors.push(`Failed to parse agent.json: ${err.message}`);
        }
      }
    }
  }

  let groupSummary = null;
  let milestoneIds = [];
  let milestoneNames = [];
  if (manifest.kind === 'group') {
    const groupRes = validateGroupManifestSection(manifest, adkDir, errors, warnings);
    groupSummary = groupRes.groupSummary;
    milestoneIds = groupRes.milestoneIds;
    milestoneNames = groupRes.milestoneNames;
  }

  const result = { ok: errors.length === 0, errors, warnings };
  if (groupSummary) {
    result.groupSummary = groupSummary;
    result.milestoneIds = milestoneIds;
    result.milestoneNames = milestoneNames;
  }
  return result;
}

export function validateAdkPath(inputPath) {
  const { adkDir, manifestPath } = resolveAdkManifestPath(inputPath);
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, adkDir, manifestPath, manifest: null, errors: [`Missing adk.json at ${manifestPath}`], warnings: [] };
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return { ok: false, adkDir, manifestPath, manifest: null, errors: [`Invalid JSON in ${manifestPath}: ${err.message}`], warnings: [] };
  }
  const res = validateAdkManifest(manifest, adkDir);
  return { ...res, adkDir, manifestPath, manifest };
}
