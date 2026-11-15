// Work ledger drive: an overdue ledger item that carries an instruction file
// starts its own worker. The role is only notified, in its own wake box.
// This file holds no ledger of its own: paths, locking, validation and writes
// all come from ledger.mjs.
import { mkdir, open, readFile, readdir, stat, statfs, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  atomicJson,
  closedProperly,
  driven,
  ledgerPath,
  readLedger,
  safeName,
  validateLedger,
  withLock,
} from "./ledger.mjs";
import { createAdapter } from "./messenger.mjs";

const CLOSED = ["done", "dropped"];
const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const oneLine = (value) =>
  typeof value === "string" && value.trim() !== "" && !/[\r\n]/.test(value);
const count = (value, fallback, min, name) => {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < min)
    throw new Error(`Invalid drive.${name}`);
  return value;
};
const argv = (value) =>
  Array.isArray(value) && value.length > 0 && value.every(oneLine);
const iso = (ms) => new Date(ms).toISOString();

const LABELS = {
  launched: "일꾼 띄움",
  "result-ready": "결과 나옴",
  "result-preexisting": "일꾼 없이 결과 파일이 이미 있음",
  reopened: "기록 없이 닫혀 다시 엶",
  "long-run": "일꾼이 오래 돎",
  "attempts-exhausted": "시도 횟수 소진",
  "instruction-missing": "지시서 없음",
  "disk-low": "디스크 부족으로 안 띄움",
  queued: "동시 수 상한으로 대기",
  "launch-failed": "일꾼 띄우기 실패",
};

