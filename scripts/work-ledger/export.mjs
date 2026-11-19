#!/usr/bin/env node
// Publish the minimal board projection, separately for each source owner.
import { open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateLedger } from "./ledger.mjs";
import { redact } from "../bot-mention-wake.mjs";

const ACTIVE = new Set(["open", "waiting_human", "escalated_human"]);
const textOrNull = (value) => typeof value === "string" ? redact(value).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED]") : null;
const safeRole = (role) => typeof role === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(role);

export function projectLedger(ledger, role) {
  validateLedger(ledger, role);
  return {
    version: 1,
    role,
    items: ledger.items.filter((item) => item && ACTIVE.has(item.status)).map((item) => {
      if (typeof item.id !== "string" || typeof item.title !== "string")
        throw new Error(`Invalid active item in ${role}`);
      const worker = item.worker && typeof item.worker === "object" ? item.worker : null;
      return {
        id: textOrNull(item.id),
        title: textOrNull(item.public_title) || "작업",
        due: textOrNull(item.due),
        status: item.status,
        worker: worker ? { name: textOrNull(worker.name), alive: typeof worker.alive === "boolean" ? worker.alive : null } : null,
        updated_at: textOrNull(item.updated_at) ?? textOrNull(item.checked_at),
        from: { channel: textOrNull(item.from?.channel), msg_id: textOrNull(item.from?.msg_id) },
      };
    }),
  };
}

export function validateConfig(config) {
  if (!config || typeof config.outputDir !== "string" || !path.isAbsolute(config.outputDir) || !Array.isArray(config.sources) || !config.sources.length)
    throw new Error("Configuration requires absolute outputDir and non-empty sources");
  const seen = new Set();
  for (const source of config.sources) {
    if (!source || !safeRole(source.role) || typeof source.path !== "string" || !path.isAbsolute(source.path) || seen.has(source.role))
      throw new Error("Each source requires a unique safe role and an absolute path");
    seen.add(source.role);
  }
  return config;
}

// The output directory must already exist, be writable by the selected owner,
// and reside on the same filesystem as the temporary files used for rename.
export async function atomicExport(file, value, renameFile = rename) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await handle.chmod(0o644);
    } finally {
      await handle.close();
    }
    await renameFile(temporary, file);
  } finally {
    if (created) await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

// Resolve symlinks even when a source does not yet exist.
async function canonicalPath(file) {
  try { return await realpath(file); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(await canonicalPath(parent), path.basename(file));
  }
}

async function validatePaths(config) {
  const output = await canonicalPath(path.resolve(config.outputDir));
  for (const source of config.sources) {
    const input = await canonicalPath(path.resolve(source.path));
    const relative = path.relative(output, path.dirname(input));
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)))
      throw new Error(`Output directory overlaps source: ${source.role}`);
    for (const target of config.sources) {
      if (await canonicalPath(path.join(output, `${target.role}.json`)) === input)
        throw new Error(`Output file overlaps source: ${source.role}`);
    }
  }
}

export async function exportLedgers(config, roles) {
  validateConfig(config);
  if (!Array.isArray(roles) || !roles.length || new Set(roles).size !== roles.length)
    throw new Error("Select at least one distinct role with --role");
  const selected = roles.map((role) => {
    const source = config.sources.find((entry) => entry.role === role);
    if (!source) throw new Error(`Role not configured: ${role}`);
    return source;
  });
  await validatePaths(config);
  const errors = [];
  for (const source of selected) {
    try {
      const ledger = JSON.parse(await readFile(source.path, "utf8"));
      await atomicExport(path.join(config.outputDir, `${source.role}.json`), projectLedger(ledger, source.role));
    } catch (error) {
      errors.push(`${source.role}: ${error.message}`);
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
}

async function main(args) {
  let configFile;
  const roles = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && args[i + 1] && !configFile) configFile = args[++i];
    else if (args[i] === "--role" && args[i + 1]) roles.push(args[++i]);
    else throw new Error("Usage: export.mjs --config FILE --role ROLE [--role ROLE ...]");
  }
  if (!configFile) throw new Error("--config is required");
  await exportLedgers(JSON.parse(await readFile(configFile, "utf8")), roles);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
