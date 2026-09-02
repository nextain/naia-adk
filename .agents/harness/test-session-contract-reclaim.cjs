#!/usr/bin/env node
"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const core = require("../hooks/core/session-contract.js");
const recovery = require("./session-contract-recovery.cjs");
const STOPPED_PROCESS_DEPENDENCIES = { processLines: [] };

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
		allowed_paths: ["orphan/**"],
		target_ownership: ["orphan/**"],
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

function addCurrentContract(test) {
	const contractPath = path.join(test.root, ".agents/session-contracts/current-job.json");
	const progressPath = path.join(test.root, ".agents/progress/current-job.json");
	const contract = {
		schema_version: "1.0", id: "current-job", status: "active", project_root: ".",
		goal: "current work", scope: ["test"], non_goals: [], success_criteria: ["switched"],
		allowed_paths: ["current/**"], target_ownership: ["current/**"], audiences: ["test"], source_refs: ["test"],
		session_bindings: [{ session_id: test.newSession, contract_digest: "" }],
		progress_file: ".agents/progress/current-job.json", contract_digest: "",
	};
	const digest = core.contractDigest(contract);
	contract.contract_digest = digest;
	contract.session_bindings[0].contract_digest = digest;
	writeJson(contractPath, contract);
	writeJson(progressPath, { schema_version: "1.0", session_id: test.newSession, contract_id: contract.id, contract_digest: digest, status: "in_progress" });
	const registryPath = path.join(test.root, ".agents/session-contracts/.session-map.json");
	const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
	registry.bindings[test.newSession] = { contract_id: contract.id, contract_path: ".agents/session-contracts/current-job.json", contract_digest: digest };
	writeJson(registryPath, registry);
	return { contractPath, progressPath, digest };
}

function approve(test) {
	recovery.handleEvent("UserPromptSubmit", JSON.stringify({ cwd: test.root, session_id: test.newSession, prompt: `/harness reclaim orphan-job` }), test.root);
}

function approveSwitch(test) {
	recovery.handleEvent("UserPromptSubmit", JSON.stringify({ cwd: test.root, session_id: test.newSession, prompt: "/harness switch current-job orphan-job" }), test.root);
}

function switchTxPath(test) {
	return path.join(test.root, `.agents/session-contracts/.recovery/transactions/${recovery.switchSubject("current-job", "orphan-job")}--${test.newSession}.json`);
}

function testFreshOwnerBlocks() {
	const test = fixture();
	try {
		approve(test);
		recovery.recordLease(test.root, { session_id: test.oldSession }, "PreToolUse");
		assert.throws(() => recovery.reclaim(test.root, "orphan-job", test.newSession, STOPPED_PROCESS_DEPENDENCIES), /owner_session_live/);
		assert.equal(core.resolveSessionContract({ cwd: test.root, sessionId: test.oldSession }).status, core.STATES.BOUND);
	} finally { fs.rmSync(test.root, { recursive: true, force: true }); }
}

