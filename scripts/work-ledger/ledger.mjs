#!/usr/bin/env node
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
const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const oneLine = (value) =>
  typeof value === "string" && value.trim() !== "" && !/[\r\n]/ .test(value);
export const MAX_HUMAN_DROPS = 2;
export const MAX_HUMAN_DEFERS = 2;
export function hasHumanMsgId(msgId) {
  if (typeof msgId !== "string") return false;
  const trimmed = msgId.trim();
  if (!trimmed || trimmed === "-") return false;
  if (/^(?:none|null|self)(?:[-:]|$)/i.test(trimmed)) return false;
  return true;
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
      !["open", "waiting_human", "escalated_human", "done", "dropped"].includes(item.status) ||
      (item.drop_count !== undefined &&
        (!Number.isInteger(item.drop_count) || item.drop_count < 0)) ||
      (item.defer_count !== undefined &&
        (!Number.isInteger(item.defer_count) || item.defer_count < 0)) ||
      (item.checked_at !== null && !validDate(item.checked_at)) ||
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
    const driveConfig = JSON.parse(await readFile(o.config ? path.resolve(root, o.config) : path.join(root, "config/work-ledger.json"), "utf8"));
    return (await import("./drive.mjs")).tick({ root, config: driveConfig, now: clock(), dry: o.dry === true, env, freeGb });
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
  if (command === "confirm") {
    if (!["done", "dropped"].includes(o.as ?? "dropped")) throw new Error("--as must be done or dropped");
    const target = find(await readLedger(root, role));
    if (!driven(target)) throw new Error("confirm requires an item with an instruction file");
    // The messenger is read before the ledger lock is taken.
    ownerRecord = await drive.verifyOwner({ config, item: target, channel: o.channel, msgId: o["msg-id"], fetchImpl, env, sleep });
  }
  let startedItem;
  let escalationError = null;
  const result = await changeLedger(root, role, async (l) => {
    if (l.report.every_min === 0 && roleConfig?.report) {
      l.report.every_min = roleConfig.report.every_min;
      l.report.channel = roleConfig.report.channel;
    }
    if (command === "add") {
      if (!o.title || !validDate(o.due) || !o.channel || !o["msg-id"])
        throw new Error(
          "add requires --title --due (UTC ISO) --channel --msg-id",
        );
      if (
        hasHumanMsgId(o["msg-id"]) &&
        l.items.some(
          (i) =>
            i.from?.msg_id === o["msg-id"] && i.status === "escalated_human",
        )
      )
        throw new Error(
          `이미 사람에게 올림(escalated_human) 상태인 사람 지시(msg_id=${o["msg-id"]})는 새 카드로 재생성할 수 없습니다`,
        );
      const itemId = safeName(o.id || randomUUID());
      if (l.items.some((i) => i.id === itemId)) throw new Error("Duplicate id");
      if (
        (o["worker-name"] || o.result || o["done-file"]) &&
        !(o["worker-name"] && o.result && o["done-file"])
      )
        throw new Error("Worker requires --worker-name --result --done-file");
      const driveFields = drive ? await drive.register({ root, config, role, ledger: l, opts: o, now: clock() }) : undefined;
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
        ...(driveFields ? { drive: driveFields } : {}),
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
    if (!["done", "drop", "touch", "due", "adopt", "start", "attach", "confirm"].includes(command))
      throw new Error("Commands: add due done drop touch report list adopt start attach confirm drive");
    const item = find(l);
    if (command === "adopt") {
      if (driven(item)) throw new Error("Item already has an instruction file");
      if (item.status !== "open") throw new Error("adopt requires an open item");
      item.drive = await drive.register({ root, config, role, ledger: l, opts: o, now: clock() });
      return item.id;
    }
    if (command === "start") {
      const text = await drive.start({ root, config, role, item, now: clock(), env, freeGb });
      startedItem = item;
      return text;
    }
    if (command === "attach") return drive.attach(item, o.pid, clock());
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
      if (!oneLine(o.result)) throw new Error("done requires --result <file or URL> for an item with an instruction file");
      let address = o.result;
      if (!/^https?:\/\/\S+$/.test(address)) {
        address = path.resolve(root, address);
        const info = await stat(address).catch(() => null);
        if (!info?.isFile() || info.size === 0) throw new Error(`Result file is missing or empty: ${address}`);
      }
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
          .filter((i) => i.from?.msg_id === item.from.msg_id)
          .reduce((sum, i) => sum + itemDeferCount(i), 0);
        if (priorDefers >= MAX_HUMAN_DEFERS) {
          item.status = "escalated_human";
          item.defer_count = (item.defer_count ?? 0) + 1;
          item.checked_at = new Date(clock()).toISOString();
          item.note = `사람에게 올림 (기한 미룸 ${priorDefers + 1}회 거절): ${o.reason.trim()}`;
          escalationError = new Error(
            `사람 지시 카드(${item.id}, msg_id=${item.from.msg_id})는 기한 미룸 ${MAX_HUMAN_DEFERS}회를 넘어 거절되었으며 사람에게 올림(escalated_human) 상태로 전환되었습니다`,
          );
          return item.id;
        }
      }
      item.due = o.due;
      if (isDefer) item.defer_count = (item.defer_count ?? 0) + 1;
    } else if (command === "touch") item.checked_at = new Date().toISOString();
    else if (command === "drop") {
      const currentDrops =
        item.drop_count ?? (item.status === "dropped" ? 1 : 0);
      if (hasHumanMsgId(item.from?.msg_id)) {
        const priorDrops = l.items
          .filter((i) => i.from?.msg_id === item.from.msg_id)
          .reduce((sum, i) => sum + itemDropCount(i), 0);
        if (item.status === "escalated_human" || priorDrops >= MAX_HUMAN_DROPS) {
          item.status = "escalated_human";
          item.drop_count = currentDrops + 1;
          item.checked_at = new Date(clock()).toISOString();
          item.note = `사람에게 올림 (drop ${priorDrops + 1}회 거절): ${o.reason.trim()}`;
          escalationError = new Error(
            `사람 지시 카드(${item.id}, msg_id=${item.from.msg_id})는 drop ${MAX_HUMAN_DROPS}회를 넘어 거절되었으며 사람에게 올림(escalated_human) 상태로 전환되었습니다`,
          );
          return item.id;
        }
      }
      item.status = "dropped";
      item.drop_count = currentDrops + 1;
    } else item.status = "done";
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
