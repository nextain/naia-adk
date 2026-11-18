import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

/**
 * Validate a role or work-ledger item id using the same rule as scripts/work-ledger/ledger.mjs.
 */
export function safeLedgerName(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) {
    throw new Error("Invalid role or item id");
  }
  return value;
}

/**
 * Compute the per-role JSON ledger path under `<root>/.agents/work/ledger/<role>.json`.
 */
export function ledgerFilePath(root, role) {
  return join(root, ".agents/work/ledger", `${safeLedgerName(role)}.json`);
}

/**
 * Validate parsed work-ledger.json content.
 */
export function validateWorkLedgerConfig(raw) {
  if (
    !raw
    || typeof raw !== "object"
    || Array.isArray(raw)
    || (raw.version !== undefined && raw.version !== 1)
    || !Array.isArray(raw.roles)
    || raw.roles.some((r) => !r || typeof r !== "object" || Array.isArray(r) || typeof r.role !== "string" || !r.role.trim())
  ) {
    throw new Error("invalid workLedgerConfig");
  }
  return raw;
}

/**
 * Read optional work-ledger.json metadata to find ledger dir, wake_dir, and report channel per role.
 * Reused by both session-health/stalled-cards and the dashboard/server ledger API.
 */
export async function readWorkLedgerMeta(config) {
  if (!config.workLedgerConfig && !config.workLedgerDir) return null;
  let ledgerConfig = null;
  let root = config.workLedgerRoot ?? null;
  if (config.workLedgerConfig) {
    ledgerConfig = validateWorkLedgerConfig(JSON.parse(await readFile(config.workLedgerConfig, "utf8")));
    if (!root) {
      const explicitRoot = typeof ledgerConfig.ledger_root === "string" && ledgerConfig.ledger_root.trim()
        ? ledgerConfig.ledger_root.trim()
        : null;
      if (explicitRoot) {
        root = resolve(dirname(config.workLedgerConfig), explicitRoot);
      } else {
        const parent = dirname(config.workLedgerConfig);
        root = parent.endsWith(`${sep}config`) || parent.endsWith("/config") ? dirname(parent) : parent;
      }
    }
  }
  const configDir = typeof ledgerConfig?.ledger_dir === "string" && ledgerConfig.ledger_dir.trim()
    ? resolve(root ?? dirname(config.workLedgerConfig), ledgerConfig.ledger_dir.trim())
    : null;
  const dir = config.workLedgerDir ?? configDir ?? join(root, ".agents/work/ledger");
  if (!root) root = dirname(dirname(dirname(dir)));
  return { root, dir, config: ledgerConfig };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Resolve work-ledger configuration and directory for a server workspace root.
 * Returns `{ configured: false }` when no work-ledger config/override is present so
 * servers without a work ledger keep their legacy board behavior unchanged.
 */
export async function resolveWorkLedgerLocation(adkRoot, env = process.env) {
  const envConfig = nonEmptyString(env?.NAIA_WORK_LEDGER_CONFIG);
  const envRoot = nonEmptyString(env?.NAIA_WORK_LEDGER_ROOT);
  const envDir = nonEmptyString(env?.NAIA_WORK_LEDGER_DIR);

  const defaultConfigPath = join(adkRoot, "config", "work-ledger.json");
  const configPath = envConfig
    ? (isAbsolute(envConfig) ? envConfig : resolve(adkRoot, envConfig))
    : existsSync(defaultConfigPath)
      ? defaultConfigPath
      : null;

  if (!configPath && !envRoot && !envDir) {
    return {
      configured: false,
      available: false,
      root: null,
      dir: null,
      configPath: null,
      config: null,
      guildId: null,
      error: null,
    };
  }

  const resolvedRoot = envRoot ? (isAbsolute(envRoot) ? envRoot : resolve(adkRoot, envRoot)) : null;
  const resolvedDir = envDir ? (isAbsolute(envDir) ? envDir : resolve(adkRoot, envDir)) : null;

  try {
    const meta = await readWorkLedgerMeta({
      workLedgerConfig: configPath ?? undefined,
      workLedgerRoot: resolvedRoot ?? undefined,
      workLedgerDir: resolvedDir ?? undefined,
    });
    if (!meta) {
      return {
        configured: true,
        available: true,
        root: resolvedRoot ?? adkRoot,
        dir: resolvedDir ?? join(resolvedRoot ?? adkRoot, ".agents/work/ledger"),
        configPath: null,
        config: null,
        guildId: nonEmptyString(env?.NAIA_DISCORD_GUILD_ID),
        error: null,
      };
    }

    // If configPath lives outside `<root>/config/work-ledger.json` (e.g. a kit directory) and
    // no explicit root was supplied, prefer adkRoot when `<adkRoot>/.agents/work/ledger` exists.
    let finalRoot = meta.root;
    let finalDir = meta.dir;
    if (
      configPath
      && !resolvedRoot
      && !resolvedDir
      && !existsSync(finalDir)
      && !nonEmptyString(meta.config?.ledger_root)
      && !nonEmptyString(meta.config?.ledger_dir)
    ) {
      const adkLedgerDir = join(adkRoot, ".agents/work/ledger");
      if (existsSync(adkLedgerDir)) {
        finalRoot = adkRoot;
        finalDir = adkLedgerDir;
      }
    }

    const guildId =
      nonEmptyString(meta.config?.provider?.guild_id)
      ?? nonEmptyString(meta.config?.provider?.guildId)
      ?? nonEmptyString(meta.config?.defaults?.guild_id)
      ?? nonEmptyString(meta.config?.defaults?.guildId)
      ?? nonEmptyString(meta.config?.guild_id)
      ?? nonEmptyString(meta.config?.guildId)
      ?? nonEmptyString(env?.NAIA_DISCORD_GUILD_ID);

    return {
      configured: true,
      available: true,
      root: finalRoot,
      dir: finalDir,
      configPath,
      config: meta.config,
      guildId,
      error: null,
    };
  } catch (error) {
    return {
      configured: true,
      available: false,
      root: resolvedRoot,
      dir: resolvedDir,
      configPath,
      config: null,
      guildId: nonEmptyString(env?.NAIA_DISCORD_GUILD_ID),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
