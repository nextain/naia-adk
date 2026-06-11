#!/usr/bin/env node
/**
 * BEH drift tick (UserPromptSubmit) — Claude Code adapter (plan §3.1, §6.1).
 *
 * THIN ADAPTER. On each user/agent turn: increment the turn counter, accrue
 * cumulative per-phase dwell (NO reset on re-entry), run the pure
 * evaluateDrift() over the session ledger + bound progress, persist the inject
 * barrier, and surface any injects (drift/stall/ceiling/scope) + hard-stop
 * notice as additionalContext.
 *
 * Inject-only here (UserPromptSubmit cannot block). The termination gate +
 * hard-stop ENFORCEMENT is in beh-stop.js (Stop event). Fail-safe exit 0.
 * Opt-in per session (`.claude/beh-on`).
 */
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
		/* defaults */
	}
	const cwd = data.cwd || process.cwd();
	const sessionId = data.session_id || null;
	if (!beh.behEnabled(cwd, process.env)) process.exit(0);

	const { ledger: ledgerPath, state: statePath } = beh.behPaths(cwd, sessionId);
	const st = beh.loadState(statePath);
	st.turn += 1; //  one turn per user prompt

	const bound = beh.findBoundProgress(cwd, sessionId);
	const progress = (bound && bound.progress) || { scope_items: [] };
	const phase = progress.current_phase;
	const now = Date.now();

	// accrue cumulative phase dwell (turns + firstTs); never reset on re-entry.
	if (phase) {
		const pu = st.phase_usage[phase] || { turns: 0, firstTs: now, lastTs: now };
		pu.turns += 1;
		pu.lastTs = now;
		if (pu.firstTs == null) pu.firstTs = now;
		st.phase_usage[phase] = pu;
	}
	st.last_phase = phase || st.last_phase;

	const ledger = beh.readLedger(ledgerPath);
	const result = beh.evaluateDrift({
		now,
		turn: st.turn,
		ledger,
		progress: { ...progress, phase_usage: st.phase_usage },
		barrier: st.barrier,
	});
	st.barrier = result.barrier;
	try {
		beh.saveState(statePath, st);
	} catch {
		/* best-effort */
	}

	if (result.injects.length === 0 && !result.hardStop) process.exit(0);

	const lines = ["══ [BEH: BEHAVIOR ENFORCEMENT] ════════════════════════════"];
	if (result.hardStop) {
		lines.push(result.hardStopReason);
		lines.push("");
	}
	for (const inj of result.injects) lines.push("• " + inj.message);
	lines.push("══════════════════════════════════════════════════════════");

	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: lines.join("\n") },
		}),
	);
	process.exit(0);
}
main().catch(() => process.exit(0));
