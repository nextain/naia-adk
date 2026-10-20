#!/usr/bin/env node
/**
 * Naia ADK v2.0.0 — Automated Project ADK Scaffolder
 *
 * Usage:
 *   node projects/naia-adk/scripts/adk-scaffold-project.mjs \
 *     --target <dir> --name <name> --owner <owner> --responsible <human> [--description <desc>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAdkPath } from './adk-link.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skeletonRoot = path.resolve(__dirname, '..', 'templates', 'project-skeleton');

function toKebabId(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'naia-project';
}

function applyPlaceholders(content, vars) {
  return content
    .replaceAll('{{PROJECT_NAME}}', vars.PROJECT_NAME)
    .replaceAll('{{PROJECT_ID}}', vars.PROJECT_ID)
    .replaceAll('{{PROJECT_DESCRIPTION}}', vars.PROJECT_DESCRIPTION)
    .replaceAll('{{OWNER}}', vars.OWNER)
    .replaceAll('{{RESPONSIBLE_HUMAN}}', vars.RESPONSIBLE_HUMAN)
    .replaceAll('{{DATE}}', vars.DATE);
}

function copyTemplateTree(srcDir, dstDir, vars, createdFiles = []) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copyTemplateTree(srcPath, dstPath, vars, createdFiles);
    } else if (entry.isFile()) {
      const raw = fs.readFileSync(srcPath, 'utf8');
      const rendered = applyPlaceholders(raw, vars);
      fs.writeFileSync(dstPath, rendered, 'utf8');
      if ( dstPath.endsWith('.mjs') ) {
        try {
          fs.chmodSync(dstPath, 0o755);
        } catch {
          // ignore chmod on unsupported fs
        }
      }
      createdFiles.push(dstPath);
    }
  }
  return createdFiles;
}

export function scaffoldProjectAdk({
  targetDir,
  name,
  id = null,
  owner,
  responsibleHuman,
  description = null,
  date = null,
}) {
  if (!targetDir || !String(targetDir).trim()) {
    throw new Error('--target <dir> is required');
  }
  if (!name || !String(name).trim()) {
    throw new Error('--name <name> is required');
  }
  if (!owner || !String(owner).trim()) {
    throw new Error('--owner <owner> is required');
  }
  if (!responsibleHuman || !String(responsibleHuman).trim()) {
    throw new Error('--responsible <human> is required ("무조건 사람이 주인이어야 합니다")');
  }

  const resolvedTarget = path.resolve(targetDir);
  const projectId = id ? toKebabId(id) : toKebabId(name);
  const vars = {
    PROJECT_NAME: String(name).trim(),
    PROJECT_ID: projectId,
    PROJECT_DESCRIPTION:
      description && String(description).trim()
        ? String(description).trim()
        : `${String(name).trim()} — Naia ADK v2.0.0 Project Studio`,
    OWNER: String(owner).trim(),
    RESPONSIBLE_HUMAN: String(responsibleHuman).trim(),
    DATE: date || new Date().toISOString().slice(0, 10),
  };

  const createdFiles = copyTemplateTree(skeletonRoot, resolvedTarget, vars, []);

  // Ensure standard ADK isolated directories exist
  for (const dirName of ['rules', 'data', 'keys', 'skills']) {
    const dirPath = path.join(resolvedTarget, dirName);
    fs.mkdirSync(dirPath, { recursive: true });
    const keepFile = path.join(dirPath, '.gitkeep');
    if (!fs.existsSync(keepFile)) {
      fs.writeFileSync(keepFile, '', 'utf8');
    }
  }

  const check = validateAdkPath(resolvedTarget);
  if (!check.ok) {
    throw new Error(`Scaffolded project failed ADK validation: ${check.errors.join('; ')}`);
  }

  return {
    ok: true,
    targetDir: resolvedTarget,
    projectId,
    manifest: check.manifest,
    createdFilesCount: createdFiles.length,
  };
}

export function scaffoldAdkInstance({
  targetDir,
  kind,
  id,
  name = null,
  owner,
  responsibleHuman,
}) {
  if (kind === 'project') {
    return scaffoldProjectAdk({ targetDir, name: name || id, id, owner, responsibleHuman });
  }
  if (!responsibleHuman || !String(responsibleHuman).trim()) {
    throw new Error('responsible_human is required and must not be empty');
  }
  if (!owner || !String(owner).trim()) {
    throw new Error('owner is required and must not be empty');
  }

  const resolvedTarget = path.resolve(targetDir);
  fs.mkdirSync(resolvedTarget, { recursive: true });

  for (const dirName of ['rules', 'data', 'keys', 'skills']) {
    fs.mkdirSync(path.join(resolvedTarget, dirName), { recursive: true });
  }

  const effectiveKind = kind === 'org' ? 'group' : kind;

  const baseManifest = {
    schema_version: '1.0',
    adk_version: '2.0.0',
    id,
    name: name || id,
    kind: effectiveKind,
    owner: String(owner).trim(),
    responsible_human: String(responsibleHuman).trim(),
    base_commit: '2.0.0',
    paths: {
      rules: 'rules',
      data: 'data',
      keys: 'keys',
      skills: 'skills',
    },
    isolation: {
      keys_isolated: true,
      keys_gitignored: true,
      keys_never_linked: true,
    },
    links: [],
    permissions: {
      allowed_roots: ['rules', 'data', 'skills'],
      denied_roots: ['keys'],
      actions: ['read', 'write', 'export'],
    },
  };

  if (effectiveKind === 'user') {
    baseManifest.user_config = {
      shell: { workspace_root: '.', theme: 'dark', voice_enabled: true, avatar_display: true },
      devices: ['primary-pc'],
      accounts: [owner],
      groups: [],
    };
  } else if (effectiveKind === 'agent') {
    const nowIso = new Date().toISOString();
    baseManifest.permissions.allowed_roots.push('persona', 'memory/common', 'nva', 'public-room');
    baseManifest.agent_config = {
      agent_json_path: 'agent.json',
      birth: { created_at: nowIso, created_by: String(responsibleHuman).trim(), adk_version: '2.0.0' },
      groups: [],
      organizations: [],
      projects: [],
      persona_dir: 'persona',
      memory: { common_dir: 'memory/common', groups_dir: 'memory/groups' },
      nva: { dir: 'nva', config_file: 'nva/avatar.json' },
      public_room: { dir: 'public-room', enabled: false },
    };
    for (const d of ['persona', 'memory/common', 'memory/groups', 'nva', 'public-room']) {
      fs.mkdirSync(path.join(resolvedTarget, d), { recursive: true });
    }
    const agentJson = {
      id,
      name: name || id,
      owner: String(owner).trim(),
      responsible_human: String(responsibleHuman).trim(),
      birth: baseManifest.agent_config.birth,
      groups: [],
      organizations: [],
      information_scope: {
        allowed_roots: baseManifest.permissions.allowed_roots,
        denied_roots: ['keys'],
      },
    };
    fs.writeFileSync(path.join(resolvedTarget, 'agent.json'), JSON.stringify(agentJson, null, 2) + '\n', 'utf8');
  } else if (effectiveKind === 'group') {
    baseManifest.permissions.allowed_roots.push('agents', 'projects');
    baseManifest.group_config = {
      members: [{ user_id: String(responsibleHuman).trim(), access: 'owner' }],
      projects: [],
      agents: [],
      calendar: { milestones: [] },
      channels: 'channels.yaml',
      messenger_servers: [
        { id: 'internal-main', kind: 'internal', name: 'Internal Workspace Server' },
        { id: 'customer-support', kind: 'customer', name: 'Customer Dedicated Server' },
      ],
    };
    for (const d of ['agents', 'projects']) {
      fs.mkdirSync(path.join(resolvedTarget, d), { recursive: true });
    }
    fs.writeFileSync(
      path.join(resolvedTarget, 'channels.yaml'),
      `schemaVersion: 1\ncompany: ${String(owner).trim()}\nroles: [minho, jina, alpha, naia]\nservers:\n  - key: internal\n    channels: []\n  - key: customer\n    channels: []\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(resolvedTarget, 'channel-ids.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          companies: {
            [String(owner).trim()]: {
              servers: {
                internal: { guildId: null, channels: {} },
                customer: { guildId: null, channels: {} },
              },
            },
          },
          allowedUserIds: ['9000000000000000001'],
          readerInstance: 'minho',
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
  }

  fs.writeFileSync(path.join(resolvedTarget, 'adk.json'), JSON.stringify(baseManifest, null, 2) + '\n', 'utf8');
  const check = validateAdkPath(resolvedTarget);
  if (!check.ok) {
    throw new Error(`Scaffolded ${kind} ADK failed validation: ${check.errors.join('; ')}`);
  }
  return { ok: true, targetDir: resolvedTarget, manifest: check.manifest };
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target' || a === '--root') opts.targetDir = argv[++i];
    else if (a === '--name') opts.name = argv[++i];
    else if (a === '--id') opts.id = argv[++i];
    else if (a === '--owner') opts.owner = argv[++i];
    else if (a === '--responsible' || a === '--responsible-human') opts.responsibleHuman = argv[++i];
    else if (a === '--description') opts.description = argv[++i];
    else if (a === '--date') opts.date = argv[++i];
  }
  return opts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const res = scaffoldProjectAdk(opts);
    console.log(
      `✓ Scaffolded project ADK "${res.projectId}" at ${res.targetDir} (${res.createdFilesCount} files, owner=${res.manifest.owner}, responsible_human=${res.manifest.responsible_human})`,
    );
  } catch (err) {
    console.error(`✗ adk-scaffold-project FAILED: ${err.message}`);
    process.exit(1);
  }
}
