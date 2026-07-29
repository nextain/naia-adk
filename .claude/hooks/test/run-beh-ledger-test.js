#!/usr/bin/env node
/**
 * BEH §3.1 ledger core — fault-injection test runner (plan §4, §6.1).
 *
 * Drift is reproduced by INJECTING synthetic ledger+progress states into the
 * pure evaluateDrift(), then asserting the decision. We test "does the harness
 * react to drift SIGNALS / not over-fire on legitimate work", NOT "does an LLM
 * drift" (which is not reproducible). This is the testability answer (plan §4).
 *
 * Usage: node run-beh-ledger-test.js
 */
const path = require("path");
const beh = require(path.join(__dirname, "..", "..", "..", ".agents", "hooks", "core", "beh-ledger.js"));

let PASS = 0,
	FAIL = 0;
const FAILED = [];
function ok(name) {
	PASS++;
}
function bad(name, detail) {
	FAIL++;
	FAILED.push(name);
	console.log(`  ✗ FAIL: ${name}${detail ? "\n     " + detail : ""}`);
}
function assert(cond, name, detail) {
	cond ? ok(name) : bad(name, detail);
}
const MIN = 60 * 1000;

// helper: invariants present in a result
function invs(r) {
	return new Set(r.injects.map((i) => i.invariant));
}

// ── unit: canonTarget ─────────────────────────────────────────────────────
{
	const c = beh.canonTarget("Edit", { file_path: "/repo/src/x.ts" }, { cwd: "/repo" });
	assert(c === "file:src/x.ts", "canon: Edit abs→rel", `got ${c}`);
	const b = beh.canonTarget("Bash", { command: "npm   test  'foo bar'" });
	assert(b === "bash:npm test ''", "canon: Bash collapse+quote-blank", `got ${b}`);
	const posixBackslash = beh.canonTarget("Edit", { file_path: "src/a\\b.ts" }, { cwd: "/repo", platform: "linux" });
	const posixSlash = beh.canonTarget("Edit", { file_path: "src/a/b.ts" }, { cwd: "/repo", platform: "linux" });
	assert(posixBackslash === "file:src/a\\b.ts" && posixBackslash !== posixSlash, "canon: POSIX literal backslash remains distinct", `${posixBackslash} vs ${posixSlash}`);
	const windows = beh.canonTarget("Edit", { file_path: "src\\a\\b.ts" }, { cwd: "C:\\repo", platform: "win32" });
	assert(windows === "file:src/a/b.ts", "canon: Windows separators normalize to slash", `got ${windows}`);
}

// ── unit: matchMilestone ──────────────────────────────────────────────────
{
	const item = {
		milestones: [
			{ id: "m1", accept: { kind: "path", glob: "src/**/*.ts" } },
			{ id: "m2", accept: { kind: "bash_ok", pattern: "^npm test" } },
		],
	};
	assert(
		beh.matchMilestone(item, { tool: "Edit", target_canon: "file:src/a/b.ts", outcome: "ok" }) === "m1",
		"match: path glob",
	);
	assert(
		beh.matchMilestone(item, { tool: "Bash", target_canon: "bash:npm test x", outcome: "ok" }) === "m2",
		"match: bash_ok",
	);
	assert(
		beh.matchMilestone(item, { tool: "Edit", target_canon: "file:docs/x.md", outcome: "ok" }) === null,
		"match: non-matching path → null",
	);
	const consumed = { milestones: [{ id: "m1", accept: { kind: "path", glob: "*" }, consumed_turn: 3 }] };
	assert(
		beh.matchMilestone(consumed, { tool: "Edit", target_canon: "file:x", outcome: "ok" }) === null,
		"match: consumed milestone → null (one-shot)",
	);
}

// ── unit: deriveProgressMarks one-shot ────────────────────────────────────
{
	const items = [{ id: "A", milestones: [{ id: "m1" }] }];
	const ledger = [
		{ turn: 2, ts: 2 * MIN, scope_item: "A", matched_milestone: "m1" },
		{ turn: 5, ts: 5 * MIN, scope_item: "A", matched_milestone: "m1" }, // repeat — ignored
	];
	const marks = beh.deriveProgressMarks(ledger, items);
	assert(marks.A.lastTurn === 2, "derive: one-shot keeps FIRST consumption", `got ${marks.A.lastTurn}`);
}

