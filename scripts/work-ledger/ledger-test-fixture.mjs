import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  utimes,
  symlink,
  mkdir,
  readdir,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { main, readLedger, ledgerPath, changeLedger, wakeHeader } from "./ledger.mjs";
import { watch } from "./ledger-watch.mjs";
import { startWorkerRun } from "./worker-run.mjs";
import { dueWake } from "./due-timer.mjs";
import { tick as drive } from "./drive.mjs";
import { registerWorker, updateWorkerRuntime, watchWorkers } from "../work-watch.mjs";
import { createAdapter } from "./messenger.mjs";
const now = Date.parse("2026-11-08T12:00:00Z");
const headerRow = (id, changes = {}) => ({
  id, title: id, due: "2026-11-08T10:00:00Z", status: "open",
  from: { channel: "channel", msg_id: id },
  ...changes,
});

const createdRoots = [];
test.after(async () => {
  await Promise.all(
    createdRoots.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
const config = {
  roles: [
    {
      role: "secretary",
      channels: [],
      human_ids: ["human"],
      user_ids: ["bot"],
    },
  ],
};
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-ledger-"));
  createdRoots.push(root);
  await main([
    "add",
    "--root",
    root,
    "--role",
    "secretary",
    "--id",
    "task",
    "--title",
    "검토",
    "--due",
    "2026-11-08T13:00:00Z",
    "--channel",
    "channel",
    "--msg-id",
    "source",
  ]);
  return root;
}
const edit = (root, fn) => changeLedger(root, "secretary", fn);

export {now,headerRow,createdRoots,config,setup,edit};
