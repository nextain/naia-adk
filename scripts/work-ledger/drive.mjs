// Work ledger drive: an overdue ledger item that carries an instruction file
// starts its own worker. The role is only notified, in its own wake box.
// This file holds no ledger of its own: paths, locking, validation and writes
// all come from ledger.mjs.
import { mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  atomicJson,
  closedProperly,
  driven,
  isWorkerItem,
  ledgerPath,
  processStart,
  readLedger,
  safeName,
  validateLedger,
  withLock,
} from "./ledger.mjs";
export { processStart };
import { resolveWorkerStep, workerProfilePath } from "./worker-profile.mjs";
import { createAdapter, verifyCardCancellation, verifyCardReply } from "./messenger.mjs";
import { measureMinFreeGb } from "../lib/disk-free.mjs";
import { assertLedgerOwner } from "../lib/work-ledger-owner.mjs";
import { publishScheduledCompletion } from "./completion-wake.mjs";
import { previousScheduledRegistration, registerWorker } from "../work-watch.mjs";

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
  "worker-unavailable": "프로파일에 지정한 후보 대기",
};

export function driveConfig(config) {
  const d = config?.drive;
  if (!isObject(d)) throw new Error("Configuration has no drive section");
  const w = d.worker;
  if (!isObject(w) || (w.command !== undefined && !argv(w.command)))
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

export const workerAlive = (run) =>
  isObject(run) &&
  run.ended_at === null &&
  processStart(run.pid) !== null &&
  processStart(run.pid) === run.start;

function trackedWorker(ledger, item) {
  const run = item.drive?.run;
  if (!run?.worker_id) return null;
  const worker = ledger?.items.find(row => row.id === run.worker_id);
  if (worker && (!isWorkerItem(worker) || worker.parent !== item.id || worker.result !== item.drive.result_file)) {
    throw new Error(`Scheduled worker ${run.worker_id} does not belong to this card and result`);
  }
  return worker;
}

function driveWorkerAlive(item, ledger) {
  if (workerAlive(item.drive.run)) return true;
  const worker = trackedWorker(ledger, item);
  return worker?.status === "running" && worker.start_token && processStart(worker.pid) === worker.start_token;
}

export function verifiedDriveResult(item, ledger) {
  if (!item.drive?.run?.worker_id) return !(item.drive?.profiled || item.drive?.run?.profile);
  const worker = trackedWorker(ledger, item);
  return Boolean(worker?.profile_started_at && worker.status === "done" && worker.exit === 0);
}

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
  return measureMinFreeGb([dir]);
}

