#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, open, realpath, rename, rm, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkIndependentReviewer, commandDigest, resolveWorkerStep, workerProfilePath } from "./worker-profile.mjs";
import {
  changeLedger,
  isWorkerItem,
  ledgerPath,
  loadLedgerConfig,
  oneLine,
  processStart,
  readLedger,
  runtimeEnv,
  safeName,
  systemRunner,
  validDate,
  validToolName,
  validUnitName,
} from "./ledger.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);
const STARTUP_GRACE_MS = 5000;
const BOOLEAN_FLAGS = new Set([
  "dry",
  "wait",
  "foreground",
  "json",
  "strict-parent",
  "allow-unchanged-result",
]);
const KNOWN_TOOL_PATTERNS = [
  [/^agy(?:-cli)?$/i, "agy"],
  [/^codex(?:-cli)?$/i, "codex"],
  [/^muse(?:-bin)?(?:-[\d.]+)?$/i, "muse"],
  [/^claude(?:-code)?$/i, "claude"],
  [/^opencode(?:-cli)?$/i, "opencode"],
  [/^gemini(?:-cli)?$/i, "gemini"],
  [/^goose$/i, "goose"],
  [/^droid$/i, "droid"],
  [/^aider$/i, "aider"],
  [/^grok(?:-cli)?$/i, "grok"],
  [/^pi$/i, "pi"],
];
const STRIP_EXT_RE = /\.(?:c?js|mjs|sh|exe)$/i;

const hash = (value) => createHash("sha256").update(String(value)).digest("hex");

function normalizeUnitName(raw) {
  if (!oneLine(raw)) throw new Error("Invalid --unit");
  const trimmed = raw.trim();
  const unit = /\.(?:service|scope)$/.test(trimmed) ? trimmed : `${trimmed}.service`;
  if (!validUnitName(unit)) throw new Error(`Invalid systemd unit name: ${raw}`);
  return unit;
}

export function workerUnitName(root, role, id) {
  safeName(role);
  safeName(id);
  const rootTag = hash(root).slice(0, 8);
  const suffix = hash(JSON.stringify([root, role, id])).slice(0, 12);
  let base = `adk-worker-${rootTag}-${role}-${id}`;
  if (Buffer.byteLength(base) > 200) {
    base = `adk-worker-${rootTag}-${suffix}-${hash(id).slice(0, 16)}`;
  }
  return `${base}.service`;
}

export function makeWorkerId(name, now = Date.now()) {
  const slug = String(name ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^[^a-zA-Z0-9]+|[-_]+$/g, "")
    .slice(0, 32);
  const stamp = new Date(now).toISOString().replace(/[-:.]/g, "").slice(0, 16);
  const rand = randomBytes(3).toString("hex");
  const id = slug ? `w-${slug}-${stamp}-${rand}` : `w-${stamp}-${rand}`;
  return safeName(id);
}

export function detectTool(command, explicitTool) {
  if (explicitTool !== undefined) {
    if (!validToolName(explicitTool)) throw new Error(`Invalid --tool: ${explicitTool}`);
    return explicitTool;
  }
  if (!Array.isArray(command) || !command.length) throw new Error("Command is required");
  let idx = 0;
  while (idx < command.length) {
    const token = String(command[idx] || "");
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      idx++;
      continue;
    }
    const base = path.basename(token).replace(STRIP_EXT_RE, "");
    if (base === "env" || base === "nohup" || base === "setsid" || base === "nice" || base === "ionice") {
      idx++;
      while (idx < command.length && String(command[idx]).startsWith("-")) {
        if (command[idx] === "--") { idx++; break; }
        if (/^(?:-n|-u|--unset|-C|--chdir|-c|-p)$/.test(command[idx])) idx += 2;
        else idx++;
      }
      continue;
    }
    if (base === "timeout") {
      idx++;
      while (idx < command.length && String(command[idx]).startsWith("-")) {
        if (command[idx] === "--") { idx++; break; }
        if (/^(?:-k|-s|--kill-after|--signal)$/.test(command[idx])) idx += 2;
        else idx++;
      }
      if (idx < command.length) idx++;
      continue;
    }
    if (base === "heavy-run") {
      idx++;
      if (command[idx] === "--name") idx += 2;
      if (command[idx] === "--") idx++;
      continue;
    }
    for (const [pattern, toolName] of KNOWN_TOOL_PATTERNS) {
      if (pattern.test(base)) return toolName;
    }
    const sanitized = base.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^[^a-zA-Z0-9]+|[-.]+$/g, "");
    return sanitized && validToolName(sanitized) ? sanitized : "custom";
  }
  return "custom";
}

