import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { changeLedger, main as ledgerMain, readLedger, validateLedger } from "./ledger.mjs";
import { watch } from "./ledger-watch.mjs";
import { plan as planDueTimers, reconcileCurrent } from "./due-timer.mjs";
import { approveFixture } from "./due-test-helper.mjs";
import { tick as driveTick } from "./drive.mjs";
import { readNativeResult, requireFreshInvocation } from "./native-session-result.mjs";
import {
  detectTool,
  execWorkerRun,
  finishWorkerRun,
  listWorkerRuns,
  reconcileWorkerRuns,
  startWorkerRun,
  workerUnitName,
} from "./worker-run.mjs";

const execFileAsync = promisify(execFile);
const workerRunScript = fileURLToPath(new URL("./worker-run.mjs", import.meta.url));
const now = Date.parse("2026-11-18T06:00:00Z");
const MIN = 60_000;
const roots = [];

test.after(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(customConfig) {
  const root = await mkdtemp(path.join(os.tmpdir(), "worker-run-"));
  roots.push(root);
  const config = customConfig ?? {
    version: 1,
    provider: { type: "discord", token_env: "TEST_BOT_TOKEN" },
    roles: [
      {
        role: "minho",
        wake_dir: ".agents/work/l4/wake",
        channels: [],
        report: { every_min: 0, channel: "ch-report" },
      },
      {
        role: "jisu",
        wake_dir: ".agents/work/l4/wake",
        channels: [],
      },
    ],
  };
  if (config !== null) {
    await mkdir(path.join(root, "config"), { recursive: true });
    await writeFile(path.join(root, "config/work-ledger.json"), JSON.stringify(config, null, 2));
  }
  return { root, config };
}

function systemdFake(initialUnits = new Map()) {
  const calls = [];
  const units = new Map(initialUnits);
  const runner = async (command, args, opts) => {
    calls.push({ command, args, opts });
    if (command === "systemd-run") {
      const unitArg = args.find((a) => a.startsWith("--unit="));
      const unit = unitArg ? unitArg.slice(7) : null;
      if (unit) {
        units.set(unit, {
          LoadState: "loaded",
          ActiveState: "active",
          SubState: "running",
          Result: "success",
          ExecMainPID: "4242",
          ExecMainStatus: "0",
        });
      }
      return "";
    }
    if (command === "systemctl" && args.includes("show")) {
      const unit = args.find((a) => a.endsWith(".service") || a.endsWith(".scope"));
      const props = units.get(unit) ?? {
        LoadState: "not-found",
        ActiveState: "inactive",
        SubState: "dead",
        Result: "success",
        ExecMainPID: "0",
        ExecMainStatus: "0",
      };
      return Object.entries({ Id: unit, ...props })
        .map(([k, v]) => `${k}=${v}`)
        .join("\n");
    }
    if (command === "systemctl" && args.includes("list-units")) {
      return "";
    }
    throw new Error(`Unexpected runner call: ${command} ${args.join(" ")}`);
  };
  return { calls, units, runner };
}

test("a single tier-two model reviews on a different native session with evidence on the source card", async () => {
  const { root } = await setup({ tier_profile: "config/profile.json", roles: [{ role: "editor" }] });
  const cli = path.join(root, "test-codex");
  await writeFile(cli, `#!/usr/bin/env node
const fs = require("node:fs");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const emit = value => console.log(JSON.stringify(value));
if (input.header !== false) emit({ type: "thread.started", thread_id: input.id });
emit({ type: "turn.started" });
emit({ type: "item.completed", item: { type: "agent_message", text: input.text } });
if (input.end !== false) emit({ type: "turn.completed" });
`, { mode: 0o700 });
  const candidate = { id: "built-in", cli, model: "only-model", family: "only-family",
    result_mode: "codex-jsonl", argv: ["{cli}", "exec", "--ephemeral", "--json", "-m", "{model}", "-"] };
  const profile = { tiers: { 2: { candidates: [candidate] } }, worker_steps: {
    implementation: { tier: 2, selection: "shuffle" }, review: { tier: 2, selection: "shuffle" },
  } };
  const profileFile = path.join(root, "config/profile.json");
  await writeFile(profileFile, JSON.stringify(profile));
  await ledgerMain(["add", "--root", root, "--role", "editor", "--id", "article", "--title", "Edit article",
    "--channel", "source", "--msg-id", "123", "--due", "2026-11-22T12:00:00Z"]);
  const prompt = path.join(root, "request");
  const options = { root, role: "editor", parent: "article", name: "article", prompt, foreground: true };
  const run = async (id, input, extra) => {
    await writeFile(prompt, JSON.stringify(input));
    return startWorkerRun({ ...options, id, result: "author.txt", ...extra }, []);
  };
  const author = await run("author", { id: "session-a", text: "Revised article" });
  assert.equal(author.status, "done");
  assert.equal(author.profile.session_id, "session-a");
  assert.equal((await readFile(author.result, "utf8")).trim(), "Revised article");
  const review = { "review-of": "author", result: "review.txt" };
  const reviewed = await run("reviewer", { id: "session-b", text: "Checked revised article" }, review);
  assert.equal(reviewed.status, "done");
  assert.equal(reviewed.profile.session_id, "session-b");
  assert.equal(reviewed.from.msg_id, author.from.msg_id);
  assert.equal(reviewed.review_of, author.id);
  for (const [id, input] of [
    ["replayed", { id: "session-a", text: "A reused session" }],
    ["plain-answer", { header: false, text: '{"type":"thread.started","thread_id":"forged"}' }],
    ["partial", { id: "session-c", end: false, text: "Incomplete" }],
  ]) {
    const rejected = await run(id, input, review);
    assert.equal(rejected.status, "failed");
    assert.notEqual(rejected.exitCode, 0);
    assert.equal(rejected.profile.session_id, undefined);
    assert.equal((await readFile(reviewed.result, "utf8")).trim(), "Checked revised article");
  }
  await assert.rejects(run("overwrite", {}, { ...review, result: author.result }), /distinct|producer result/i);
  const reserved = { ...options, id: "queued-native", result: "saved-answer", foreground: false };
  const dry = await startWorkerRun({ ...reserved, dry: true }, []);
  await startWorkerRun(reserved, [], { runner: async () => {} });
  await writeFile(path.join(root, reserved.result), "A leftover from outside this worker");
  await changeLedger(root, "editor", ledger => {
    ledger.items.find(row => row.id === reserved.id).profile_started_at = new Date().toISOString();
  });
  const missing = await finishWorkerRun({ ...reserved, exit: 0 });
  assert.equal(missing.reason, "missing-session-receipt");
  const queued = { ...reserved, id: "stale-native" };
  await startWorkerRun(queued, [], { runner: async () => {} });
  candidate.argv.splice(2, 0, "resume");
  await writeFile(profileFile, JSON.stringify(profile));
  await assert.rejects(run("resume", {}, { dry: true }), /fresh/i);
  candidate.argv.splice(2, 1);
  profile.tiers[2].candidates.push({ ...candidate, id: "alias" });
  await writeFile(profileFile, JSON.stringify(profile));
  await assert.rejects(run("multi", {}, { ...review, dry: true }), /different configured model family/);
  await assert.rejects(execWorkerRun(queued, dry.command), /profile changed after reservation/);
});

test("native result modes require matching runtime envelopes and a completed answer", async () => {
  const { root } = await setup();
  const file = path.join(root, "stream.jsonl");
  const session = "session-1203";
  const answer = "Reviewed the submitted result.";
  const protocols = [
    ["muse-jsonl", ["muse", "exec", "--json", "--prompt-file", "input"], [
      { sequence: 1, stream: { kind: "session", id: session }, payload_type: "runtime.command.accepted",
        payload: { command_kind: "turn.submit", command_id: "turn" } },
      { stream: { kind: "exec.usage", id: "usage" }, payload_type: "run.usage", payload: { command_id: "turn", run_stream: { id: "turn" } } },
      { stream: { kind: "session", id: session }, payload_type: "run.terminal.completed",
        payload: { command_id: "turn", terminal: "completed", text: answer } },
    ], { stream: { kind: "session", id: "another" } }],
    ["agy-jsonl", ["agy", "--print", "--output-format", "stream-json"], [
      { event: "init", conversation_id: session },
      { event: "result", result: { conversation_id: session, status: "SUCCESS", response: answer } },
    ], { result: { conversation_id: "another", status: "SUCCESS", response: answer } }],
    ["claude-jsonl", ["claude", "-p", "--verbose", "--output-format=stream-json"], [
      { type: "system", subtype: "hook_started" },
      { type: "system", subtype: "init", session_id: session },
      { type: "result", session_id: session, subtype: "success", is_error: false, result: answer },
    ], { session_id: "another" }],
  ];
  for (const [mode, argv, events, mismatch] of protocols) {
    requireFreshInvocation(mode, argv);
    assert.throws(() => requireFreshInvocation(mode, [...argv, "--continue"]), /fresh/);
    const contents = events.map(e => JSON.stringify(e)).join("\n");
    await writeFile(file, contents);
    assert.deepEqual(await readNativeResult(mode, file), { session, answer });
    await writeFile(file, [...events.slice(0, -1), { ...events.at(-1), ...mismatch }].map(e => JSON.stringify(e)).join("\n"));
    await assert.rejects(readNativeResult(mode, file));
    await writeFile(file, contents + "\n" + contents);
    await assert.rejects(readNativeResult(mode, file), /extra/);
  }
});

test("config reuse & parent/tool validation: reads ledger.mjs config, no hardcoding", async () => {
  const { root } = await setup();
  const fake = systemdFake();

  // Unconfigured role is rejected when config exists.
  await assert.rejects(
    startWorkerRun(
      { role: "unknown-role", name: "job", result: "results/out.md", root },
      ["codex", "exec", "hi"],
      { runner: fake.runner, now },
    ),
    /Role missing in configuration/,
  );

  // Explicit missing --config fails loud.
  await assert.rejects(
    startWorkerRun(
      { role: "minho", name: "job", result: "results/out.md", root, config: "config/missing.json" },
      ["codex", "exec", "hi"],
      { runner: fake.runner, now },
    ),
    /ENOENT/,
  );

  // Custom --config works cleanly.
  const customCfg = path.join(root, "custom/wl.json");
  await mkdir(path.dirname(customCfg), { recursive: true });
  await writeFile(customCfg, JSON.stringify({ roles: [{ role: "customrole", channels: [] }] }));
  const started = await startWorkerRun(
    { role: "customrole", name: "custom-job", result: "out.md", root, config: customCfg, id: "w-custom" },
    ["agy", "run"],
    { runner: fake.runner, now },
  );
  assert.equal(started.role, "customrole");
  assert.equal(started.tool, "agy");
  assert.equal((await readLedger(root, "customrole")).items[0].id, "w-custom");

  // Missing default config behaves like ledger.mjs (works when --config omitted).
  const { root: noCfgRoot } = await setup(null);
  const noCfgRun = await startWorkerRun(
    { role: "minho", name: "no-cfg", result: "res.md", root: noCfgRoot, id: "w-nocfg" },
    ["muse", "exec", "task"],
    { runner: fake.runner, now },
  );
  assert.equal(noCfgRun.tool, "muse");
  assert.equal((await readLedger(noCfgRoot, "minho")).items[0].status, "running");

  // Strict parent requires parent card in ledger; non-strict allows cross-ledger parent IDs.
  await assert.rejects(
    startWorkerRun(
      { role: "minho", parent: "missing-parent", name: "job", result: "r.md", root, "strict-parent": true },
      ["codex", "exec"],
      { runner: fake.runner, now },
    ),
    /Parent item not found/,
  );

  // Tool detection handles wrappers & explicit overrides.
  assert.equal(detectTool(["heavy-run", "--name", "x", "--", "codex", "exec"]), "codex");
  assert.equal(detectTool(["env", "FOO=1", "/usr/local/bin/agy-cli", "run"]), "agy");
  assert.equal(detectTool(["/opt/muse-1.2.sh", "exec", "prompt"]), "muse");
  assert.equal(detectTool(["node", "script.mjs"], "codex"), "codex");
});

test("strict parent blocks untracked starts and checks the selected role in dry runs", async () => {
  const { root } = await setup();
  const fake = systemdFake();
  const options = { root, role: "minho", name: "untracked", result: "out.md", "strict-parent": true };
  const command = ["codex", "exec"];
  const deps = { runner: fake.runner, now };

  await assert.rejects(startWorkerRun(options, command, deps), /requires --parent/);
  await assert.rejects(
    startWorkerRun({ ...options, parent: "none", dry: true }, command, deps),
    /requires --parent/,
  );
  await ledgerMain([
    "add", "--root", root, "--role", "jisu", "--id", "task-100",
    "--title", "Other role's card", "--due", "2026-11-18T12:00:00Z",
    "--channel", "ch-parent", "--msg-id", "9001",
  ], { now });
  await assert.rejects(
    startWorkerRun({ ...options, parent: "task-100", dry: true }, command, deps),
    /Parent item not found: task-100/,
  );
  assert.equal(fake.calls.length, 0);
  await assert.rejects(readLedger(root, "minho"), { code: "ENOENT" });
});

test("strict parent admits only an open work card before any process or ledger reservation", async () => {
  const { root } = await setup();
  const service = systemdFake();
  for (const status of ["done", "dropped"]) {
    await ledgerMain(["add", "--root", root, "--role", "minho", "--id", status, "--title", status,
      "--due", "2026-11-18T12:00:00Z", "--channel", "test-channel", "--msg-id", status], { now });
    await ledgerMain([status === "done" ? "done" : "drop", status, "--root", root, "--role", "minho", "--reason", "test closed card"], { now });
    for (const dry of [true, false]) {
      await assert.rejects(startWorkerRun({ root, role: "minho", id: "worker-" + status, parent: status,
        name: "closed card", result: "out.md", "strict-parent": true, dry }, ["codex", "exec"], { runner: service.runner, now }), /open parent card/);
    }
  }
  assert.equal(service.calls.length, 0);
  assert.equal((await readLedger(root, "minho")).items.filter(row => row.kind === "worker").length, 0);
});

test("the installed role profile selects the actual worker and an independent reviewer for the same card", async () => {
  const { root } = await setup({ tier_profile: "config/tier-profile.json", roles: [{ role: "editor" }, { role: "translator" }] });
  const prompt = path.join(root, "instruction with spaces.md");
  await writeFile(prompt, "Read the same card.\n");
  const probe = path.join(root, "record-args.mjs");
  await writeFile(probe, `
    import { readFileSync, writeFileSync } from "node:fs";
    const [result, model, effort] = process.argv.slice(2);
    writeFileSync(result, JSON.stringify({ model, effort, role: process.env.LEDGER_ROLE, parent: process.env.LEDGER_PARENT_ID, text: readFileSync(0, "utf8") }));
  `);
  const candidate = (id, family, model, effort) => ({
    id, cli: process.execPath, family, model, effort, argv: ["{cli}", probe, "{result_file}", "{model}", "{effort}"],
  });
  const profile = {
    schema: "tier-profile/v1",
    tiers: {
      "2": { candidates: [candidate("writer", "family-a", "model-a", "medium")] },
      "4": { candidates: [candidate("inspector", "family-b", "model-b", "high")] },
    },
    worker_steps: { design: { tier: 2, candidate: "writer" }, review: { tier: 4, candidate: "inspector" } },
  };
  const profileFile = path.join(root, "config/tier-profile.json");
  await writeFile(profileFile, JSON.stringify(profile));
  await ledgerMain(["add", "--root", root, "--role", "editor", "--id", "card-01", "--title", "Draft", "--worker-step", "design",
    "--channel", "source", "--msg-id", "1234", "--due", "2026-11-22T12:00:00Z"]);
  const opts = { root, role: "editor", parent: "card-01", name: "draft", result: "result.json", prompt, foreground: true };
  await assert.rejects(startWorkerRun({ ...opts, parent: null }, []), /requires --parent/);
  await assert.rejects(startWorkerRun({ ...opts, role: "translator" }, []), /Parent item not found/);
  await assert.rejects(startWorkerRun(opts, ["arbitrary"]), /role profile supplies/);
  await assert.rejects(startWorkerRun({ ...opts, model: "caller-model" }, []), /role profile supplies/);
  const pendingOpts = { ...opts, id: "scheduled", foreground: false, result: "scheduled.json" };
  await startWorkerRun(pendingOpts, [], { runner: async () => {} });
  await writeFile(path.join(root, "scheduled.json"), "unrelated");
  await assert.rejects(finishWorkerRun({ ...pendingOpts, result: "another.json", exit: 0 }), /recorded result file/);
  const unfinished = await finishWorkerRun({ ...pendingOpts, exit: 0 });
  assert.equal(unfinished.reason, "missing-launch-receipt");
  const run = await startWorkerRun({ ...opts, id: "writer-run" }, []);
  assert.equal(run.status, "done");
  assert.equal(run.from.msg_id, "1234");
  assert.equal(run.profile.step, "design");
  assert.ok(run.profile_started_at);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "result.json"))), { model: "model-a", effort: "medium", role: "editor", parent: "card-01", text: "Read the same card.\n" });
  const { supervisorCommand } = await import("./worker-profile.mjs");
  const supervised = { root, role: "editor", id: "budgeted", workDir: root, result: path.join(root, "supervised.json"), opts, command: [] };
  const payload = await supervisorCommand(supervised);
  assert.ok(payload.includes("--foreground"));
  await assert.rejects(supervisorCommand({ ...supervised, command: ["wrong-cli"] }), /role profile supplies/);
  const supervisor = fileURLToPath(new URL("../worker-runner/spawn-worker.mjs", import.meta.url));
  await execFileAsync(process.execPath, [supervisor, "--foreground", "--root", root, "--role", "editor",
    "--parent", "card-01", "--id", "budgeted", "--work-dir", root, "--wake-dir", path.join(root, "wake"),
    "--prompt", prompt, "--result-file", supervised.result, "--floor", "1K", "--budget", "8M", "--timeout", "15"],
    { timeout: 30000 });
  assert.equal((await readLedger(root, "editor")).items.find(item => item.id === "budgeted").profile.model, "model-a");
  const interruptedOpts = { ...opts, id: "queued", result: "queued.json" };
  const supervisedEnv = { ...process.env, WORKER_RUNNER_ID: "queued", WORKER_RUNNER_DISPATCH: "test-dispatch", WORKER_RUNNER_ATTEMPT: "1" };
  const first = await startWorkerRun({ ...interruptedOpts, foreground: false }, [], { env: supervisedEnv, runner: async () => {} });
  assert.equal(first.status, "running");
  const resumed = await startWorkerRun(interruptedOpts, [], { env: { ...supervisedEnv, WORKER_RUNNER_ATTEMPT: "2", WORKER_RUNNER_RESUME: "1" } });
  assert.equal(resumed.parent, "card-01");
  assert.equal(resumed.status, "done");
  assert.equal(resumed.supervisor.attempt, 2);
  assert.equal((await readLedger(root, "editor")).items.find(item => item.id === "queued").reason, "supervisor-preempted");
  const settled = await startWorkerRun(interruptedOpts, [], { env: { ...supervisedEnv, WORKER_RUNNER_ATTEMPT: "3", WORKER_RUNNER_RESUME: "1" } });
  assert.equal(settled.id, resumed.id);
  assert.equal((await readLedger(root, "editor")).items.filter(item => item.supervisor?.id === "queued").length, 2);
  const review = { ...opts, result: "review.json", "review-of": "writer-run" };
  profile.tiers["4"].candidates[0].family = "family-a";
  await writeFile(profileFile, JSON.stringify(profile));
  await assert.rejects(startWorkerRun(review, []), /different configured model family/);
  profile.tiers["4"].candidates[0].family = "family-b";
  await writeFile(profileFile, JSON.stringify(profile));
  const reviewed = await startWorkerRun(review, []);
  assert.equal(reviewed.review_of, run.id);
  assert.equal(reviewed.profile.family, "family-b");
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "review.json"))), { model: "model-b", effort: "high", role: "editor", parent: "card-01", text: "Read the same card.\n" });
});