// Drive fields for add/adopt. An existing result file is refused in both, so
// an old file can never stand in for work that was not done.
export async function register({ root, config, role, ledger, opts, now, card, workerStep = card?.worker_step }) {
  const cfg = driveConfig(config);
  roleWakeDir(root, config, role);
  const profileFile = workerProfilePath(root, config, role);
  if (!oneLine(opts.prompt) || !oneLine(opts["result-file"]) || (!profileFile && !oneLine(opts.model)))
    throw new Error("An instruction requires --prompt --result-file --model (the profile supplies the model when configured)");
  const prompt = path.resolve(root, opts.prompt);
  const resultFile = path.resolve(root, opts["result-file"]);
  let model = opts.model;
  if (profileFile) {
    if (workerStep === "review") throw new Error("Use worker-run --review-of to review a completed producer");
    const { binding } = resolveWorkerStep(profileFile, workerStep ?? "implementation", {
      workDir: path.resolve(root, opts.cwd ?? cfg.cwd), prompt, result: resultFile, role, card,
    });
    if (model !== undefined && model !== binding.model) throw new Error("Model differs from the role profile");
    model = binding.model;
  } else {
    if (!cfg.command) throw new Error("drive.worker.command is required without a tier profile");
    if (cfg.models && !cfg.models.includes(model)) throw new Error(`Model ${model} is not in drive.worker.models`);
  }
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
    model,
    ...(profileFile ? { profiled: true } : {}),
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

function launchPlan(root, config, cfg, role, item, configPath) {
  const d = item.drive;
  const attempt = (d.run?.attempts ?? 0) + 1;
  const dir = path.join(path.dirname(ledgerPath(root, role)), "runs", role, item.id);
  const promptFile = path.join(dir, `${attempt}.prompt.md`);
  const workDir = path.resolve(root, d.cwd ?? cfg.cwd);
  const profileFile = workerProfilePath(root, config, role);
  const step = item.worker_step ?? "implementation";
  if (profileFile && step === "review") throw new Error("Review requires a completed profiled producer on the same card");
  if (!profileFile && (d.profiled || !cfg.command)) throw new Error("Configured worker profile is missing");
  const selection = profileFile && resolveWorkerStep(profileFile, step, { workDir, prompt: promptFile, result: d.result_file, role, card: item });
  const model = selection ? selection.binding.model : d.model;
  const values = { id: item.id, role, title: item.title, model, prompt: d.prompt, result_file: d.result_file };
  if (!selection) return { attempt, dir, promptFile, workDir, values, command: cfg.command.map(part => fill(part, values)) };
  const key = createHash("sha256").update(JSON.stringify([role, item.id, d.registered_at])).digest("hex").slice(0, 24);
  const workerId = `scheduled-${key}-${attempt}`;
  const launcher = fileURLToPath(new URL("./worker-run.mjs", import.meta.url));
  const command = [process.execPath, launcher, "start", "--foreground", "--root", root, "--role", role,
    "--id", workerId, "--name", workerId, "--parent", item.id, "--cwd", workDir, "--prompt", promptFile,
    "--result", d.result_file, "--expected-profile", selection.binding.profile_sha256,
    ...(configPath ? ["--config", configPath] : [])];
  return { attempt, dir, promptFile, workDir, values, command, binding: selection.binding, workerId };
}

// A failed spawn records no run: it costs no attempt and no retry wait.
async function launch({ root, config, configPath, cfg, role, item, now, env }) {
  const d = item.drive;
  const childEnv = {
    ...env,
    LEDGER_ROLE: role,
    LEDGER_ITEM_ID: item.id,
    LEDGER_RESULT_FILE: d.result_file,
  };
  // The messenger token is for reading owner confirmations; a worker never receives it.
  delete childEnv[config.provider?.token_env || "DISCORD_BOT_TOKEN"];
  delete childEnv.DISCORD_BOT_TOKEN;
  let input;
  let output;
  try {
    const { attempt, dir, promptFile, workDir, values, command, binding, workerId } = launchPlan(root, config, cfg, role, item, configPath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(d.result_file), { recursive: true });
    const log = path.join(dir, `${attempt}.log`);
    await writeFile(
      promptFile,
      `${fill(cfg.preamble ?? DEFAULT_PREAMBLE, values)}\n${await readFile(d.prompt, "utf8")}`,
      { mode: 0o600 },
    );
    if (!binding) input = await open(promptFile, "r");
    output = await open(log, "a", 0o600);
    const child = spawn(command[0], command.slice(1), {
      cwd: workDir,
      detached: true,
      stdio: [input?.fd ?? "ignore", output.fd, output.fd],
      env: childEnv,
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    if (binding) {
      d.model = binding.model;
      d.profiled = true;
    }
    d.run = {
      ...(binding ? { profile: binding, worker_id: workerId } : {}),
      pid: child.pid,
      start: processStart(child.pid),
      started_at: iso(now),
      wake_dir: roleWakeDir(root, config, role),
      ended_at: null,
      attempts: attempt,
      log,
    };
    delete d.error;
    await registerWorker({
      root,
      env,
      id: `ledger-${role}-${item.id}`,
      scheduledCard: item.id,
      role,
      pid: child.pid,
      watchDirs: [dir, path.dirname(d.result_file)],
      resultFile: d.result_file,
      wakeDir: d.run.wake_dir,
      ...(binding ? { ledgerWorker: { id: workerId, parent: item.id } } : {}),
      now: Date.parse(d.run.started_at),
    });
    return null;
  } catch (error) {
    d.error = error.message;
    return error.message;
  } finally {
    await input?.close();
    await output?.close();
  }
}

export async function start({ root, config, configPath, role, item, ledger, now, env = process.env, freeGb: freeGbImpl = freeGb }) {
  const cfg = driveConfig(config);
  roleWakeDir(root, config, role);
  if (!driven(item) || CLOSED.includes(item.status))
    throw new Error("start requires an open item with an instruction file");
  if (item.drive.run?.worker_id && !ledger) ledger = await readLedger(root, role);
  if (driveWorkerAlive(item, ledger))
    throw new Error(`Worker already running (pid ${item.drive.run.pid})`);
  if (item.drive.run?.worker_id) {
    const tracked = trackedWorker(ledger, item);
    // The runner reserves its ledger row before it can start a native process.
    if (tracked?.status === "running") throw new Error("Previous scheduled worker has no terminal receipt");
    if (!tracked && await hasContent(item.drive.result_file)) throw new Error("Result exists without a scheduled worker receipt");
    if (tracked?.status === "done" && await hasContent(item.drive.result_file)) {
      throw new Error("Scheduled worker already completed this card's result");
    }
  }
  const problem = await instructionProblem(item.drive.prompt);
  if (problem) throw new Error(`${problem}: ${item.drive.prompt}`);
  const free = await freeGbImpl(cfg.diskPath);
  if (free < cfg.minFreeGb)
    throw new Error(`Free space ${free.toFixed(2)} GB is below ${cfg.minFreeGb} GB`);
  if (item.drive.run && !item.drive.run.worker_id) item.drive.run.ended_at ??= iso(now);
  const failure = await launch({ root, config, configPath, cfg, role, item, now, env });
  if (failure) throw new Error(`Worker command failed to start: ${failure}`);
  return `${item.id} worker pid ${item.drive.run.pid} (attempt ${item.drive.run.attempts})`;
}
export function attach(item, pidText, now, { root, config, role }) {
  if (item.drive?.profiled || workerProfilePath(root, config, role)) throw new Error("A profiled card requires a recorded worker launch");
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

async function writeLedgerWake(dir, role, alert, stamp, body) {
  await mkdir(dir, { recursive: true });
  const route = `-route-${role}.md`;
  const filename = (nonce = "") => {
    const normal = `${stamp}-ledger-${alert.id}${nonce}${route}`;
    if (Buffer.byteLength(normal) <= 255) return normal;
    return `${createHash("sha256").update(JSON.stringify([role, alert.id, alert.reason, stamp, nonce])).digest("hex")}${route}`;
  };
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
}

async function deliver({ root, config, cfg, role, alert, stamp, now, env }) {
  const body = `[장부] ${LABELS[alert.reason]}: ${alert.title.replace(/[\r\n]/g, " ")}\n${alert.detail}\n`;
  const dir = roleWakeDir(root, config, role);
  if (alert.completion) {
    const { run, resultFile } = alert.completion;
    const previous = !run.wake_dir && await previousScheduledRegistration(root, env, role, alert.id, run, resultFile);
    if (previous?.alerts?.doneAt == null) {
      await publishScheduledCompletion({ wakeDir: run.wake_dir || previous?.wakeDir || dir, role, cardId: alert.id,
        startedAt: run.started_at, pid: run.pid, resultFile, now });
    }
  } else {
    await writeLedgerWake(dir, role, alert, stamp, body);
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
export async function tick({ root, config, configPath, now = Date.now(), dry = false, env = process.env, freeGb: freeGbImpl = freeGb }) {
  const cfg = driveConfig(config);
  const out = { launched: [], alerts: [], errors: [], skipped: [], handled: [] };
  if (!cfg.enabled && !dry) {
    out.skipped.push("drive.enabled is not true");
    return out;
  }
  if (!dry) await assertLedgerOwner(root);
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
        live += ledger.items.filter((item) => driven(item) && !closedProperly(item) && driveWorkerAlive(item, ledger)).length;
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
            const entry = { id: item.id, reason, title: item.title, detail };
            const d = item.drive;
            if (reason === "result-ready" && d.run.log) {
              entry.completion = { run: d.run, resultFile: d.result_file };
            }
            pending.push(entry);
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
            if (driveWorkerAlive(item, ledger)) {
              alert(item, "launched", `기한: ${item.due}\n모델: ${d.model}\n일꾼 pid: ${d.run.pid} (${d.run.attempts}번째)\n지시서: ${d.prompt}\n결과: ${d.result_file}\n기록: ${d.run.log ?? "(없음)"}`, d.run.started_at);
              if (now - Date.parse(d.run.started_at) > cfg.maxRunMin * 60000)
                alert(item, "long-run", `일꾼 pid ${d.run.pid} 가 ${d.run.started_at} 부터 돌고 있음.\n기록: ${d.run.log ?? "(없음)"}`);
              continue;
            }
            if (d.run && !d.run.worker_id) d.run.ended_at ??= iso(now);
            if (d.run?.worker_id) {
              const tracked = trackedWorker(ledger, item);
              if (tracked?.ended) d.run.ended_at = tracked.ended;
              if (tracked?.status === "running") {
                alert(item, "launch-failed", `일꾼 ${d.run.worker_id}의 종료 기록을 확인할 수 없습니다. 시작 기록: ${d.run.log}`);
                continue;
              }
              if (tracked?.status === "failed" && ["provider-unavailable", "executable-missing"].includes(tracked.reason)) {
                alert(item, "worker-unavailable", `후보를 사용할 수 없어 원본 카드를 열어 두었습니다 (${tracked.reason}). 복구 확인 후 같은 카드로 재개: start ${item.id}`);
                continue;
              }
            }
            if (await hasContent(d.result_file)) {
              if (d.profiled && !d.run) alert(item, "result-preexisting", `예약 일꾼 기동 전에 생긴 파일: ${d.result_file}. 담당자가 결과를 확인한 경우 confirm 명령을 사용하세요.`);
              else if (!verifiedDriveResult(item, ledger)) alert(item, "launch-failed", `예약 일꾼의 성공 종료가 확인되지 않았습니다. 실행 기록: ${d.run.log}`);
              else if (d.run) alert(item, "result-ready", `결과: ${d.result_file}\n읽고 닫기: done ${item.id} --result <결과 주소>`, d.run.started_at);
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
              try { launchPlan(root, config, cfg, role, item, configPath); }
              catch (error) { alert(item, "launch-failed", error.message); continue; }
              out.launched.push({ role, id: item.id, dry: true });
              live++;
              continue;
            }
            const failure = await launch({ root, config, configPath, cfg, role, item, now, env });
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
            await deliver({ root, config, cfg, role, alert: entry, stamp: iso(now + sequence++).replace(/\D/g, ""), now, env });
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
              if (!item || !driven(item)) continue;
              const observed = entry.completion?.run;
              if (observed && (item.drive.run?.pid !== observed.pid || item.drive.run?.started_at !== observed.started_at)) continue;
              item.drive.alerts[entry.reason] = iso(now);
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
export async function verifyOwner({ config, item, channel, msgId, fetchImpl, env, sleep, cancel = false }) {
  const cfg = driveConfig(config);
  if (!cfg.owners.length) throw new Error("drive.owner_ids is not configured");
  const adapter = createAdapter(config.provider, { fetchImpl, env, sleep });
  const proof = { adapter, authors: cfg.owners, item, channel, msgId };
  if (cancel) return verifyCardCancellation(proof);
  const message = await verifyCardReply(proof);
  return { channel, msg_id: msgId, author: message.author.id };
}
