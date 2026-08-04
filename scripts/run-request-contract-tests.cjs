#!/usr/bin/env node
/** Run the broad fault suite and the memory-isolated full client parity suite. */

const cp = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");
const suite = path.join(root, ".claude", "hooks", "test", "run-request-contract-test.js");

function evaluateReleaseGate(gate, expectBlocked) {
	if (gate.error) return { ok: false, kind: "invalid", reason: "spawn error" };
	if (gate.signal) return { ok: false, kind: "invalid", reason: "terminated by signal" };
	if (![0, 3].includes(gate.status)) return { ok: false, kind: "invalid", reason: "unexpected exit status" };
	if (String(gate.stderr || "") !== "") return { ok: false, kind: "invalid", reason: "stderr was not empty" };
	let status;
	try { status = JSON.parse(String(gate.stdout || "").trim()); } catch { return { ok: false, kind: "invalid", reason: "malformed JSON" }; }
	const recognizedBlocker = status?.status === "blocked" && (
		status.blocker?.code === "review_scope_stale" && /^RCI-\d{3}$/.test(status.blocker.requirement_id || "") && /^[A-Za-z0-9._-]+$/.test(status.blocker.receipt_id || "")
		|| status.blocker?.code === "legacy_source_provenance_unresolved" && JSON.stringify(status.blocker.source_ids) === JSON.stringify(["USR-001", "USR-002", "USR-003", "USR-004", "USR-005", "USR-006", "USR-007"])
	);
	if (gate.status === 3 && recognizedBlocker) return { ok: expectBlocked, kind: "blocked", status, reason: expectBlocked ? null : "release was blocked unexpectedly" };
	if (gate.status === 0 && status?.status === "eligible" && status.blocker === null) return { ok: !expectBlocked, kind: "eligible", status, reason: expectBlocked ? "expected REVIEW_ONLY but release was eligible" : null };
	return { ok: false, kind: "invalid", status, reason: "malformed or unrecognized release status" };
}

function runReleaseGateSelfTests() {
	const stale = JSON.stringify({ status: "blocked", blocker: { code: "review_scope_stale", requirement_id: "RCI-001", receipt_id: "round-1" } });
	const legacy = JSON.stringify({ status: "blocked", blocker: { code: "legacy_source_provenance_unresolved", source_ids: ["USR-001", "USR-002", "USR-003", "USR-004", "USR-005", "USR-006", "USR-007"] } });
	const eligible = JSON.stringify({ status: "eligible", blocker: null });
	const cases = [
		["spawn error", { error: new Error("boom"), status: null, signal: null, stdout: "", stderr: "" }, true, false],
		["signal", { status: null, signal: "SIGTERM", stdout: "", stderr: "" }, true, false],
		["unexpected status", { status: 1, signal: null, stdout: stale, stderr: "" }, true, false],
		["malformed JSON", { status: 3, signal: null, stdout: "not-json", stderr: "" }, true, false],
		["stderr", { status: 3, signal: null, stdout: stale, stderr: "warning" }, true, false],
		["recognized stale blocker", { status: 3, signal: null, stdout: stale, stderr: "" }, true, true],
		["recognized legacy blocker", { status: 3, signal: null, stdout: legacy, stderr: "" }, true, true],
		["unexpected blocker", { status: 3, signal: null, stdout: JSON.stringify({ status: "blocked", blocker: { code: "anything" } }), stderr: "" }, true, false],
		["eligible", { status: 0, signal: null, stdout: eligible, stderr: "" }, false, true],
		["eligible while blocked expected", { status: 0, signal: null, stdout: eligible, stderr: "" }, true, false],
		["blocked while eligible expected", { status: 3, signal: null, stdout: stale, stderr: "" }, false, false],
	];
	for (const [label, gate, expectedBlocked, expectedOk] of cases) {
		const result = evaluateReleaseGate(gate, expectedBlocked);
		if (result.ok !== expectedOk) throw new Error(`release status self-test failed: ${label}`);
	}
}

runReleaseGateSelfTests();
if (process.argv.includes("--self-test-release-status")) {
	process.stdout.write("request-contract release-status classifier: PASS\n");
	process.exit(0);
}