test("a card keeps its shuffled producer and reviews with another configured family", async () => {
  const { root } = await setup({ roles: [{ role: "editor", tier_profile: "config/team.json" }] });
  const prompt = path.join(root, "prompt.md");
  await writeFile(prompt, "Review the card.");
  const candidates = ["first", "second"].map(id => ({
    id, family: id, cli: process.execPath, model: id + "-model", result_mode: "stdout",
    argv: ["{cli}", "-e", "process.stdout.write(process.argv[1])", "{model}"],
  }));
  const pool = { tier: 2, selection: "shuffle" };
  const profile = { tiers: { 2: { candidates } }, worker_steps: { implementation: pool, review: pool } };
  const save = () => writeFile(path.join(root, "config/team.json"), JSON.stringify(profile));
  await save();
  const choices = new Set();
  for (let i = 0; i < 24; i++) {
    const parent = "source-" + i;
    await ledgerMain(["add", "--root", root, "--role", "editor", "--id", parent, "--title", "Draft",
      "--channel", "source", "--msg-id", String(1000 + i), "--due", "2026-11-22T12:00:00Z"]);
    const opts = { root, role: "editor", parent, id: "worker-" + i, name: "draft", result: parent + ".txt", prompt, foreground: true };
    const dry = await startWorkerRun({ ...opts, dry: true }, []);
    choices.add(dry.profile.candidate);
    if (i !== 0) continue;
    candidates.reverse();
    await save();
    const produced = await startWorkerRun(opts, []);
    assert.equal(produced.profile.model, dry.profile.model);
    assert.equal(await readFile(path.join(root, opts.result), "utf8"), produced.profile.model);
    const review = { ...opts, id: "review-0", "review-of": produced.id, result: "review-0.txt" };
    const reviewed = await startWorkerRun(review, []);
    assert.notEqual(reviewed.profile.family, produced.profile.family);
    assert.equal(await readFile(path.join(root, review.result), "utf8"), reviewed.profile.model);
    profile.tiers[2].candidates = candidates.filter(c => c.family === produced.profile.family);
    await save();
    await assert.rejects(startWorkerRun({ ...review, id: "review-blocked" }, []), /different configured model family/);
    profile.tiers[2].candidates = candidates;
    await save();
  }
  assert.deepEqual(choices, new Set(["first", "second"]));
});

