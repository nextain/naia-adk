#!/usr/bin/env node
"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const core = require("../hooks/core/session-contract.js");
const recovery = require("./session-contract-recovery.cjs");

function writeJson(filePath, value) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-reclaim-"));
	writeJson(path.join(root, ".agents/context/agents-rules.json"), {});
	const contractPath = path.join(root, ".agents/session-contracts/orphan-job.json");
	const progressPath = path.join(root, ".agents/progress/orphan-job.json");
	const oldSession = `old-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	const newSession = `new-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	const contract = {
		schema_version: "1.0",
		id: "orphan-job",
		status: "active",
		project_root: ".",
		goal: "test reclaim",
		scope: ["test"],
		non_goals: [],
		success_criteria: ["reclaimed"],
		allowed_paths: ["work/**"],
		target_ownership: ["work/**"],
		audiences: ["test"],
		source_refs: ["test"],
		session_bindings: [{ session_id: oldSession, contract_digest: "" }],
		progress_file: ".agents/progress/orphan-job.json",
		contract_digest: "",
	};
	const digest = core.contractDigest(contract);
	contract.contract_digest = digest;
	contract.session_bindings[0].contract_digest = digest;
	writeJson(contractPath, contract);
	writeJson(progressPath, { schema_version: "1.0", session_id: oldSession, contract_id: contract.id, contract_digest: digest, status: "in_progress" });
	writeJson(path.join(root, ".agents/session-contracts/.session-map.json"), {
		schema_version: "1.0",
		bindings: {
			[oldSession]: { contract_id: contract.id, contract_path: ".agents/session-contracts/orphan-job.json", contract_digest: digest },
		},
	});
	return { root, oldSession, newSession, digest, contractPath, progressPath };
}

// No live owner process anywhere, and no host identity of our own: the test
// process's real ancestry (a Claude/Codex host running this suite) must never
// leak into a fixture as "the same host".
const STOPPED = { processLines: [], hostIdentity: null };

function approve(test) {
	recovery.handleEvent("UserPromptSubmit", JSON.stringify({ cwd: test.root, session_id: test.newSession, prompt: `/harness reclaim orphan-job` }), test.root);
}

function testFreshOwnerBlocks() {
	const test = fixture();
	try {
		approve(test);
		recovery.recordLease(test.root, { session_id: test.oldSession }, "PreToolUse");
		assert.throws(() => recovery.reclaim(test.root, "orphan-job", test.newSession, STOPPED), /owner_session_live/);
		assert.equal(core.resolveSessionContract({ cwd: test.root, sessionId: test.oldSession }).status, core.STATES.BOUND);
	} finally { fs.rmSync(test.root, { recursive: true, force: true }); }
}

function testExplicitStoppedReclaim() {
	const test = fixture();
	try {
		approve(test);
		const tx = recovery.reclaim(test.root, "orphan-job", test.newSession, STOPPED);
		assert.equal(tx.original_digest, test.digest);
		assert.notEqual(tx.next_digest, test.digest);
		const resolved = core.resolveSessionContract({ cwd: test.root, sessionId: test.newSession });
		assert.equal(resolved.status, core.STATES.BOUND);
		assert.equal(core.resolveSessionContract({ cwd: test.root, sessionId: test.oldSession }).status, core.STATES.UNBOUND);
		assert.deepEqual(resolved.contract.session_bindings.map((item) => item.session_id), [test.newSession]);
		assert.equal(resolved.progress.recovery_history.at(-1).state, "revoked_abandoned");
		const audit = fs.readFileSync(path.join(test.root, ".agents/session-contracts/.recovery/audit.jsonl"), "utf8");
		assert.match(audit, /reclaim_granted/);
		assert.match(audit, /reclaim_prepared/);
		assert.match(audit, /reclaim_completed/);
		assert.equal(fs.existsSync(path.join(test.root, `.agents/session-contracts/.recovery/grants/${test.newSession}--orphan-job.json`)), false);
	} finally { fs.rmSync(test.root, { recursive: true, force: true }); }
}

function testHostProcessIdentityWalksPastHookProcesses() {
	const snapshots = new Map([
		[30, { pid: 30, parent_pid: 20, start_token: "hook-start", command_line: "node session-contract-recovery.cjs" }],
		[20, { pid: 20, parent_pid: 10, start_token: "launcher-start", command_line: "node run-hook.cjs" }],
		[10, { pid: 10, parent_pid: 1, start_token: "codex-start", command_line: "C:\\tools\\codex.exe exec" }],
	]);
	const identity = recovery.hostProcessIdentity(30, (pid) => snapshots.get(pid) || null);
	assert.equal(identity.pid, 10);
	assert.equal(identity.start_token, "codex-start");
	assert.equal(identity.command_line_hash.length, 64);
	assert.equal(recovery.isHostProcess('\"C:\\tools\\codex.exe\" exec'), true, "quoted Windows executables must be recognized");
}

