import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicExport, exportLedgers, projectLedger } from "./export.mjs";

const item = (id, status) => ({ id, status, title: id, due: "2026-01-01T00:00:00Z", checked_at: "2026-01-01T00:00:00Z", from: { channel: "1", msg_id: "2", quote: "private" }, worker: { name: "agent", alive: true, result: "/private/result" }, note: "private" });
const ledger = { version: 1, role: "one", items: [item("a", "open"), item("b", "waiting_human"), item("c", "escalated_human"), item("d", "done"), item("e", "dropped")] };

test("exports active rows and only permitted fields", () => {
  const out = projectLedger(ledger, "one");
  assert.deepEqual(out.items.map((row) => row.id), ["a", "b", "c"]);
  assert.deepEqual(out.items[0].worker, { name: "agent", alive: true });
  assert.deepEqual(out.items[0].from, { channel: "1", msg_id: "2" });
  assert.equal(out.items[0].updated_at, "2026-01-01T00:00:00Z");
  assert.equal("checked_at" in out.items[0], false);
  assert.equal(JSON.stringify(out).includes("private"), false);
  const unknown = projectLedger({ ...ledger, items: [{ ...item("x", "open"), worker: { name: "agent", done_file: "/tmp/done" } }] }, "one");
  assert.equal(unknown.items[0].worker.alive, null);
});

test("writes new file with mode 0644 and only replaces the old file by rename", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ledger-export-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "one.json");
  await writeFile(file, "old");
  await atomicExport(file, { ok: true }, async (tmp, target) => {
    assert.equal(await readFile(target, "utf8"), "old");
    assert.deepEqual(JSON.parse(await readFile(tmp, "utf8")), { ok: true });
    assert.equal((await stat(tmp)).mode & 0o777, 0o644);
    const { rename } = await import("node:fs/promises");
    await rename(tmp, target);
  });
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { ok: true });
  assert.deepEqual(await readdir(dir), ["one.json"]);
});

test("missing or invalid source reports failure and retains previous output while other roles succeed", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ledger-export-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "source.json");
  const missing = path.join(dir, "missing.json");
  const bad = path.join(dir, "bad.json");
  await writeFile(source, JSON.stringify(ledger));
  await writeFile(bad, "{");
  await writeFile(path.join(dir, "two.json"), "previous");
  await writeFile(path.join(dir, "three.json"), "previous");
  const config = { outputDir: dir, sources: [{ role: "one", path: source }, { role: "two", path: missing }, { role: "three", path: bad }] };
  await assert.rejects(exportLedgers(config, ["one", "two", "three"]), /two:.*ENOENT[\s\S]*three:/);
  assert.equal(JSON.parse(await readFile(path.join(dir, "one.json"), "utf8")).items.length, 3);
  assert.equal(await readFile(path.join(dir, "two.json"), "utf8"), "previous");
  assert.equal(await readFile(path.join(dir, "three.json"), "utf8"), "previous");
  await assert.rejects(exportLedgers(config, ["../escape"]), /not configured/);
});

test("rename failure keeps last good output and cleans temporary file", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ledger-export-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "one.json");
  await writeFile(file, "previous");
  await assert.rejects(atomicExport(file, {}, async () => { throw new Error("rename failed"); }), /rename failed/);
  assert.equal(await readFile(file, "utf8"), "previous");
  assert.deepEqual(await readdir(dir), ["one.json"]);
});