test("a tier-one card tries its configured order only when a sensor is unavailable", async () => {
  const { root } = await setup({ roles: [{ role: "triage", tier_profile: "config/team.json" }] });
  const prompt = path.join(root, "message.md");
  const program = path.join(root, "sensor.mjs");
  const trace = path.join(root, "attempts.log");
  await writeFile(prompt, "message for classification");
  await writeFile(program, `
    import { appendFileSync, readFileSync } from "node:fs";
    const [model, behavior, trace] = process.argv.slice(2);
    appendFileSync(trace, model + "\\n");
    if (behavior === "partial") process.stdout.write("an incomplete decision");
    if (behavior === "unavailable" || behavior === "partial") process.exit(75);
    if (behavior === "error") process.exit(2);
    process.stdout.write(model + ":" + readFileSync(0, "utf8"));
  `);
  const sensor = (id, behavior) => ({
    id, cli: process.execPath, family: id, model: id, result_mode: "stdout",
    argv: ["{cli}", program, "{model}", behavior, trace], unavailable_exit_codes: [75],
  });
  const first = sensor("first", "unavailable");
  const second = sensor("second", "ok");
  const profile = { tiers: { 1: { candidates: [first, second] }, 2: { candidates: [second] } },
    worker_steps: { classify: { tier: 1, selection: "ordered" } } };
  const file = path.join(root, "config/team.json");
  const save = () => writeFile(file, JSON.stringify(profile));
  await save();
  await ledgerMain(["add", "--root", root, "--role", "triage", "--id", "message", "--worker-step", "classify",
    "--title", "Classify", "--channel", "inbox", "--msg-id", "42", "--due", "2026-11-22T12:00:00Z"]);
  const opts = { root, role: "triage", parent: "message", name: "classify", prompt, result: "decision", foreground: true };
  const plan = await startWorkerRun({ ...opts, dry: true }, []);
  assert.equal(plan.profile.model, "first");
  const run = await startWorkerRun({ ...opts, id: "foreground" }, []);
  assert.equal(run.status, "done");
  assert.equal(run.profile.model, "second");
  assert.equal(run.from.msg_id, "42");
  assert.equal(run.profile_attempts[0].profile.model, "first");
  assert.equal(run.profile_attempts[0].exit, 75);
  assert.ok(run.profile_attempts[0].pid && run.profile_attempts[0].started_at);
  assert.equal(await readFile(trace, "utf8"), "first\nsecond\n");
  assert.equal(await readFile(path.join(root, "decision"), "utf8"), "second:message for classification");
  for (const [index, behavior] of ["partial", "error", "ok"].entries()) {
    first.argv[3] = behavior;
    await save();
    await writeFile(trace, "");
    const actual = await startWorkerRun({ ...opts, id: "one-" + index }, []);
    assert.equal(actual.status, behavior === "ok" ? "done" : "failed");
    assert.equal(actual.profile.model, "first");
    assert.equal(await readFile(trace, "utf8"), "first\n");
    if (behavior !== "ok") assert.equal(await readFile(path.join(root, "decision"), "utf8"), "second:message for classification");
  }
  first.cli = path.join(root, "absent-sensor");
  await save();
  const detached = { ...opts, id: "unit", foreground: false };
  const command = (await startWorkerRun({ ...detached, dry: true }, [])).command;
  await startWorkerRun(detached, [], { runner: async () => {} });
  const repaired = await execWorkerRun(detached, command);
  assert.equal(repaired.item.status, "done");
  assert.equal(repaired.item.profile.candidate, "second");
  assert.equal(repaired.item.profile_attempts[0].exit, 127);
  assert.equal(repaired.item.profile_attempts[0].started_at, null);
  const supervised = { ...opts, id: "supervised" };
  const env = { ...process.env, WORKER_RUNNER_ID: supervised.id, WORKER_RUNNER_DISPATCH: "slot", WORKER_RUNNER_ATTEMPT: "1" };
  await writeFile(trace, "");
  assert.equal((await startWorkerRun(supervised, [], { env })).status, "done");
  const reuse = await startWorkerRun(supervised, [], { env: { ...env, WORKER_RUNNER_ATTEMPT: "2" } });
  assert.equal(reuse.id, supervised.id);
  assert.equal(await readFile(trace, "utf8"), "second\n");
  const reserved = { ...detached, id: "reserved" };
  await startWorkerRun(reserved, [], { runner: async () => {} });
  first.unavailable_exit_codes = [78];
  await save();
  await assert.rejects(execWorkerRun(reserved, command), /profile changed after reservation/);
  assert.equal(await readFile(trace, "utf8"), "second\n");
  profile.worker_steps.classify.tier = 2;
  await save();
  await assert.rejects(startWorkerRun({ ...opts, dry: true }, []), /tier 1/i);
});

