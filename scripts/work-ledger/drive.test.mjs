import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  test(`current command shapes pass unchanged (${withDrive ? "drive configured" : "no configuration"})`, async () => {
    const { root } = await setup();
    if (!withDrive) await rm(path.join(root, "config/work-ledger.json"));
    const config = withDrive ? ["--config", path.join(root, "config/work-ledger.json")] : [];
    const env = { ...process.env, ADK_FORBID_SYSTEM_RUNNER: "1" };
    delete env.NODE_TEST_CONTEXT;
    const call = async (...args) => (await run(process.execPath, [ledgerScript, ...args], { cwd: root, env })).stdout.trim();
    // Promise-only registration, as the post guard instructs: title, due, channel, message.
    const first = (await call("add", "--role", "lead", "--title", "15시까지 올림", "--due", "2099-01-02T06:00:00Z", "--channel", "111", "--msg-id", "222")).split("\n")[0];
    const second = (await call("add", "--role", "lead", "--title", "둘째", "--due", "2099-01-02T07:00:00Z", "--channel", "111", "--msg-id", "223", ...config)).split("\n")[0];
    // Wrapper shape: touch, then done / drop with the same arguments.
    await call("touch", first, "--role", "lead", ...config);
    assert.equal(await call("done", first, "--role", "lead", ...config), first);
    await call("touch", "--id", second, "--reason", "요청자가 중단함", "--role", "lead", ...config);
    assert.equal(await call("drop", "--id", second, "--reason", "요청자가 중단함", "--role", "lead", ...config), second);
    assert.equal(await call("report", "--role", "lead", ...config, "--channel", "111", "--msg-id", "333", "--every-min", "120"), "보고 기록");
    const ledger = await readLedger(root, "lead");
    assert.deepEqual(ledger.items.map((entry) => [entry.status, entry.checked_at !== null, entry.drive]), [["done", true, undefined], ["dropped", true, undefined]]);
    assert.equal(ledger.items[1].note, "요청자가 중단함");
    assert.deepEqual([ledger.report.last_msg_id, ledger.report.every_min, ledger.report.channel], ["333", 120, "111"]);
    assert.match(await call("list", "--role", "lead"), new RegExp(`${first} \\[done\\] 2099-01-02T06:00:00Z 15시까지 올림`));
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
    501: { id: "501", author: { id: "777" }, content: "abcd1234 그만해도 됩니다" },
    502: { id: "502", author: { id: "900" }, content: "그만해도 됩니다" },
    503: { id: "503", author: { id: "900" }, content: "네 중단하세요", message_reference: { message_id: "504" } },
    504: { id: "504", author: { id: "1" }, content: "장부 abcd1234 중단해도 될까요" },
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
  await assert.rejects(confirm("599"), /Discord HTTP 404/);
  assert.equal((await item(root, "writer", "abcd1234-task")).status, "open");
  assert.equal(await confirm("503"), "abcd1234-task");
  assert.equal(limited, 2, "a 429 is waited out and retried");
  const closed = await item(root, "writer", "abcd1234-task");
  assert.deepEqual([closed.status, closed.drive.closed.by, closed.drive.closed.msg_id, closed.drive.closed.author], ["dropped", "owner", "503", "900"]);
  const after = await pass(root, config, now + 32 * MIN);
  assert.deepEqual([after.launched, after.alerts, after.errors], [[], [], []]);
  assert.equal((await item(root, "writer", "abcd1234-task")).status, "dropped");
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
