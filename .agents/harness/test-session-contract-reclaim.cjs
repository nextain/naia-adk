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

function approve(test) {
	recovery.handleEvent("UserPromptSubmit", JSON.stringify({ cwd: test.root, session_id: test.newSession, prompt: `/harness reclaim orphan-job` }), test.root);
}

function testFreshOwnerBlocks() {
	const test = fixture();
	try {
		approve(test);
		recovery.recordLease(test.root, { session_id: test.oldSession }, "PreToolUse");
		assert.throws(() => recovery.reclaim(test.root, "orphan-job", test.newSession), /owner_session_live/);
		assert.equal(core.resolveSessionContract({ cwd: test.root, sessionId: test.oldSession }).status, core.STATES.BOUND);
	} finally { fs.rmSync(test.root, { recursive: true, force: true }); }
}

function testExplicitStoppedReclaim() {
	const test = fixture();
	try {
		approve(test);
		const tx = recovery.reclaim(test.root, "orphan-job", test.newSession);
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
		assert.throws(() => recovery.reclaim(test.root, "orphan-job", test.newSession), /explicit_reclaim_approval_required/);
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
		assert.throws(() => recovery.reclaim(test.root, "orphan-job", test.newSession), /reclaim_approval_expired/);
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
testRecordedHostProcessUsesPidAndStartToken();
testStopKeepsLeaseActive();
testApprovalIsRequired();
testExpiredApprovalBlocks();
testLifecycleCliNeverWritesStdout();
process.stdout.write("session contract reclaim tests passed\n");
