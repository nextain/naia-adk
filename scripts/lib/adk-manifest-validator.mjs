/**
 * Naia ADK v0.2.0 — Manifest Validator Library (user, agent, project, org)
 * Validates adk.json schema rules, owner/responsible_human presence, and keys/ isolation.
 */
import fs from 'node:fs';
import path from 'node:path';

export const VALID_KINDS = ['user', 'agent', 'project', 'org'];
export const VALID_ACTIONS = ['read', 'write', 'export'];

export function isNonEmptyString(val) {
  return typeof val === 'string' && val.trim().length > 0;
}

export function defaultMountForKind(kind, id) {
  const folderMap = {
    agent: 'agents',
    project: 'projects',
    org: 'orgs',
    user: 'users',
  };
  return `${folderMap[kind] || 'links'}/${id}`;
}

export function isKeysSegment(relPath) {
  if (!isNonEmptyString(relPath)) return false;
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const parts = normalized.split('/');
  return parts.includes('keys') || parts.includes('.keys');
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

  if (!isNonEmptyString(manifest.adk_version) || !/^\d+\.\d+\.\d+/.test(manifest.adk_version)) {
    errors.push('adk_version must be a valid semver string (e.g. "0.2.0")');
  }

  if (!VALID_KINDS.includes(manifest.kind)) {
    errors.push(`kind must be one of: ${VALID_KINDS.join(', ')} (got: ${String(manifest.kind)})`);
  }

  if (!isNonEmptyString(manifest.id) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(manifest.id)) {
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

  if (manifest.kind === 'agent') {
    const ac = manifest.agent_config || {};
    if (ac.organizations !== undefined) {
      if (!Array.isArray(ac.organizations) || ac.organizations.some((o) => !isNonEmptyString(o) || o.includes('/') || o.includes('\\'))) {
        errors.push('agent_config.organizations must be an array of organization name strings (never paths/links)');
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

  return { ok: errors.length === 0, errors, warnings };
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
