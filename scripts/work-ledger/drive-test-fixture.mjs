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


export {run,ledgerScript,drive,now,MIN,PAST,FUTURE,roots,pids,WORKER,NOTIFY,LEAD_BOX,WRITER_BOX,setup,cli,addDriven,pass,box,boxText,item,until,reasons};

export const woken = (out) => out.wakes.map((entry) => `${entry.role}:${entry.id}:${entry.reason}`).sort();
