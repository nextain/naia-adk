#!/usr/bin/env node
/**
 * BEH §3.2 completion receipts — fault-injection test (plan §4, §6.2).
 *
 * Injects synthetic items + receipts + current-closure states into the pure
 * evaluateCompletion(), asserting which "done" claims are rejected (no receipt
 * / stale / fail-closed) and which pass. Plus I/O helpers (closure capture,
 * tree_state_id, verify-command match) on a hermetic temp dir.
 *
 * Usage: node run-beh-receipts-test.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const R = require(path.join(__dirname, "..", "..", "..", ".agents", "hooks", "core", "beh-receipts.js"));
const beh = require(path.join(__dirname, "..", "..", "..", ".agents", "hooks", "core", "beh-ledger.js"));

let PASS = 0,
	FAIL = 0;
const FAILED = [];
function assert(c, n, d) {
	c ? PASS++ : (FAIL++, FAILED.push(n), console.log(`  ✗ FAIL: ${n}${d ? "\n     " + d : ""}`));
}
const inc = (r, id) => r.incomplete.some((x) => x.item === id);

const VSPEC = { cmd_pattern: "^npm test", closure: ["src/x.ts"] };

// 1. done, no verify spec → incomplete.
{
	const r = R.evaluateCompletion({ items: [{ id: "a", state: "done" }], receipts: [], currentClosureById: {} });
	assert(inc(r, "a"), "1. done w/o verify spec → incomplete");
}
// 2. done, verify but no receipt → incomplete.
{
	const r = R.evaluateCompletion({ items: [{ id: "a", state: "done", verify: VSPEC }], receipts: [], currentClosureById: {} });
	assert(inc(r, "a"), "2. done, no receipt → incomplete");
}
// 3. done, exit-0 receipt, closure matches → complete.
{
	const closure = [{ path: "src/x.ts", hash: "h1" }];
	const r = R.evaluateCompletion({
		items: [{ id: "a", state: "done", verify: VSPEC }],
		receipts: [{ item_id: "a", cmd: "npm test", exit: 0, closure }],
		currentClosureById: { a: [{ path: "src/x.ts", hash: "h1" }] },
	});
	assert(!inc(r, "a"), "3. valid receipt + matching closure → complete", JSON.stringify(r));
}
// 4. done, receipt closure hash changed → stale incomplete.
{
	const r = R.evaluateCompletion({
		items: [{ id: "a", state: "done", verify: VSPEC }],
		receipts: [{ item_id: "a", exit: 0, closure: [{ path: "src/x.ts", hash: "h1" }] }],
		currentClosureById: { a: [{ path: "src/x.ts", hash: "h2_CHANGED" }] },
	});
	assert(inc(r, "a"), "4. stale receipt (closure changed) → incomplete");
}
// 5. fail-closed: undeclared_input receipt → incomplete.
{
	const r = R.evaluateCompletion({
		items: [{ id: "a", state: "done", verify: VSPEC }],
		receipts: [{ item_id: "a", exit: 0, undeclared_input: true, closure: [] }],
		currentClosureById: { a: [] },
	});
	assert(inc(r, "a"), "5. undeclared input → fail-closed incomplete");
}
// 6. running item ignored (not a completion claim).
{
	const r = R.evaluateCompletion({ items: [{ id: "a", state: "running", verify: VSPEC }], receipts: [], currentClosureById: {} });
	assert(!inc(r, "a"), "6. running item → not checked");
}
// 7. closure file removed since receipt → stale (count mismatch).
{
	const r = R.evaluateCompletion({
		items: [{ id: "a", state: "done", verify: VSPEC }],
		receipts: [{ item_id: "a", exit: 0, closure: [{ path: "src/x.ts", hash: "h1" }, { path: "src/y.ts", hash: "h2" }] }],
		currentClosureById: { a: [{ path: "src/x.ts", hash: "h1" }] },
	});
	assert(inc(r, "a"), "7. closure file removed → stale incomplete");
}
// 8. isVerifyCommand pattern match.
{
	assert(R.isVerifyCommand({ verify: VSPEC }, "bash:npm test src") === true, "8. isVerifyCommand: match");
	assert(R.isVerifyCommand({ verify: VSPEC }, "bash:echo hi") === false, "8. isVerifyCommand: non-match");
}
// 9. captureClosure + treeStateId determinism (hermetic temp dir).
{
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "beh-rc-"));
	fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
	fs.writeFileSync(path.join(cwd, "src", "x.ts"), "alpha");
	const cand = ["src/x.ts", "src/y.ts", "docs/r.md"];
	const c1 = R.captureClosure(cwd, ["src/**"], beh.globToRe, cand);
	const id1 = R.treeStateId(c1);
	// change file → tree id changes.
	fs.writeFileSync(path.join(cwd, "src", "x.ts"), "beta");
	const c2 = R.captureClosure(cwd, ["src/**"], beh.globToRe, cand);
	const id2 = R.treeStateId(c2);
	const x1 = c1.find((e) => e.path === "src/x.ts");
	assert(x1 && x1.hash && c1.every((e) => e.path.startsWith("src/")), "9. captureClosure: glob match (src/** → src/x.ts hashed)", JSON.stringify(c1));
	assert(id1 !== id2, "9. treeStateId changes when closure content changes");
	// missing file → null hash, deterministic.
	const cMiss = R.captureClosure(cwd, ["src/y.ts"], beh.globToRe, cand);
	assert(cMiss[0].hash === null, "9. captureClosure: missing file → null hash");
	fs.rmSync(cwd, { recursive: true, force: true });
}

console.log(`\nBEH receipts fault-injection: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) {
	console.log("FAILED: " + FAILED.join(", "));
	process.exit(1);
}
