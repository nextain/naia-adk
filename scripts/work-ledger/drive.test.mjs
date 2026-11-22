import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { main, readLedger, changeLedger, ledgerPath } from "./ledger.mjs";
import { watch } from "./ledger-watch.mjs";
import { fire, receiptPath } from "./due-timer.mjs";
import { approveFixture } from "./due-test-helper.mjs";

const run = promisify(execFile);
const ledgerScript = fileURLToPath(new URL("./ledger.mjs", import.meta.url));
const drive = () => import("./drive.mjs");
const now = Date.parse("2026-11-14T12:00:00Z");
const MIN = 60000;
const PAST = "2026-11-14T11:00:00Z";
const FUTURE = "2026-11-14T13:00:00Z";
const roots = [];
const pids = [];
test.after(async () => {
  for (const pid of pids) try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

const WORKER = `
import { writeFileSync, existsSync } from "node:fs";
let input = "";
process.stdin.on("data", (data) => { input += data; });
process.stdin.on("end", async () => {
  const result = process.env.LEDGER_RESULT_FILE;
  if (process.env.WORKER_MODE === "hold")
    while (!existsSync(result + ".release")) await new Promise((resolve) => setTimeout(resolve, 20));
  writeFileSync(result, "model=" + process.argv[2] + " token=" + (process.env.TEST_TOKEN ?? "none") + "\\n" + input);
});
`;
// Fails unless <root>/notify-ok exists; hangs when <root>/notify-hang exists.
const NOTIFY = `
import { existsSync, appendFileSync } from "node:fs";
const root = process.argv[2];
process.stdin.resume();
process.stdin.on("end", () => {
  if (existsSync(root + "/notify-hang")) return setInterval(() => {}, 1000);
  if (!existsSync(root + "/notify-ok")) process.exit(1);
  appendFileSync(root + "/notify-log", process.env.LEDGER_ROLE + " " + process.env.LEDGER_ALERT + "\\n");
});
`;
// The lead's box is the top wake folder and the writer's box is a folder
// inside it: a notice written to the wrong one is delivered to the wrong role.
const LEAD_BOX = ".agents/work/l4/wake";
const WRITER_BOX = ".agents/work/l4/wake/writer";
async function setup(change = (config) => config) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ledger-drive-"));
  roots.push(root);
  await writeFile(path.join(root, "worker.mjs"), WORKER);
  await writeFile(path.join(root, "notify.mjs"), NOTIFY);
  await writeFile(path.join(root, "task.md"), "초안을 검토해 결과 파일에 적는다\n");
  const config = change({
    version: 1,
    provider: { type: "discord", token_env: "TEST_TOKEN" },
    roles: [
      { role: "lead", wake_dir: LEAD_BOX },
      { role: "writer", wake_dir: WRITER_BOX },
    ],
    drive: {
      enabled: true,
      worker: { command: [process.execPath, path.join(root, "worker.mjs"), "{model}"], models: ["model-a"], max_parallel: 2, max_attempts: 3, retry_min: 30 },
      disk: { path: root, min_free_gb: 0 },
      notify: { repeat_min: 60 },
      owner_ids: ["900"],
    },
  });
  await mkdir(path.join(root, "config"), { recursive: true });
  await writeFile(path.join(root, "config/work-ledger.json"), JSON.stringify(config));
  return { root, config };
}
const cli = (root, ...args) => main([...args, "--root", root], { now });
const addDriven = (root, role, id, due = PAST, extra = []) =>
  cli(root, "add", "--role", role, "--id", id, "--title", `일 ${id}`, "--due", due, "--channel", "111", "--msg-id", "222",
    "--prompt", "task.md", "--result-file", `results/${id}.md`, "--model", "model-a", ...extra);
const pass = async (root, config, at = now, options = {}) => {
  const out = await (await drive()).tick({ root, config, now: at, env: { ...process.env, TEST_TOKEN: "secret" }, ...options });
  for (const entry of out.launched) if (entry.pid) pids.push(entry.pid);
  return out;
};
const box = async (root, dir) => {
  try {
    return (await readdir(path.join(root, dir), { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => entry.name);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
};
const boxText = async (root, dir) =>
  (await Promise.all((await box(root, dir)).map((name) => readFile(path.join(root, dir, name), "utf8")))).join("\n");
const item = async (root, role, id) => (await readLedger(root, role)).items.find((entry) => entry.id === id);
async function until(check, what) {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out: ${what}`);
}
const reasons = (out) => out.alerts.map((entry) => `${entry.role}:${entry.id}:${entry.reason}:${entry.delivered}`);

// ---- 갈래 B-1: 지금 쓰는 장부를 깨지 않음 ----

for (const withDrive of [false, true])
  test(`ordinary work records its result through the CLI (${withDrive ? "drive configured" : "no configuration"})`, async () => {
    const { root } = await setup();
    if (!withDrive) await rm(path.join(root, "config/work-ledger.json"));
    const config = withDrive ? ["--config", path.join(root, "config/work-ledger.json")] : [];
    const env = { ...process.env, ADK_FORBID_SYSTEM_RUNNER: "1" };
    delete env.NODE_TEST_CONTEXT;
    const call = async (...args) => (await run(process.execPath, [ledgerScript, ...args], { cwd: root, env })).stdout.trim();
    // Promise-only registration, as the post guard instructs: title, due, channel, message.
    const first = await call("add", "--role", "lead", "--title", "15시까지 올림", "--due", "2099-01-02T06:00:00Z", "--channel", "111", "--msg-id", "222");
    const second = await call("add", "--role", "lead", "--title", "둘째", "--due", "2099-01-02T07:00:00Z", "--channel", "111", "--msg-id", "223", ...config);
    // The same wrapper can record a result with or without a drive configuration.
    await call("touch", first, "--role", "lead", ...config);
    const resultUrl = "https://example.org/reports/first";
    assert.equal(await call("done", first, "--role", "lead", "--result", resultUrl, ...config), first);
    await call("touch", "--id", second, "--reason", "요청자가 중단함", "--role", "lead", ...config);
    await assert.rejects(call("drop", "--id", second, "--reason", "요청자가 중단함", "--role", "lead", ...config), /--human-msg-id/);
    await assert.rejects(call("drop", "--id", second, "--reason", "요청자가 중단함", "--human-msg-id", "444", "--role", "lead", ...config), /No configured humans/);
    assert.equal(await call("report", "--role", "lead", ...config, "--channel", "111", "--msg-id", "333", "--every-min", "120"), "보고 기록");
    const ledger = await readLedger(root, "lead");
    assert.equal(ledger.items[0].result, resultUrl);
    assert.deepEqual(ledger.items.map((entry) => [entry.status, entry.checked_at !== null, entry.drive]), [["done", true, undefined], ["open", true, undefined]]);
    assert.equal(ledger.items[1].note, "요청자가 중단함");
    assert.deepEqual([ledger.report.last_msg_id, ledger.report.every_min, ledger.report.channel], ["333", 120, "111"]);
    assert.match(await call("list", "--role", "lead"), new RegExp(`${first} \\[done\\] 2099-01-02T06:00:00Z 15시까지 올림`));
  });

test("add prints only the card ID to stdout and leaves it last when the shell merges stderr", async () => {
  const { root } = await setup(config => ({ ...config, intake: { enabled: true } }));
  const add = [ledgerScript, "add", "--title", "Draft", "--due", "2099-01-02T06:00:00Z",
    "--channel", "room", "--msg-id", "request", "--role", "lead", "--root", root];
  const id = "draft_1-review";
  const { stdout, stderr } = await run(process.execPath, [...add, "--id", id]);
  assert.equal(stdout, `${id}\n`);
  assert.match(stderr, /^지금부터 -?\d+분 뒤\n$/);

  // Hold stderr until the event loop is idle to reproduce a backed-up pipe deterministically.
  const bufferedStderr = "data:text/javascript," +
    "process.stderr.cork(); process.once('beforeExit', () => process.stderr.uncork());";
  const replay = await run("bash", ["-o", "pipefail", "-c", '"$@" 2>&1 | tail -n 1',
    "ledger-add", process.execPath, "--import", bufferedStderr, ...add]);
  assert.equal(replay.stdout, `${id}\n`);

  await assert.rejects(run(process.execPath, [...add, "--id", "another-card"]), {
    code: 1, stdout: "", stderr: /^Source already belongs to card .+\n$/,
  });
  assert.deepEqual((await readLedger(root, "lead")).items.map(item => item.id), [id]);
});

test("a drive pass leaves waiting_human and every item without an instruction alone", async () => {
  const { root, config } = await setup();
  for (const [id, due] of [["open-late", PAST], ["waiting", PAST], ["gone", PAST], ["promise", FUTURE]])
    await cli(root, "add", "--role", "lead", "--id", id, "--title", id, "--due", due, "--channel", "111", "--msg-id", `m-${id}`);
  await changeLedger(root, "lead", (ledger) => {
    ledger.items[1].status = "waiting_human";
    ledger.items[2].status = "dropped";
  });
  const before = await readFile(ledgerPath(root, "lead"), "utf8");
  const out = await pass(root, config);
  assert.deepEqual([out.launched, out.alerts, out.errors], [[], [], []]);
  assert.equal(await readFile(ledgerPath(root, "lead"), "utf8"), before);
  assert.deepEqual([await box(root, LEAD_BOX), await box(root, WRITER_BOX)], [[], []]);
  // The post guard reads the file directly: open items of a channel with a due time.
  const open = JSON.parse(before).items.filter((entry) => entry.status === "open" && entry.from?.channel === "111" && Date.parse(entry.due) > now);
  assert.deepEqual(open.map((entry) => entry.id), ["promise"]);
  assert.equal((await readLedger(root, "lead")).items[1].status, "waiting_human");
});

test("an instruction is optional at registration, and a bad one is refused", async () => {
  const { root } = await setup((config) => {
    config.roles.push({ role: "boxless" });
    return config;
  });
  const base = ["add", "--role", "writer", "--title", "일", "--due", FUTURE, "--channel", "111", "--msg-id", "222"];
  await cli(root, ...base, "--id", "plain");
  assert.equal((await item(root, "writer", "plain")).drive, undefined);
  await assert.rejects(cli(root, ...base, "--prompt", "task.md"), /--prompt --result-file --model/);
  await assert.rejects(cli(root, ...base, "--prompt", "none.md", "--result-file", "r.md", "--model", "model-a"), /instruction file does not exist/);
  await writeFile(path.join(root, "empty.md"), "  \n");
  await assert.rejects(cli(root, ...base, "--prompt", "empty.md", "--result-file", "r.md", "--model", "model-a"), /instruction file is empty/);
  await assert.rejects(cli(root, ...base, "--prompt", "task.md", "--result-file", "r.md", "--model", "other"), /not in drive.worker.models/);
  await writeFile(path.join(root, "old.md"), "예전 결과\n");
  await assert.rejects(cli(root, ...base, "--prompt", "task.md", "--result-file", "old.md", "--model", "model-a"), /Result file already exists/);
  await assert.rejects(
    cli(root, "add", "--role", "boxless", "--title", "일", "--due", FUTURE, "--channel", "111", "--msg-id", "222", "--prompt", "task.md", "--result-file", "r.md", "--model", "model-a"),
    /no wake_dir/,
  );
  assert.equal((await readLedger(root, "writer")).items.length, 1);
  await addDriven(root, "writer", "driven", FUTURE);
  const d = (await item(root, "writer", "driven")).drive;
  assert.deepEqual([d.prompt, d.result_file, d.model, d.run, d.closed], [path.join(root, "task.md"), path.join(root, "results/driven.md"), "model-a", null, null]);
  await changeLedger(root, "writer", (ledger) => {
    delete ledger.items[1].drive.model;
  }).then(() => assert.fail("a malformed drive field must not be written"), (error) => assert.match(error.message, /Invalid ledger item/));
});

// ---- 갈래 B-1.2: 역할별 깨움함 ----

test("an overdue instructed item starts one worker and notifies only its own role's box", async () => {
  const { root, config } = await setup();
  await addDriven(root, "writer", "draft");
  const first = await pass(root, config, now, { env: { ...process.env, TEST_TOKEN: "secret", WORKER_MODE: "hold" } });
  assert.deepEqual(first.errors, []);
  assert.deepEqual(first.launched.map((entry) => [entry.role, entry.id, entry.attempt]), [["writer", "draft", 1]]);
  assert.deepEqual(reasons(first), ["writer:draft:launched:true"]);
  assert.deepEqual(first.handled, ["writer/draft"]);
  const names = await box(root, WRITER_BOX);
  assert.equal(names.length, 1);
  assert.match(names[0], /^\d{17}-ledger-draft-route-writer\.md$/);
  assert.match(await boxText(root, WRITER_BOX), /^\[장부\] 일꾼 띄움: 일 draft\n/);
  assert.deepEqual(await box(root, LEAD_BOX), [], "nothing for another role's box");
  // Still running: no second worker, no repeated notice.
  const second = await pass(root, config, now + MIN);
  assert.deepEqual([second.launched, second.alerts, second.errors], [[], [], []]);
  assert.equal((await item(root, "writer", "draft")).drive.run.attempts, 1);
  const result = path.join(root, "results/draft.md");
  await writeFile(`${result}.release`, "");
  const { workerAlive } = await drive();
  await until(async () => existsSync(result) && !workerAlive((await item(root, "writer", "draft")).drive.run), "worker exit");
  const text = await readFile(result, "utf8");
  assert.match(text, /^model=model-a token=none\n/, "model from the item; messenger token withheld");
  assert.match(text, /초안을 검토해 결과 파일에 적는다/);
  const third = await pass(root, config, now + 2 * MIN);
  assert.deepEqual([third.launched, reasons(third)], [[], ["writer:draft:result-ready:true"]]);
  const beforeWatch = await box(root, WRITER_BOX);
  assert.equal(beforeWatch.length, 2, "one launch and one completion");
  const { watchWorkers } = await import("../work-watch.mjs");
  assert.deepEqual((await watchWorkers({ root, now: now + 3 * MIN })).wakes, []);
  assert.deepEqual(await box(root, WRITER_BOX), beforeWatch);
  assert.deepEqual(await box(root, LEAD_BOX), []);
  // Closing an instructed item needs its record.
  await assert.rejects(cli(root, "drop", "draft", "--role", "writer", "--reason", "새 기한으로 옮김"), /drop is not available/);
  await assert.rejects(cli(root, "done", "draft", "--role", "writer"), /done requires --result/);
  await assert.rejects(cli(root, "done", "draft", "--role", "writer", "--result", "results/none.md"), /missing or empty/);
  assert.equal((await item(root, "writer", "draft")).status, "open");
  await cli(root, "done", "draft", "--role", "writer", "--result", "results/draft.md");
  const closed = await item(root, "writer", "draft");
  assert.deepEqual([closed.status, closed.drive.closed.by, closed.drive.closed.result], ["done", "result", result]);
  const last = await pass(root, config, now + 3 * MIN);
  assert.deepEqual([last.launched, last.alerts, last.errors], [[], [], []]);
});

test("concurrent completion polls and a retried callback deliver one inbox message per run", async () => {
  const { root, config } = await setup();
  await addDriven(root, "writer", "concurrent");
  await pass(root, config);
  const run = (await item(root, "writer", "concurrent")).drive.run;
  await until(async () => !(await drive()).workerAlive(run), "worker exited");
  const launchFiles = await box(root, WRITER_BOX);
  config.drive.notify.command = [process.execPath, path.join(root, "notify.mjs"), root];
  const { watchWorkers } = await import("../work-watch.mjs");
  const [polled] = await Promise.all([
    pass(root, config, now + MIN),
    watchWorkers({ root, now: now + MIN }),
  ]);
  assert.deepEqual(reasons(polled), ["writer:concurrent:result-ready:false"]);
  const completion = (await box(root, WRITER_BOX)).filter(file => !launchFiles.includes(file));
  assert.equal(completion.length, 1);
  assert.match(await readFile(path.join(root, WRITER_BOX, completion[0]), "utf8"), /done concurrent --result/);
  await rm(path.join(root, WRITER_BOX, completion[0]));
  const later = now + 8 * 24 * 60 * MIN;
  await watchWorkers({ root, now: later }); // Past terminal registry retention.
  await writeFile(path.join(root, "notify-ok"), "");
  const retry = await pass(root, config, later);
  assert.deepEqual(reasons(retry), ["writer:concurrent:result-ready:true"]);
  assert.deepEqual((await pass(root, config, later + 61 * MIN)).alerts, []);
  assert.deepEqual(await box(root, WRITER_BOX), launchFiles);
  assert.equal(await readFile(path.join(root, "notify-log"), "utf8"), "writer result-ready\n");
});

test("an interrupted inbox publication resumes once and a later run can notify again", async () => {
  const { root } = await setup();
  const { publishScheduledCompletion } = await import("./completion-wake.mjs");
  const wakeDir = path.join(root, WRITER_BOX);
  const event = { wakeDir, role: "writer", cardId: "draft", startedAt: PAST, pid: 123, resultFile: "answer", now };
  const first = await publishScheduledCompletion(event);
  const receipts = path.join(wakeDir, ".work-watch-completions");
  const [receipt] = await readdir(receipts);
  await rename(first, path.join(receipts, receipt, "pending")); // Restored at the commit-before-publication boundary.
  await mkdir(first); // The destination is temporarily unavailable.
  await assert.rejects(publishScheduledCompletion(event), { code: "EISDIR" });
  await rm(first, { recursive: true });
  const recovered = await publishScheduledCompletion(event);
  assert.equal(recovered, first);
  await rm(recovered);
  assert.equal(await publishScheduledCompletion(event), null);
  assert.deepEqual(await box(root, WRITER_BOX), []);
  const next = await publishScheduledCompletion({ ...event, startedAt: FUTURE });
  assert.notEqual(next, first);
  assert.deepEqual(await box(root, WRITER_BOX), [path.basename(next)]);
});

for (const first of ["scheduler", "watcher"]) {
  test(`an upgraded installation honors the previous ${first}'s completion receipt`, async () => {
    const { root, config } = await setup();
    await addDriven(root, "writer", "legacy");
    await pass(root, config);
    const run = (await item(root, "writer", "legacy")).drive.run;
    await until(async () => !(await drive()).workerAlive(run), "worker exited");
    const { defaultRegistryPath, watchWorkers } = await import("../work-watch.mjs");
    const file = defaultRegistryPath(root);
    const registry = JSON.parse(await readFile(file, "utf8"));
    delete registry.workers[0].scheduledCard;
    if (first === "watcher") {
      registry.workers[0].status = "done";
      registry.workers[0].alerts.doneAt = now + MIN;
    }
    await writeFile(file, JSON.stringify(registry));
    await changeLedger(root, "writer", ledger => {
      const d = ledger.items.find(row => row.id === "legacy").drive;
      delete d.run.wake_dir;
      if (first === "scheduler") d.alerts["result-ready"] = new Date(now + MIN).toISOString();
    });
    const before = await box(root, WRITER_BOX);
    assert.deepEqual((await pass(root, config, now + 2 * MIN)).errors, []);
    assert.deepEqual((await watchWorkers({ root, now: now + 2 * MIN })).wakes, []);
    assert.deepEqual(await box(root, WRITER_BOX), before);
  });
}

test("a scheduled sensor records the model that actually classified the original message", async () => {
  const { root, config } = await setup();
  config.roles[1].tier_profile = "config/sensors.json";
  const primary = { id: "primary", cli: path.join(root, "missing-sensor"), family: "alpha", model: "first",
    result_mode: "stdout", argv: ["{cli}", "--model", "{model}"] };
  const secondary = { id: "second", cli: process.execPath, family: "beta", model: "second",
    result_mode: "stdout", argv: ["{cli}", "-e", "console.log(process.argv[1])", "{model}"] };
  await writeFile(path.join(root, "config/work-ledger.json"), JSON.stringify(config));
  await writeFile(path.join(root, "config/sensors.json"), JSON.stringify({
    tiers: { 1: { candidates: [primary, secondary] }, 2: { candidates: [secondary] } },
    worker_steps: { classify: { tier: 1, selection: "ordered" } },
  }));
  await cli(root, "add", "--role", "writer", "--id", "incoming", "--title", "Classify", "--due", PAST,
    "--channel", "source", "--msg-id", "22", "--prompt", "task.md", "--result-file", "results/decision", "--worker-step", "classify");
  const started = await pass(root, config);
  assert.equal(started.launched.length, 1);
  const run = (await item(root, "writer", "incoming")).drive.run;
  await until(async () => (await item(root, "writer", run.worker_id))?.status === "done", "scheduled sensor classified message");
  const card = await item(root, "writer", "incoming");
  assert.equal(card.drive.model, "second");
  assert.equal(card.drive.run.profile.candidate, "second");
  assert.equal((await item(root, "writer", run.worker_id)).from.msg_id, "22");
  assert.equal((await readFile(path.join(root, "results/decision"), "utf8")).trim(), "second");
});

test("timer launch resolves the installed card profile and records the actual argument selection", async () => {
  const { root, config } = await setup();
  config.roles[1].tier_profile = "config/writer.json";
  delete config.drive.worker.command;
  const candidate = { id: "default", family: "family", cli: process.execPath, model: "installation-model",
    argv: ["{cli}", path.join(root, "worker.mjs"), "{model}"] };
  await writeFile(path.join(root, "config/work-ledger.json"), JSON.stringify(config));
  await writeFile(path.join(root, "config/writer.json"), JSON.stringify({
    tiers: { 2: { candidates: [candidate] } }, worker_steps: { design: { tier: 2, candidate: "default" } },
  }));
  const fields = ["add", "--role", "writer", "--id", "design", "--title", "plan", "--worker-step", "design",
    "--due", PAST, "--channel", "111", "--msg-id", "222", "--prompt", "task.md", "--result-file", "result.md"];
  await assert.rejects(cli(root, ...fields, "--model", "wrong"), /differs from the role profile/);
  await cli(root, ...fields);
  await assert.rejects(cli(root, "attach", "design", "--role", "writer", "--pid", String(process.pid)), /recorded worker launch/);
  const out = await pass(root, config);
  assert.equal(out.launched.length, 1);
  const card = await item(root, "writer", "design");
  assert.equal(card.drive.run.profile.model, "installation-model");
  assert.equal(card.drive.run.profile.step, "design");
  assert.equal(card.drive.run.profile.cli, process.execPath);
  const result = path.join(root, "result.md");
  await until(() => existsSync(result), "profiled worker result");
  assert.match(await readFile(result, "utf8"), /model=installation-model/);
});

test("a scheduled stdout producer has a completed worker receipt usable by an independent reviewer", async () => {
  const { root, config } = await setup();
  config.roles[1].tier_profile = "config/selected.json";
  const configPath = path.join(root, "config/scheduled.json");
  await writeFile(configPath, JSON.stringify(config));
  const candidate = (id, program) => ({ id, family: id, model: id, cli: process.execPath, result_mode: "stdout",
    argv: ["{cli}", "-e", program, "{model}"] });
  const writer = candidate("writer", "process.stdout.write(process.argv[1] + ':' + process.env.LEDGER_PARENT_ID)");
  const reviewer = candidate("reviewer", "process.stdout.write(process.argv[1])");
  await writeFile(path.join(root, "config/selected.json"), JSON.stringify({ tiers: { 2: { candidates: [writer, reviewer] } },
    worker_steps: { implementation: { tier: 2, candidate: "writer" }, review: { tier: 2, candidate: "reviewer" } } }));
  await cli(root, "add", "--config", configPath, "--role", "writer", "--id", "queued", "--title", "Draft",
    "--due", PAST, "--channel", "111", "--msg-id", "222", "--prompt", "task.md", "--result-file", "scheduled-answer.txt");
  await assert.rejects(cli(root, "done", "queued", "--role", "writer", "--config", configPath, "--result", "task.md"), /successful terminal receipt/);
  const missingConfig = path.join(root, "config/not-installed.json");
  const first = await pass(root, config, now, { configPath: missingConfig });
  assert.equal(first.launched.length, 1);
  const beforeInstall = (await item(root, "writer", "queued")).drive.run;
  await until(async () => !(await drive()).workerAlive(beforeInstall), "failed wrapper exited before reserving a worker");
  assert.equal(await item(root, "writer", beforeInstall.worker_id), undefined);
  const out = await pass(root, config, now + 31 * MIN, { configPath });
  assert.equal(out.launched.length, 1);
  const run = (await item(root, "writer", "queued")).drive.run;
  assert.equal(run.attempts, 2);
  assert.ok(run.worker_id, "scheduled runs must reference their tracked worker");
  await until(async () => (await item(root, "writer", run.worker_id))?.status === "done", "worker terminal receipt");
  const producer = await item(root, "writer", run.worker_id);
  assert.equal((await item(root, "writer", "queued")).drive.run.ended_at, producer.ended, "native exit updates the card before polling");
  assert.equal(producer.parent, "queued");
  assert.equal(producer.from.msg_id, "222");
  assert.ok(producer.profile_started_at);
  assert.equal(await readFile(path.join(root, "scheduled-answer.txt"), "utf8"), "writer:queued");
  await until(async () => !(await drive()).workerAlive(run), "wrapper exited");
  const { watchWorkers } = await import("../work-watch.mjs");
  const watched = await watchWorkers({ root, now: now + 32 * MIN });
  assert.deepEqual(watched.wakes.map(w => [w.role, w.reason]), [["writer", "done"]]);
  await rm(watched.wakes[0].wakeFile); // The role has already consumed its completion.
  const beforePoll = await box(root, WRITER_BOX);
  const polled = await pass(root, config, now + 36 * MIN, { configPath });
  assert.deepEqual(polled.errors, []);
  assert.deepEqual(await box(root, WRITER_BOX), beforePoll, "the scheduler repeats a consumed worker completion");
  assert.equal((await item(root, "writer", "queued")).drive.run.ended_at, producer.ended);
  assert.deepEqual((await pass(root, config, now + 101 * MIN, { configPath })).alerts, []);
  await assert.rejects(cli(root, "start", "queued", "--role", "writer", "--config", configPath), /already completed/);
  const { startWorkerRun } = await import("./worker-run.mjs");
  const review = await startWorkerRun({ root, config: configPath, role: "writer", parent: "queued", id: "reviewed", name: "Review",
    "review-of": producer.id, foreground: true, prompt: "scheduled-answer.txt", result: "reviewed.txt" }, []);
  assert.equal(review.status, "done");
  assert.equal(review.review_of, producer.id);
});

test("a partial scheduled result from a failing native worker stays open", async () => {
  const { root, config } = await setup();
  config.roles[1].tier_profile = "config/writer.json";
  await writeFile(path.join(root, "config/work-ledger.json"), JSON.stringify(config));
  const program = "require('node:fs').writeFileSync(process.argv[1], 'partial'); process.exitCode = 3";
  const candidate = { id: "writer", family: "one", model: "one", cli: process.execPath,
    argv: ["{cli}", "-e", program, "{result_file}", "{model}"] };
  await writeFile(path.join(root, "config/writer.json"), JSON.stringify({ tiers: { 2: { candidates: [candidate] } },
    worker_steps: { implementation: { tier: 2, candidate: "writer" } } }));
  await cli(root, "add", "--role", "writer", "--id", "partial", "--title", "Draft", "--due", PAST,
    "--channel", "111", "--msg-id", "222", "--prompt", "task.md", "--result-file", "partial-answer.txt");
  await pass(root, config);
  const run = (await item(root, "writer", "partial")).drive.run;
  await until(async () => (await item(root, "writer", run.worker_id))?.status === "failed", "failed worker");
  await until(async () => !(await drive()).workerAlive(run), "wrapper exited");
  const { watchWorkers } = await import("../work-watch.mjs");
  assert.deepEqual((await watchWorkers({ root })).wakes.map(w => [w.role, w.reason]), [["writer", "dead"]]);
  const next = await pass(root, config, now + 2 * MIN);
  assert.deepEqual(next.launched, []);
  assert.deepEqual(next.alerts.map(a => a.reason), ["launch-failed"]);
  await assert.rejects(cli(root, "done", "partial", "--role", "writer", "--result", "partial-answer.txt"),
    /successful terminal receipt/);
  assert.equal((await item(root, "writer", "partial")).status, "open");
});

test("an exhausted scheduled tier waits on its original card without spending another attempt", async () => {
  const { root, config } = await setup();
  config.roles[1].tier_profile = "config/writer.json";
  await writeFile(path.join(root, "config/work-ledger.json"), JSON.stringify(config));
  const candidates = ["first", "second"].map(id => ({
    id, family: id, model: id, cli: process.execPath, result_mode: "stdout", unavailable_exit_codes: [75],
    argv: ["{cli}", "-e", "process.exit(75)", "{model}"],
  }));
  const profile = { tiers: { 2: { candidates } }, worker_steps: { implementation: { tier: 2, selection: "shuffle" } } };
  const file = path.join(root, "config/writer.json");
  await writeFile(file, JSON.stringify(profile));
  await cli(root, "add", "--role", "writer", "--id", "capacity", "--title", "Draft", "--due", PAST,
    "--channel", "111", "--msg-id", "222", "--prompt", "task.md", "--result-file", "reply.md");
  await pass(root, config);
  const run = (await item(root, "writer", "capacity")).drive.run;
  await until(async () => (await item(root, "writer", run.worker_id))?.status === "failed", "provider refusals");
  await until(async () => !(await drive()).workerAlive(run), "admission process exited");
  const refused = await item(root, "writer", run.worker_id);
  assert.equal(refused.reason, "provider-unavailable");
  assert.equal(refused.profile_attempts.length, 1);
  assert.notEqual(refused.profile_attempts[0].profile.candidate, refused.profile.candidate);
  for (const delay of [60, 120]) {
    const check = await pass(root, config, now + delay * MIN);
    assert.deepEqual(check.launched, []);
    assert.ok(check.alerts.some(alert => alert.reason === "worker-unavailable"));
  }
  const card = await item(root, "writer", "capacity");
  assert.equal(card.status, "open");
  assert.equal(card.drive.run.attempts, 1);
  assert.equal(card.drive.model, refused.profile.model);
  for (const candidate of candidates) candidate.argv[2] = "process.stdout.write('accepted')";
  await writeFile(file, JSON.stringify(profile));
  await cli(root, "start", "capacity", "--role", "writer");
  await until(() => existsSync(path.join(root, "reply.md")), "answer after capacity returned");
  assert.equal(await readFile(path.join(root, "reply.md"), "utf8"), "accepted");
});

test("queued registration and launch retain the original card's shuffled assignment", async () => {
  const { root, config } = await setup();
  config.roles[1].tier_profile = "config/writer.json";
  await writeFile(path.join(root, "config/work-ledger.json"), JSON.stringify(config));
  const candidates = ["first", "second"].map(id => ({
    id, family: id, model: id, cli: process.execPath,
    argv: ["{cli}", path.join(root, "worker.mjs"), "{model}"],
  }));
  const profile = { tiers: { 2: { candidates } }, worker_steps: { implementation: { tier: 2, selection: "shuffle" } } };
  const save = () => writeFile(path.join(root, "config/writer.json"), JSON.stringify(profile));
  await save();
  await cli(root, "add", "--role", "writer", "--id", "queued-card", "--title", "plan", "--due", PAST,
    "--channel", "111", "--msg-id", "222", "--prompt", "task.md", "--result-file", "queued-result.md");
  const assigned = (await item(root, "writer", "queued-card")).drive.model;
  candidates.reverse();
  await save();
  const { launched } = await pass(root, config);
  assert.deepEqual(launched.map(({ role, id }) => [role, id]), [["writer", "queued-card"]]);
  const run = (await item(root, "writer", "queued-card")).drive.run;
  assert.equal(run.profile.candidate, assigned);
  assert.equal(run.profile.model, assigned);
  await until(() => existsSync(path.join(root, "queued-result.md")), "shuffled worker result");
});


test("a role without a wake box gets nothing started and the pass reports it", async () => {
  const { root, config } = await setup();
  await addDriven(root, "writer", "draft");
  delete config.roles[1].wake_dir;
  const out = await pass(root, config);
  assert.deepEqual([out.launched, out.alerts], [[], []]);
  assert.match(out.errors.join("\n"), /writer: Role writer has no wake_dir in configuration; nothing started/);
  assert.equal((await item(root, "writer", "draft")).drive.run, null);
  assert.deepEqual([await box(root, LEAD_BOX), await box(root, WRITER_BOX)], [[], []]);
});

// ---- 갈래 B-2: 실패·느림 ----

test("a failed notification does not lock the cooldown; a delivered one does", async () => {
  const { root, config } = await setup((config) => {
    config.drive.notify = { repeat_min: 60, timeout_sec: 1 };
    config.drive.disk.min_free_gb = 2;
    return config;
  });
  config.drive.notify.command = [process.execPath, path.join(root, "notify.mjs"), root];
  await addDriven(root, "writer", "draft");
  const low = { freeGb: async () => 0 };
  const stamp = async () => (await item(root, "writer", "draft")).drive.alerts["disk-low"];
  const failed = await pass(root, config, now, low);
  assert.deepEqual([failed.launched, reasons(failed)], [[], ["writer:draft:disk-low:false"]]);
  assert.match(failed.errors.join("\n"), /notify draft disk-low: notify command failed \(1\)/);
  assert.equal(await stamp(), undefined, "failure must not start the cooldown");
  assert.deepEqual(failed.handled, [], "an item whose notice failed is not reported as handled");
  await writeFile(path.join(root, "notify-hang"), "");
  const slow = await pass(root, config, now + MIN, low);
  assert.deepEqual(reasons(slow), ["writer:draft:disk-low:false"]);
  assert.match(slow.errors.join("\n"), /timed out after 1s/);
  assert.equal(await stamp(), undefined);
  await rm(path.join(root, "notify-hang"));
  // The wake box itself cannot be written.
  const blocked = structuredClone(config);
  await writeFile(path.join(root, "not-a-folder"), "");
  blocked.roles[1].wake_dir = "not-a-folder/box";
  assert.deepEqual(reasons(await pass(root, blocked, now + 2 * MIN, low)), ["writer:draft:disk-low:false"]);
  assert.equal(await stamp(), undefined);
  await writeFile(path.join(root, "notify-ok"), "");
  const sent = await pass(root, config, now + 3 * MIN, low);
  assert.deepEqual([reasons(sent), sent.errors], [["writer:draft:disk-low:true"], []]);
  assert.equal(await stamp(), new Date(now + 3 * MIN).toISOString());
  assert.equal(await readFile(path.join(root, "notify-log"), "utf8"), "writer disk-low\n");
  assert.equal((await box(root, WRITER_BOX)).length, 1, "retries reuse the unread notice instead of piling up files");
  assert.deepEqual((await pass(root, config, now + 30 * MIN, low)).alerts, [], "inside the cooldown after a delivery");
  assert.deepEqual(reasons(await pass(root, config, now + 64 * MIN, low)), ["writer:draft:disk-low:true"]);
});

test("a launch notice that failed is sent again without starting a second worker", async () => {
  const { root, config } = await setup();
  config.drive.notify.command = [process.execPath, path.join(root, "notify.mjs"), root];
  await addDriven(root, "writer", "draft");
  const hold = { env: { ...process.env, WORKER_MODE: "hold" } };
  const first = await pass(root, config, now, hold);
  assert.deepEqual([first.launched.length, reasons(first)], [1, ["writer:draft:launched:false"]]);
  await writeFile(path.join(root, "notify-ok"), "");
  const second = await pass(root, config, now + MIN, hold);
  assert.deepEqual([second.launched, reasons(second)], [[], ["writer:draft:launched:true"]]);
  assert.deepEqual((await pass(root, config, now + 2 * MIN, hold)).alerts, []);
  assert.equal((await item(root, "writer", "draft")).drive.run.attempts, 1);
});

test("a worker command that cannot start costs no attempt and is retried on the next pass", async () => {
  const { root, config } = await setup();
  const broken = structuredClone(config);
  broken.drive.worker.command = [path.join(root, "no-such-program")];
  await addDriven(root, "writer", "draft");
  const first = await pass(root, broken);
  assert.deepEqual([first.launched, reasons(first)], [[], ["writer:draft:launch-failed:true"]]);
  const failed = await item(root, "writer", "draft");
  assert.equal(failed.drive.run, null, "no run and no attempt recorded");
  assert.match(failed.drive.error, /ENOENT/);
  const second = await pass(root, config, now + MIN);
  assert.deepEqual(second.launched.map((entry) => [entry.id, entry.attempt]), [["draft", 1]]);
  assert.equal((await item(root, "writer", "draft")).drive.error, undefined);
});

test("a result file that exists before any worker ran is never taken as done work", async () => {
  const { root, config } = await setup();
  await cli(root, "add", "--role", "writer", "--id", "old", "--title", "옛 줄", "--due", PAST, "--channel", "111", "--msg-id", "222");
  await writeFile(path.join(root, "old-result.md"), "예전에 쓴 글\n");
  const adopt = (file) => cli(root, "adopt", "old", "--role", "writer", "--prompt", "task.md", "--result-file", file, "--model", "model-a");
  await assert.rejects(adopt("old-result.md"), /Result file already exists/);
  assert.equal((await item(root, "writer", "old")).drive, undefined);
  assert.equal(await adopt("results/old.md"), "old");
  await assert.rejects(adopt("results/other.md"), /already has an instruction/);
  await mkdir(path.join(root, "results"), { recursive: true });
  await writeFile(path.join(root, "results/old.md"), "누가 손으로 넣은 글\n");
  const out = await pass(root, config);
  assert.deepEqual([out.launched, reasons(out)], [[], ["writer:old:result-preexisting:true"]]);
  assert.equal((await item(root, "writer", "old")).status, "open");
});

test("low disk and the parallel limit start nothing and say so; a role without a ledger is reported", async () => {
  const { root, config } = await setup((config) => {
    config.drive.worker.max_parallel = 1;
    config.drive.disk.min_free_gb = 2;
    return config;
  });
  await addDriven(root, "writer", "first", "2026-11-14T10:00:00Z");
  await addDriven(root, "writer", "second", PAST);
  const blocked = await pass(root, config, now, { freeGb: async () => 1.5 });
  assert.deepEqual([blocked.launched, reasons(blocked)], [[], ["writer:first:disk-low:true", "writer:second:disk-low:true"]]);
  assert.match(await boxText(root, WRITER_BOX), /\[장부\] 디스크 부족으로 안 띄움: 일 first\n.*여유 1\.50 GB/);
  const out = await pass(root, config, now + MIN, { freeGb: async () => 50, env: { ...process.env, WORKER_MODE: "hold" } });
  assert.deepEqual(out.launched.map((entry) => entry.id), ["first"], "earliest due first, one at a time");
  assert.deepEqual(reasons(out), ["writer:first:launched:true", "writer:second:queued:true"]);
  assert.deepEqual(out.skipped, ["lead: no ledger file"]);
});

// ---- 닫기 관문 ----

test("an instructed item closed without a record is reopened; an owner message closes it", async () => {
  const { root, config } = await setup();
  await addDriven(root, "writer", "abcd1234-task", FUTURE);
  await changeLedger(root, "writer", (ledger) => {
    ledger.items[0].status = "dropped";
    ledger.items[0].note = "새 기한으로 다시 잡음";
  });
  const out = await pass(root, config);
  assert.deepEqual([out.launched, reasons(out)], [[], ["writer:abcd1234-task:reopened:true"]]);
  assert.equal((await item(root, "writer", "abcd1234-task")).status, "open");
  assert.deepEqual((await pass(root, config, now + 30 * MIN)).alerts, [], "one notice per reopening");
  const messages = {
    501: { id: "501", author: { id: "777" }, content: "abcd1234 취소" },
    502: { id: "502", author: { id: "900" }, content: "중단하세요" },
    503: { id: "503", author: { id: "900" }, content: "네 중단하세요", message_reference: { message_id: "504" } },
    504: { id: "504", author: { id: "1" }, content: "장부 abcd1234 중단해도 될까요" },
    505: { id: "505", author: { id: "900" }, content: "네", message_reference: { message_id: "504" } },
    506: { id: "506", author: { id: "900" }, content: "continue abcd1234" },
    507: { id: "507", author: { id: "900" }, content: "cancel abcd1234-other" },
  };
  let limited = 0;
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(String(url));
    assert.equal(options.headers.Authorization, "Bot token-value");
    assert.ok(options.signal, "every lookup carries a time limit");
    if (String(url).endsWith("/503") && limited++ === 0)
      return { status: 429, ok: false, headers: { get: () => "0" }, text: async () => '{"retry_after":0}' };
    const message = messages[String(url).split("/").pop()];
    return { status: message ? 200 : 404, ok: Boolean(message), headers: { get: () => null }, text: async () => "missing", json: async () => message };
  };
  const confirm = (msgId) =>
    main(["confirm", "abcd1234-task", "--role", "writer", "--root", root, "--channel", "111", "--msg-id", msgId], { now: now + 31 * MIN, fetchImpl, env: { TEST_TOKEN: "token-value" }, sleep: async () => {} });
  await assert.rejects(confirm("501"), /not written by a configured owner/);
  await assert.rejects(confirm("502"), /does not name item abcd1234/);
  await assert.rejects(confirm("505"), /explicit cancellation/);
  await assert.rejects(confirm("506"), /explicit cancellation/);
  await assert.rejects(confirm("507"), /does not name item abcd1234/);
  await assert.rejects(confirm("599"), /Discord HTTP 404/);
  assert.equal((await item(root, "writer", "abcd1234-task")).status, "open");
  assert.equal(await confirm("503"), "abcd1234-task");
  const reads = calls.length;
  assert.equal(await confirm("503"), "abcd1234-task");
  assert.equal(calls.length, reads);
  assert.equal(limited, 2, "a 429 is waited out and retried");
  const closed = await item(root, "writer", "abcd1234-task");
  assert.deepEqual([closed.status, closed.drive.closed.by, closed.drive.closed.msg_id, closed.drive.closed.author], ["dropped", "owner", "503", "900"]);
  const after = await pass(root, config, now + 32 * MIN);
  assert.deepEqual([after.launched, after.alerts, after.errors], [[], [], []]);
  assert.equal((await item(root, "writer", "abcd1234-task")).status, "dropped");
});

test("an owner cancellation distinguishes instructed cards with the same eight-character prefix", async () => {
  const { root } = await setup();
  await addDriven(root, "writer", "abcd1234-first", FUTURE);
  await addDriven(root, "writer", "abcd1234-second", FUTURE);
  const confirm = msgId => main(["confirm", "abcd1234-second", "--role", "writer", "--root", root, "--channel", "111", "--msg-id", msgId], {
    now, env: { TEST_TOKEN: "fixture" }, fetchImpl: async url => {
      const id = url.pathname.split("/").at(-1);
      const text = { 511: "cancel abcd1234", 512: "cancel abcd1234-first", 513: "cancel abcd1234-second" }[id];
      return Response.json({ id, author: { id: "900" }, content: text });
    },
  });
  await assert.rejects(confirm("511"), /unambiguously/);
  await assert.rejects(confirm("512"), /does not name/);
  assert.equal(await confirm("513"), "abcd1234-second");
  assert.deepEqual((await readLedger(root, "writer")).items.map(row => row.status), ["open", "dropped"]);
});

test("drive is off unless enabled; the command line pass and start/attach work", async () => {
  const { root, config } = await setup((config) => {
    config.drive.enabled = false;
    return config;
  });
  // The command line pass reads the real clock, so this item is overdue on any day.
  await addDriven(root, "writer", "draft", "2020-01-01T00:00:00Z");
  const off = await pass(root, config);
  assert.deepEqual([off.launched, off.alerts, off.skipped], [[], [], ["drive.enabled is not true"]]);
  const env = { ...process.env, WORKER_MODE: "hold" };
  delete env.NODE_TEST_CONTEXT;
  const dry = JSON.parse((await run(process.execPath, [ledgerScript, "drive", "--dry", "--root", root], { env })).stdout);
  assert.equal(dry.launched.length, 1, "--dry shows what would start");
  assert.equal(dry.launched[0].dry, true);
  assert.equal((await item(root, "writer", "draft")).drive.run, null);
  assert.deepEqual(await box(root, WRITER_BOX), []);
  const started = await main(["start", "draft", "--role", "writer", "--root", root], { now, env });
  assert.match(started, /^draft worker pid \d+ \(attempt 1\)$/);
  pids.push(Number(started.match(/pid (\d+)/)[1]));
  await assert.rejects(main(["start", "draft", "--role", "writer", "--root", root], { now, env }), /Worker already running/);
  await assert.rejects(main(["attach", "draft", "--role", "writer", "--root", root, "--pid", String(process.pid)], { now }), /Worker already running/);
  await cli(root, "add", "--role", "writer", "--id", "plain", "--title", "일", "--due", PAST, "--channel", "111", "--msg-id", "222");
  await assert.rejects(main(["start", "plain", "--role", "writer", "--root", root], { now, env }), /instruction file/);
});

// ---- 갈래 5.2: 감시·정시 타이머와 한 줄기 ----

const woken = (out) => out.wakes.map((entry) => `${entry.role}:${entry.id}:${entry.reason}`).sort();

test("the watcher runs the drive pass and does not also wake the role for an item the pass handled", async () => {
  const { root, config } = await setup();
  await addDriven(root, "writer", "draft");
  await cli(root, "add", "--role", "writer", "--id", "plain", "--title", "약속", "--due", PAST, "--channel", "111", "--msg-id", "223");
  const out = await watch({ root, config, now });
  for (const entry of out.drive.launched) pids.push(entry.pid);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.drive.launched.map((entry) => [entry.role, entry.id]), [["writer", "draft"]]);
  assert.deepEqual(woken(out), ["writer:plain:기한 넘음"], "only the item without an instruction gets the overdue wake");
  assert.match(await boxText(root, WRITER_BOX), /^\[장부\] 일꾼 띄움: 일 draft\n/);
  const flat = await box(root, LEAD_BOX);
  assert.equal(flat.length, 1);
  assert.match(flat[0], /-ledger-plain-route-writer\.md$/);
  assert.equal((await item(root, "writer", "draft")).drive.run.attempts, 1);
});