function testLaterEventsReuseSessionStartIdentity() {
	const test = fixture();
	try {
		const leasePath = path.join(test.root, `.agents/session-contracts/.recovery/leases/${test.oldSession}.json`);
		const identity = { pid: 42, start_token: "stable-start", command_line_hash: "a".repeat(64) };
		writeJson(leasePath, { schema_version: "1.0", session_id: test.oldSession, state: "active", host_process: identity });
		recovery.recordLease(test.root, { session_id: test.oldSession }, "Stop");
		const lease = JSON.parse(fs.readFileSync(leasePath, "utf8"));
		assert.deepEqual(lease.host_process, identity);
		assert.equal(lease.event, "Stop");
	} finally { fs.rmSync(test.root, { recursive: true, force: true }); }
}

function testRecordedHostProcessUsesPidAndStartToken() {
	const lease = { host_process: { pid: 42, start_token: "original" } };
	assert.equal(recovery.recordedHostProcessLive(lease, () => ({ pid: 42, start_token: "original" })), true);
	assert.equal(recovery.recordedHostProcessLive(lease, () => ({ pid: 42, start_token: "reused" })), false);
	assert.equal(recovery.recordedHostProcessLive(lease, () => null), false);
	assert.throws(() => recovery.recordedHostProcessLive(lease, () => undefined), /liveness_probe_unavailable/);
}

function testStopKeepsLeaseActive() {
	const test = fixture();
	try {
		recovery.recordLease(test.root, { session_id: test.oldSession }, "Stop");
		const leasePath = path.join(test.root, `.agents/session-contracts/.recovery/leases/${test.oldSession}.json`);
		const lease = JSON.parse(fs.readFileSync(leasePath, "utf8"));
		assert.equal(lease.state, "active");
		assert.equal(lease.event, "Stop");
	} finally { fs.rmSync(test.root, { recursive: true, force: true }); }
}

function staleLease(test, hostProcess = null) {
	const stale = new Date(Date.now() - recovery.LEASE_FRESH_MS - 1000).toISOString();
	writeJson(path.join(test.root, `.agents/session-contracts/.recovery/leases/${test.oldSession}.json`), { schema_version: "1.0", session_id: test.oldSession, state: "active", updated_at: stale, host_process: hostProcess });
}

// A provably dead owner is the whole safety condition. Demanding a typed
// approval on top of it made every crash a human chore and left unattended
// sessions stuck for good; the audit still records that no grant was involved.
function testDeadOwnerReclaimsWithoutApproval() {
	const test = fixture();
	try {
		staleLease(test);
		const tx = recovery.reclaim(test.root, "orphan-job", test.newSession, STOPPED);
		assert.equal(core.resolveSessionContract({ cwd: test.root, sessionId: test.newSession }).status, core.STATES.BOUND);
		assert.equal(tx.new_session_id, test.newSession);
		const audit = fs.readFileSync(path.join(test.root, ".agents/session-contracts/.recovery/audit.jsonl"), "utf8");
		assert.doesNotMatch(audit, /reclaim_granted/);
		assert.match(audit, /"granted":false/);
		assert.match(audit, /reclaim_completed/);
	} finally { fs.rmSync(test.root, { recursive: true, force: true }); }
}

function testExpiredApprovalIsIgnored() {
	const test = fixture();
	try {
		approve(test);
		const grantPath = path.join(test.root, `.agents/session-contracts/.recovery/grants/${test.newSession}--orphan-job.json`);
		const grant = JSON.parse(fs.readFileSync(grantPath, "utf8"));
		grant.expires_at = new Date(0).toISOString();
		writeJson(grantPath, grant);
		staleLease(test);
		recovery.reclaim(test.root, "orphan-job", test.newSession, STOPPED);
		assert.equal(core.resolveSessionContract({ cwd: test.root, sessionId: test.newSession }).status, core.STATES.BOUND);
		assert.equal(fs.existsSync(grantPath), false, "a stale grant is cleared so it cannot be replayed");
	} finally { fs.rmSync(test.root, { recursive: true, force: true }); }
}

// `/clear` gives the same host process a new session id. The old lease then
// names a host that is alive — us. That must read as the owner continuing,
// never as a rival owner, and it must happen by itself at SessionStart.
function testSameHostContinuesAfterClear() {
	const test = fixture();
	try {
		const identity = { pid: 4242, start_token: "host-start", command_line_hash: "b".repeat(64) };
		writeJson(path.join(test.root, `.agents/session-contracts/.recovery/leases/${test.oldSession}.json`), { schema_version: "1.0", session_id: test.oldSession, state: "active", updated_at: new Date().toISOString(), host_process: identity });
		const alive = (pid) => (pid === 4242 ? { pid: 4242, start_token: "host-start" } : null);
		recovery.handleEvent("SessionStart", JSON.stringify({ cwd: test.root, session_id: test.newSession }), test.root, { hostIdentity: identity, snapshot: alive, processLines: [] });
		const resolved = core.resolveSessionContract({ cwd: test.root, sessionId: test.newSession });
		assert.equal(resolved.status, core.STATES.BOUND, "the new session id continues the same host's contract");
		assert.equal(resolved.contract.id, "orphan-job");
		assert.equal(core.resolveSessionContract({ cwd: test.root, sessionId: test.oldSession }).status, core.STATES.UNBOUND);
		const audit = fs.readFileSync(path.join(test.root, ".agents/session-contracts/.recovery/audit.jsonl"), "utf8");
		assert.match(audit, /session_continued/);
		// Running the same start again is a no-op: the session is already bound.
		assert.equal(recovery.continueSameHost(test.root, test.newSession, { hostIdentity: identity, snapshot: alive, processLines: [] }), null);
	} finally { fs.rmSync(test.root, { recursive: true, force: true }); }
}