export function driveConfig(config) {
  const d = config?.drive;
  if (!isObject(d)) throw new Error("Configuration has no drive section");
  const w = d.worker;
  if (!isObject(w) || !argv(w.command))
    throw new Error("drive.worker.command must be a non-empty argument list");
  if (w.models !== undefined && !(Array.isArray(w.models) && w.models.every(oneLine)))
    throw new Error("Invalid drive.worker.models");
  const n = d.notify ?? {};
  if (!isObject(n) || (n.command != null && !argv(n.command)))
    throw new Error("Invalid drive.notify");
  const owners = d.owner_ids ?? [];
  if (!Array.isArray(owners) || !owners.every((id) => typeof id === "string" && /^\d+$/.test(id)))
    throw new Error("Invalid drive.owner_ids");
  return {
    enabled: d.enabled === true,
    command: w.command,
    models: w.models ?? null,
    cwd: w.cwd ?? ".",
    preamble: typeof w.preamble === "string" ? w.preamble : null,
    maxParallel: count(w.max_parallel, 2, 1, "worker.max_parallel"),
    maxAttempts: count(w.max_attempts, 3, 1, "worker.max_attempts"),
    retryMin: count(w.retry_min, 30, 0, "worker.retry_min"),
    maxRunMin: count(w.max_run_min, 240, 1, "worker.max_run_min"),
    diskPath: d.disk?.path ?? "/",
    minFreeGb: count(d.disk?.min_free_gb, 2, 0, "disk.min_free_gb"),
    notifyCommand: n.command ?? null,
    notifyTimeoutMs: count(n.timeout_sec, 30, 1, "notify.timeout_sec") * 1000,
    repeatMin: count(n.repeat_min, 60, 0, "notify.repeat_min"),
    owners,
  };
}
// Each role is notified in its own wake box. There is no shared default:
// a role without one is refused, never routed to another role's box.
export function roleWakeDir(root, config, role) {
  const entry = Array.isArray(config?.roles)
    ? config.roles.find((candidate) => candidate?.role === role)
    : undefined;
  if (!entry) throw new Error(`Role ${role} missing in configuration`);
  if (!oneLine(entry.wake_dir))
    throw new Error(`Role ${role} has no wake_dir in configuration`);
  return path.resolve(root, entry.wake_dir);
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
export const workerAlive = (run) =>
  isObject(run) &&
  run.ended_at === null &&
  processStart(run.pid) !== null &&
  processStart(run.pid) === run.start;

async function hasContent(file) {
  try {
    const info = await stat(file);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}
async function instructionProblem(file) {
  try {
    if (!(await stat(file)).isFile()) return "instruction path is not a regular file";
    if (!(await readFile(file, "utf8")).trim()) return "instruction file is empty";
    return null;
  } catch {
    return "instruction file does not exist";
  }
}
export async function freeGb(dir) {
  const info = await statfs(dir);
  return (Number(info.bavail) * Number(info.bsize)) / 2 ** 30;
}

// Drive fields for add/adopt. An existing result file is refused in both, so
// an old file can never stand in for work that was not done.
export async function register({ root, config, role, ledger, opts, now }) {
  const cfg = driveConfig(config);
  roleWakeDir(root, config, role);
  if (!opts.prompt || !opts["result-file"] || !oneLine(opts.model))
    throw new Error("An instruction requires --prompt --result-file --model");
  if (cfg.models && !cfg.models.includes(opts.model))
    throw new Error(`Model ${opts.model} is not in drive.worker.models`);
  const prompt = path.resolve(root, opts.prompt);
  const resultFile = path.resolve(root, opts["result-file"]);
  const problem = await instructionProblem(prompt);
  if (problem) throw new Error(`Registration refused: ${problem}: ${prompt}`);
  if (resultFile === prompt)
    throw new Error("Result file must differ from the instruction file");
  if (existsSync(resultFile))
    throw new Error(`Result file already exists: ${resultFile}`);
  if (ledger.items.some((item) => driven(item) && !closedProperly(item) && item.drive.result_file === resultFile))
    throw new Error("Result file is already used by another open item");
  return {
    prompt,
    result_file: resultFile,
    model: opts.model,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    registered_at: iso(now),
    run: null,
    closed: null,
    alerts: {},
  };
}

const DEFAULT_PREAMBLE =
  "업무 장부 항목 {id} ({role}): {title}\n결과를 이 파일에 쓴다: {result_file}\n지시서: {prompt}\n고치기 전 지시서·결과에 architecture_fit 세 칸(original_request · parent_structure · acceptance_rationale)을 확인한다(docs/guides/architecture-fit-before-fix.md).\n";
const fill = (template, values) =>
  template.replace(/\{(\w+)\}/g, (all, key) =>
    Object.hasOwn(values, key) ? values[key] : all,
  );

// A failed spawn records no run: it costs no attempt and no retry wait.
async function launch({ root, config, cfg, role, item, now, env }) {
  const d = item.drive;
  const attempt = (d.run?.attempts ?? 0) + 1;
  const dir = path.join(path.dirname(ledgerPath(root, role)), "runs", role, item.id);
  const values = {
    id: item.id,
    role,
    title: item.title,
    model: d.model,
    prompt: d.prompt,
    result_file: d.result_file,
  };
  const [command, ...args] = cfg.command.map((part) => fill(part, values));
  const childEnv = {
    ...env,
    LEDGER_ROLE: role,
    LEDGER_ITEM_ID: item.id,
    LEDGER_RESULT_FILE: d.result_file,
  };
  // The messenger token is for reading owner confirmations; a worker never receives it.
  delete childEnv[config.provider?.token_env || "DISCORD_BOT_TOKEN"];
  let input;
  let output;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(d.result_file), { recursive: true });
    const promptFile = path.join(dir, `${attempt}.prompt.md`);
    const log = path.join(dir, `${attempt}.log`);
    await writeFile(
      promptFile,
      `${fill(cfg.preamble ?? DEFAULT_PREAMBLE, values)}\n${await readFile(d.prompt, "utf8")}`,
      { mode: 0o600 },
    );
    input = await open(promptFile, "r");
    output = await open(log, "a", 0o600);
    const child = spawn(command, args, {
      cwd: path.resolve(root, d.cwd ?? cfg.cwd),
      detached: true,
      stdio: [input.fd, output.fd, output.fd],
      env: childEnv,
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    d.run = {
      pid: child.pid,
      start: processStart(child.pid),
      started_at: iso(now),
      ended_at: null,
      attempts: attempt,
      log,
    };
    delete d.error;
    return null;
  } catch (error) {
    d.error = error.message;
    return error.message;
  } finally {
    await input?.close();
    await output?.close();
  }
}

export async function start({ root, config, role, item, now, env = process.env, freeGb: freeGbImpl = freeGb }) {
  const cfg = driveConfig(config);
  roleWakeDir(root, config, role);
  if (!driven(item) || CLOSED.includes(item.status))
    throw new Error("start requires an open item with an instruction file");
  if (workerAlive(item.drive.run))
    throw new Error(`Worker already running (pid ${item.drive.run.pid})`);
  const problem = await instructionProblem(item.drive.prompt);
  if (problem) throw new Error(`${problem}: ${item.drive.prompt}`);
  const free = await freeGbImpl(cfg.diskPath);
  if (free < cfg.minFreeGb)
    throw new Error(`Free space ${free.toFixed(2)} GB is below ${cfg.minFreeGb} GB`);
  if (item.drive.run && item.drive.run.ended_at === null) item.drive.run.ended_at = iso(now);
  const failure = await launch({ root, config, cfg, role, item, now, env });
  if (failure) throw new Error(`Worker command failed to start: ${failure}`);
  return `${item.id} worker pid ${item.drive.run.pid} (attempt ${item.drive.run.attempts})`;
}
export function attach(item, pidText, now) {
  const pid = Number(pidText);
  const started = processStart(pid);
  if (!driven(item) || CLOSED.includes(item.status))
    throw new Error("attach requires an open item with an instruction file");
  if (started === null) throw new Error("No running process with that pid");
  if (workerAlive(item.drive.run))
    throw new Error(`Worker already running (pid ${item.drive.run.pid})`);
  item.drive.run = {
    pid,
    start: started,
    started_at: iso(now),
    ended_at: null,
    attempts: item.drive.run?.attempts ?? 0,
    log: null,
  };
  return `${item.id} attached pid ${pid}`;
}

// Throws unless the role's wake file was written and, when a notify command is
// configured, that command exited 0 within its time limit.
async function deliver({ root, config, cfg, role, alert, stamp, env }) {
  const dir = roleWakeDir(root, config, role);
  await mkdir(dir, { recursive: true });
  const route = `-route-${role}.md`;
  const filename = (nonce = "") => {
    const normal = `${stamp}-ledger-${alert.id}${nonce}${route}`;
    if (Buffer.byteLength(normal) <= 255) return normal;
    return `${createHash("sha256").update(JSON.stringify([role, alert.id, alert.reason, stamp, nonce])).digest("hex")}${route}`;
  };
  const body = `[장부] ${LABELS[alert.reason]}: ${alert.title.replace(/[\r\n]/g, " ")}\n${alert.detail}\n`;
  // The same notice, still unread in the box, is not written again: a notify
  // command that keeps failing must not pile up one file per pass.
  let unread = false;
  for (const name of await readdir(dir)) {
    if (unread || !name.endsWith(route)) continue;
    unread = (await readFile(path.join(dir, name), "utf8").catch(() => "")) === body;
  }
  if (!unread) {
    try {
      await writeFile(path.join(dir, filename()), body, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await writeFile(path.join(dir, filename(`-${randomUUID().slice(0, 8)}`)), body, { flag: "wx", mode: 0o600 });
    }
  }
  if (!cfg.notifyCommand) return;
  const [command, ...args] = cfg.notifyCommand;
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...env, LEDGER_ROLE: role, LEDGER_ITEM_ID: alert.id, LEDGER_ALERT: alert.reason },
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`notify command timed out after ${cfg.notifyTimeoutMs / 1000}s`));
    }, cfg.notifyTimeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`notify command failed (${signal || code})`));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(body);
  });
}