test("when the drive pass cannot handle a role the watcher keeps the overdue wake and reports the failure", async () => {
  const { root, config } = await setup();
  await addDriven(root, "writer", "draft");
  const boxless = structuredClone(config);
  delete boxless.roles[1].wake_dir;
  const first = await watch({ root, config: boxless, now });
  assert.deepEqual(first.drive.launched, []);
  assert.deepEqual(first.errors, ["drive:writer"]);
  assert.deepEqual(woken(first), ["writer:draft:기한 넘음", "writer:drive-error:감시 실패"]);
  assert.match(await boxText(root, LEAD_BOX), /\[장부\] 감시 실패: 굴리기 실패\n[^]*no wake_dir/);
  // The whole pass fails before it reaches any role.
  const invalid = structuredClone(config);
  invalid.drive.worker.command = [];
  const second = await watch({ root, config: invalid, now: now + 31 * MIN });
  assert.equal(second.drive, undefined);
  assert.deepEqual(second.errors, ["drive"]);
  assert.deepEqual(woken(second), ["writer:draft:기한 넘음", "writer:drive-error:감시 실패"]);
  assert.equal((await item(root, "writer", "draft")).drive.run, null);
  // Drive off: the watcher behaves exactly as before.
  const off = structuredClone(config);
  off.drive.enabled = false;
  const third = await watch({ root, config: off, now: now + 62 * MIN });
  assert.deepEqual([third.errors, woken(third), third.drive], [[], ["writer:draft:기한 넘음"], undefined]);
});