function testDifferentLiveHostStillBlocks() {
	const test = fixture();
	try {
		const other = { pid: 5150, start_token: "other-start", command_line_hash: "c".repeat(64) };
		staleLease(test, other);
		const mine = { pid: 4242, start_token: "host-start", command_line_hash: "b".repeat(64) };
		const alive = (pid) => (pid === 5150 ? { pid: 5150, start_token: "other-start" } : null);
		assert.equal(recovery.continueSameHost(test.root, test.newSession, { hostIdentity: mine, snapshot: alive, processLines: [] }), null, "another host's contract is not continued");
		assert.throws(() => recovery.reclaim(test.root, "orphan-job", test.newSession, { hostIdentity: mine, snapshot: alive, processLines: [] }), /owner_session_live/);
		assert.equal(core.resolveSessionContract({ cwd: test.root, sessionId: test.oldSession }).status, core.STATES.BOUND);
	} finally { fs.rmSync(test.root, { recursive: true, force: true }); }
}

// A session working inside projects/<name> (its own .git) types
// `/harness reclaim`. The contract lives at the ADK root, so the grant and the
// lease must be filed there, and SessionStart from the nested directory must
// continue the root contract.
function testNestedWorkingDirectoryFindsRootContract() {
	const test = fixture();
	try {
		const nested = path.join(test.root, "projects", "voice");
		fs.mkdirSync(path.join(nested, ".git"), { recursive: true });
		recovery.handleEvent("UserPromptSubmit", JSON.stringify({ cwd: nested, session_id: test.newSession, prompt: "/harness reclaim orphan-job" }), nested);
		assert.equal(fs.existsSync(path.join(test.root, `.agents/session-contracts/.recovery/grants/${test.newSession}--orphan-job.json`)), true, "the grant is filed where the contract lives");
		assert.equal(fs.existsSync(path.join(test.root, `.agents/session-contracts/.recovery/leases/${test.newSession}.json`)), true, "the lease is filed at the ADK root too");
		assert.equal(recovery.contractRoot(nested, "orphan-job"), path.resolve(test.root), "the reclaim CLI resolves the root holding the contract");
		const identity = { pid: 4242, start_token: "host-start", command_line_hash: "b".repeat(64) };
		writeJson(path.join(test.root, `.agents/session-contracts/.recovery/leases/${test.oldSession}.json`), { schema_version: "1.0", session_id: test.oldSession, state: "active", updated_at: new Date().toISOString(), host_process: identity });
		const third = `third-${Date.now()}`;
		recovery.handleEvent("SessionStart", JSON.stringify({ cwd: nested, session_id: third }), nested, { hostIdentity: identity, snapshot: () => null, processLines: [] });
		assert.equal(core.resolveSessionContract({ cwd: test.root, sessionId: third }).status, core.STATES.BOUND, "continuation from a nested working directory reaches the root contract");
	} finally { fs.rmSync(test.root, { recursive: true, force: true }); }
}

function testLifecycleCliNeverWritesStdout() {
	const test = fixture();
	try {
		for (const eventName of ["SessionStart", "UserPromptSubmit", "Stop"]) {
			const result = spawnSync(process.execPath, [path.resolve(__dirname, "session-contract-recovery.cjs"), "event", eventName], {
				cwd: test.root,
				input: JSON.stringify({ cwd: test.root, session_id: test.newSession, prompt: "ordinary prompt" }),
				encoding: "utf8",
			});
			assert.equal(result.status, 0, result.stderr);
			assert.equal(result.stdout, "", `${eventName} must not corrupt hook protocol stdout`);
		}
	} finally { fs.rmSync(test.root, { recursive: true, force: true }); }
}

testFreshOwnerBlocks();
testExplicitStoppedReclaim();
testHostProcessIdentityWalksPastHookProcesses();
testLaterEventsReuseSessionStartIdentity();
testRecordedHostProcessUsesPidAndStartToken();
testStopKeepsLeaseActive();
testDeadOwnerReclaimsWithoutApproval();
testExpiredApprovalIsIgnored();
testSameHostContinuesAfterClear();
testDifferentLiveHostStillBlocks();
testNestedWorkingDirectoryFindsRootContract();
testLifecycleCliNeverWritesStdout();
process.stdout.write("session contract reclaim tests passed\n");