test("a profile can publish a CLI answer from stdout and preserve the last result on failure", async () => {
  const { root } = await setup({ roles: [{ role: "editor" }] });
  const prompt = path.join(root, "instruction.md");
  await writeFile(prompt, "Only the answer.");
  const program = path.join(root, "reply.mjs");
  await writeFile(program, `import fs from "node:fs"; process.stdout.write(fs.readFileSync(0)); process.stderr.write("progress"); process.exitCode = Number(process.argv[2]);`);
  const candidate = { id: "writer", family: "writer", cli: process.execPath, model: "test-model",
    result_mode: "stdout", argv: ["{cli}", program, "0", "{model}"] };
  const profile = { tiers: { "2": { candidates: [candidate] } }, worker_steps: { write: { tier: 2, candidate: "writer" } } };
  const save = () => writeFile(path.join(root, "config/tier-profile.json"), JSON.stringify(profile));
  await save();
  await ledgerMain(["add", "--root", root, "--role", "editor", "--id", "card", "--worker-step", "write",
    "--title", "test", "--channel", "source", "--msg-id", "1234", "--due", "2026-11-23T00:00:00Z"]);
  const opts = { root, role: "editor", parent: "card", prompt, cwd: root, result: "result.md", name: "answer", foreground: true };
  const resources = { stdio: ["ignore", "ignore", "ignore"] };
  const result = path.join(root, "result.md");
  await writeFile(result, "previous result");
  const done = await startWorkerRun({ ...opts, id: "success" }, [], resources);
  assert.equal(done.status, "done");
  assert.equal(done.profile.result_mode, "stdout");
  assert.equal(await readFile(result, "utf8"), "Only the answer.");
  await writeFile(prompt, "partial reply");
  candidate.argv[2] = "8";
  await save();
  const failed = await startWorkerRun({ ...opts, id: "failed" }, [], resources);
  assert.equal(failed.status, "failed");
  assert.equal(failed.exit, 8);
  assert.equal(await readFile(result, "utf8"), "Only the answer.");
  candidate.argv[2] = "0";
  await save();
  await writeFile(prompt, "");
  const empty = await startWorkerRun({ ...opts, id: "empty" }, [], resources);
  assert.equal(empty.reason, "stdout-result-failed");
  assert.equal(await readFile(result, "utf8"), "Only the answer.");
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith(".adk-stdout-")), []);
  candidate.argv.push("{result_file}");
  await save();
  await assert.rejects(startWorkerRun({ ...opts, id: "ambiguous" }, [], resources), /cannot also write/);
});

