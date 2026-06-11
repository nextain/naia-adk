#!/usr/bin/env node
/**
 * BEH tool-less-spin watchdog — external wall-clock monitor (plan §3.1, §3.3).
 *
 * Pure reasoning emits NO PostToolUse events, so no in-loop tick fires between
 * turns. This out-of-band process fills that gap: on a wall-clock timer it runs
 * the SAME pure evaluateDrift() over the session ledger + bound progress with
 * the real clock, so a running item that goes silent past its wall stall window
 * is caught even with no new turn.
 *
 * Platform limit (plan §3.1): Claude Code hooks can't inject MID-turn from an
 * external process. Guarantee here = (a) wall-clock STUCK DETECTION (exit 3 +
 * `.claude/beh-stuck` flag, which beh-tick surfaces next turn) and (b) Stop-time
 * enforcement via beh-stop.js. Mid-turn interruption is best-effort (flag only).
 *
 * Usage:
 *   node beh-watchdog.js <cwd> <session_id> [--interval=30] [--once]
 *   node beh-watchdog.js --selftest
 */
const fs = require("fs");
const path = require("path");
const beh = require(path.join(__dirname, "..", "..", ".agents", "hooks", "core", "beh-ledger.js"));

function evalStuck(cwd, sessionId, nowFn) {
	const now = nowFn ? nowFn() : Date.now();
	const { ledger: ledgerPath, state: statePath } = beh.behPaths(cwd, sessionId);
	const st = beh.loadState(statePath);
	const bound = beh.findBoundProgress(cwd, sessionId);
	const progress = (bound && bound.progress) || { scope_items: [] };
	const ledger = beh.readLedger(ledgerPath);
	return beh.evaluateDrift({
		now,
		turn: st.turn,
		ledger,
		progress: { ...progress, phase_usage: st.phase_usage },
		barrier: st.barrier,
	});
}

function isStuck(result) {
	return (
		result.hardStop ||
		result.injects.some((i) => i.invariant === "active_stall" || i.invariant === "new_value_zero")
	);
}

function writeFlag(cwd, result) {
	try {
		const flag = path.join(cwd, ".claude", "beh-stuck");
		fs.mkdirSync(path.dirname(flag), { recursive: true });
		fs.writeFileSync(flag, result.injects.map((i) => i.message).join("\n") + (result.hardStopReason || ""));
	} catch {
		/* best-effort */
	}
}

// ── self-test (deterministic, hermetic) ───────────────────────────────────
function selftest() {
	const os = require("os");
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "beh-wd-"));
	const sid = "wd";
	// bound progress with a running item that started 20 min ago, no ledger.
	const pd = path.join(cwd, ".agents", "progress");
	fs.mkdirSync(pd, { recursive: true });
	const startedTs = Date.now() - 20 * 60 * 1000;
	fs.writeFileSync(
		path.join(pd, "t.json"),
		JSON.stringify({ session_id: sid, current_phase: "build", scope_items: [{ id: "x", state: "running", started_turn: 0, started_ts: startedTs, milestones: [{ id: "m1" }] }] }),
	);
	const { state } = beh.behPaths(cwd, sid);
	beh.saveState(state, { turn: 1, last_phase: "build", phase_usage: {}, barrier: { lastInjectTurn: {}, ignored: {} } });

	const flat = evalStuck(cwd, sid);
	const flatOk = isStuck(flat);

	// now add a fresh milestone-matched ledger entry → no longer stuck.
	const { ledger } = beh.behPaths(cwd, sid);
	beh.appendLedger(ledger, { turn: 1, ts: Date.now(), tool: "Edit", target_canon: "file:x", outcome: "ok", scope_item: "x", matched_milestone: "m1" });
	const fresh = evalStuck(cwd, sid);
	const freshOk = !isStuck(fresh);

	fs.rmSync(cwd, { recursive: true, force: true });
	if (flatOk && freshOk) {
		console.log("beh-watchdog selftest: PASS (flat ledger → STUCK; fresh milestone → clear)");
		process.exit(0);
	}
	console.log(`beh-watchdog selftest: FAIL (flatStuck=${flatOk} freshClear=${freshOk})`);
	process.exit(1);
}

function main() {
	const argv = process.argv.slice(2);
	if (argv.includes("--selftest")) return selftest();
	const cwd = argv[0] || process.cwd();
	const sessionId = argv[1];
	if (!sessionId) {
		console.error("usage: node beh-watchdog.js <cwd> <session_id> [--interval=30] [--once]");
		process.exit(2);
	}
	if (!beh.behEnabled(cwd, process.env)) {
		console.error("[beh-watchdog] BEH not enabled (no .claude/beh-on) — nothing to watch.");
		process.exit(0);
	}
	const intervalArg = argv.find((a) => a.startsWith("--interval="));
	const interval = intervalArg ? Math.max(5, parseInt(intervalArg.split("=")[1], 10) || 30) : 30;
	const once = argv.includes("--once");

	const tick = () => {
		const result = evalStuck(cwd, sessionId);
		if (isStuck(result)) {
			writeFlag(cwd, result);
			for (const i of result.injects) console.error("[beh-watchdog] " + i.message);
			if (result.hardStop) console.error("[beh-watchdog] " + result.hardStopReason);
			if (once) process.exit(3);
		} else if (once) {
			process.exit(0);
		}
	};
	tick();
	if (!once) setInterval(tick, interval * 1000);
}

main();