function testExplicitStoppedReclaim() {
	const test = fixture();
	try {
		approve(test);
		const tx = recovery.reclaim(test.root, "orphan-job", test.newSession, STOPPED_PROCESS_DEPENDENCIES);
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
	assert.equal(recovery.isHostProcess('"C:\\tools\\codex.exe" exec'), true, "quoted Windows executables must be recognized");
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

function testApprovalIsRequired() {
	const test = fixture();
	try {
		recovery.recordLease(test.root, { session_id: test.oldSession }, "Stop");
		assert.throws(() => recovery.reclaim(test.root, "orphan-job", test.newSession, STOPPED_PROCESS_DEPENDENCIES), /explicit_reclaim_approval_required/);
	} finally { fs.rmSync(test.root, { recursive: true, force: true }); }
}

function testExpiredApprovalBlocks() {
	const test = fixture();
	try {
		approve(test);
		const grantPath = path.join(test.root, `.agents/session-contracts/.recovery/grants/${test.newSession}--orphan-job.json`);
		const grant = JSON.parse(fs.readFileSync(grantPath, "utf8"));
		grant.expires_at = new Date(0).toISOString();
		writeJson(grantPath, grant);
		recovery.recordLease(test.root, { session_id: test.oldSession }, "Stop");
		assert.throws(() => recovery.reclaim(test.root, "orphan-job", test.newSession, STOPPED_PROCESS_DEPENDENCIES), /reclaim_approval_expired/);
	} finally { fs.rmSync(test.root, { recursive: true, force: true }); }
}

function testDeadRecoveryLockIsReclaimed() {
	const test = fixture();
	try {
		approve(test);
		const lockPath = path.join(test.root, ".agents/session-contracts/.recovery/locks/orphan-job.lock");
		writeJson(path.join(lockPath, "owner.json"), { schema_version: "1.0", contract_id: "orphan-job", pid: 2147483647, start_token: "dead-process", nonce: "stale", acquired_at: new Date(0).toISOString() });
		const tx = recovery.reclaim(test.root, "orphan-job", test.newSession, STOPPED_PROCESS_DEPENDENCIES);
		assert.equal(tx.contract_id, "orphan-job");
		assert.equal(fs.existsSync(lockPath), false);
	} finally { fs.rmSync(test.root, { recursive: true, force: true }); }
}

function testLiveRecoveryLockBlocks() {
	const test = fixture();
	try {
		approve(test);
		const identity = recovery.processSnapshot(process.pid);
		assert(identity?.start_token, "current process identity must be probeable");
		const lockPath = path.join(test.root, ".agents/session-contracts/.recovery/locks/orphan-job.lock");
		writeJson(path.join(lockPath, "owner.json"), { schema_version: "1.0", contract_id: "orphan-job", pid: process.pid, start_token: String(identity.start_token), nonce: "live", acquired_at: new Date().toISOString() });
		assert.throws(() => recovery.reclaim(test.root, "orphan-job", test.newSession, STOPPED_PROCESS_DEPENDENCIES), /reclaim_already_running/);
		assert.equal(fs.existsSync(lockPath), true);
	} finally { fs.rmSync(test.root, { recursive: true, force: true }); }
}

function testExplicitSwitchClosesCurrentAndRebindsTarget() {
	const test = fixture();
	try {
		const current = addCurrentContract(test);
		approveSwitch(test);
		const tx = recovery.switchContract(test.root, "current-job", "orphan-job", test.newSession, STOPPED_PROCESS_DEPENDENCIES);
		assert.equal(tx.from_original_digest, current.digest);
		assert.equal(tx.to_original_digest, test.digest);
		const resolved = core.resolveSessionContract({ cwd: test.root, sessionId: test.newSession });
		assert.equal(resolved.status, core.STATES.BOUND);
		assert.equal(resolved.contract.id, "orphan-job");
		assert.equal(core.resolveSessionContract({ cwd: test.root, sessionId: test.oldSession }).status, core.STATES.UNBOUND);
		const closed = JSON.parse(fs.readFileSync(current.contractPath, "utf8"));
		const closedProgress = JSON.parse(fs.readFileSync(current.progressPath, "utf8"));
		assert.equal(closed.status, "closed");
		assert.equal(closed.contract_digest, core.contractDigest(closed));
		assert.equal(closedProgress.current_phase, "close");
		assert.equal(closedProgress.recovery_history.at(-1).state, "switched_away");
		assert.equal(resolved.progress.recovery_history.at(-1).state, "revoked_abandoned");
		assert.equal(resolved.progress.recovery_history.at(-1).from_contract_id, "current-job");
		const audit = fs.readFileSync(path.join(test.root, ".agents/session-contracts/.recovery/audit.jsonl"), "utf8");
		assert.match(audit, /switch_granted/);
		assert.match(audit, /switch_prepared/);
		assert.match(audit, /switch_completed/);
		const grant = path.join(test.root, `.agents/session-contracts/.recovery/grants/${test.newSession}--${recovery.switchSubject("current-job", "orphan-job")}.json`);
		assert.equal(fs.existsSync(grant), false);
	} finally { fs.rmSync(test.root, { recursive: true, force: true }); }
}

function testSwitchApprovalIsRequired() {
	const test = fixture();
	try {
		addCurrentContract(test);
		assert.throws(() => recovery.switchContract(test.root, "current-job", "orphan-job", test.newSession, STOPPED_PROCESS_DEPENDENCIES), /explicit_switch_approval_required/);
	} finally { fs.rmSync(test.root, { recursive: true, force: true }); }
}

function testExpiredSwitchApprovalBlocks() {
	const test = fixture();
	try {
		addCurrentContract(test);
		approveSwitch(test);
		const grantPath = path.join(test.root, `.agents/session-contracts/.recovery/grants/${test.newSession}--${recovery.switchSubject("current-job", "orphan-job")}.json`);
		const grant = JSON.parse(fs.readFileSync(grantPath, "utf8"));
		grant.expires_at = new Date(0).toISOString();
		writeJson(grantPath, grant);
		assert.throws(() => recovery.switchContract(test.root, "current-job", "orphan-job", test.newSession, STOPPED_PROCESS_DEPENDENCIES), /switch_approval_expired/);
	} finally { fs.rmSync(test.root, { recursive: true, force: true }); }
}

function testLiveTargetOwnerBlocksSwitch() {
	const test = fixture();
	try {
		addCurrentContract(test);
		approveSwitch(test);
		recovery.recordLease(test.root, { session_id: test.oldSession }, "PreToolUse");
		assert.throws(() => recovery.switchContract(test.root, "current-job", "orphan-job", test.newSession, STOPPED_PROCESS_DEPENDENCIES), /owner_session_live/);
		assert.equal(core.resolveSessionContract({ cwd: test.root, sessionId: test.newSession }).contract.id, "current-job");
	} finally { fs.rmSync(test.root, { recursive: true, force: true }); }
}

function testInterruptedSwitchResumesFromJournalAfterGrantExpiry() {
	const test = fixture();
	try {
		addCurrentContract(test);
		approveSwitch(test);
		const tx = recovery.buildSwitchTransaction(test.root, "current-job", "orphan-job", test.newSession, STOPPED_PROCESS_DEPENDENCIES);
		writeJson(switchTxPath(test), tx);
		writeJson(tx.from_contract_path, tx.next_from_contract);
		writeJson(tx.from_progress_path, tx.next_from_progress);
		const grantPath = path.join(test.root, `.agents/session-contracts/.recovery/grants/${test.newSession}--${recovery.switchSubject("current-job", "orphan-job")}.json`);
		const grant = JSON.parse(fs.readFileSync(grantPath, "utf8"));
		grant.expires_at = new Date(0).toISOString();
		writeJson(grantPath, grant);
		const resumed = recovery.switchContract(test.root, "current-job", "orphan-job", test.newSession, STOPPED_PROCESS_DEPENDENCIES);
		assert.equal(resumed.transaction_digest, tx.transaction_digest);
		const resolved = core.resolveSessionContract({ cwd: test.root, sessionId: test.newSession });
		assert.equal(resolved.status, core.STATES.BOUND);
		assert.equal(resolved.contract.id, "orphan-job");
		assert.equal(fs.existsSync(switchTxPath(test)), false);
	} finally { fs.rmSync(test.root, { recursive: true, force: true }); }
}

function testInterruptedReclaimResumesFromJournalAfterGrantExpiry() {
	const test = fixture();
	try {
		approve(test);
		const tx = recovery.buildTransaction(test.root, "orphan-job", test.newSession, STOPPED_PROCESS_DEPENDENCIES);
		const txPath = path.join(test.root, `.agents/session-contracts/.recovery/transactions/orphan-job--${test.newSession}.json`);
		writeJson(txPath, tx);
		writeJson(tx.contract_path, tx.next_contract);
		const grantPath = path.join(test.root, `.agents/session-contracts/.recovery/grants/${test.newSession}--orphan-job.json`);
		const grant = JSON.parse(fs.readFileSync(grantPath, "utf8"));
		grant.expires_at = new Date(0).toISOString();
		writeJson(grantPath, grant);
		const resumed = recovery.reclaim(test.root, "orphan-job", test.newSession, STOPPED_PROCESS_DEPENDENCIES);
		assert.equal(resumed.transaction_digest, tx.transaction_digest);
		assert.equal(core.resolveSessionContract({ cwd: test.root, sessionId: test.newSession }).status, core.STATES.BOUND);
		assert.equal(fs.existsSync(txPath), false);
	} finally { fs.rmSync(test.root, { recursive: true, force: true }); }
}

function testTamperedSwitchJournalFailsClosed() {
	const test = fixture();
	try {
		addCurrentContract(test);
		approveSwitch(test);
		const tx = recovery.buildSwitchTransaction(test.root, "current-job", "orphan-job", test.newSession, STOPPED_PROCESS_DEPENDENCIES);
		tx.next_registry.bindings[test.newSession].contract_id = "tampered-job";
		writeJson(switchTxPath(test), tx);
		assert.throws(() => recovery.switchContract(test.root, "current-job", "orphan-job", test.newSession, STOPPED_PROCESS_DEPENDENCIES), /recovery_transaction_digest_mismatch/);
		assert.equal(core.resolveSessionContract({ cwd: test.root, sessionId: test.newSession }).contract.id, "current-job");
	} finally { fs.rmSync(test.root, { recursive: true, force: true }); }
}

function testResumedSwitchRechecksTargetOwnerLiveness() {
	const test = fixture();
	try {
		addCurrentContract(test);
		approveSwitch(test);
		const tx = recovery.buildSwitchTransaction(test.root, "current-job", "orphan-job", test.newSession, STOPPED_PROCESS_DEPENDENCIES);
		writeJson(switchTxPath(test), tx);
		writeJson(tx.from_contract_path, tx.next_from_contract);
		writeJson(tx.from_progress_path, tx.next_from_progress);
		recovery.recordLease(test.root, { session_id: test.oldSession }, "PreToolUse");
		assert.throws(() => recovery.switchContract(test.root, "current-job", "orphan-job", test.newSession, STOPPED_PROCESS_DEPENDENCIES), /owner_session_live/);
		const registry = JSON.parse(fs.readFileSync(tx.registry_path, "utf8"));
		assert.equal(registry.bindings[test.oldSession].contract_id, "orphan-job");
	} finally { fs.rmSync(test.root, { recursive: true, force: true }); }
}

function testResumedSwitchPreservesUnrelatedRegistryChanges() {
	const test = fixture();
	try {
		addCurrentContract(test);
		approveSwitch(test);
		const tx = recovery.buildSwitchTransaction(test.root, "current-job", "orphan-job", test.newSession, STOPPED_PROCESS_DEPENDENCIES);
		writeJson(switchTxPath(test), tx);
		const registry = JSON.parse(fs.readFileSync(tx.registry_path, "utf8"));
		registry.bindings.UNRELATED = { contract_id: "other-job", contract_path: ".agents/session-contracts/other-job.json", contract_digest: "f".repeat(64) };
		writeJson(tx.registry_path, registry);
		recovery.switchContract(test.root, "current-job", "orphan-job", test.newSession, STOPPED_PROCESS_DEPENDENCIES);
		const finalRegistry = JSON.parse(fs.readFileSync(tx.registry_path, "utf8"));
		assert.deepEqual(finalRegistry.bindings.UNRELATED, registry.bindings.UNRELATED);
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

// The gate settles a foreign contract's liveness through this helper. A dead
// orphan's recorded host PID must read as gone (false, not held) so it stops
// locking its paths to every live session; a missing recorded host falls back to
// the scan (null); an unavailable probe fails closed (throws).
function testSessionRecordedHostLive() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-hostlive-"));
	try {
		const sid = "sess-hostlive-1";
		const leaseFile = path.join(root, `.agents/session-contracts/.recovery/leases/${sid}.json`);
		const alive = () => ({ pid: 42, start_token: "orig" });
		assert.equal(recovery.sessionRecordedHostLive(root, sid, alive), null, "no lease → null (fall back to scan)");
		writeJson(leaseFile, { schema_version: "1.0", session_id: sid, state: "active" });
		assert.equal(recovery.sessionRecordedHostLive(root, sid, alive), null, "lease without host_process → null");
		writeJson(leaseFile, { schema_version: "1.0", session_id: sid, state: "active", host_process: { pid: 42, start_token: "orig" } });
		assert.equal(recovery.sessionRecordedHostLive(root, sid, alive), true, "recorded PID+start_token match → held");
		assert.equal(recovery.sessionRecordedHostLive(root, sid, () => null), false, "recorded PID gone → provably dead, not held");
		assert.equal(recovery.sessionRecordedHostLive(root, sid, () => ({ pid: 42, start_token: "reused" })), false, "recorded PID reused → not held");
		assert.throws(() => recovery.sessionRecordedHostLive(root, sid, () => undefined), /liveness_probe_unavailable/, "targeted probe unavailable → fail closed");
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
}

testFreshOwnerBlocks();
testExplicitStoppedReclaim();
testHostProcessIdentityWalksPastHookProcesses();
testLaterEventsReuseSessionStartIdentity();
testRecordedHostProcessUsesPidAndStartToken();
testSessionRecordedHostLive();
testStopKeepsLeaseActive();
testApprovalIsRequired();
testExpiredApprovalBlocks();
testDeadRecoveryLockIsReclaimed();
testLiveRecoveryLockBlocks();
testExplicitSwitchClosesCurrentAndRebindsTarget();
testSwitchApprovalIsRequired();
testExpiredSwitchApprovalBlocks();
testLiveTargetOwnerBlocksSwitch();
testInterruptedSwitchResumesFromJournalAfterGrantExpiry();
testInterruptedReclaimResumesFromJournalAfterGrantExpiry();
testTamperedSwitchJournalFailsClosed();
testResumedSwitchRechecksTargetOwnerLiveness();
testResumedSwitchPreservesUnrelatedRegistryChanges();
testLifecycleCliNeverWritesStdout();
process.stdout.write("session contract reclaim tests passed\n");