test("the due-time timer leaves an instructed item to the drive pass", async () => {
  const { root, config } = await setup();
  await addDriven(root, "writer", "draft", FUTURE);
  await cli(root, "add", "--role", "writer", "--id", "plain", "--title", "약속", "--due", FUTURE, "--channel", "111", "--msg-id", "223");
  await approveFixture(root, config);
  const armed = JSON.parse(await readFile(path.join(root, "config/work-ledger.json"), "utf8"));
  const at = Date.parse(FUTURE);
  const call = (id, conf) => fire({ root, role: "writer", id, due: FUTURE, now: at, config: conf, warn: (text) => assert.fail(text) });
  assert.equal(await call("draft", armed), false);
  assert.equal(existsSync(receiptPath(root, "writer", "draft", FUTURE)), false, "no receipt, so the watcher's fallback is not suppressed");
  assert.deepEqual(await box(root, LEAD_BOX), []);
  assert.equal(await call("plain", armed), true);
  assert.equal((await box(root, LEAD_BOX)).length, 1);
  // Drive off: the timer wakes for the instructed item as before.
  const off = structuredClone(armed);
  off.drive.enabled = false;
  assert.equal(await call("draft", off), true);
  assert.equal((await box(root, LEAD_BOX)).length, 2);
});

test("the due date of an instructed item cannot be moved by command", async () => {
  const { root } = await setup();
  await addDriven(root, "writer", "draft", FUTURE);
  await cli(root, "add", "--role", "writer", "--id", "plain", "--title", "약속", "--due", FUTURE, "--channel", "111", "--msg-id", "223");
  const later = "2026-12-01T00:00:00Z";
  await assert.rejects(cli(root, "due", "draft", "--role", "writer", "--due", later, "--reason", "미룸"), /due is not available for an item with an instruction file/);
  assert.equal((await item(root, "writer", "draft")).due, FUTURE);
  await cli(root, "due", "plain", "--role", "writer", "--due", later, "--reason", "요청자가 미룸");
  assert.equal((await item(root, "writer", "plain")).due, later);
});

test("the command line pass exits 1 when the pass reports an error", async () => {
  const { root, config } = await setup();
  await addDriven(root, "writer", "draft", "2020-01-01T00:00:00Z");
  delete config.roles[1].wake_dir;
  await writeFile(path.join(root, "config/work-ledger.json"), JSON.stringify(config));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const failure = await run(process.execPath, [ledgerScript, "drive", "--root", root], { env }).then(() => assert.fail("must exit 1"), (error) => error);
  assert.equal(failure.code, 1);
  assert.match(JSON.parse(failure.stdout).errors.join("\n"), /writer: Role writer has no wake_dir/);
});