// One pass over every configured role. Starts workers and notifies; never
// closes an item and never touches an item without an instruction.
// handled lists "<role>/<id>" for each instructed item this pass dealt with
// without an error; the watcher keeps its own overdue wake for every other item.
export async function tick({ root, config, now = Date.now(), dry = false, env = process.env, freeGb: freeGbImpl = freeGb }) {
  const cfg = driveConfig(config);
  const out = { launched: [], alerts: [], errors: [], skipped: [], handled: [] };
  if (!cfg.enabled && !dry) {
    out.skipped.push("drive.enabled is not true");
    return out;
  }
  if (!Array.isArray(config.roles) || !config.roles.length)
    throw new Error("Configuration requires roles");
  const roles = config.roles.map((entry) => safeName(entry?.role));
  const run = async () => {
    const ledgers = new Map();
    let live = 0;
    for (const role of roles) {
      try {
        const ledger = await readLedger(root, role);
        ledgers.set(role, ledger);
        live += ledger.items.filter((item) => driven(item) && !closedProperly(item) && workerAlive(item.drive.run)).length;
      } catch (error) {
        if (error.code === "ENOENT") out.skipped.push(`${role}: no ledger file`);
        else out.errors.push(`${role}: ${error.message}`);
      }
    }
    let free;
    let sequence = 0;
    for (const role of roles) {
      if (!ledgers.has(role) || !ledgers.get(role).items.some((item) => driven(item) && !closedProperly(item))) continue;
      try {
        roleWakeDir(root, config, role);
      } catch (error) {
        out.errors.push(`${role}: ${error.message}; nothing started`);
        continue;
      }
      const file = ledgerPath(root, role);
      const save = (ledger) => atomicJson(file, validateLedger(ledger, role));
      const pending = [];
      let seen = [];
      let failed = false;
      try {
        await withLock(file, async () => {
          const ledger = await readLedger(root, role);
          const before = JSON.stringify(ledger);
          // since: an event time. Such an alert is due until one delivery after it succeeds.
          // Without since the alert repeats after repeat_min from its last successful delivery.
          const alert = (item, reason, detail, since) => {
            const last = Date.parse(item.drive.alerts[reason] ?? "");
            if (since !== undefined ? last >= Date.parse(since) : now - last < cfg.repeatMin * 60000) return;
            pending.push({ id: item.id, reason, title: item.title, detail });
          };
          const active = ledger.items
            .filter((item) => driven(item) && !closedProperly(item))
            .sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
          seen = active.map((item) => item.id);
          for (const item of active) {
            const d = item.drive;
            if (CLOSED.includes(item.status)) {
              d.reopened = { from: item.status, at: iso(now) };
              item.status = "open";
              d.closed = null;
            }
            if (d.reopened)
              alert(item, "reopened", `${d.reopened.from} 로 닫혔으나 결과 주소나 소유자 확인 기록이 없어 다시 열었음.\n닫기: done ${item.id} --result <결과 주소> 또는 confirm ${item.id} --channel <채널> --msg-id <글>`, d.reopened.at);
            if (item.status !== "open") continue;
            if (workerAlive(d.run)) {
              alert(item, "launched", `기한: ${item.due}\n모델: ${d.model}\n일꾼 pid: ${d.run.pid} (${d.run.attempts}번째)\n지시서: ${d.prompt}\n결과: ${d.result_file}\n기록: ${d.run.log ?? "(없음)"}`, d.run.started_at);
              if (now - Date.parse(d.run.started_at) > cfg.maxRunMin * 60000)
                alert(item, "long-run", `일꾼 pid ${d.run.pid} 가 ${d.run.started_at} 부터 돌고 있음.\n기록: ${d.run.log ?? "(없음)"}`);
              continue;
            }
            if (d.run && d.run.ended_at === null) d.run.ended_at = iso(now);
            if (await hasContent(d.result_file)) {
              if (d.run) alert(item, "result-ready", `결과: ${d.result_file}\n읽고 닫기: done ${item.id} --result <결과 주소>`);
              else alert(item, "result-preexisting", `결과: ${d.result_file}\n일꾼을 띄운 적이 없는데 결과 파일에 내용이 있어 띄우지 않음. 맞는 결과면 done ${item.id} --result <결과 주소>, 아니면 파일을 치움.`);
              continue;
            }
            if (Date.parse(item.due) >= now) continue;
            const attempts = d.run?.attempts ?? 0;
            if (attempts >= cfg.maxAttempts) {
              alert(item, "attempts-exhausted", `${attempts}번 띄웠으나 결과가 없음.\n마지막 기록: ${d.run.log ?? "(없음)"}\n지시서나 환경을 고친 뒤: start ${item.id}`);
              continue;
            }
            if (d.run && now - Date.parse(d.run.started_at) < cfg.retryMin * 60000) continue;
            const problem = await instructionProblem(d.prompt);
            if (problem) {
              alert(item, "instruction-missing", `${problem}: ${d.prompt}`);
              continue;
            }
            free ??= await freeGbImpl(cfg.diskPath);
            if (free < cfg.minFreeGb) {
              alert(item, "disk-low", `${cfg.diskPath} 여유 ${free.toFixed(2)} GB 가 문턱 ${cfg.minFreeGb} GB 아래라 띄우지 않음.`);
              continue;
            }
            if (live >= cfg.maxParallel) {
              alert(item, "queued", `기한: ${item.due}\n일꾼 ${live}개가 도는 중(상한 ${cfg.maxParallel}). 하나가 끝나면 띄움.`);
              continue;
            }
            if (dry) {
              out.launched.push({ role, id: item.id, dry: true });
              live++;
              continue;
            }
            const failure = await launch({ root, config, cfg, role, item, now, env });
            if (failure) {
              alert(item, "launch-failed", `일꾼 명령을 띄우지 못함: ${failure}\n다음 순회에 다시 시도함.`);
              continue;
            }
            // Record the run before anything else can fail; an unrecorded worker would be started twice.
            try {
              await save(ledger);
            } catch (error) {
              try { process.kill(-d.run.pid, "SIGKILL"); } catch { /* already gone */ }
              throw error;
            }
            live++;
            out.launched.push({ role, id: item.id, pid: d.run.pid, attempt: d.run.attempts });
            alert(item, "launched", `기한: ${item.due}\n모델: ${d.model}\n일꾼 pid: ${d.run.pid} (${d.run.attempts}번째)\n지시서: ${d.prompt}\n결과: ${d.result_file}\n기록: ${d.run.log}`, d.run.started_at);
          }
          if (!dry && JSON.stringify(ledger) !== before) await save(ledger);
        });
      } catch (error) {
        failed = true;
        out.errors.push(`${role}: ${error.message}`);
      }
      // Deliver outside the ledger lock; record the cooldown only for delivered alerts.
      const delivered = [];
      const undelivered = new Set();
      for (const entry of pending) {
        let ok = dry ? undefined : true;
        if (!dry) {
          try {
            await deliver({ root, config, cfg, role, alert: entry, stamp: iso(now + sequence++).replace(/\D/g, ""), env });
            delivered.push(entry);
          } catch (error) {
            ok = false;
            undelivered.add(entry.id);
            out.errors.push(`${role}: notify ${entry.id} ${entry.reason}: ${error.message}`);
          }
        }
        out.alerts.push({ role, id: entry.id, reason: entry.reason, ...(ok === undefined ? {} : { delivered: ok }) });
      }
      if (delivered.length) {
        try {
          await withLock(file, async () => {
            const ledger = await readLedger(root, role);
            for (const entry of delivered) {
              const item = ledger.items.find((candidate) => candidate.id === entry.id);
              if (item && driven(item)) item.drive.alerts[entry.reason] = iso(now);
            }
            await save(ledger);
          });
        } catch (error) {
          failed = true;
          out.errors.push(`${role}: ${error.message}`);
        }
      }
      if (!dry && !failed)
        out.handled.push(...seen.filter((id) => !undelivered.has(id)).map((id) => `${role}/${id}`));
    }
    return out;
  };
  return dry
    ? run()
    : withLock(path.join(path.dirname(ledgerPath(root, roles[0])), "drive"), run);
}