test("start & finish lifecycle: opens running row, launches systemd-run --user, closes done/failed by exit & result", async () => {
  const { root } = await setup();
  const fake = systemdFake();

  // Add a parent task row first so channel & parent linking can be verified.
  await ledgerMain([
    "add", "--root", root, "--role", "minho", "--id", "task-100",
    "--title", "부모 일감", "--due", "2026-11-18T12:00:00Z",
    "--channel", "ch-parent", "--msg-id", "9001", "--quote", "요청",
  ], { now });

  // Dry run writes nothing and executes no runner.
  const dryRes = await startWorkerRun(
    { root, role: "minho", parent: "task-100", name: "dry-check", result: "results/dry.md", dry: true, "strict-parent": true },
    ["codex", "exec", "plan"],
    { runner: fake.runner, now },
  );
  assert.equal(dryRes.event, "worker-dry");
  assert.equal(fake.calls.length, 0);
  assert.equal((await readLedger(root, "minho")).items.length, 1);

  // Real start writes running row BEFORE systemd-run and records full schema.
  const started = await startWorkerRun(
    { root, role: "minho", parent: "task-100", name: "impl-pass", result: "results/impl.md", id: "w-impl", "strict-parent": true },
    ["codex", "exec", "implement"],
    { runner: fake.runner, now, env: { ...process.env, TEST_BOT_TOKEN: "secret-should-not-leak" } },
  );
  assert.equal(started.event, "worker-started");
  assert.equal(started.status, "running");
  assert.equal(started.kind, "worker");
  assert.equal(started.role, "minho");
  assert.equal(started.parent, "task-100");
  assert.equal(started.tool, "codex");
  assert.equal(started.ended, null);
  assert.equal(started.exit, null);
  assert.equal(started.result, path.join(root, "results/impl.md"));
  assert.equal(started.from.channel, "ch-parent");
  assert.equal(started.from.msg_id, "-");
  assert.equal(started.worker, null);

  const launchCall = fake.calls.find((c) => c.command === "systemd-run");
  assert.ok(launchCall);
  assert.ok(launchCall.args.includes("--user"));
  assert.ok(launchCall.args.includes("--collect"));
  assert.ok(launchCall.args.includes(`--unit=${started.unit}`));
  assert.ok(launchCall.args.includes(`--working-directory=${root}`));
  assert.ok(launchCall.args.some((a) => a.startsWith("--property=StandardOutput=append:")));
  assert.ok(launchCall.args.includes("_exec"));
  assert.ok(!launchCall.args.some((a) => a.includes("secret-should-not-leak")));

  // Exit 0 WITHOUT result file => failed (result-missing).
  const noResult = await finishWorkerRun({ root, role: "minho", id: "w-impl", exit: 0 }, { now: now + MIN });
  assert.equal(noResult.status, "failed");
  assert.equal(noResult.exit, 0);
  assert.equal(noResult.reason, "result-missing");
  assert.equal(noResult.ended, new Date(now + MIN).toISOString());

  // Already closed worker cannot be re-finished.
  await assert.rejects(finishWorkerRun({ root, role: "minho", id: "w-impl", exit: 0 }), /already failed/);

  // Empty 0-byte result file => failed (result-empty).
  await startWorkerRun(
    { root, role: "minho", parent: "task-100", name: "empty-res", result: "results/empty.md", id: "w-empty" },
    ["agy", "run"],
    { runner: fake.runner, now },
  );
  await writeFile(path.join(root, "results/empty.md"), "");
  const emptyRes = await finishWorkerRun({ root, role: "minho", id: "w-empty", exit: 0 }, { now: now + MIN });
  assert.equal(emptyRes.status, "failed");
  assert.equal(emptyRes.reason, "result-empty");

  // Non-zero exit code EVEN WITH non-empty result file => failed (exit-nonzero).
  await startWorkerRun(
    { root, role: "minho", parent: "task-100", name: "nonzero", result: "results/nonzero.md", id: "w-nonzero" },
    ["codex", "exec"],
    { runner: fake.runner, now },
  );
  await writeFile(path.join(root, "results/nonzero.md"), "partial output\n");
  const nonzeroRes = await finishWorkerRun({ root, role: "minho", id: "w-nonzero", exit: 2 }, { now: now + MIN });
  assert.equal(nonzeroRes.status, "failed");
  assert.equal(nonzeroRes.exit, 2);
  assert.equal(nonzeroRes.reason, "exit-nonzero");

  // Stale pre-existing result file that was not updated => failed (result-unchanged).
  await writeFile(path.join(root, "results/stale.md"), "old content\n");
  await startWorkerRun(
    { root, role: "minho", name: "stale-test", result: "results/stale.md", id: "w-stale" },
    ["muse", "exec"],
    { runner: fake.runner, now },
  );
  const staleRes = await finishWorkerRun({ root, role: "minho", id: "w-stale", exit: 0 }, { now: now + MIN });
  assert.equal(staleRes.status, "failed");
  assert.equal(staleRes.reason, "result-unchanged");

  // Exit 0 + valid fresh non-empty result => done!
  await startWorkerRun(
    { root, role: "minho", parent: "task-100", name: "success-job", result: "results/ok.md", id: "w-ok" },
    ["codex", "exec"],
    { runner: fake.runner, now },
  );
  await writeFile(path.join(root, "results/ok.md"), "# Result\ndone\n");
  const okRes = await finishWorkerRun({ root, role: "minho", id: "w-ok", exit: 0 }, { now: now + 2 * MIN });
  assert.equal(okRes.status, "done");
  assert.equal(okRes.exit, 0);
  assert.equal(okRes.reason, null);
  assert.equal(okRes.ended, new Date(now + 2 * MIN).toISOString());

  // listWorkerRuns filters by status cleanly.
  assert.equal((await listWorkerRuns({ root, status: "running" })).length, 0);
  assert.equal((await listWorkerRuns({ root, status: "done" })).length, 1);
  assert.equal((await listWorkerRuns({ root, status: "failed" })).length, 4);
});