export function parseWorkerArgs(args = []) {
  const tokens = [...args];
  const dashIdx = tokens.indexOf("--");
  const head = dashIdx >= 0 ? tokens.slice(0, dashIdx) : tokens;
  const command = dashIdx >= 0 ? tokens.slice(dashIdx + 1) : [];

  let subcommand = null;
  if (head[0] && !head[0].startsWith("-")) {
    subcommand = head.shift();
  }
  const opts = {};
  for (let i = 0; i < head.length; i++) {
    const arg = head[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const eq = arg.indexOf("=");
    if (eq > 2) {
      opts[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      opts[key] = true;
      continue;
    }
    if (head[i + 1] === undefined || (head[i + 1].startsWith("--"))) {
      throw new Error(`Missing --${key} value`);
    }
    opts[key] = head[++i];
  }
  if (opts["result-file"] !== undefined && opts.result === undefined) opts.result = opts["result-file"];
  if (opts.title !== undefined && opts.name === undefined) opts.name = opts.title;
  if (opts["parent-id"] !== undefined && opts.parent === undefined) opts.parent = opts["parent-id"];

  const cmd = subcommand ?? "start";
  if (!["start", "run", "finish", "reconcile", "list", "_exec"].includes(cmd)) {
    throw new Error("Commands: start finish reconcile list");
  }
  return { commandName: cmd === "run" ? "start" : cmd, opts, command };
}

export async function snapshotResultBaseline(resultPath) {
  if (!resultPath) return null;
  try {
    const st = await stat(resultPath, { bigint: true });
    if (st.isFile() && st.size > 0n) {
      return { size: Number(st.size), mtime_ns: st.mtimeNs.toString() };
    }
    return null;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

export async function inspectResultFile(resultPath, initialResult = null, { allowUnchanged = false } = {}) {
  if (!resultPath) return { valid: true, reason: null, size: null };
  let st;
  try {
    st = await stat(resultPath, { bigint: true });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return { valid: false, reason: "result-missing", size: 0 };
    }
    throw error;
  }
  if (!st.isFile()) return { valid: false, reason: "result-missing", size: 0 };
  if (st.size === 0n) return { valid: false, reason: "result-empty", size: 0 };
  if (
    !allowUnchanged &&
    initialResult &&
    Number(st.size) === initialResult.size &&
    st.mtimeNs.toString() === initialResult.mtime_ns
  ) {
    return { valid: false, reason: "result-unchanged", size: Number(st.size) };
  }
  return { valid: true, reason: null, size: Number(st.size) };
}

export function parseSystemctlShowOutput(raw) {
  const props = {};
  for (const line of String(raw || "").split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0) props[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  const exitRaw = props.ExecMainStatus;
  const pidRaw = props.ExecMainPID;
  const execMainStatus =
    exitRaw !== undefined && exitRaw !== "" && Number.isInteger(Number(exitRaw))
      ? Number(exitRaw)
      : null;
  const execMainPid =
    pidRaw !== undefined && pidRaw !== "" && Number.isInteger(Number(pidRaw))
      ? Number(pidRaw)
      : 0;
  return {
    id: props.Id || "",
    loadState: props.LoadState || "unknown",
    activeState: props.ActiveState || "unknown",
    subState: props.SubState || "unknown",
    result: props.Result || "unknown",
    execMainStatus,
    execMainPid,
  };
}

export async function probeSystemdUnit(unit, { runner = systemRunner, env = process.env } = {}) {
  try {
    const stdout = await runner(
      "systemctl",
      [
        "--user",
        "show",
        unit,
        "--no-pager",
        "--property=Id,LoadState,ActiveState,SubState,Result,ExecMainStatus,ExecMainPID",
      ],
      { env: runtimeEnv(env) },
    );
    return { ok: true, ...parseSystemctlShowOutput(stdout) };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

export function defaultPidProbe(pid, startToken = null) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const observed = processStart(pid);
  if (observed === null) return false;
  if (startToken && observed !== "unknown" && observed !== startToken) return false;
  return true;
}

function buildChildEnv({ env, config, role, id, parent, resultPath, unit, tool }) {
  const childEnv = {
    ...env,
    LEDGER_ROLE: role,
    LEDGER_ITEM_ID: id,
    ...(parent ? { LEDGER_PARENT_ID: parent } : {}),
    ...(resultPath ? { LEDGER_RESULT_FILE: resultPath } : {}),
    ...(unit ? { LEDGER_UNIT: unit } : {}),
    LEDGER_TOOL: tool,
  };
  delete childEnv[config?.provider?.token_env || "DISCORD_BOT_TOKEN"];
  delete childEnv.DISCORD_BOT_TOKEN;
  return childEnv;
}

async function resolveRootAndResult(opts, workCwd) {
  if (!oneLine(opts.result)) throw new Error("worker-run requires --result <path>");
  return path.isAbsolute(opts.result)
    ? path.resolve(opts.result)
    : path.resolve(workCwd, opts.result);
}

export async function finishWorkerRun(
  opts,
  { now, clock = now === undefined ? Date.now : () => now } = {},
) {
  const root = path.resolve(opts.root || process.cwd());
  const role = safeName(opts.role);
  const id = safeName(opts.id);
  await loadLedgerConfig({ root, configPath: opts.config, role });

  let exitCode = null;
  if (opts.exit !== undefined && opts.exit !== null && opts.exit !== "") {
    const parsed = Number(opts.exit);
    if (!Number.isInteger(parsed)) throw new Error(`Invalid --exit: ${opts.exit}`);
    exitCode = parsed;
  } else if (!opts.reason) {
    throw new Error("finish requires integer --exit <code> (or --reason)");
  }

  const currentLedger = await readLedger(root, role);
  const existing = currentLedger.items.find((i) => i.id === id);
  if (!existing) throw new Error(`Unknown worker run: ${id}`);
  if (!isWorkerItem(existing)) throw new Error(`Item ${id} is not a worker run`);
  if (existing.status !== "running") {
    if (opts.ifRunning) return existing;
    throw new Error(`Worker run ${id} is already ${existing.status}`);
  }

  const workCwd = existing.cwd || root;
  const effectiveResult =
    opts.result !== undefined
      ? opts.result === null || opts.result === "-"
        ? null
        : path.isAbsolute(opts.result)
          ? path.resolve(opts.result)
          : path.resolve(workCwd, opts.result)
      : existing.result;

  if (existing.profile && effectiveResult !== existing.result) {
    throw new Error("A profiled worker must finish with its recorded result file");
  }
  const resultCheck = await inspectResultFile(effectiveResult, existing.initial_result, {
    allowUnchanged: !existing.profile && (opts.allowUnchangedResult === true || opts["allow-unchanged-result"] === true),
  });

  let nextStatus = "failed";
  let nextReason = opts.reason ? String(opts.reason) : null;
  if (exitCode === 0 && !opts.reason) {
    if (resultCheck.valid) {
      nextStatus = "done";
      nextReason = null;
    } else {
      nextStatus = "failed";
      nextReason = resultCheck.reason;
    }
  } else if (nextReason === null) {
    nextReason = exitCode === null ? "unit-missing" : "exit-nonzero";
  }

  const endedIso = new Date(clock()).toISOString();
  return changeLedger(root, role, async (l) => {
    const item = l.items.find((i) => i.id === id);
    if (!item) throw new Error(`Unknown worker run: ${id}`);
    if (!isWorkerItem(item)) throw new Error(`Item ${id} is not a worker run`);
    if (item.status !== "running") {
      if (opts.ifRunning) return item;
      throw new Error(`Worker run ${id} is already ${item.status}`);
    }
    if (nextStatus === "done" && item.profile && !item.profile_started_at) {
      nextStatus = "failed";
      nextReason = "missing-launch-receipt";
    }
    item.status = nextStatus;
    item.ended = endedIso;
    item.exit = exitCode;
    item.reason = nextReason;
    item.launch_pending = false;
    if (effectiveResult !== existing.result) item.result = effectiveResult;
    if (opts.note !== undefined) item.note = String(opts.note);
    else if (nextStatus === "failed" && !item.note && nextReason) {
      item.note =
        nextReason === "result-missing" || nextReason === "result-empty" || nextReason === "result-unchanged"
          ? `종료 코드 0이나 결과 파일 확인 실패(${nextReason})`
          : `종료(${nextReason}, exit=${exitCode ?? "null"})`;
    }
    return item;
  });
}

// Keep partial output private. A later write by an inherited child descriptor
// cannot change the result inode once the finished snapshot has been published.
async function captureStdout(resultPath) {
  const dir = await mkdtemp(path.join(path.dirname(resultPath), ".adk-stdout-"));
  const output = path.join(dir, "output");
  let handle;
  try { handle = await open(output, "wx", 0o600); }
  catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
  return {
    fd: handle.fd,
    async finish(publish) {
      try {
        await handle.close();
        if (!publish) return;
        const snapshot = path.join(dir, "finished");
        await copyFile(output, snapshot);
        if ((await stat(snapshot)).size === 0) throw new Error("Worker stdout was empty");
        await rename(snapshot, resultPath);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

async function runSubprocessAndRecord(
  { root, configPath, config, role, id, parent, resultPath, unit, tool, workCwd, command, env, prompt, resultMode, stdio = ["ignore", "inherit", "inherit"] },
  { clock = Date.now } = {},
) {
  const childEnv = buildChildEnv({ env, config, role, id, parent, resultPath, unit, tool });
  let child;
  let input;
  let capture;
  try {
    if (resultMode === "stdout") capture = await captureStdout(resultPath);
    if (prompt) input = await open(prompt, "r");
    child = spawn(command[0], command.slice(1), {
      cwd: workCwd,
      env: childEnv,
      stdio: input ? [input.fd, capture?.fd ?? stdio[1], stdio[2]] : stdio,
    });
  } catch (error) {
    await input?.close();
    await capture?.finish(false);
    const item = await finishWorkerRun({ root, config: configPath, role, id, exit: 127, reason: "launch-failed", note: error.message, ifRunning: true }, { clock });
    return { exitCode: 127, item, error };
  }

  let spawnError = null;
  const spawned = await new Promise((resolve) => {
    child.once("spawn", () => resolve(true));
    child.once("error", (err) => {
      spawnError = err;
      resolve(false);
    });
  });
  if (input) void input.close().catch(() => {});

  if (!spawned) {
    await capture?.finish(false);
    const item = await finishWorkerRun(
      {
        root,
        config: configPath,
        role,
        id,
        exit: 127,
        reason: "launch-failed",
        note: spawnError?.message || "Failed to spawn worker command",
        ifRunning: true,
      },
      { clock },
    );
    return { exitCode: 127, item, error: spawnError };
  }

  const pid = child.pid;
  const startToken = processStart(pid);
  const spawnedAt = new Date(clock()).toISOString();
  const receipt = changeLedger(root, role, async (l) => {
    const item = l.items.find((i) => i.id === id);
    if (item && isWorkerItem(item) && item.status === "running") {
      item.pid = pid;
      item.start_token = startToken;
      item.launch_pending = false;
      if (item.profile) item.profile_started_at = spawnedAt;
    }
  }).then(() => null, error => error);

  let receivedSignal = null;
  const forwardSignal = (sig) => {
    receivedSignal = sig;
    try { child.kill(sig); } catch { /* child already gone */ }
  };
  process.on("SIGTERM", forwardSignal);
  process.on("SIGINT", forwardSignal);

  const { code, signal } = await new Promise((resolve) => {
    child.once("exit", (c, s) => resolve({ code: c, signal: s }));
  });
  process.removeListener("SIGTERM", forwardSignal);
  process.removeListener("SIGINT", forwardSignal);
  const receiptError = await receipt;

  const finalSig = signal || receivedSignal;
  const exitCode =
    code !== null
      ? code
      : 128 + (os.constants.signals[finalSig] || 15);
  let captureError;
  try { await capture?.finish(exitCode === 0 && !finalSig && !receiptError); }
  catch (error) { captureError = error; }
  const item = await finishWorkerRun(
    {
      root,
      config: configPath,
      role,
      id,
      exit: exitCode,
      ...(captureError ? { reason: "stdout-result-failed", note: captureError.message } : {}),
      ...(finalSig ? { reason: `signal-${finalSig}` } : {}),
      ...(prompt && receiptError ? { reason: "missing-launch-receipt", note: receiptError.message } : {}),
      ifRunning: true,
    },
    { clock },
  );
  return { exitCode: prompt && item.status === "failed" ? exitCode || 1 : exitCode, item, error: receiptError };
}

export async function execWorkerRun(
  opts,
  command,
  { now, clock = now === undefined ? Date.now : () => now, env = process.env, stdio } = {},
) {
  const root = path.resolve(opts.root || process.cwd());
  const role = safeName(opts.role);
  const id = safeName(opts.id);
  if (!command.length) throw new Error("_exec requires -- <command...>");
  const { config } = await loadLedgerConfig({ root, configPath: opts.config, role });
  const ledger = await readLedger(root, role);
  const item = ledger.items.find((i) => i.id === id);
  if (!item || !isWorkerItem(item)) throw new Error(`Unknown worker run: ${id}`);
  if (item.status !== "running") return { exitCode: item.exit ?? 1, item };
  const workCwd = opts.cwd ? path.resolve(root, opts.cwd) : item.cwd || root;
  if (item.profile) {
    if (workCwd !== item.cwd || commandDigest(command) !== item.profile.argv_sha256) {
      throw new Error("Worker command or cwd differs from its recorded profile");
    }
    await changeLedger(root, role, ledger => {
      const run = ledger.items.find(row => row.id === id);
      if (run.status !== "running" || run.exec_claimed_at || run.profile_started_at) {
        throw new Error("Profiled worker launch already claimed");
      }
      run.exec_claimed_at = new Date(clock()).toISOString();
    });
  }
  return runSubprocessAndRecord(
    {
      root,
      configPath: opts.config,
      config,
      role,
      id,
      parent: item.parent,
      resultPath: item.result,
      unit: item.unit,
      tool: item.tool,
      workCwd,
      command,
      prompt: item.prompt,
      resultMode: item.profile?.result_mode,
      env,
      stdio,
    },
    { clock },
  );
}

export async function startWorkerRun(
  opts,
  command,
  {
    runner = systemRunner,
    now,
    clock = now === undefined ? Date.now : () => now,
    env = process.env,
    stdio,
  } = {},
) {
  const root = path.resolve(opts.root || process.cwd());
  const canonical = await realpath(root).catch(() => root);
  const role = safeName(opts.role);
  const { config, roleConfig } = await loadLedgerConfig({ root, configPath: opts.config, role });
  if (!oneLine(opts.name)) throw new Error("worker-run requires --name <name>");
  const workCwd = opts.cwd ? path.resolve(root, opts.cwd) : root;
  const resultPath = await resolveRootAndResult(opts, workCwd);
  const at = clock();
  const startedIso = new Date(at).toISOString();
  const requestId = opts.id ? safeName(opts.id) : makeWorkerId(opts.name, at);
  const profileFile = workerProfilePath(root, config, role);
  const supervised = profileFile && !opts.dry && env.WORKER_RUNNER_ID === requestId && env.WORKER_RUNNER_DISPATCH;
  const attempt = supervised ? Number(env.WORKER_RUNNER_ATTEMPT) : 1;
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("Invalid supervisor attempt");
  const id = attempt === 1 ? requestId : `${requestId}-attempt-${attempt}`;
  const parent =
    !opts.parent || opts.parent === "-" || opts.parent === "none"
      ? null
      : safeName(opts.parent);
  const requireParent = Boolean(profileFile || opts["strict-parent"]);
  if (requireParent && parent === null) {
    throw new Error("Worker requires --parent <card-id>");
  }
  if (parent === id || parent === requestId) throw new Error("parent cannot equal worker id");
  const dueIso = opts.due !== undefined ? opts.due : startedIso;
  if (!validDate(dueIso)) throw new Error("Invalid --due (UTC ISO required)");

  let selection;
  let prompt;
  const reviewOf = opts["review-of"];
  function cardContext(ledger) {
    const card = ledger?.items.find(item => item.id === parent && (!requireParent || !isWorkerItem(item)));
    if (requireParent && !card) throw new Error(`Parent item not found: ${parent}`);
    if (requireParent && card.status !== "open") throw new Error("Worker requires an open parent card");
    const producer = reviewOf && ledger?.items.find(item => item.id === reviewOf && isWorkerItem(item));
    if (profileFile && card.worker_step === "review") throw new Error("Use --review-of to review a completed producer");
    if (reviewOf && (!producer?.profile_started_at || !producer.profile?.family || producer.status !== "done" || producer.parent !== parent || producer.profile.step === "review")) {
      throw new Error("Review requires a completed profiled producer on the same card");
    }
    return { card, step: reviewOf ? "review" : card?.worker_step ?? "implementation", producer };
  }
  if (profileFile) {
    if (command?.length || ["tool", "model", "effort", "step", "profile"].some(key => Object.hasOwn(opts, key))) {
      throw new Error("The role profile supplies the worker command, model, effort and step");
    }
    if (!oneLine(opts.prompt)) throw new Error("Profiled worker requires --prompt <file>");
    prompt = path.resolve(workCwd, opts.prompt);
    if (!(await stat(prompt)).isFile() || prompt === resultPath) throw new Error("Worker prompt must be a file distinct from the result");
  } else if (opts.prompt || reviewOf) {
    throw new Error("Profiled start requires a configured tier_profile for the role");
  } else if (!Array.isArray(command) || !command.length) {
    throw new Error("worker-run requires -- <command...>");
  }
  if (requireParent) {
    const ledger = await readLedger(root, role).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    const { card, step, producer } = cardContext(ledger);
    if (profileFile) {
      selection = resolveWorkerStep(profileFile, step, { workDir: workCwd, prompt, result: resultPath, role, card, producer: producer?.profile });
      checkIndependentReviewer(producer?.profile, selection.binding);
      command = selection.command;
    }
  }
  const tool = selection ? detectTool([selection.binding.cli]) : detectTool(command, opts.tool);
  const foreground = opts.foreground === true;
  const unit = foreground
    ? null
    : opts.unit
      ? normalizeUnitName(opts.unit)
      : workerUnitName(canonical, role, id);
  const logFile = opts.log
    ? path.isAbsolute(opts.log)
      ? path.resolve(opts.log)
      : path.resolve(root, opts.log)
    : path.join(path.dirname(ledgerPath(root, role)), "worker-runs", role, `${id}.log`);

  if (opts.dry) {
    return {
      event: "worker-dry",
      id,
      kind: "worker",
      role,
      parent,
      name: opts.name.trim(),
      unit,
      tool,
      status: "running",
      started: startedIso,
      result: resultPath,
      log: logFile,
      cwd: workCwd,
      command,
      ...(selection ? { profile: selection.binding } : {}),
    };
  }

  await mkdir(path.dirname(resultPath), { recursive: true });
  await mkdir(path.dirname(logFile), { recursive: true, mode: 0o700 });
  const initialResult = await snapshotResultBaseline(resultPath);

  const alreadyFinished = await changeLedger(root, role, async (l) => {
    if (l.report.every_min === 0 && roleConfig?.report) {
      l.report.every_min = roleConfig.report.every_min;
      l.report.channel = roleConfig.report.channel;
    }
    if (supervised && attempt > 1) {
      const previous = l.items.filter(run => run.supervisor?.dispatch === supervised && run.supervisor.id === requestId);
      for (const run of previous) {
        if (run.parent !== parent || run.result !== resultPath || run.prompt !== prompt || run.profile.argv_sha256 !== selection.binding.argv_sha256 || run.profile.result_mode !== selection.binding.result_mode) {
          throw new Error("Profiled supervisor resumption differs from its original dispatch");
        }
        if (run.status === "done") return run;
        if (run.status === "running") {
          if (defaultPidProbe(run.pid, run.start_token)) throw new Error("Previous worker attempt is still running");
          run.status = "failed";
          run.ended = startedIso;
          run.reason = "supervisor-preempted";
          run.launch_pending = false;
        }
      }
    }
    if (l.items.some((i) => i.id === id)) throw new Error("Duplicate id");
    const { card: parentItem, step, producer } = cardContext(l);
    if (selection) {
      if (step !== selection.binding.step) throw new Error("Card step changed before worker start");
      checkIndependentReviewer(producer?.profile, selection.binding);
    }
    l.items.push({
      id,
      kind: "worker",
      title: opts.name.trim(),
      name: opts.name.trim(),
      role,
      parent,
      unit,
      tool,
      status: "running",
      started: startedIso,
      ended: null,
      result: resultPath,
      exit: null,
      pid: null,
      start_token: null,
      log: logFile,
      cwd: workCwd,
      reason: null,
      launch_pending: true,
      initial_result: initialResult,
      ...(supervised ? { supervisor: { id: requestId, dispatch: supervised, attempt } } : {}),
      ...(selection ? { profile: selection.binding, prompt, ...(foreground ? { exec_claimed_at: startedIso } : {}), ...(reviewOf ? { review_of: reviewOf } : {}) } : {}),
      from: {
        channel: parentItem?.from?.channel || roleConfig?.report?.channel || "",
        msg_id: selection ? parentItem.from.msg_id : "-",
        quote: "",
      },
      due: dueIso,
      created_at: startedIso,
      worker: null,
      checked_at: null,
      note: opts.note ? String(opts.note) : "",
    });
  });

  if (isWorkerItem(alreadyFinished)) {
    return { event: "worker-finished", ...alreadyFinished, exitCode: 0, ledger_file: ledgerPath(root, role) };
  }

  if (foreground) {
    const out = await runSubprocessAndRecord(
      {
        root,
        configPath: opts.config,
        config,
        role,
        id,
        parent,
        resultPath,
        unit: null,
        tool,
        workCwd,
        command,
        prompt,
        resultMode: selection?.binding.result_mode,
        env,
        stdio,
      },
      { clock },
    );
    return {
      event: "worker-finished",
      ...out.item,
      exitCode: out.exitCode,
      ledger_file: ledgerPath(root, role),
    };
  }

  const systemdArgs = [
    "--user",
    `--unit=${unit}`,
    "--collect",
    `--description=ADK worker ${role}/${id} (${tool})`,
    `--working-directory=${workCwd}`,
    `--setenv=LEDGER_ROLE=${role}`,
    `--setenv=LEDGER_ITEM_ID=${id}`,
    ...(parent ? [`--setenv=LEDGER_PARENT_ID=${parent}`] : []),
    `--setenv=LEDGER_RESULT_FILE=${resultPath}`,
    `--setenv=LEDGER_UNIT=${unit}`,
    `--setenv=LEDGER_TOOL=${tool}`,
    ...(env.PATH ? [`--setenv=PATH=${env.PATH}`] : []),
    `--property=StandardOutput=append:${logFile}`,
    `--property=StandardError=append:${logFile}`,
    ...(opts.wait ? ["--wait"] : []),
    "--",
    process.execPath,
    SELF_PATH,
    "_exec",
    "--root",
    root,
    "--role",
    role,
    "--id",
    id,
    ...(opts.config ? ["--config", path.resolve(root, opts.config)] : []),
    "--cwd",
    workCwd,
    "--",
    ...command,
  ];

  try {
    await runner("systemd-run", systemdArgs, { env: runtimeEnv(env) });
  } catch (error) {
    await finishWorkerRun(
      {
        root,
        config: opts.config,
        role,
        id,
        exit: null,
        reason: "launch-failed",
        note: error?.message || String(error),
        ifRunning: true,
      },
      { clock },
    ).catch(() => {});
    throw error;
  }

  if (opts.wait) {
    const latest = (await readLedger(root, role)).items.find((i) => i.id === id);
    if (latest && latest.status === "running") {
      const closed = await finishWorkerRun(
        {
          root,
          config: opts.config,
          role,
          id,
          exit: null,
          reason: "unit-exited-unclosed",
          ifRunning: true,
        },
        { clock },
      );
      return { event: "worker-finished", ...closed, ledger_file: ledgerPath(root, role) };
    }
    return { event: "worker-finished", ...latest, ledger_file: ledgerPath(root, role) };
  }

  await changeLedger(root, role, async (l) => {
    const item = l.items.find((i) => i.id === id);
    if (item && isWorkerItem(item) && item.status === "running" && !item.profile) {
      item.launch_pending = false;
    }
  });

  const current = (await readLedger(root, role)).items.find((i) => i.id === id);
  return {
    event: current?.status === "running" ? "worker-started" : "worker-finished",
    ...current,
    ledger_file: ledgerPath(root, role),
  };
}

export async function reconcileWorkerRuns({
  root,
  config,
  configPath,
  roles,
  now,
  clock = now === undefined ? Date.now : () => now,
  runner = systemRunner,
  unitProbe,
  pidProbe = defaultPidProbe,
  dry = false,
  env = process.env,
} = {}) {
  const resolvedRoot = path.resolve(root || process.cwd());
  let effectiveConfig = config;
  if (!effectiveConfig && !roles) {
    const loaded = await loadLedgerConfig({
      root: resolvedRoot,
      configPath,
      requireConfig: false,
      requireRole: false,
    });
    effectiveConfig = loaded.config;
  }
  const roleList = roles
    ? roles.map((r) => safeName(r))
    : Array.isArray(effectiveConfig?.roles)
      ? effectiveConfig.roles.map((r) => r?.role).filter(Boolean)
      : [];

  const at = now ?? clock();
  const endedIso = new Date(at).toISOString();
  const probeFn = unitProbe ?? ((unit) => probeSystemdUnit(unit, { runner, env }));
  const out = { checked: 0, closed: [], errors: [] };

  for (const rawRole of new Set(roleList)) {
    let role;
    try {
      role = safeName(rawRole);
    } catch (error) {
      out.errors.push(`${rawRole}: ${error.message}`);
      continue;
    }

    let ledger;
    try {
      ledger = await readLedger(resolvedRoot, role);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      out.errors.push(`${role}: ${error.message}`);
      continue;
    }

    const runningItems = ledger.items.filter((i) => isWorkerItem(i) && i.status === "running");
    if (!runningItems.length) continue;

    const planned = [];
    for (const item of runningItems) {
      out.checked++;
      const startedMs = Date.parse(item.started);
      if (item.launch_pending === true && Number.isFinite(startedMs) && at - startedMs < STARTUP_GRACE_MS) {
        continue;
      }

      if (item.unit) {
        const probe = await probeFn(item.unit);
        if (!probe?.ok) {
          out.errors.push(`${role}/${item.id}: unit probe failed (${probe?.error || "unknown"})`);
          continue;
        }
        const active = probe.activeState;
        const sub = probe.subState;
        if (
          active === "active" ||
          active === "activating" ||
          active === "reloading" ||
          (active === "deactivating" && sub !== "dead")
        ) {
          continue;
        }

        const pidAlive =
          Number.isInteger(item.pid) && item.pid > 0 && pidProbe(item.pid, item.start_token);
        if (pidAlive) continue;

        if (probe.loadState === "not-found") {
          planned.push({
            id: item.id,
            status: "failed",
            exit: null,
            reason: "unit-missing",
            note: `systemd 유닛(${item.unit})이 없어 종료(failed)로 닫음`,
          });
          continue;
        }

        if (active === "failed" || probe.result === "failed") {
          planned.push({
            id: item.id,
            status: "failed",
            exit: probe.execMainStatus,
            reason: "unit-failed",
            note: `systemd 유닛(${item.unit}) 실패(ActiveState=${active}, Result=${probe.result})`,
          });
          continue;
        }

        if ((active === "inactive" || active === "deactivating") && sub === "dead") {
          if (probe.result === "success" && probe.execMainStatus === 0) {
            const check = item.profile && !item.profile_started_at
              ? { valid: false, reason: "missing-launch-receipt" }
              : await inspectResultFile(item.result, item.initial_result);
            if (check.valid) {
              planned.push({
                id: item.id,
                status: "done",
                exit: 0,
                reason: null,
                note: item.note || "",
              });
            } else {
              planned.push({
                id: item.id,
                status: "failed",
                exit: 0,
                reason: check.reason,
                note: `유닛 종료(exit 0) 후 결과 파일 확인 실패(${check.reason})`,
              });
            }
          } else {
            planned.push({
              id: item.id,
              status: "failed",
              exit: probe.execMainStatus,
              reason: "unit-failed",
              note: `systemd 유닛(${item.unit}) 비정상 종료(Result=${probe.result})`,
            });
          }
        }
        continue;
      }

      const pidAlive =
        Number.isInteger(item.pid) && item.pid > 0 && pidProbe(item.pid, item.start_token);
      if (pidAlive) continue;
      const reason = item.pid ? "process-missing" : "no-unit-or-pid";
      planned.push({
        id: item.id,
        status: "failed",
        exit: null,
        reason,
        note: `실행 프로세스(${item.pid ?? "없음"})가 사라져 종료(failed)로 닫음`,
      });
    }

    if (!planned.length) continue;

    if (dry) {
      for (const entry of planned) {
        const src = runningItems.find((i) => i.id === entry.id);
        out.closed.push({
          role,
          id: entry.id,
          title: src.title,
          parent: src.parent,
          unit: src.unit,
          tool: src.tool,
          result: src.result,
          log: src.log,
          status: entry.status,
          exit: entry.exit,
          reason: entry.reason,
          dry: true,
        });
      }
      continue;
    }

    await changeLedger(resolvedRoot, role, async (l) => {
      for (const entry of planned) {
        const target = l.items.find((i) => i.id === entry.id);
        if (!target || !isWorkerItem(target) || target.status !== "running") continue;
        target.status = entry.status;
        target.ended = endedIso;
        target.exit = entry.exit;
        target.reason = entry.reason;
        target.launch_pending = false;
        if (entry.note && !target.note) target.note = entry.note;
        out.closed.push({
          role,
          id: target.id,
          title: target.title,
          parent: target.parent,
          unit: target.unit,
          tool: target.tool,
          result: target.result,
          log: target.log,
          status: target.status,
          exit: target.exit,
          reason: target.reason,
        });
      }
    });
  }

  return out;
}

export async function listWorkerRuns({ root, configPath, role, status } = {}) {
  const resolvedRoot = path.resolve(root || process.cwd());
  let roles = [];
  if (role !== undefined) {
    const safeRole = safeName(role);
    await loadLedgerConfig({ root: resolvedRoot, configPath, role: safeRole });
    roles = [safeRole];
  } else {
    const { config } = await loadLedgerConfig({
      root: resolvedRoot,
      configPath,
      requireConfig: false,
      requireRole: false,
    });
    roles = Array.isArray(config.roles) ? config.roles.map((r) => safeName(r.role)) : [];
  }

  const workers = [];
  for (const r of roles) {
    let ledger;
    try {
      ledger = await readLedger(resolvedRoot, r);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const item of ledger.items) {
      if (!isWorkerItem(item)) continue;
      if (status && item.status !== status) continue;
      workers.push(item);
    }
  }
  return workers;
}

export async function main(args = process.argv.slice(2), deps = {}) {
  const { commandName, opts, command } = parseWorkerArgs(args);
  if (commandName === "start") {
    const run = await startWorkerRun(opts, command, deps);
    if (run.profile && run.exitCode && deps.setExitCode !== false) process.exitCode = run.exitCode;
    return run;
  }
  if (commandName === "finish") {
    return finishWorkerRun(opts, deps);
  }
  if (commandName === "_exec") {
    const res = await execWorkerRun(opts, command, deps);
    if (res.exitCode !== 0 && deps.setExitCode !== false) process.exitCode = res.exitCode;
    return res;
  }
  if (commandName === "reconcile") {
    const root = path.resolve(opts.root || process.cwd());
    const { config } = await loadLedgerConfig({
      root,
      configPath: opts.config,
      role: opts.role,
      requireConfig: !opts.role,
      requireRole: Boolean(opts.role),
    });
    return reconcileWorkerRuns({
      root,
      config,
      configPath: opts.config,
      roles: opts.role ? [opts.role] : undefined,
      dry: opts.dry === true,
      ...deps,
    });
  }
  if (commandName === "list") {
    const items = await listWorkerRuns({
      root: opts.root,
      configPath: opts.config,
      role: opts.role,
      status: opts.status,
    });
    if (opts.json) return items;
    return (
      items
        .map((i) => `${i.id} [${i.status}] (${i.role}/${i.tool}) parent=${i.parent ?? "-"} unit=${i.unit ?? "-"} ${i.name ?? i.title}`)
        .join("\n") || "(일꾼 기록 없음)"
    );
  }
  throw new Error(`Unknown command: ${commandName}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main()
    .then((value) => {
      console.log(typeof value === "string" ? value : JSON.stringify(value));
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