// ════════════════ #1 DRIFT REPRODUCTION (must catch) ═════════════════════
const base = (over) => ({
	now: 100 * MIN,
	turn: 20,
	ledger: [],
	progress: { current_phase: "build", phase_usage: {}, scope_items: [] },
	barrier: { lastInjectTurn: {}, ignored: {} },
	...over,
});

// 1. all-empty-retry: mature running item, zero matched milestones.
{
	const r = beh.evaluateDrift(
		base({
			progress: {
				current_phase: "build",
				phase_usage: {},
				scope_items: [
					{ id: "uc5", phase: "build", state: "running", started_turn: 0, started_ts: 0, milestones: [{ id: "m1" }] },
				],
			},
		}),
	);
	const s = invs(r);
	assert(s.has("new_value_zero"), "#1.1 all-empty-retry → new_value_zero inject");
	assert(s.has("active_stall"), "#1.1 all-empty-retry → active_stall inject");
}

// 2. K-ignore → hard-stop (inject barrier counts AFTER inject turn).
{
	let barrier = { lastInjectTurn: {}, ignored: {} };
	let last = null;
	for (let t = 20; t <= 25; t++) {
		last = beh.evaluateDrift(
			base({
				turn: t,
				now: (80 + t) * MIN,
				barrier,
				progress: {
					current_phase: "build",
					phase_usage: {},
					scope_items: [
						{ id: "uc5", phase: "build", state: "running", started_turn: 0, started_ts: 0, milestones: [{ id: "m1" }] },
					],
				},
			}),
		);
		barrier = last.barrier;
	}
	assert(last.hardStop === true, "#1.2 persistent drift past K → hard-stop", `hardStop=${last.hardStop}`);
	assert(/HARD-STOP/.test(last.hardStopReason || ""), "#1.2 hard-stop reason set");
}

// 3. blocked disposition: termination requested with a live item.
{
	const r = beh.evaluateDrift(
		base({
			progress: {
				current_phase: "build",
				termination_requested: true,
				phase_usage: {},
				scope_items: [
					{ id: "done1", state: "done", milestones: [] },
					{ id: "live", state: "running", started_turn: 19, started_ts: 99 * MIN, milestones: [{ id: "m1" }] },
				],
			},
		}),
	);
	assert(r.blockTermination === true, "#1.3 termination with live item → blockTermination");
	assert(invs(r).has("blocked_termination"), "#1.3 → blocked_termination inject");
}

// 4. scope undeclared (autonomous, no items).
{
	const r = beh.evaluateDrift(
		base({ progress: { current_phase: "build", autonomous: true, phase_usage: {}, scope_items: [] } }),
	);
	assert(invs(r).has("scope_undeclared"), "#1.4 autonomous + no scope → scope_undeclared inject");
}

// 5. phase cumulative ceiling.
{
	const r = beh.evaluateDrift(
		base({
			progress: {
				current_phase: "plan",
				phase_usage: { plan: { turns: 40, firstTs: 0 } }, // ceiling 40
				scope_items: [],
			},
		}),
	);
	assert(invs(r).has("phase_ceiling"), "#1.5 plan turns≥ceiling → phase_ceiling inject");
}

// 6. starvation of a ready (schedulable) item.
{
	const r = beh.evaluateDrift(
		base({
			progress: {
				current_phase: "build",
				phase_usage: {},
				scope_items: [{ id: "waiting", state: "ready", ready_since_turn: 0, ready_since_ts: 0, milestones: [{ id: "m1" }] }],
			},
		}),
	);
	assert(invs(r).has("starvation"), "#1.6 long-ready item → starvation inject");
}

// 7. one-shot masking: repeat-execute the SAME milestone → still stalls.
{
	const ledger = [];
	for (let t = 1; t <= 12; t++) ledger.push({ turn: t, ts: t * MIN, scope_item: "uc5", matched_milestone: "m1" });
	const r = beh.evaluateDrift(
		base({
			turn: 20,
			now: 30 * MIN,
			ledger,
			progress: {
				current_phase: "build",
				phase_usage: {},
				scope_items: [{ id: "uc5", state: "running", started_turn: 0, started_ts: 0, milestones: [{ id: "m1" }] }],
			},
		}),
	);
	assert(invs(r).has("active_stall"), "#1.7 repeat same milestone (masking) → still active_stall");
}