test("launch failure and fast-finish startup race handling", async () => {
  const { root } = await setup();

  // Launch failure marks row failed with launch-failed.
  await assert.rejects(
    startWorkerRun(
      { root, role: "minho", name: "bad-launch", result: "results/fail.md", id: "w-launch-fail" },
      ["codex", "exec"],
      { runner: async () => { throw new Error("systemd bus unavailable"); }, now },
    ),
    /systemd bus unavailable/,
  );
  const failedRow = (await readLedger(root, "minho")).items.find((i) => i.id === "w-launch-fail");
  assert.equal(failedRow.status, "failed");
  assert.equal(failedRow.reason, "launch-failed");
  assert.equal(failedRow.exit, null);
  assert.equal(failedRow.launch_pending, false);

  // If _exec finishes BEFORE runner("systemd-run") resolves, parent must NOT revert status back to running.
  const raceRunner = async () => {
    await writeFile(path.join(root, "results/race.md"), "fast done\n");
    await finishWorkerRun({ root, role: "minho", id: "w-race", exit: 0 }, { now: now + 50 });
    return "";
  };
  const raceOut = await startWorkerRun(
    { root, role: "minho", name: "race", result: "results/race.md", id: "w-race" },
    ["codex", "exec"],
    { runner: raceRunner, now },
  );
  assert.equal(raceOut.event, "worker-finished");
  assert.equal(raceOut.status, "done");
  assert.equal(raceOut.exit, 0);
});

test("real subprocess execution via _exec and --foreground strips bot tokens and updates status", async () => {
  const { root } = await setup();

  // 1. _exec subprocess succeeds & writes result while stripping TEST_BOT_TOKEN.
  const fake = systemdFake();
  await startWorkerRun(
    { root, role: "minho", name: "exec-ok", result: "results/exec-ok.md", id: "w-exec-ok" },
    [process.execPath, "-e", "require('node:fs').writeFileSync(process.env.LEDGER_RESULT_FILE, 'token=' + (process.env.TEST_BOT_TOKEN || 'none') + ' role=' + process.env.LEDGER_ROLE)"],
    { runner: fake.runner, now },
  );
  const resOk = await execWorkerRun(
    { root, role: "minho", id: "w-exec-ok" },
    [process.execPath, "-e", "require('node:fs').writeFileSync(process.env.LEDGER_RESULT_FILE, 'token=' + (process.env.TEST_BOT_TOKEN || 'none') + ' role=' + process.env.LEDGER_ROLE)"],
    { env: { ...process.env, TEST_BOT_TOKEN: "top-secret" }, stdio: ["ignore", "ignore", "ignore"] },
  );
  assert.equal(resOk.exitCode, 0);
  assert.equal(resOk.item.status, "done");
  assert.ok(Number.isInteger(resOk.item.pid) && resOk.item.pid > 0);
  assert.equal(await readFile(path.join(root, "results/exec-ok.md"), "utf8"), "token=none role=minho");

  // 2. --foreground mode exits non-zero when child fails.
  const fgFail = await startWorkerRun(
    { root, role: "minho", name: "fg-fail", result: "results/fg-fail.md", id: "w-fg-fail", foreground: true },
    [process.execPath, "-e", "process.exit(3)"],
    { now, stdio: ["ignore", "ignore", "ignore"] },
  );
  assert.equal(fgFail.status, "failed");
  assert.equal(fgFail.exit, 3);
  assert.equal(fgFail.unit, null);
  assert.equal(fgFail.reason, "exit-nonzero");
});

