#!/usr/bin/env node
/**
 * BEH §3.3 supervise core — fault-injection test (plan §4, §6.3).
 *
 * Pure status-machine + grace/monotonic/rate-sanity + degraded + lease logic,
 * driven by synthetic timing/probe series. (Real spawn/kill is covered by the
 * wrapper's hermetic dummy-process test.)
 *
 * Usage: node run-beh-supervise-test.js
 */
const path = require("path");
const S = require(path.join(__dirname, "..", "..", "..", ".agents", "hooks", "core", "beh-supervise-core.js"));

let PASS = 0,
	FAIL = 0;
const FAILED = [];
function assert(c, n, d) {
	c ? PASS++ : (FAIL++, FAILED.push(n), console.log(`  ✗ FAIL: ${n}${d ? "\n     " + d : ""}`));
}
const T0 = 1_000_000;
const cfg = (over) => ({ maxWallMs: 600_000, maxStallMs: 20_000, graceMs: 10_000, probeType: "file_lines", ...over });

// 1. exit 0 → DONE, no kill.
{
	const r = S.evaluateSupervisor({ now: T0 + 5000, startTs: T0, exit: 0, probeSeries: [], config: cfg() });
	assert(r.status === "DONE" && r.action === "none", "1. exit 0 → DONE");
}
// 2. exit 1 → FAIL, no kill.
{
	const r = S.evaluateSupervisor({ now: T0 + 5000, startTs: T0, exit: 1, probeSeries: [], config: cfg() });
	assert(r.status === "FAIL" && r.action === "none", "2. exit 1 → FAIL");
}
// 3. invalid probe-type → FAIL + kill (free-form forbidden).
{
	const r = S.evaluateSupervisor({ now: T0 + 5000, startTs: T0, exit: null, probeSeries: [], config: cfg({ probeType: "run_my_script.sh" }) });
	assert(r.status === "FAIL" && r.action === "kill", "3. free-form probe → FAIL+kill");
}
// 4. wall exceeded → TIMEOUT + kill.
{
	const r = S.evaluateSupervisor({ now: T0 + 600_001, startTs: T0, exit: null, probeSeries: [{ ts: T0 + 599_000, value: 10 }], config: cfg() });
	assert(r.status === "TIMEOUT" && r.action === "kill", "4. wall exceeded → TIMEOUT+kill");
}
// 5. stall after grace (flat probe) → STALL + kill.
{
	const r = S.evaluateSupervisor({ now: T0 + 60_000, startTs: T0, exit: null, probeSeries: [], config: cfg() });
	assert(r.status === "STALL" && r.action === "kill", "5. flat probe past grace → STALL+kill", JSON.stringify(r));
}
// 6. within grace, flat probe → RUNNING (no false stall).
{
	const r = S.evaluateSupervisor({ now: T0 + 5000, startTs: T0, exit: null, probeSeries: [], config: cfg() });
	assert(r.status === "RUNNING" && r.action === "none", "6. flat probe within grace → RUNNING", JSON.stringify(r));
}
// 7. progressing probe → RUNNING.
{
	const r = S.evaluateSupervisor({
		now: T0 + 60_000,
		startTs: T0,
		exit: null,
		probeSeries: [{ ts: T0 + 50_000, value: 100 }, { ts: T0 + 58_000, value: 200 }],
		config: cfg(),
	});
	assert(r.status === "RUNNING" && r.action === "none", "7. progressing probe → RUNNING", JSON.stringify(r));
}
// 8. non-monotonic (decrease) does NOT reset stall clock → STALL.
{
	const r = S.evaluateSupervisor({
		now: T0 + 30_000,
		startTs: T0,
		exit: null,
		probeSeries: [{ ts: T0 + 1000, value: 5 }, { ts: T0 + 2000, value: 3 }],
		config: cfg(),
	});
	assert(r.status === "STALL" && r.action === "kill", "8. probe decrease ≠ progress → STALL", JSON.stringify(r));
}
// 9. degraded + unapproved + under degraded wall → DEGRADED, no kill.
{
	const r = S.evaluateSupervisor({ now: T0 + 5000, startTs: T0, exit: null, probeSeries: [], config: cfg({ degraded: true, degradedMaxWallMs: 60_000 }) });
	assert(r.status === "UNSUPERVISED-DEGRADED" && r.action === "none", "9. degraded under wall → DEGRADED no-kill", JSON.stringify(r));
}
// 10. degraded + unapproved + over degraded wall → DEGRADED + kill.
{
	const r = S.evaluateSupervisor({ now: T0 + 61_000, startTs: T0, exit: null, probeSeries: [], config: cfg({ degraded: true, degradedMaxWallMs: 60_000 }) });
	assert(r.status === "UNSUPERVISED-DEGRADED" && r.action === "kill", "10. degraded over forced wall → DEGRADED+kill");
}
// 11. degraded + approved → normal wall logic (RUNNING if progressing).
{
	const r = S.evaluateSupervisor({
		now: T0 + 60_000,
		startTs: T0,
		exit: null,
		probeSeries: [{ ts: T0 + 58_000, value: 9 }],
		config: cfg({ degraded: true, approvedDegraded: true }),
	});
	assert(r.status === "RUNNING", "11. degraded+approved → normal supervise", JSON.stringify(r));
}
// 12. lease acquire / renew / deny / stale recovery.
{
	const a = S.acquireLease(null, { owner: "p1", now: T0, ttlMs: 30_000 });
	assert(a.granted && a.lease.owner === "p1", "12. lease: new acquire");
	const renew = S.acquireLease({ owner: "p1", ts: T0 }, { owner: "p1", now: T0 + 1000, ttlMs: 30_000 });
	assert(renew.granted, "12. lease: same owner renew");
	const deny = S.acquireLease({ owner: "p1", ts: T0 }, { owner: "p2", now: T0 + 1000, ttlMs: 30_000 });
	assert(!deny.granted, "12. lease: other owner denied while fresh");
	const steal = S.acquireLease({ owner: "p1", ts: T0 }, { owner: "p2", now: T0 + 31_000, ttlMs: 30_000 });
	assert(steal.granted && steal.lease.owner === "p2", "12. lease: stale recovery");
}
// 13. lastProgressTs strict-increase tracking.
{
	const lp = S.lastProgressTs([{ ts: 10, value: 1 }, { ts: 20, value: 5 }, { ts: 30, value: 5 }, { ts: 40, value: 2 }], 0);
	assert(lp === 20, "13. lastProgressTs = last strict increase", `got ${lp}`);
}

console.log(`\nBEH supervise fault-injection: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) {
	console.log("FAILED: " + FAILED.join(", "));
	process.exit(1);
}
