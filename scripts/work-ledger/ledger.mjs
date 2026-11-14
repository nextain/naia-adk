#!/usr/bin/env node
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
export function safeName(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value))
    throw new Error("Invalid role or item id");
  return value;
}
export function ledgerPath(root, role) {
  return path.join(root, ".agents/work/ledger", `${safeName(role)}.json`);
}
// Kernel locks survive stale lock files and release automatically after a crash.
// The helper holds flock until its parent closes stdin (including on SIGKILL).
export async function withLock(file, fn) {
  await mkdir(path.dirname(file), { recursive: true });
  const child = spawn(
    "flock",
    [
      "--exclusive",
      "--timeout",
      "10",
      `${file}.lock`,
      process.execPath,
      "-e",
      "process.stdout.write('locked\\n'); process.stdin.resume();",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const finished = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Lock helper failed (${signal || code})`));
    });
  });
  // Attach rejection handling before waiting for readiness.
  finished.catch(() => {});
  let diagnostic = "";
  child.stderr.on("data", (data) => {
    diagnostic += data.toString();
  });
  await Promise.race([
    new Promise((resolve) => child.stdout.once("data", resolve)),
    finished.then(() => {
      throw new Error(`Lock ended before acquisition: ${diagnostic}`);
    }),
  ]);
  try {
    return await fn();
  } finally {
    child.stdin.end();
    await finished;
  }
}
export async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await (await open(temporary, "wx", 0o600)).close();
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
export function validDate(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() ===
      value.replace(/Z$/, value.includes(".") ? "Z" : ".000Z")
  );
}
export function validateLedger(ledger, role) {
  if (
    !ledger ||
    ledger.version !== 1 ||
    ledger.role !== role ||
    !Array.isArray(ledger.items) ||
    !ledger.report ||
    !Number.isFinite(ledger.report.every_min) ||
    ledger.report.every_min < 0 ||
    typeof ledger.report.channel !== "string" ||
    (ledger.report.last_msg_id !== null &&
      typeof ledger.report.last_msg_id !== "string")
  )
    throw new Error("Invalid ledger schema");
  const ids = new Set();
  for (const item of ledger.items) {
    safeName(item.id);
    if (
      ids.has(item.id) ||
      typeof item.title !== "string" ||
      !item.from ||
      typeof item.from.msg_id !== "string" ||
      typeof item.from.channel !== "string" ||
      typeof item.from.quote !== "string" ||
      typeof item.note !== "string" ||
      !validDate(item.due) ||
      (item.created_at !== undefined && !validDate(item.created_at)) ||
      !["open", "waiting_human", "done", "dropped"].includes(item.status) ||
      (item.checked_at !== null && !validDate(item.checked_at)) ||
      (item.worker !== null &&
        (!item.worker ||
          typeof item.worker.done_file !== "string" ||
          typeof item.worker.name !== "string" ||
          typeof item.worker.result !== "string"))
    )
      throw new Error("Invalid ledger item");
    ids.add(item.id);
  }
  if (ledger.report.last_at !== null && !validDate(ledger.report.last_at))
    throw new Error("Invalid report date");
  return ledger;
}
export async function readLedger(root, role) {
  return validateLedger(
    JSON.parse(await readFile(ledgerPath(root, role), "utf8")),
    role,
  );
}
export async function changeLedger(root, role, update) {
  const file = ledgerPath(root, role);
  return withLock(file, async () => {
    let ledger;
    try {
      ledger = await readLedger(root, role);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      ledger = {
        version: 1,
        role,
        report: { every_min: 0, channel: "", last_msg_id: null, last_at: null },
        items: [],
      };
    }
    const result = await update(ledger);
    validateLedger(ledger, role);
    await atomicJson(file, ledger);
    return result ?? ledger;
  });
}
export function parseArgs(args) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      if (!args[i + 1] || args[i + 1].startsWith("--"))
        throw new Error(`Missing --${key} value`);
      opts[key] = args[++i];
    } else positional.push(args[i]);
  }
  return { opts, positional };
}
export async function main(args = process.argv.slice(2), { runner, now, clock = now === undefined ? Date.now : () => now, warn = console.warn } = {}) {
  const {
    opts: o,
    positional: [command, id],
  } = parseArgs(args);
  const root = path.resolve(o.root || process.cwd());
  const role = safeName(o.role);
  if (command === "list") {
    const l = await readLedger(root, role);
    return (
      l.items
        .map((i) => `${i.id} [${i.status}] ${i.due} ${i.title}`)
        .join("\n") || "(빈 장부)"
    );
  }
  let roleConfig;
  let config = {};
  const configFile = o.config
    ? path.resolve(root, o.config)
    : path.join(root, "config/work-ledger.json");
  try {
    config = JSON.parse(await readFile(configFile, "utf8"));
    roleConfig = config.roles?.find((entry) => entry.role === role);
    if (!roleConfig) throw new Error("Role missing in configuration");
  } catch (error) {
    if (error.code !== "ENOENT" || o.config) throw error;
  }
  const result = await changeLedger(root, role, (l) => {
    if (l.report.every_min === 0 && roleConfig?.report) {
      l.report.every_min = roleConfig.report.every_min;
      l.report.channel = roleConfig.report.channel;
    }
    if (command === "add") {
      if (!o.title || !validDate(o.due) || !o.channel || !o["msg-id"])
        throw new Error(
          "add requires --title --due (UTC ISO) --channel --msg-id",
        );
      const itemId = safeName(o.id || randomUUID());
      if (l.items.some((i) => i.id === itemId)) throw new Error("Duplicate id");
      if (
        (o["worker-name"] || o.result || o["done-file"]) &&
        !(o["worker-name"] && o.result && o["done-file"])
      )
        throw new Error("Worker requires --worker-name --result --done-file");
      l.items.push({
        id: itemId,
        title: o.title,
        from: { channel: o.channel, msg_id: o["msg-id"], quote: o.quote || "" },
        due: o.due,
        created_at: new Date(clock()).toISOString(),
        status: "open",
        worker: o["worker-name"]
          ? {
              name: o["worker-name"],
              result: o.result,
              done_file: o["done-file"],
            }
          : null,
        checked_at: null,
        note: o.note || "",
      });
      return itemId;
    }
    if (command === "report") {
      if (!o["msg-id"] || !o.channel)
        throw new Error("report requires --msg-id --channel");
      if (o["every-min"] !== undefined) {
        const n = Number(o["every-min"]);
        if (!Number.isFinite(n) || n < 0) throw new Error("Invalid every-min");
        l.report.every_min = n;
      }
      l.report.channel = o.channel;
      l.report.last_msg_id = o["msg-id"];
      l.report.last_at = new Date().toISOString();
      return "보고 기록";
    }
    if (!["done", "drop", "touch", "due"].includes(command))
      throw new Error("Commands: add due done drop touch report list");
    const item = l.items.find((i) => i.id === (id || o.id));
    if (!item) throw new Error("Unknown item");
    if (command === "drop" && !o.reason?.trim())
      throw new Error("drop requires --reason");
    if (command === "due") {
      if (!o.reason?.trim() || !validDate(o.due)) throw new Error("due requires --reason and --due (UTC ISO)");
      if (item.status !== "open") throw new Error("due requires an open item");
      item.due = o.due;
    } else if (command === "touch") item.checked_at = new Date().toISOString();
    else item.status = command === "done" ? "done" : "dropped";
    if (o.reason) item.note = o.reason;
    return item.id;
  });
  if (["add", "due", "done", "drop"].includes(command) && config.due_timer?.enabled === true) {
    try {
      const { reconcileCurrent } = await import("./due-timer.mjs");
      const warnings = await reconcileCurrent({ root, config, roles: [role], clock, runner, configPath: o.config ? configFile : undefined });
      for (const warning of warnings) warn(`timer: 못 걺 (${warning})`);
    } catch (error) { warn(`timer: 못 걺 (${error.message})`); }
  }
  return result;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main()
    .then((value) =>
      {
        console.log(typeof value === "string" ? value : JSON.stringify(value));
        const { opts, positional } = parseArgs(process.argv.slice(2));
        if (positional[0] === "add" && validDate(opts.due))
          console.log(`지금부터 ${Math.round((Date.parse(opts.due) - Date.now()) / 60000)}분 뒤`);
      },
    )
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
