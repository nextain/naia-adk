#!/usr/bin/env node
/**
 * BEH adapters — REAL-condition replay test (plan §4, §6.1).
 *
 * Invokes beh-record / beh-tick / beh-stop EXACTLY as Claude Code does
 * (`echo '<json>' | node <hook>.js`, documented PostToolUse/UserPromptSubmit/
 * Stop stdin schema) under real conditions: real mktemp cwd with `.claude/
 * beh-on`, a real bound progress file (session_id + scope_items), real ledger
 * + state files on disk. Asserts effective behavior: ledger records milestone
 * matches, tick injects on drift, Stop BLOCKS on a live item, and everything
 * stays inert when not opted in. Hermetic; exit non-zero on any fail.
 *
 * Usage: node run-beh-adapter-test.js
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOOKS = path.join(__dirname, "..");
const beh = require(path.join(__dirname, "..", "..", "..", ".agents", "hooks", "core", "beh-ledger.js"));
const rcpt = require(path.join(__dirname, "..", "..", "..", ".agents", "hooks", "core", "beh-receipts.js"));

let PASS = 0,
	FAIL = 0;
const FAILED = [];
function ok() {
	PASS++;
}
function bad(n, d) {
	FAIL++;
	FAILED.push(n);
	console.log(`  ✗ FAIL: ${n}${d ? "\n     " + d : ""}`);
}
function assert(c, n, d) {
	c ? ok() : bad(n, d);
}

function fire(hook, stdin) {
	try {
		return execFileSync("node", [path.join(HOOKS, hook)], { input: JSON.stringify(stdin), encoding: "utf8" });
	} catch (e) {
		return "__EXEC_ERROR__:" + (e.message || "");
	}
}

// ── hermetic fixture ──────────────────────────────────────────────────────
const SID = "test-session-beh";
function setup({ optIn = true, items, phase = "build" }) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "beh-e2e-"));
	fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
	if (optIn) fs.writeFileSync(path.join(cwd, ".claude", "beh-on"), "");
	const progDir = path.join(cwd, ".agents", "progress");
	fs.mkdirSync(progDir, { recursive: true });
	fs.writeFileSync(
		path.join(progDir, "task.json"),
		JSON.stringify({ session_id: SID, current_phase: phase, scope_items: items }, null, 2),
	);
	return cwd;
}

const OLD_TS = () => Date.now() - 20 * 60 * 1000; // 20 min ago → past stallMs(15m)

// 1. beh-record appends a milestone-matched ledger entry.
{
	const cwd = setup({
		items: [{ id: "uc5", state: "running", started_turn: 0, started_ts: OLD_TS(), milestones: [{ id: "m1", accept: { kind: "path", glob: "src/**" } }] }],
	});
	// a tick first to set turn=1
	fire("beh-tick.js", { cwd, session_id: SID, hook_event_name: "UserPromptSubmit" });
	fire("beh-record.js", {
		cwd,
		session_id: SID,
		hook_event_name: "PostToolUse",
		tool_name: "Edit",
		tool_input: { file_path: path.join(cwd, "src", "x.ts") },
		tool_response: { ok: true },
	});
	const { ledger } = beh.behPaths(cwd, SID);
	const entries = beh.readLedger(ledger);
	const matched = entries.find((e) => e.matched_milestone === "m1");
	assert(matched && matched.scope_item === "uc5", "1. record: Edit→ledger entry with matched milestone m1", JSON.stringify(entries));
	fs.rmSync(cwd, { recursive: true, force: true });
}

// 2. beh-tick injects on a stalled mature item (no matched milestones).
{
	const cwd = setup({
		items: [{ id: "uc5", state: "running", started_turn: 0, started_ts: OLD_TS(), milestones: [{ id: "m1", accept: { kind: "path", glob: "src/**" } }] }],
	});
	const out = fire("beh-tick.js", { cwd, session_id: SID, hook_event_name: "UserPromptSubmit" });
	assert(/BEH: BEHAVIOR ENFORCEMENT/.test(out) && /정체|진척/.test(out), "2. tick: stalled item → drift inject", out.slice(0, 200));
	fs.rmSync(cwd, { recursive: true, force: true });
}

// 3. beh-stop BLOCKS when a live (running) item remains.
{
	const cwd = setup({
		items: [{ id: "uc5", state: "running", started_turn: 0, started_ts: OLD_TS(), milestones: [{ id: "m1" }] }],
	});
	fire("beh-tick.js", { cwd, session_id: SID, hook_event_name: "UserPromptSubmit" });
	const out = fire("beh-stop.js", { cwd, session_id: SID, hook_event_name: "Stop", stop_hook_active: false });
	let blocked = false;
	try {
		blocked = JSON.parse(out).decision === "block";
	} catch {}
	assert(blocked, "3. stop: live item → decision=block (termination gate)", out.slice(0, 200));
	fs.rmSync(cwd, { recursive: true, force: true });
}

// 4. beh-stop ALLOWS when all items are disposed via deferral/abandonment
//    (false-positive guard; deferred/abandoned are not completion claims so
//    they need no receipt — only "done" does, tested in #8/#9).
{
	const cwd = setup({
		items: [
			{ id: "a", state: "abandoned", milestones: [] },
			{ id: "b", state: "deferred", milestones: [] },
		],
	});
	fire("beh-tick.js", { cwd, session_id: SID, hook_event_name: "UserPromptSubmit" });
	const out = fire("beh-stop.js", { cwd, session_id: SID, hook_event_name: "Stop", stop_hook_active: false });
	const blocked = /"decision":"block"/.test(out);
	assert(!blocked, "4. stop: all disposed → allow (no block)", out.slice(0, 200));
	fs.rmSync(cwd, { recursive: true, force: true });
}

// 5. opt-out (no .claude/beh-on) → everything inert.
{
	const cwd = setup({ optIn: false, items: [{ id: "uc5", state: "running", started_ts: OLD_TS(), milestones: [{ id: "m1" }] }] });
	const tick = fire("beh-tick.js", { cwd, session_id: SID, hook_event_name: "UserPromptSubmit" });
	const stop = fire("beh-stop.js", { cwd, session_id: SID, hook_event_name: "Stop" });
	assert(tick.trim() === "" && stop.trim() === "", "5. not opted-in → tick+stop silent (inert)", `tick=${tick} stop=${stop}`);
	fs.rmSync(cwd, { recursive: true, force: true });
}

// 6. beh-reset releases the Stop gate one time.
{
	const cwd = setup({ items: [{ id: "uc5", state: "running", started_ts: OLD_TS(), milestones: [{ id: "m1" }] }] });
	fire("beh-tick.js", { cwd, session_id: SID, hook_event_name: "UserPromptSubmit" });
	fs.writeFileSync(path.join(cwd, ".claude", "beh-reset"), "");
	const out = fire("beh-stop.js", { cwd, session_id: SID, hook_event_name: "Stop" });
	const released = !/"decision":"block"/.test(out) && !fs.existsSync(path.join(cwd, ".claude", "beh-reset"));
	assert(released, "6. beh-reset → Stop allowed + marker consumed", out.slice(0, 120));
	fs.rmSync(cwd, { recursive: true, force: true });
}

// 7. §3.2 — successful verify command records a completion receipt.
{
	const cwd = setup({ items: [{ id: "v", state: "running", started_ts: Date.now(), milestones: [{ id: "m1" }], verify: { cmd_pattern: "^npm test", closure: ["src/x.ts"] } }] });
	fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
	fs.writeFileSync(path.join(cwd, "src", "x.ts"), "alpha");
	fire("beh-tick.js", { cwd, session_id: SID, hook_event_name: "UserPromptSubmit" });
	fire("beh-record.js", { cwd, session_id: SID, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { ok: true } });
	const recs = rcpt.readReceipts(rcpt.receiptsPath(beh.behPaths(cwd, SID).dir, SID));
	const rr = recs.find((r) => r.item_id === "v");
	assert(rr && rr.exit === 0 && rr.closure[0] && rr.closure[0].path === "src/x.ts" && rr.closure[0].hash, "7. record: verify cmd → receipt w/ closure hash", JSON.stringify(recs));
	fs.rmSync(cwd, { recursive: true, force: true });
}

// 8. §3.2 — Stop BLOCKS a "done" item with no verification receipt.
{
	const cwd = setup({ items: [{ id: "v", state: "done", verify: { cmd_pattern: "^npm test", closure: ["src/x.ts"] } }] });
	fire("beh-tick.js", { cwd, session_id: SID, hook_event_name: "UserPromptSubmit" });
	const out = fire("beh-stop.js", { cwd, session_id: SID, hook_event_name: "Stop" });
	assert(/"decision":"block"/.test(out) && /완료주장 무효/.test(out), "8. stop: done w/o receipt → block", out.slice(0, 200));
	fs.rmSync(cwd, { recursive: true, force: true });
}

// 9. §3.2 — valid receipt → allow; mutate closure → stale → block.
{
	const cwd = setup({ items: [{ id: "v", state: "done", verify: { cmd_pattern: "^npm test", closure: ["src/x.ts"] } }] });
	fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
	fs.writeFileSync(path.join(cwd, "src", "x.ts"), "alpha");
	fire("beh-tick.js", { cwd, session_id: SID, hook_event_name: "UserPromptSubmit" });
	fire("beh-record.js", { cwd, session_id: SID, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { ok: true } });
	const allow = fire("beh-stop.js", { cwd, session_id: SID, hook_event_name: "Stop" });
	assert(!/"decision":"block"/.test(allow), "9. stop: valid receipt + unchanged closure → allow", allow.slice(0, 160));
	fs.writeFileSync(path.join(cwd, "src", "x.ts"), "beta-CHANGED");
	const block = fire("beh-stop.js", { cwd, session_id: SID, hook_event_name: "Stop" });
	assert(/"decision":"block"/.test(block) && /stale/.test(block), "9. stop: mutated closure → stale block", block.slice(0, 200));
	fs.rmSync(cwd, { recursive: true, force: true });
}

console.log(`\nBEH adapter replay: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) {
	console.log("FAILED: " + FAILED.join(", "));
	process.exit(1);
}
