#!/usr/bin/env node
/**
 * BEH termination gate (Stop) — Claude Code adapter (plan §3.1, §6.1).
 *
 * THIN ADAPTER. On a Stop event, evaluate the termination gate: the session
 * may NOT end while scope items remain undisposed (not done/deferred/abandoned),
 * and a latched hard-stop blocks normal termination until a user-auth reset.
 * Blocks by emitting {"decision":"block","reason":...} (forces continuation).
 *
 * Escape (always available, by design — self-hosted enforcement only raises
 * cost/visibility, plan §0): dispose each item, OR release the session
 * (`rm .claude/beh-on` / BEH=off / `.claude/no-harness`), OR user-auth reset
 * (`.claude/beh-reset`). Fail-safe: any error → exit 0 (never trap on a bug).
 * Opt-in per session (`.claude/beh-on`).
 */
const fs = require("fs");
const path = require("path");
let beh;
try {
	beh = require(path.join(__dirname, "..", "..", ".agents", "hooks", "core", "beh-ledger.js"));
} catch {
	process.exit(0);
}

async function main() {
	let input = "";
	try {
		process.stdin.setEncoding("utf8");
		for await (const c of process.stdin) input += c;
	} catch {
		/* no stdin */
	}
	let data = {};
	try {
		data = JSON.parse(input || "{}");
	} catch {
		process.exit(0);
	}
	const cwd = data.cwd || process.cwd();
	const sessionId = data.session_id || null;
	if (!beh.behEnabled(cwd, process.env)) process.exit(0);

	// user-auth reset releases the gate one time + clears the barrier.
	const resetMarker = path.join(cwd, ".claude", "beh-reset");
	const { state: statePath } = beh.behPaths(cwd, sessionId);
	if (fs.existsSync(resetMarker)) {
		try {
			const st = beh.loadState(statePath);
			st.barrier = { lastInjectTurn: {}, ignored: {} };
			beh.saveState(statePath, st);
			fs.unlinkSync(resetMarker);
		} catch {
			/* best-effort */
		}
		process.exit(0); //  allow this stop
	}

	const st = beh.loadState(statePath);
	const bound = beh.findBoundProgress(cwd, sessionId);
	const progress = (bound && bound.progress) || { scope_items: [] };
	const { ledger: ledgerPath } = beh.behPaths(cwd, sessionId);
	const ledger = beh.readLedger(ledgerPath);

	const result = beh.evaluateDrift({
		now: Date.now(),
		turn: st.turn,
		ledger,
		progress: { ...progress, phase_usage: st.phase_usage, termination_requested: true },
		barrier: st.barrier,
	});

	if (result.blockTermination || result.hardStop) {
		const reason = [
			result.hardStop ? result.hardStopReason : "[BEH] 종료 차단 (termination gate).",
			...result.injects.filter((i) => i.invariant === "blocked_termination").map((i) => i.message),
			"해제: 각 항목 disposition(done/deferred/abandoned) | 세션 해제(rm .claude/beh-on) | 사용자 reset(touch .claude/beh-reset).",
		].join("\n");
		process.stdout.write(JSON.stringify({ decision: "block", reason }));
		process.exit(0);
	}
	process.exit(0); //  allow stop
}
main().catch(() => process.exit(0));