// Owner confirmation = a message written by a configured owner that names the
// item (first 8 characters of its id), directly or as a reply to a message that names it.
export async function verifyOwner({ config, item, channel, msgId, fetchImpl, env, sleep }) {
  const cfg = driveConfig(config);
  if (!cfg.owners.length) throw new Error("drive.owner_ids is not configured");
  if (!/^\d+$/.test(channel ?? "") || !/^\d+$/.test(msgId ?? ""))
    throw new Error("confirm requires numeric --channel and --msg-id");
  const adapter = createAdapter(config.provider, {
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(env ? { env } : {}),
    ...(sleep ? { sleep } : {}),
  });
  const message = await adapter.message(channel, msgId);
  if (message?.id !== msgId || !cfg.owners.includes(message.author?.id))
    throw new Error("Message was not written by a configured owner");
  const key = item.id.slice(0, 8);
  let named = typeof message.content === "string" && message.content.includes(key);
  if (!named && message.message_reference?.message_id) {
    const parent =
      message.referenced_message ??
      (await adapter.message(message.message_reference.channel_id ?? channel, message.message_reference.message_id));
    named = typeof parent?.content === "string" && parent.content.includes(key);
  }
  if (!named)
    throw new Error(`Owner message does not name item ${key} (in its text or in the message it replies to)`);
  return { channel, msg_id: msgId, author: message.author.id };
}