// ════════════════ FALSE-POSITIVE PREVENTION (must NOT catch) ═════════════
// 8. fresh running item (immature) → no stall / no new-value-zero.
{
	const r = beh.evaluateDrift(
		base({
			turn: 20,
			now: 100 * MIN,
			progress: {
				current_phase: "build",
				phase_usage: {},
				scope_items: [{ id: "fresh", state: "running", started_turn: 19, started_ts: 99 * MIN, milestones: [{ id: "m1" }] }],
			},
		}),
	);
	const s = invs(r);
	assert(!s.has("active_stall") && !s.has("new_value_zero"), "#FP.8 fresh item → no stall/new-value inject", [...s].join(","));
}

// 9. legitimate iterative progress (recent new milestone within window).
{
	const r = beh.evaluateDrift(
		base({
			turn: 20,
			now: 100 * MIN,
			ledger: [{ turn: 19, ts: 99 * MIN, scope_item: "uc5", matched_milestone: "m3" }],
			progress: {
				current_phase: "build",
				phase_usage: {},
				scope_items: [
					{ id: "uc5", state: "running", started_turn: 0, started_ts: 0, milestones: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] },
				],
			},
		}),
	);
	const s = invs(r);
	assert(!s.has("active_stall") && !s.has("new_value_zero"), "#FP.9 recent milestone → no drift inject", [...s].join(","));
}

// 10. dep_blocked item idle long → NO starvation (exempt).
{
	const r = beh.evaluateDrift(
		base({
			progress: {
				current_phase: "build",
				phase_usage: {},
				scope_items: [{ id: "blocked", state: "dep_blocked", deps: ["x"], ready_since_turn: 0, ready_since_ts: 0, milestones: [{ id: "m1" }] }],
			},
		}),
	);
	assert(!invs(r).has("starvation"), "#FP.10 dep_blocked idle → no starvation (exempt)");
}

// 11. phase ceiling extended by user re-approval → no inject.
{
	const r = beh.evaluateDrift(
		base({
			progress: {
				current_phase: "plan",
				phase_usage: { plan: { turns: 99, firstTs: 0 } },
				phase_ceiling_extended: { plan: true },
				scope_items: [],
			},
		}),
	);
	assert(!invs(r).has("phase_ceiling"), "#FP.11 ceiling extended → no phase_ceiling inject");
}

// 12. plain plan phase, within budget, no items → fully quiet.
{
	const r = beh.evaluateDrift(
		base({ progress: { current_phase: "plan", phase_usage: { plan: { turns: 5, firstTs: 90 * MIN } }, scope_items: [] } }),
	);
	assert(r.injects.length === 0 && !r.hardStop, "#FP.12 healthy plan phase → no injects", `${r.injects.length} injects`);
}

// 13. barrier clears when drift resolves (no lingering ignore count).
{
	let barrier = { lastInjectTurn: { new_value_zero: 19 }, ignored: { new_value_zero: 1 } };
	const r = beh.evaluateDrift(
		base({
			turn: 20,
			now: 100 * MIN,
			barrier,
			ledger: [{ turn: 20, ts: 100 * MIN, scope_item: "uc5", matched_milestone: "m1" }],
			progress: {
				current_phase: "build",
				phase_usage: {},
				scope_items: [{ id: "uc5", state: "running", started_turn: 0, started_ts: 0, milestones: [{ id: "m1" }] }],
			},
		}),
	);
	assert(r.barrier.ignored.new_value_zero === undefined, "#FP.13 resolved drift clears barrier ignore count");
	assert(!r.hardStop, "#FP.13 resolved → no hard-stop");
}

// ── summary ───────────────────────────────────────────────────────────────
console.log(`\nBEH ledger fault-injection: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) {
	console.log("FAILED: " + FAILED.join(", "));
	process.exit(1);
}
