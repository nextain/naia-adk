#!/usr/bin/env node
/**
 * Naia ADK v2.0.0 — Relative Symlink Linker, Group & Schedule Checker CLI
 *
 * Commands:
 *   node scripts/adk-link.mjs --validate <adk-dir-or-adk.json> [...] [--json]
 *   node scripts/adk-link.mjs --link --from <source-adk> --to <target-adk> [--mount <rel-path>]
 *   node scripts/adk-link.mjs --link <adk-dir>
 *   node scripts/adk-link.mjs --check <adk-dir> [...] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VALID_KINDS,
  LEGACY_KIND_ALIASES,
  VALID_ACTIONS,
  normalizeKind,
  defaultMountForKind,
  isKeysSegment,
  resolveAdkManifestPath,
  validateAdkManifest,
  validateAdkPath,
} from './lib/adk-manifest-validator.mjs';
import {
  isValidCalendarDate,
  parseWorkDocSchedule,
  validateWorkDocSchedule,
} from './lib/adk-schedule.mjs';

export {
  VALID_KINDS,
  LEGACY_KIND_ALIASES,
  VALID_ACTIONS,
  normalizeKind,
  defaultMountForKind,
  isKeysSegment,
  resolveAdkManifestPath,
  validateAdkManifest,
  validateAdkPath,
  isValidCalendarDate,
  parseWorkDocSchedule,
  validateWorkDocSchedule,
};

export function linkAdkInstances({ fromDir, toDir, mountPath = null, remoteUrl = null }) {
  const srcCheck = validateAdkPath(fromDir);
  if (!srcCheck.ok) {
    throw new Error(`Source ADK invalid (${fromDir}): ${srcCheck.errors.join('; ')}`);
  }
  const dstCheck = validateAdkPath(toDir);
  if (!dstCheck.ok) {
    throw new Error(`Target ADK invalid (${toDir}): ${dstCheck.errors.join('; ')}`);
  }

  const srcAbs = srcCheck.adkDir;
  const dstAbs = dstCheck.adkDir;
  if (fs.realpathSync(srcAbs) === fs.realpathSync(dstAbs)) {
    throw new Error('Cannot link an ADK instance to itself');
  }

  const targetManifest = dstCheck.manifest;
  const normalizedTargetKind = normalizeKind(targetManifest.kind);
  const relToTargetFromRoot = path.relative(srcAbs, dstAbs).split(path.sep).join('/');
  if (isKeysSegment(relToTargetFromRoot)) {
    throw new Error(`Refusing to link path containing keys/: ${relToTargetFromRoot}`);
  }

  const resolvedMount = (mountPath || defaultMountForKind(normalizedTargetKind, targetManifest.id))
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');

  if (isKeysSegment(resolvedMount) || resolvedMount.split('/').includes('..')) {
    throw new Error(`Invalid or prohibited mount_path: ${resolvedMount}`);
  }

  const mountAbs = path.join(srcAbs, resolvedMount);
  fs.mkdirSync(path.dirname(mountAbs), { recursive: true });

  const relSymlinkTarget = path.relative(path.dirname(mountAbs), dstAbs).split(path.sep).join('/');
  if (fs.existsSync(mountAbs) || fs.lstatSync(mountAbs, { throwIfNoEntry: false })) {
    const st = fs.lstatSync(mountAbs);
    if (st.isSymbolicLink()) {
      fs.unlinkSync(mountAbs);
    } else {
      throw new Error(`Mount path already exists and is not a symlink: ${mountAbs}`);
    }
  }

  fs.symlinkSync(relSymlinkTarget, mountAbs, 'dir');

  const srcManifest = srcCheck.manifest;
  const linkEntry = {
    id: targetManifest.id,
    kind: normalizedTargetKind,
    local_path: relToTargetFromRoot,
    mount_path: resolvedMount,
    remote_url: remoteUrl,
    adk_version: targetManifest.adk_version,
  };

  const existingIdx = srcManifest.links.findIndex(
    (l) => l.id === linkEntry.id && normalizeKind(l.kind) === linkEntry.kind,
  );
  if (existingIdx >= 0) {
    srcManifest.links[existingIdx] = linkEntry;
  } else {
    srcManifest.links.push(linkEntry);
  }

  fs.writeFileSync(srcCheck.manifestPath, JSON.stringify(srcManifest, null, 2) + '\n', 'utf8');
  return {
    ok: true,
    from: srcAbs,
    to: dstAbs,
    mountAbs,
    relSymlinkTarget,
    linkEntry,
  };
}

export function materializeManifestLinks(adkDir) {
  const check = validateAdkPath(adkDir);
  if (!check.ok) {
    throw new Error(`ADK manifest invalid (${adkDir}): ${check.errors.join('; ')}`);
  }
  const results = [];
  for (const link of check.manifest.links) {
    const targetAbs = path.resolve(check.adkDir, link.local_path);
    const mountRel = (link.mount_path || defaultMountForKind(link.kind, link.id)).replace(/\\/g, '/');
    const mountAbs = path.join(check.adkDir, mountRel);
    fs.mkdirSync(path.dirname(mountAbs), { recursive: true });
    const relSymlinkTarget = path.relative(path.dirname(mountAbs), targetAbs).split(path.sep).join('/');
    const st = fs.lstatSync(mountAbs, { throwIfNoEntry: false });
    if (st) {
      if (st.isSymbolicLink()) {
        fs.unlinkSync(mountAbs);
      } else {
        throw new Error(`Mount path exists and is not a symlink: ${mountAbs}`);
      }
    }
    fs.symlinkSync(relSymlinkTarget, mountAbs, 'dir');
    results.push({ id: link.id, kind: normalizeKind(link.kind), mountAbs, relSymlinkTarget });
  }
  return results;
}

function scanSymlinksForIsolation(rootDir, currentDir = rootDir, depth = 0, errors = [], visitedDirs = new Set()) {
  if (depth > 32) return errors;
  try {
    const realCurrent = fs.realpathSync(currentDir);
    if (visitedDirs.has(realCurrent)) return errors;
    visitedDirs.add(realCurrent);
  } catch {
    return errors;
  }
  let entries = [];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return errors;
  }
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const fullPath = path.join(currentDir, entry.name);
    const relFromRoot = path.relative(rootDir, fullPath).split(path.sep).join('/');
    const lst = fs.lstatSync(fullPath);
    if (lst.isSymbolicLink()) {
      const rawTarget = fs.readlinkSync(fullPath);
      if (path.isAbsolute(rawTarget)) {
        errors.push(`Symlink "${relFromRoot}" must use a relative path (found absolute: ${rawTarget})`);
      }
      if (entry.name === 'keys' || entry.name === '.keys' || isKeysSegment(relFromRoot) || isKeysSegment(rawTarget)) {
        errors.push(`Forbidden keys/ symlink detected at "${relFromRoot}" -> "${rawTarget}" (keys/ must be strictly isolated)`);
      }
      const resolved = path.resolve(path.dirname(fullPath), rawTarget);
      if (!fs.existsSync(resolved)) {
        errors.push(`Broken symlink at "${relFromRoot}" -> "${rawTarget}"`);
      }
    } else if (lst.isDirectory()) {
      scanSymlinksForIsolation(rootDir, fullPath, depth + 1, errors, visitedDirs);
    }
  }
  return errors;
}

export function checkAdkInstance(inputPath) {
  const val = validateAdkPath(inputPath);
  const errors = [...val.errors];
  const warnings = [...val.warnings];

  if (!val.manifest) {
    return { ok: false, adkDir: val.adkDir, errors, warnings };
  }

  const adkDir = val.adkDir;
  const manifest = val.manifest;

  const keysPath = path.join(adkDir, manifest.paths?.keys || 'keys');
  const keysStat = fs.lstatSync(keysPath, { throwIfNoEntry: false });
  if (keysStat && keysStat.isSymbolicLink()) {
    errors.push(`keys/ directory at ${keysPath} must NEVER be a symbolic link`);
  }

  scanSymlinksForIsolation(adkDir, adkDir, 0, errors);

  const visitedRealpaths = new Set();
  for (const [idx, link] of (manifest.links || []).entries()) {
    const normalizedLinkKind = normalizeKind(link.kind);
    const prefix = `links[${idx}](${normalizedLinkKind}:${link.id})`;
    if (path.isAbsolute(link.local_path)) {
      errors.push(`${prefix}: local_path must be relative`);
      continue;
    }
    const targetAbs = path.resolve(adkDir, link.local_path);
    const targetValidation = validateAdkPath(targetAbs);
    if (!targetValidation.ok) {
      errors.push(`${prefix}: linked target ADK at ${link.local_path} failed validation: ${targetValidation.errors.join('; ')}`);
      continue;
    }
    const targetKind = normalizeKind(targetValidation.manifest.kind);
    if (targetValidation.manifest.id !== link.id || targetKind !== normalizedLinkKind) {
      errors.push(
        `${prefix}: link metadata (${normalizedLinkKind}:${link.id}) does not match target adk.json (${targetKind}:${targetValidation.manifest.id})`,
      );
    }
    if (link.adk_version && link.adk_version !== targetValidation.manifest.adk_version) {
      warnings.push(
        `${prefix}: version mismatch warning (link expects ${link.adk_version}, target has ${targetValidation.manifest.adk_version})`,
      );
    }

    const mountRel = (link.mount_path || defaultMountForKind(normalizedLinkKind, link.id)).replace(/\\/g, '/');
    const mountAbs = path.join(adkDir, mountRel);
    const mountStat = fs.lstatSync(mountAbs, { throwIfNoEntry: false });
    if (!mountStat || !mountStat.isSymbolicLink()) {
      errors.push(`${prefix}: expected relative symlink at "${mountRel}"`);
      continue;
    }
    const rawLink = fs.readlinkSync(mountAbs);
    if (path.isAbsolute(rawLink)) {
      errors.push(`${prefix}: symlink at "${mountRel}" must be relative (got: ${rawLink})`);
    }
    const mountReal = fs.realpathSync(mountAbs);
    const targetReal = fs.realpathSync(targetAbs);
    if (mountReal !== targetReal) {
      errors.push(`${prefix}: symlink "${mountRel}" resolves to ${mountReal}, expected ${targetReal}`);
    }
    if (visitedRealpaths.has(targetReal)) {
      errors.push(`${prefix}: duplicate link pointing to the same physical ADK realpath (${targetReal})`);
    }
    visitedRealpaths.add(targetReal);
  }

  let workDocs = null;
  if (manifest.kind === 'group') {
    const workDocsRel = manifest.group_config?.calendar?.work_docs_dir;
    if (typeof workDocsRel === 'string' && workDocsRel.trim().length > 0 && !path.isAbsolute(workDocsRel) && !workDocsRel.split(/[\\/]/).includes('..') && !isKeysSegment(workDocsRel)) {
      const workDocsAbs = path.join(adkDir, workDocsRel);
      if (fs.existsSync(workDocsAbs) && fs.statSync(workDocsAbs).isDirectory()) {
        const mdFiles = fs
          .readdirSync(workDocsAbs, { withFileTypes: true })
          .filter((e) => e.isFile() && e.name.endsWith('.md'))
          .map((e) => e.name)
          .sort();
        let docErrorCount = 0;
        for (const fname of mdFiles) {
          const fullDocPath = path.join(workDocsAbs, fname);
          const text = fs.readFileSync(fullDocPath, 'utf8');
          const schedRes = validateWorkDocSchedule(text, {
            milestoneIds: val.milestoneIds || [],
            milestoneNames: val.milestoneNames || [],
          });
          for (const w of schedRes.warnings) {
            warnings.push(`${workDocsRel}/${fname}: ${w}`);
          }
          for (const e of schedRes.errors) {
            errors.push(`${workDocsRel}/${fname}: ${e}`);
            docErrorCount += 1;
          }
        }
        workDocs = {
          dir: workDocsRel,
          checked: mdFiles.length,
          errors: docErrorCount,
        };
      }
    }
  }

  const out = { ok: errors.length === 0, adkDir, manifest, errors, warnings };
  if (val.groupSummary) out.groupSummary = val.groupSummary;
  if (workDocs) out.workDocs = workDocs;
  return out;
}

function printGroupSummaryAndOpen(res, isCheckMode = false) {
  if (!res.groupSummary) return;
  console.log(res.groupSummary.summaryLine);
  const open = res.groupSummary.open || {};
  if (Array.isArray(open.unset_access) && open.unset_access.length > 0) {
    console.log(`open: unset access (${open.unset_access.length}): ${open.unset_access.join(', ')}`);
  }
  if (Array.isArray(open.undecided_repos) && open.undecided_repos.length > 0) {
    console.log(`open: undecided repos (${open.undecided_repos.length}): ${open.undecided_repos.join(', ')}`);
  }
  if (Array.isArray(open.planned_bots) && open.planned_bots.length > 0) {
    console.log(`open: planned bots (${open.planned_bots.length}): ${open.planned_bots.join(', ')}`);
  }
  if (Array.isArray(open.seats_not_created) && open.seats_not_created.length > 0) {
    console.log(`open: seats not created (${open.seats_not_created.length}): ${open.seats_not_created.join(', ')}`);
  }
  if (Array.isArray(open.seats_without_manifest) && open.seats_without_manifest.length > 0) {
    console.log(`open: seats without manifest (${open.seats_without_manifest.length}): ${open.seats_without_manifest.join(', ')}`);
  }
  if (Array.isArray(open.missing_entry) && open.missing_entry.length > 0) {
    console.log(`open: entry AGENTS.md missing`);
  }
  if (Array.isArray(open.missing_context) && open.missing_context.length > 0) {
    console.log(`open: missing context (${open.missing_context.length}): ${open.missing_context.join(', ')}`);
  }
  if (isCheckMode && res.workDocs) {
    console.log(`work docs: ${res.workDocs.checked} checked, ${res.workDocs.errors} errors`);
  }
}

function parseCliArgs(argv) {
  const opts = { mode: null, from: null, to: null, mount: null, remote: null, json: false, targets: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--validate') opts.mode = 'validate';
    else if (arg === '--link') opts.mode = 'link';
    else if (arg === '--check') opts.mode = 'check';
    else if (arg === '--json') opts.json = true;
    else if (arg === '--from') opts.from = argv[++i];
    else if (arg === '--to') opts.to = argv[++i];
    else if (arg === '--mount') opts.mount = argv[++i];
    else if (arg === '--remote') opts.remote = argv[++i];
    else if (arg === '--root' || arg === '--manifest') opts.targets.push(argv[++i]);
    else if (!arg.startsWith('-')) opts.targets.push(arg);
  }
  return opts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const opts = parseCliArgs(process.argv.slice(2));
  if (!opts.mode) {
    console.error('Usage: adk-link.mjs <--validate | --link | --check> [--json] [options]');
    process.exit(1);
  }

  if (opts.mode === 'validate') {
    const targets = opts.targets.length > 0 ? opts.targets : ['.'];
    let failed = false;
    const results = [];
    for (const t of targets) {
      const res = validateAdkPath(t);
      results.push(res);
      if (!res.ok) failed = true;
      if (!opts.json) {
        for (const w of res.warnings) {
          console.warn(`⚠ [validate] ${t}: ${w}`);
        }
        if (res.ok) {
          console.log(`✓ [validate] ${res.manifest.kind}:${res.manifest.id} (${res.manifestPath}) — owner=${res.manifest.owner}, responsible_human=${res.manifest.responsible_human}`);
          printGroupSummaryAndOpen(res, false);
        } else {
          console.error(`✗ [validate] ${t} FAILED:\n  - ${res.errors.join('\n  - ')}`);
        }
      }
    }
    if (opts.json) {
      console.log(JSON.stringify(results.length === 1 ? results[0] : { ok: !failed, results }, null, 2));
    }
    process.exit(failed ? 1 : 0);
  }

  if (opts.mode === 'link') {
    try {
      if (opts.from && opts.to) {
        const res = linkAdkInstances({
          fromDir: opts.from,
          toDir: opts.to,
          mountPath: opts.mount,
          remoteUrl: opts.remote,
        });
        if (opts.json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(`✓ [link] ${res.linkEntry.kind}:${res.linkEntry.id} linked at ${res.linkEntry.mount_path} -> ${res.relSymlinkTarget}`);
        }
      } else {
        const target = opts.targets[0] || '.';
        const linked = materializeManifestLinks(target);
        if (opts.json) {
          console.log(JSON.stringify({ ok: true, target, linked }, null, 2));
        } else {
          console.log(`✓ [link] Materialized ${linked.length} relative symlink(s) for ${target}`);
        }
      }
      process.exit(0);
    } catch (err) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
      } else {
        console.error(`✗ [link] FAILED: ${err.message}`);
      }
      process.exit(1);
    }
  }

  if (opts.mode === 'check') {
    const targets = opts.targets.length > 0 ? opts.targets : ['.'];
    let failed = false;
    const results = [];
    for (const t of targets) {
      const res = checkAdkInstance(t);
      results.push(res);
      if (!res.ok) failed = true;
      if (!opts.json) {
        for (const w of res.warnings) {
          console.warn(`⚠ [check] ${t}: ${w}`);
        }
        if (res.ok) {
          console.log(`✓ [check] ${res.manifest.kind}:${res.manifest.id} (${res.adkDir}) — links=${res.manifest.links.length}, keys_isolated=true, responsible_human=${res.manifest.responsible_human}`);
          printGroupSummaryAndOpen(res, true);
        } else {
          printGroupSummaryAndOpen(res, true);
          console.error(`✗ [check] ${t} FAILED:\n  - ${res.errors.join('\n  - ')}`);
        }
      }
    }
    if (opts.json) {
      console.log(JSON.stringify(results.length === 1 ? results[0] : { ok: !failed, results }, null, 2));
    }
    process.exit(failed ? 1 : 0);
  }
}