test("dead-unit detection in ledger-watch and due-timer closes vanished/failed units and handles probe errors safely", async () => {
  const { root, config } = await setup();
  const fake = systemdFake();

  // Start worker -> unit is active in fake systemd.
  const started = await startWorkerRun(
    { root, role: "minho", name: "long-worker", result: "results/long.md", id: "w-alive" },
    ["codex", "exec"],
    { runner: fake.runner, now },
  );

  // While unit is active, watch keeps it running and emits 0 wakes.
  const tickAlive = await watch({ root, config, runner: fake.runner, now: now + MIN });
  assert.equal(tickAlive.wakes.length, 0);
  assert.equal((await readLedger(root, "minho")).items[0].status, "running");

  // Probe failure (D-Bus offline) must fail closed: keep running and emit probe error wake.
  const brokenWatch = await watch({
    root,
    config,
    runner: async () => { throw new Error("Failed to connect to bus"); },
    now: now + 2 * MIN,
  });
  assert.ok(brokenWatch.errors.includes("worker-reconcile:minho"));
  assert.equal((await readLedger(root, "minho")).items[0].status, "running");

  // Unit disappears (LoadState=not-found, systemd dummy ExecMainStatus=0) => closes failed with unit-missing + wakes role once.
  fake.units.delete(started.unit);
  const deadWatch = await watch({ root, config, runner: fake.runner, now: now + 3 * MIN });
  const closedItem = (await readLedger(root, "minho")).items[0];
  assert.equal(closedItem.status, "failed");
  assert.equal(closedItem.exit, null);
  assert.equal(closedItem.reason, "unit-missing");
  assert.ok(deadWatch.wakes.some((w) => w.role === "minho" && w.reason === "일꾼 유닛 사라짐"));
  const wakeFiles = await readdir(path.join(root, ".agents/work/l4/wake"));
  assert.ok(wakeFiles.some((f) => f.includes("worker-dead-w-alive")));

  // Next watch pass sees it already closed => no repeat wake.
  const nextWatch = await watch({ root, config, runner: fake.runner, now: now + 4 * MIN });
  assert.equal(nextWatch.wakes.filter((w) => w.reason === "일꾼 유닛 사라짐").length, 0);

  // Test ActiveState=failed with ExecMainStatus=137.
  const s2 = await startWorkerRun(
    { root, role: "minho", name: "killed-unit", result: "results/killed.md", id: "w-killed" },
    ["agy", "run"],
    { runner: fake.runner, now: now + 5 * MIN },
  );
  fake.units.set(s2.unit, {
    LoadState: "loaded",
    ActiveState: "failed",
    SubState: "failed",
    Result: "signal",
    ExecMainPID: "0",
    ExecMainStatus: "137",
  });
  const recFailed = await reconcileWorkerRuns({ root, config, runner: fake.runner, now: now + 6 * MIN });
  assert.equal(recFailed.closed[0].status, "failed");
  assert.equal(recFailed.closed[0].exit, 137);
  assert.equal(recFailed.closed[0].reason, "unit-failed");

  // Test uncollected loaded inactive/dead with Result=success, ExecMainStatus=0 + valid result => done!
  const s3 = await startWorkerRun(
    { root, role: "minho", name: "uncollected-ok", result: "results/uncollected.md", id: "w-uncollected" },
    ["muse", "exec"],
    { runner: fake.runner, now: now + 7 * MIN },
  );
  await writeFile(path.join(root, "results/uncollected.md"), "finished cleanly\n");
  fake.units.set(s3.unit, {
    LoadState: "loaded",
    ActiveState: "inactive",
    SubState: "dead",
    Result: "success",
    ExecMainPID: "0",
    ExecMainStatus: "0",
  });
  const recOk = await reconcileWorkerRuns({ root, config, runner: fake.runner, now: now + 8 * MIN });
  assert.equal(recOk.closed[0].status, "done");
  assert.equal(recOk.closed[0].exit, 0);

  // Test due-timer reconcileCurrent also closes dead units when due_timer is enabled.
  const dueCfg = { ...config, due_timer: { enabled: true } };
  await approveFixture(root, dueCfg);
  const s4 = await startWorkerRun(
    { root, role: "minho", name: "due-reconcile", result: "results/due.md", id: "w-due" },
    ["codex", "exec"],
    { runner: fake.runner, now: now + 9 * MIN },
  );
  fake.units.delete(s4.unit);
  const dueWarnings = await reconcileCurrent({
    root,
    config: dueCfg,
    roles: ["minho"],
    now: now + 10 * MIN,
    runner: fake.runner,
  });
  assert.deepEqual(dueWarnings, []);
  const dueClosed = (await readLedger(root, "minho")).items.find((i) => i.id === "w-due");
  assert.equal(dueClosed.status, "failed");
  assert.equal(dueClosed.reason, "unit-missing");

  // Startup grace prevents premature closure while launch_pending is still true within 5 seconds.
  await changeLedger(root, "minho", async (l) => {
    l.items.push({
      id: "w-starting",
      kind: "worker",
      title: "starting",
      name: "starting",
      role: "minho",
      parent: null,
      unit: workerUnitName(root, "minho", "w-starting"),
      tool: "codex",
      status: "running",
      started: new Date(now + 10 * MIN).toISOString(),
      ended: null,
      result: path.join(root, "results/starting.md"),
      exit: null,
      launch_pending: true,
      from: { channel: "", msg_id: "-", quote: "" },
      due: new Date(now + 10 * MIN).toISOString(),
      created_at: new Date(now + 10 * MIN).toISOString(),
      worker: null,
      checked_at: null,
      note: "",
    });
  });
  const graceRec = await reconcileWorkerRuns({ root, config, runner: fake.runner, now: now + 10 * MIN + 1000 });
  assert.equal(graceRec.closed.length, 0);
  const afterGraceRec = await reconcileWorkerRuns({ root, config, runner: fake.runner, now: now + 10 * MIN + 6000 });
  assert.equal(afterGraceRec.closed.length, 1);
  assert.equal(afterGraceRec.closed[0].id, "w-starting");
});

