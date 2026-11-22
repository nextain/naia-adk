#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { assertLedgerOwner } from "../lib/work-ledger-owner.mjs";
import { configuredHumans, createAdapter, verifyCardReply } from "./messenger.mjs";
export function safeName(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value))
    throw new Error("Invalid role or item id");
  return value;
}
export function ledgerPath(root, role) {
  return path.join(root, ".agents/work/ledger", `${safeName(role)}.json`);
}
export function resolveConfigPath(root, configPath) {
  return configPath
    ? path.resolve(root, configPath)
    : path.join(root, "config/work-ledger.json");
}
export async function loadLedgerConfig({
  root,
  configPath,
  role,
  requireConfig = false,
  requireRole = Boolean(role),
} = {}) {
  const configFile = resolveConfigPath(root, configPath);
  let config = {};
  let loaded = false;
  try {
    config = JSON.parse(await readFile(configFile, "utf8"));
    loaded = true;
  } catch (error) {
    if (error.code !== "ENOENT" || configPath || requireConfig) throw error;
  }
  let roleConfig;
  if (loaded && role !== undefined) {
    roleConfig = config.roles?.find((entry) => entry.role === role);
    if (requireRole && !roleConfig) throw new Error("Role missing in configuration");
  }
  return { configFile, config, roleConfig, loaded };
}
export function runtimeEnv(env = process.env) {
  return {
    ...env,
    XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? ""}`,
  };
}
// The runner receives an argv array, never shell text. Tests inject a fake.
export function systemRunner(command, args, options = {}) {
  if (process.env.NODE_TEST_CONTEXT || process.env.ADK_FORBID_SYSTEM_RUNNER === "1")
    throw new Error("System runner forbidden in tests; inject a runner");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `${command} exited ${code}`)),
    );
  });
}
// Process identity = pid + kernel start time, so a reused pid is not mistaken for the worker.
export function processStart(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!existsSync("/proc/self/stat")) {
    try {
      process.kill(pid, 0);
      return "unknown";
    } catch {
      return null;
    }
  }
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    return fields[0] === "Z" ? null : fields[19];
  } catch {
    return null;
  }
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
      "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ pid: Number(process.argv[2]), helperPid: process.pid, started: Date.now() }) + '\\n'); process.stdout.write('locked\\n'); process.stdin.resume();",
      `${file}.lock`,
      String(process.pid),
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
export const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const oneLine = (value) =>
  typeof value === "string" && value.trim() !== "" && !/[\r\n]/.test(value);
async function resultAddress(root, value) {
  if (!oneLine(value)) throw new Error("done requires --result <file or URL>");
  if (/^https?:\/\//i.test(value)) {
    if (/[\s\\]/.test(value) || !URL.canParse(value)) throw new Error("Invalid HTTP(S) result URL");
    return value;
  }
  const address = path.resolve(root, value);
  const info = await stat(address).catch(() => null);
  if (!info?.isFile() || info.size === 0) throw new Error(`Result file is missing or empty: ${address}`);
  return address;
}
export const isWorkerItem = (item) => item?.kind === "worker";
export function validUnitName(value) {
  return (
    oneLine(value) &&
    Buffer.byteLength(value) <= 255 &&
    /^[a-zA-Z0-9][a-zA-Z0-9:_.@-]*\.(?:service|scope)$/.test(value)
  );
}
export function validToolName(value) {
  return oneLine(value) && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value);
}
export const MAX_HUMAN_DROPS = 2;
export const MAX_HUMAN_DEFERS = 2;
export function normalizeMsgId(msgId) {
  return typeof msgId === "string" ? msgId.trim() : "";
}
export function hasHumanMsgId(msgId) {
  const trimmed = normalizeMsgId(msgId);
  if (!trimmed || trimmed === "-") return false;
  if (/^(?:none|null|self)(?:[-:]|$)/i.test(trimmed)) return false;
  return true;
}
function sameHumanMsgId(a, b) {
  return hasHumanMsgId(a) && hasHumanMsgId(b) && normalizeMsgId(a) === normalizeMsgId(b);
}
export function matchesSource(source, channel, msgId) {
  return source?.channel === channel && sameHumanMsgId(source?.msg_id, msgId);
}
export function taskForSource(items, channel, msgId) {
  return items.find(item => !isWorkerItem(item) && (matchesSource(item.from, channel, msgId) ||
    item.intake_messages?.some(message => matchesSource(message, channel, msgId))));
}
export function intakeSettings(config, roleConfig) {
  return { ...config.intake, ...config.defaults?.intake, ...roleConfig?.intake };
}
function itemDropCount(item) {
  if (Number.isInteger(item?.drop_count) && item.drop_count > 0)
    return item.drop_count;
  return item?.status === "dropped" ? 1 : 0;
}
function itemDeferCount(item) {
  return Number.isInteger(item?.defer_count) && item.defer_count > 0
    ? item.defer_count
    : 0;
}
// An item with an instruction file ("drive") is worked by a worker the ledger
// starts itself (drive.mjs). The field is optional and additive: items without
// it behave exactly as before, and older readers ignore it.
export const driven = (item) => item.drive !== undefined;
// Such an item counts as closed only with its record: a result address, or a
// verified owner message. Anything else is reopened by the next drive pass.
export const closedProperly = (item) =>
  ["done", "dropped"].includes(item.status) &&
  isObject(item.drive?.closed) &&
  ((item.drive.closed.by === "result" &&
    item.status === "done" &&
    oneLine(item.drive.closed.result)) ||
    (item.drive.closed.by === "owner" &&
      oneLine(item.drive.closed.msg_id) &&
      oneLine(item.drive.closed.author)));
function validDrive(drive) {
  return (
    isObject(drive) &&
    oneLine(drive.prompt) &&
    oneLine(drive.result_file) &&
    oneLine(drive.model) &&
    (drive.cwd === undefined || oneLine(drive.cwd)) &&
    (drive.run === null ||
      (isObject(drive.run) &&
        Number.isInteger(drive.run.attempts) &&
        drive.run.attempts >= 0 &&
        validDate(drive.run.started_at) &&
        (drive.run.ended_at === null || validDate(drive.run.ended_at)))) &&
    (drive.closed === null || isObject(drive.closed)) &&
    isObject(drive.alerts) &&
    Object.values(drive.alerts).every(validDate)
  );
}
function validWorkerItem(item, role) {
  if (
    item.kind !== "worker" ||
    item.role !== role ||
    (item.name !== undefined && !oneLine(item.name)) ||
    (item.parent !== null &&
      (item.parent === item.id ||
        typeof item.parent !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(item.parent))) ||
    (item.unit !== null && !validUnitName(item.unit)) ||
    !validToolName(item.tool) ||
    !["running", "done", "failed"].includes(item.status) ||
    !validDate(item.started) ||
    (item.status === "running" ? item.ended !== null : !validDate(item.ended)) ||
    (item.result !== null && !oneLine(item.result)) ||
    (item.status === "running"
      ? item.exit !== null
      : item.exit !== null && !Number.isInteger(item.exit)) ||
    (item.pid !== undefined && item.pid !== null && (!Number.isInteger(item.pid) || item.pid <= 0)) ||
    (item.start_token !== undefined && item.start_token !== null && !oneLine(item.start_token)) ||
    (item.log !== undefined && item.log !== null && !oneLine(item.log)) ||
    (item.cwd !== undefined && item.cwd !== null && !oneLine(item.cwd)) ||
    (item.reason !== undefined && item.reason !== null && !oneLine(item.reason)) ||
    (item.launch_pending !== undefined && typeof item.launch_pending !== "boolean") ||
    (item.initial_result !== undefined &&
      item.initial_result !== null &&
      (!isObject(item.initial_result) ||
        !Number.isInteger(item.initial_result.size) ||
        item.initial_result.size < 0 ||
        typeof item.initial_result.mtime_ns !== "string")) ||
    item.worker !== null ||
    item.drive !== undefined
  )
    return false;
  return true;
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
    if (item.group !== undefined) safeName(item.group);
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
      (item.checked_at !== null && !validDate(item.checked_at))
    )
      throw new Error("Invalid ledger item");
    if (isWorkerItem(item)) {
      if (!validWorkerItem(item, role)) throw new Error("Invalid ledger item");
    } else if (
      (item.kind !== undefined && item.kind !== "task") ||
      !["open", "waiting_human", "escalated_human", "done", "dropped"].includes(item.status) ||
      (item.drop_count !== undefined &&
        (!Number.isInteger(item.drop_count) || item.drop_count < 0)) ||
      (item.defer_count !== undefined &&
        (!Number.isInteger(item.defer_count) || item.defer_count < 0)) ||
      (item.human_msg_id !== undefined && !oneLine(item.human_msg_id)) ||
      (item.intake_messages !== undefined && (!Array.isArray(item.intake_messages) ||
        !item.intake_messages.every(e => oneLine(e?.channel) && oneLine(e.msg_id) && validDate(e.at) &&
          (e.pending === undefined || (oneLine(e.pending?.title) && validDate(e.pending.due)))))) ||
      (item.worker !== null &&
        (!item.worker ||
          typeof item.worker.done_file !== "string" ||
          typeof item.worker.name !== "string" ||
          typeof item.worker.result !== "string")) ||
      (driven(item) && !validDrive(item.drive))
    )
      throw new Error("Invalid ledger item");
    ids.add(item.id);
  }
  if (ledger.report.last_at !== null && !validDate(ledger.report.last_at))
    throw new Error("Invalid report date");
  return ledger;
}
function parseLedger(text, role) {
  return validateLedger(JSON.parse(text), role);
}
export async function readLedger(root, role) {
  return parseLedger(await readFile(ledgerPath(root, role), "utf8"), role);
}
export function readLedgerFileSync(file, role) {
  return parseLedger(readFileSync(file, "utf8"), role);
}

export function wakeHeader(items, { channel, msgId, cardId } = {}, nowMs) {
  const sourceKey = (item) => hasHumanMsgId(item.from?.msg_id)
    ? JSON.stringify([item.from.channel, normalizeMsgId(item.from.msg_id)])
    : item.id;
  const lastUpdate = (item) => [item.updated_at, item.checked_at, item.created_at, item.due]
    .map((date) => Date.parse(date)).find(Number.isFinite);
  const byId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const recent = items.filter((item) => !isWorkerItem(item))
    .sort((a, b) => lastUpdate(b) - lastUpdate(a) || byId(a, b));
  const matched = recent.find(item => cardId && item.id === cardId) ??
    (channel ? taskForSource(recent, channel, msgId) : recent.find(item => sameHumanMsgId(item.from?.msg_id, msgId)));
  const latest = recent.find((item) => item.status === "open");
  const seen = new Set();
  const selected = [matched, latest].filter((item) => {
    if (!item || seen.has(sourceKey(item))) return false;
    seen.add(sourceKey(item));
    return true;
  });
  const overdue = recent.filter((item) =>
    ["open", "waiting_human"].includes(item.status) && Date.parse(item.due) < nowMs)
    .sort((a, b) => Date.parse(a.due) - Date.parse(b.due) || byId(a, b))
    .filter((item) => {
      const key = sourceKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const lines = [...selected, ...overdue.slice(0, 3)].map((item) => {
    const title = [...item.title.replace(/\s+/g, " ").trim()].slice(0, 80).join("");
    return `- ${item.id.slice(0, 8)} | ${item.status} | ${title} | ${item.due}`;
  });
  if (overdue.length > 3) lines.push(`외 ${overdue.length - 3}건`);
  if (!lines.length) lines.push("열린 업무 없음 — 이 글이 업무면 장부에 올릴 것");
  return ["[내 장부 먼저]", ...lines].join("\n");
}
export async function changeLedger(root, role, update) {
  await assertLedgerOwner(root);
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
    if (args[i] === "--dry") opts.dry = true;
    else if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      if (!args[i + 1] || args[i + 1].startsWith("--"))
        throw new Error(`Missing --${key} value`);
      opts[key] = args[++i];
    } else positional.push(args[i]);
  }
  return { opts, positional };
}
export async function main(args = process.argv.slice(2), { runner, now, clock = now === undefined ? Date.now : () => now, warn = console.warn, fetchImpl, env = process.env, sleep, freeGb } = {}) {
  const {
    opts: o,
    positional: [command, id],
  } = parseArgs(args);
  const root = path.resolve(o.root || process.cwd());
  if (command === "drive") {
    // One pass over every configured role: start workers for overdue items that carry an instruction.
    const { config: driveConfig, configFile } = await loadLedgerConfig({
      root,
      configPath: o.config,
      requireConfig: true,
      requireRole: false,
    });
    return (await import("./drive.mjs")).tick({ root, config: driveConfig, configPath: configFile, now: clock(), dry: o.dry === true, env, freeGb });
  }
  const role = safeName(o.role);
  if (command === "list") {
    const l = await readLedger(root, role);
    return (
      l.items
        .map((i) => `${i.id} [${i.status}] ${i.due} ${i.title}`)
        .join("\n") || "(빈 장부)"
    );
  }
  const { configFile, config, roleConfig } = await loadLedgerConfig({
    root,
    configPath: o.config,
    role,
  });
  const instructed = Boolean(o.prompt || o["result-file"] || o.model);
  const drive =
    ["adopt", "start", "attach", "confirm"].includes(command) || (command === "add" && instructed)
      ? await import("./drive.mjs")
      : null;
  const find = (l) => {
    const item = l.items.find((i) => i.id === (id || o.id));
    if (!item) throw new Error("Unknown item");
    return item;
  };
  const close = (item, status, record) => {
    if (closedProperly(item)) throw new Error("Item is already closed");
    const at = new Date(clock()).toISOString();
    item.status = status;
    item.drive.closed = { ...record, at };
    item.checked_at = at;
  };
  let ownerRecord;
  const humanAck = normalizeMsgId(o["human-msg-id"]);
  let humanResult;
  if (command === "confirm") {
    if (!["done", "dropped"].includes(o.as ?? "dropped")) throw new Error("--as must be done or dropped");
    const target = find(await readLedger(root, role));
    if (!driven(target)) throw new Error("confirm requires an item with an instruction file");
    // The messenger is read before the ledger lock is taken.
    ownerRecord = await drive.verifyOwner({ config, item: target, channel: o.channel, msgId: o["msg-id"], fetchImpl, env, sleep });
  } else if (command === "done" && o["human-msg-id"] !== undefined) {
    const target = find(await readLedger(root, role));
    if (!isWorkerItem(target) && !driven(target) && target.status !== "done") {
      if (!hasHumanMsgId(humanAck) || sameHumanMsgId(humanAck, target.from.msg_id))
        throw new Error("--human-msg-id에는 원 지시와 다른 사람 확인 답글 번호가 필요합니다");
      const authors = configuredHumans(config, roleConfig);
      if (!Array.isArray(authors) || !authors.length) throw new Error("No configured humans for this role's --human-msg-id");
      const channel = o.channel ?? target.from.channel;
      const adapter = createAdapter(config.provider, { fetchImpl, env, sleep });
      const message = await verifyCardReply({ adapter, authors, item: target, channel, msgId: humanAck, ordinary: true });
      const direct = (roleConfig?.direct_channels ?? config.defaults?.direct_channels ?? config.direct_channels ?? []).includes(channel);
      const guildId = message.guild_id || roleConfig?.guild_id || config.defaults?.guild_id || config.guild_id;
      humanResult = adapter.messageUrl(channel, humanAck, { direct, guildId }) ?? `${channel}/${humanAck}`;
    }
  }
  let startedItem;
  let escalationError = null;
  const result = await changeLedger(root, role, async (l) => {
    if (l.report.every_min === 0 && roleConfig?.report) {
      l.report.every_min = roleConfig.report.every_min;
      l.report.channel = roleConfig.report.channel;
    }
    if (command === "add") {
      const normalizedMsgId = normalizeMsgId(o["msg-id"]);
      if (!o.title || !validDate(o.due) || !o.channel || !normalizedMsgId)
        throw new Error(
          "add requires --title --due (UTC ISO) --channel --msg-id",
        );
      const received = taskForSource(l.items, o.channel, normalizedMsgId);
      if (received && (received.intake_messages || intakeSettings(config, roleConfig).enabled === true)) {
        if (instructed || o["worker-name"] || o["done-file"] || o.result || o["worker-step"] ||
            (o.id && o.id !== received.id)) {
          throw new Error(`Source already belongs to card ${received.id}. Use that card ID; use adopt to attach instructions.`);
        }
        return received.id;
      }
      if (hasHumanMsgId(normalizedMsgId)) {
        const sameMsgItems = l.items.filter((i) =>
          !isWorkerItem(i) && sameHumanMsgId(i.from?.msg_id, normalizedMsgId),
        );
        const totalDrops = sameMsgItems.reduce((sum, i) => sum + itemDropCount(i), 0);
        const totalDefers = sameMsgItems.reduce((sum, i) => sum + itemDeferCount(i), 0);
        if (
          sameMsgItems.some((i) => i.status === "escalated_human" || Boolean(i.human_msg_id)) ||
          totalDrops > MAX_HUMAN_DROPS ||
          totalDefers > MAX_HUMAN_DEFERS
        ) {
          throw new Error(
            `이미 사람에게 올림(escalated_human) 상태인 사람 지시이거나 취소·연기 상한을 넘긴 지시(msg_id=${normalizedMsgId})는 새 카드로 재생성할 수 없습니다`,
          );
        }
      }
      const itemId = safeName(o.id || randomUUID());
      if (l.items.some((i) => i.id === itemId)) throw new Error("Duplicate id");
      const workerStep = o["worker-step"] === undefined ? undefined : safeName(o["worker-step"]);
      if (workerStep === "review") throw new Error("Use worker-run --review-of to review a completed producer");
      if (
        (o["worker-name"] || o.result || o["done-file"]) &&
        !(o["worker-name"] && o.result && o["done-file"])
      )
        throw new Error("Worker requires --worker-name --result --done-file");
      const card = {
        id: itemId,
        ...(roleConfig?.handoff ? { group: safeName(roleConfig.handoff.group) } : {}),
        title: o.title,
        from: { channel: o.channel, msg_id: normalizedMsgId, quote: o.quote || "" },
        ...(workerStep ? { worker_step: workerStep } : {}),
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
      };
      if (drive) card.drive = await drive.register({ root, config, role, ledger: l, opts: o, now: clock(), card });
      l.items.push(card);
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
    if (!["done", "drop", "touch", "due", "adopt", "start", "attach", "confirm"].includes(command))
      throw new Error("Commands: add due done drop touch report list adopt start attach confirm drive");
    const item = find(l);
    if (isWorkerItem(item) && command !== "touch")
      throw new Error(`Worker run item (${item.id}) is managed by worker-run.mjs`);
    if (command === "adopt") {
      if (driven(item)) throw new Error("Item already has an instruction file");
      if (item.status !== "open") throw new Error("adopt requires an open item");
      if (o["worker-step"] !== undefined && o["worker-step"] !== item.worker_step) throw new Error("The work step is set on the original card");
      item.drive = await drive.register({ root, config, role, ledger: l, opts: o, now: clock(), card: item });
      return item.id;
    }
    if (command === "start") {
      const text = await drive.start({ root, config, configPath: configFile, role, item, ledger: l, now: clock(), env, freeGb });
      startedItem = item;
      return text;
    }
    if (command === "attach") return drive.attach(item, o.pid, clock(), { root, config, role });
    if (command === "confirm") {
      if (!driven(item)) throw new Error("confirm requires an item with an instruction file");
      close(item, o.as ?? "dropped", { by: "owner", ...ownerRecord });
      if (o.reason) item.note = o.reason;
      return item.id;
    }
    // An item with an instruction closes only on a result address or an owner confirmation.
    if (driven(item) && command === "drop")
      throw new Error("drop is not available for an item with an instruction file. Close with: done <id> --result <file or URL>, or confirm <id> --channel <id> --msg-id <id> (owner confirmation)");
    if (driven(item) && command === "done") {
      if ((item.drive.profiled || item.drive.run?.profile) && !(await import("./drive.mjs")).verifiedDriveResult(item, l)) {
        throw new Error("A scheduled worker requires its successful terminal receipt");
      }
      const address = await resultAddress(root, o.result);
      close(item, "done", { by: "result", result: address });
      if (o.reason) item.note = o.reason;
      return item.id;
    }
    // Its due time is what starts the worker, so a command cannot push it away.
    if (driven(item) && command === "due")
      throw new Error("due is not available for an item with an instruction file. Close it (done --result or confirm) and register the new due time as a new item");
    if (command === "drop" && !o.reason?.trim())
      throw new Error("drop requires --reason");
    if (command === "due") {
      if (!o.reason?.trim() || !validDate(o.due))
        throw new Error("due requires --reason and --due (UTC ISO)");
      if (item.status === "escalated_human")
        throw new Error(
          `사람에게 올림(escalated_human) 상태인 카드(${item.id})는 기한을 미룰 수 없습니다`,
        );
      if (item.status !== "open") throw new Error("due requires an open item");
      const isDefer = Date.parse(o.due) >= Date.parse(item.due);
      if (isDefer && hasHumanMsgId(item.from?.msg_id)) {
        const priorDefers = l.items
          .filter((i) => sameHumanMsgId(i.from?.msg_id, item.from.msg_id))
          .reduce((sum, i) => sum + itemDeferCount(i), 0);
        if (priorDefers >= MAX_HUMAN_DEFERS) {
          item.status = "escalated_human";
          item.defer_count = (item.defer_count ?? 0) + 1;
          item.checked_at = new Date(clock()).toISOString();
          item.note = `사람에게 올림 (기한 미룸 ${priorDefers + 1}회 거절): ${o.reason.trim()}`;
          escalationError = new Error(
            `사람 지시 카드(${item.id}, msg_id=${normalizeMsgId(item.from.msg_id)})는 기한 미룸 ${MAX_HUMAN_DEFERS}회를 넘어 거절되었으며 사람에게 올림(escalated_human) 상태로 전환되었습니다`,
          );
          return item.id;
        }
      }
      item.due = o.due;
      if (item.due_assumed === true) delete item.due_assumed;
      if (isDefer) item.defer_count = (item.defer_count ?? 0) + 1;
    } else if (command === "touch") item.checked_at = new Date().toISOString();
    else if (command === "drop") {
      const currentDrops =
        item.drop_count ?? (item.status === "dropped" ? 1 : 0);
      if (hasHumanMsgId(item.from?.msg_id)) {
        const priorDrops = l.items
          .filter((i) => sameHumanMsgId(i.from?.msg_id, item.from.msg_id))
          .reduce((sum, i) => sum + itemDropCount(i), 0);
        if (item.status === "escalated_human" || priorDrops >= MAX_HUMAN_DROPS) {
          item.status = "escalated_human";
          item.drop_count = currentDrops + 1;
          item.checked_at = new Date(clock()).toISOString();
          item.note = `사람에게 올림 (drop ${priorDrops + 1}회 거절): ${o.reason.trim()}`;
          escalationError = new Error(
            `사람 지시 카드(${item.id}, msg_id=${normalizeMsgId(item.from.msg_id)})는 drop ${MAX_HUMAN_DROPS}회를 넘어 거절되었으며 사람에게 올림(escalated_human) 상태로 전환되었습니다`,
          );
          return item.id;
        }
      }
      item.status = "dropped";
      item.drop_count = currentDrops + 1;
    } else {
      if (item.status === "done") {
        if ((o.result !== undefined && item.result !== o.result && item.result !== path.resolve(root, o.result)) ||
            (o["human-msg-id"] !== undefined && item.human_msg_id !== humanAck))
          throw new Error("Item is already closed with different evidence");
        return item.id;
      }
      if (item.status === "escalated_human" && !humanResult)
        throw new Error(`사람에게 올림(escalated_human) 상태인 카드(${item.id})를 닫으려면 --human-msg-id <확인 답글 ID>가 필요합니다`);
      if (o.result === undefined && !humanResult)
        throw new Error("done requires --result <file or URL> or --human-msg-id <confirmation ID>");
      item.result = o.result === undefined ? humanResult : await resultAddress(root, o.result);
      if (humanResult) item.human_msg_id = humanAck;
      else delete item.human_msg_id;
      if (item.status === "dropped" && item.drop_count === undefined) {
        item.drop_count = 1;
      }
      item.status = "done";
      item.completed_at = new Date(clock()).toISOString();
      item.checked_at = item.completed_at;
    }
    if (o.reason) item.note = o.reason;
    return item.id;
  }).catch((error) => {
    // A worker whose run could not be recorded would be started a second time.
    if (startedItem) try { process.kill(-startedItem.drive.run.pid, "SIGKILL"); } catch { /* already gone */ }
    throw error;
  });
  if (["add", "due", "done", "drop", "confirm"].includes(command) && config.due_timer?.enabled === true) {
    try {
      const { reconcileCurrent } = await import("./due-timer.mjs");
      const warnings = await reconcileCurrent({ root, config, roles: [role], clock, runner, configPath: o.config ? configFile : undefined });
      for (const warning of warnings) warn(`timer: 못 걺 (${warning})`);
    } catch (error) { warn(`timer: 못 걺 (${error.message})`); }
  }
  if (escalationError) throw escalationError;
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
        if (positional[0] === "drive" && value.errors.length) process.exitCode = 1;
        if (positional[0] === "add" && validDate(opts.due))
          console.log(`지금부터 ${Math.round((Date.parse(opts.due) - Date.now()) / 60000)}분 뒤`);
      },
    )
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