/** The transcript parser and the requirement trace gate the rest: a misread verdict here would license everything after it. */
const gates = [
	{ label: "review-transcript-parser", argv: [path.join(root, "scripts", "request-contract-review-transcript.cjs")] },
	{ label: "requirements-trace-self-test", argv: [path.join(root, "scripts", "validate-request-contract-requirements.cjs")], env: { ...process.env, RCI_SELF_TEST_ONLY: "1" } },
	{ label: "preservation-snapshot", argv: [path.join(root, ".agents", "hooks", "core", "preservation-snapshot.test.js")] },
	{ label: "preservation-execution-runner", argv: [path.join(root, ".agents", "hooks", "core", "preservation-execution-runner.test.js")] },
	{ label: "preservation-receipt-evidence", argv: [path.join(root, ".agents", "hooks", "core", "preservation-receipt-evidence.test.js")] },
	{ label: "preservation-attestor-service", argv: [path.join(root, "scripts", "preservation-attestor-service.test.cjs")] },
	{ label: "preservation-attestor-e2e", argv: [path.join(root, "scripts", "preservation-attestor-e2e.test.cjs")] },
];
let failed = false;
for (const gate of gates) {
	const result = cp.spawnSync(process.execPath, gate.argv, { cwd: root, env: gate.env || process.env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
	if (result.error || result.status !== 0) {
		if (result.stdout) process.stderr.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		process.stderr.write(`request-contract ${gate.label}: FAIL\n`);
		failed = true;
		continue;
	}
	process.stdout.write(`request-contract ${gate.label}: PASS\n`);
}
const runs = [
	{ label: "fault-suite", env: { ...process.env, TEST_FILTER: "" } },
	{ label: "persisted-client-parity", env: { ...process.env, TEST_FILTER: "full persisted lifecycle" } },
];

for (const run of runs) {
	process.stdout.write(`request-contract ${run.label}: RUN\n`);
	const result = cp.spawnSync(process.execPath, [suite], { cwd: root, env: run.env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
	if (result.error || result.status !== 0) {
		if (result.stdout) process.stderr.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		process.stderr.write(`request-contract ${run.label}: FAIL\n`);
		failed = true;
		continue;
	}
	process.stdout.write(`request-contract ${run.label}: PASS\n`);
}

const releaseGate = cp.spawnSync(process.execPath, [path.join(root, "scripts", "validate-request-contract-requirements.cjs")], { cwd: root, env: { ...process.env, RCI_RELEASE_STATUS_JSON: "1" }, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const expectReleaseBlocked = process.env.REQUEST_CONTRACT_EXPECT_RELEASE_BLOCKED === "1";
const releaseEvaluation = evaluateReleaseGate(releaseGate, expectReleaseBlocked);
if (releaseEvaluation.kind === "invalid") {
	if (releaseGate.stdout) process.stderr.write(releaseGate.stdout);
	if (releaseGate.stderr) process.stderr.write(releaseGate.stderr);
	process.stderr.write(`request-contract release-eligibility validator: FAIL (${releaseEvaluation.reason})\n`);
	failed = true;
} else if (releaseEvaluation.kind === "blocked") {
	process.stderr.write(`request-contract release-eligibility: BLOCKED (${releaseEvaluation.status.blocker.code})\n`);
	if (!releaseEvaluation.ok) failed = true;
} else if (releaseEvaluation.kind === "eligible") {
	process.stdout.write("request-contract release-eligibility: PASS\n");
	if (!releaseEvaluation.ok) process.stderr.write(`${releaseEvaluation.reason}\n`);
	if (!releaseEvaluation.ok) failed = true;
} else {
	process.stderr.write(`request-contract release-eligibility: FAIL (${releaseEvaluation.reason})\n`);
	failed = true;
}

if (failed) {
	process.stderr.write("request-contract orchestrator: FAIL\n");
	process.exit(1);
}
process.stdout.write(`request-contract orchestrator: PASS${expectReleaseBlocked ? " (REVIEW_ONLY expected)" : ""}\n`);