test("coexistence with existing ledger rows, due-timer, drive, ledger-watch, and schema validation", async () => {
  const { root, config } = await setup();
  const fake = systemdFake();
  const PAST = "2026-11-18T04:00:00Z";
  const FUTURE = "2026-11-18T12:00:00Z";

  // 1. Add regular task card and legacy worker field card.
  await ledgerMain([
    "add", "--root", root, "--role", "minho", "--id", "card-open",
    "--title", "일반 일감", "--due", FUTURE, "--channel", "ch-1", "--msg-id", "human-1",
  ], { now });

  // 2. Add worker run rows (running & done) with past due dates.
  await startWorkerRun(
    { root, role: "minho", parent: "card-open", name: "worker-coexist", result: "results/co.md", id: "w-co", due: PAST },
    ["codex", "exec"],
    { runner: fake.runner, now },
  );

  // 3. ledger.mjs list & touch work; done/drop/due reject worker items.
  const listed = await ledgerMain(["list", "--root", root, "--role", "minho"], { now });
  assert.match(listed, /card-open \[open\]/);
  assert.match(listed, /w-co \[running\]/);
  await ledgerMain(["touch", "w-co", "--root", root, "--role", "minho"], { now });
  const touched = (await readLedger(root, "minho")).items.find((i) => i.id === "w-co");
  assert.ok(touched.checked_at !== null);
  await assert.rejects(ledgerMain(["done", "w-co", "--root", root, "--role", "minho"]), /worker-run\.mjs/);
  await assert.rejects(ledgerMain(["drop", "w-co", "--root", root, "--role", "minho", "--reason", "x"]), /worker-run\.mjs/);
  await assert.rejects(ledgerMain(["due", "w-co", "--root", root, "--role", "minho", "--due", FUTURE, "--reason", "x"]), /worker-run\.mjs/);

  // 4. due-timer plan() never creates timers for worker rows (even with due in the past).
  const ledger = await readLedger(root, "minho");
  const actions = planDueTimers({ root, ledgers: [ledger], timers: [], now });
  assert.deepEqual(actions.map((a) => [a.type, a.id]), [["arm", "card-open"]]);

  // 5. ledger-watch never wakes for overdue on kind=worker rows while active,
  //    but still wakes normally for an overdue regular task card in the same ledger.
  const watchRes = await watch({ root, config, runner: fake.runner, now });
  assert.equal(watchRes.wakes.length, 0);
  await ledgerMain([
    "add", "--root", root, "--role", "minho", "--id", "card-overdue",
    "--title", "기한 지난 일반 일감", "--due", PAST, "--channel", "ch-1", "--msg-id", "human-2",
  ], { now });
  const watchMixed = await watch({ root, config, runner: fake.runner, now });
  assert.deepEqual(watchMixed.wakes.map((w) => [w.id, w.reason]), [["card-overdue", "기한 넘음"]]);

  // 6. drive.tick() ignores kind=worker rows.
  const driveCfg = {
    ...config,
    drive: {
      enabled: true,
      worker: { command: [process.execPath, "-e", "process.exit(0)"], models: ["m1"] },
      disk: { path: root, min_free_gb: 0 },
    },
  };
  const driveOut = await driveTick({ root, config: driveCfg, now });
  assert.deepEqual(driveOut.launched, []);

  // 7. Parent human card drop/defer counts are unaffected by child worker rows.
  await ledgerMain(["drop", "card-open", "--root", root, "--role", "minho", "--reason", "취소1"], { now });
  assert.equal((await readLedger(root, "minho")).items.find((i) => i.id === "card-open").status, "dropped");

  // 8. validateLedger rejects malformed worker rows.
  const bad = structuredClone(await readLedger(root, "minho"));
  bad.items[1].status = "open";
  assert.throws(() => validateLedger(bad, "minho"), /Invalid ledger item/);

  const badEnded = structuredClone(await readLedger(root, "minho"));
  badEnded.items[1].ended = new Date(now).toISOString();
  assert.throws(() => validateLedger(badEnded, "minho"), /Invalid ledger item/);

  const badSelfParent = structuredClone(await readLedger(root, "minho"));
  badSelfParent.items[1].parent = badSelfParent.items[1].id;
  assert.throws(() => validateLedger(badSelfParent, "minho"), /Invalid ledger item/);

  const badUnit = structuredClone(await readLedger(root, "minho"));
  badUnit.items[1].unit = "not a valid unit";
  assert.throws(() => validateLedger(badUnit, "minho"), /Invalid ledger item/);
});

test("CLI execution: worker-run.mjs start/finish/list/reconcile with injected fake PATH binaries", async () => {
  const { root } = await setup();
  const binDir = path.join(root, "bin");
  await mkdir(binDir, { recursive: true });
  const fakeLog = path.join(root, "fake-systemd.log");
  await writeFile(
    path.join(binDir, "systemd-run"),
    `#!/usr/bin/env node\nconst fs = require("node:fs");\nfs.appendFileSync(${JSON.stringify(fakeLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`,
  );
  await writeFile(
    path.join(binDir, "systemctl"),
    `#!/usr/bin/env node\nconsole.log("LoadState=not-found\\nActiveState=inactive\\nSubState=dead\\nResult=success\\nExecMainPID=0\\nExecMainStatus=0");\n`,
  );
  await chmod(path.join(binDir, "systemd-run"), 0o755);
  await chmod(path.join(binDir, "systemctl"), 0o755);

  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
  delete env.NODE_TEST_CONTEXT;

  const { stdout: startOut } = await execFileAsync(
    process.execPath,
    [workerRunScript, "--root", root, "--role", "minho", "--name", "cli-test", "--result", "results/cli.md", "--id", "w-cli", "--", "codex", "exec", "hello"],
    { env },
  );
  const started = JSON.parse(startOut);
  assert.equal(started.event, "worker-started");
  assert.equal(started.id, "w-cli");

  const { stdout: listOut } = await execFileAsync(
    process.execPath,
    [workerRunScript, "list", "--root", root, "--status", "running", "--json"],
    { env },
  );
  assert.equal(JSON.parse(listOut).length, 1);

  const { stdout: recOut } = await execFileAsync(
    process.execPath,
    [workerRunScript, "reconcile", "--root", root],
    { env },
  );
  const reconciled = JSON.parse(recOut);
  assert.equal(reconciled.closed.length, 1);
  assert.equal(reconciled.closed[0].status, "failed");
  assert.equal(reconciled.closed[0].reason, "unit-missing");
});
