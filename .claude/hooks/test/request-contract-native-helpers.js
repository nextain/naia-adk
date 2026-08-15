"use strict";

/** Native adapter, execution-control, and parity helpers. */

const assert = require("assert");
const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const core = require("../../../.agents/hooks/core/request-contract.js");
const { CLIENT_VERSIONS, EXPECTED_SANDBOX_ENGINE } = require("./request-contract-test-constants.js");

function runNativeAdapter(client, fx, input, eventName) {
	const root = path.resolve(__dirname, "..", "..", "..");
	const script = client === "claude" ? path.join(root, ".claude", "hooks", "request-contract.js") : path.join(root, ".codex", "hooks", "request-contract.cjs");
	const stdout = cp.execFileSync(process.execPath, [script], {
		cwd: fx.cwd,
		input: typeof input === "string" ? input : JSON.stringify({ client_version: CLIENT_VERSIONS[client], ...input }),
		encoding: "utf8",
		env: { ...process.env, REQUEST_CONTRACT: "on", REQUEST_CONTRACT_EVENT: eventName || "" },
	});
	return stdout ? JSON.parse(stdout) : null;
}

function nativePolicyOutput(output) {
	if (output == null) return null;
	if (output.decision === "block") return { kind: "block", message: output.reason };
	if (output.continue === false) return { kind: "block", message: output.stopReason };
	if (output.hookSpecificOutput && output.hookSpecificOutput.additionalContext) return { kind: "context", message: output.hookSpecificOutput.additionalContext };
	if (output.systemMessage) return { kind: "context", message: output.systemMessage };
	return output;
}

function installProductionControlSurface(fx) {
	const root = path.resolve(__dirname, "..", "..", "..");
	for (const relative of [
		".agents/context/agents-rules.json",
		".agents/hooks/core/request-contract.js",
		".agents/hooks/core/request-contract-foundation.js",
		".agents/hooks/core/request-contract-lifecycle.js",
		".agents/hooks/core/request-contract-transactions.js",
		".agents/hooks/core/request-contract-workspace.js",
		".agents/hooks/core/request-contract-quarantine.js",
		".agents/hooks/core/request-contract-validation.js",
		".agents/hooks/core/request-contract-semantics.js",
		".agents/hooks/core/request-contract-binding.js",
		".agents/hooks/core/request-contract-review.js",
		".agents/hooks/core/request-contract-review-records.js",
		".agents/hooks/core/request-contract-completion.js",
		".agents/hooks/core/request-contract-completion-state.js",
		".agents/hooks/core/request-contract-events.js",
		".agents/hooks/core/request-contract-event-handler.js",
		".agents/hooks/core/delegation-contract.js",
		".agents/hooks/core/hook-project-root.js",
		".agents/hooks/core/session-contract.js",
		".agents/hooks/core/subagent-failure-receipt.js",
		".agents/hooks/core/preservation-contract.js",
		".agents/hooks/core/request-contract-adapter.js",
		".agents/hooks/core/request-contract-review-runner.js",
		".claude/hooks/request-contract.js",
		".codex/hooks/request-contract.cjs",
		"scripts/request-contract.cjs",
		"scripts/request-contract-review-runner.cjs",
	]) {
		const destination = path.join(fx.cwd, relative);
		fs.mkdirSync(path.dirname(destination), { recursive: true });
		fs.copyFileSync(path.join(root, relative), destination);
	}
	cp.execFileSync("git", ["add", ".agents/hooks/core", ".claude/hooks", ".codex/hooks", "scripts"], { cwd: fx.cwd });
	cp.execFileSync("git", ["commit", "-q", "-m", "install production control surface"], { cwd: fx.cwd });
}

function runInstalledNativeAdapter(client, fx, input, eventName) {
	const script = client === "claude" ? path.join(fx.cwd, ".claude", "hooks", "request-contract.js") : path.join(fx.cwd, ".codex", "hooks", "request-contract.cjs");
	const stdout = cp.execFileSync(process.execPath, [script, eventName], {
		cwd: fx.cwd,
		input: JSON.stringify({ client_version: CLIENT_VERSIONS[client], ...input }),
		encoding: "utf8",
		env: { ...process.env, ADK_PROJECT_ROOT: fx.cwd, REQUEST_CONTRACT: "on" },
	});
	return stdout ? JSON.parse(stdout) : null;
}

function shellCommand(words) {
	return words.map((word) => JSON.stringify(String(word))).join(" ");
}

function nativeEnvelope(client, fx, eventName, sessionId, fields = {}) {
	const common = { hook_event_name: eventName, session_id: sessionId, cwd: fx.cwd, client_version: CLIENT_VERSIONS[client] };
	if (client === "claude") return { ...common, transcript_path: "/tmp/claude-transcript.jsonl", permission_mode: "default", source: eventName === "SessionStart" ? "startup" : undefined, ...fields };
	return { ...common, transcript_path: null, turn_id: "019f-codex-turn", model: "gpt-5.6-sol", permission_mode: "bypassPermissions", stop_hook_active: eventName === "Stop" ? false : undefined, ...fields };
}

function makeAttestor(fx, key, name) {
	const keyPath = path.join(fx.cwd, `${name}.key`);
	const scriptPath = path.join(fx.cwd, `${name}-attestor.cjs`);
	const role = name.includes("runner") ? "runner" : "reviewer";
	fs.writeFileSync(keyPath, key.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
	fs.writeFileSync(scriptPath, `#!${process.execPath}\nconst crypto=require("crypto"),fs=require("fs");let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",x=>input+=x);process.stdin.on("end",()=>{let p;try{p=JSON.parse(input)}catch{process.exit(2)};const ok=${JSON.stringify(role)}==="runner"?p.sandbox_engine===${JSON.stringify(EXPECTED_SANDBOX_ENGINE)}&&p.no_network===true&&p.repository_blind===true&&p.home_blind===true&&/^[a-f0-9]{64}$/.test(p.reviewer_executable_digest||"")&&/^[a-f0-9]{64}$/.test(p.review_payload_digest||"")&&Number.isInteger(p.executed_at):p.sandbox&&p.sandbox.no_network===true&&p.sandbox.repository_blind===true&&p.sandbox.home_blind===true&&p.executor&&/^[a-f0-9]{64}$/.test(p.executor.attestor_executable_digest||"")&&Number.isInteger(p.reviewed_at);if(!ok)process.exit(3);process.stdout.write(crypto.sign(null,Buffer.from(input),fs.readFileSync(${JSON.stringify(keyPath)})).toString("base64"))});\n`, { mode: 0o700 });
	return scriptPath;
}

function projectedUnitSnapshot(unit, fx) {
	const head = core.readJson(unit.paths.head);
	const sources = core.verifySourceChain(unit.paths, head);
	const scope = core.verifyScopeHistory(unit);
	const reviews = core.verifyReviewChain(unit.paths);
	assert(sources.ok, sources.errors.join(","));
	assert(scope.ok, scope.errors.join(","));
	assert(reviews.ok, reviews.errors.join(","));
	const contract = core.readJson(unit.paths.contract);
	assert.equal(core.sha256(core.canonicalJson(contract)), head.contract_digest);
	const validation = core.validateContract(contract, sources.records, core.readJson(unit.paths.state).occurrences, { publicKeyPem: fx.publicKeyPem, cwd: fx.cwd });
	assert(validation.ok, validation.errors.join(","));
	for (const review of reviews.records) {
		assert(crypto.verify(null, Buffer.from(core.canonicalJson(core.reviewSignaturePayload(review))), fx.reviewerPublicKeyPem, Buffer.from(review.executor.signature, "base64")));
		assert(crypto.verify(null, Buffer.from(core.canonicalJson(core.isolationSignaturePayload(review.isolation))), fx.runnerPublicKeyPem, Buffer.from(review.isolation.signature, "base64")));
	}
	const persisted = [];
	const walk = (directory) => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const file = path.join(directory, entry.name);
			if (entry.isDirectory()) walk(file);
			else {
				const relative = path.relative(unit.paths.unit, file).replace(/\\/g, "/");
				let value;
				if (relative.endsWith(".jsonl")) value = core.readJsonl(file);
				else {
					const raw = fs.readFileSync(file, "utf8");
					try { value = JSON.parse(raw); } catch { value = { content_base64: Buffer.from(raw).toString("base64") }; }
				}
				persisted.push({ relative, mode: fs.statSync(file).mode & 0o777, value });
			}
		}
	};
	walk(unit.paths.unit);
	const projected = core.canonicalParityProjection({ persisted });
	projected.persisted.sort((left, right) => core.canonicalJson(left).localeCompare(core.canonicalJson(right)));
	return projected;
}

function firstDifference(left, right, cursor = "$") {
	if (typeof left !== typeof right || left === null || right === null) return left === right ? null : { cursor, left, right };
	if (typeof left !== "object") return left === right ? null : { cursor, left, right };
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	if (core.canonicalJson(leftKeys) !== core.canonicalJson(rightKeys)) return { cursor, left: leftKeys, right: rightKeys };
	for (const key of leftKeys) {
		const difference = firstDifference(left[key], right[key], `${cursor}.${key}`);
		if (difference) return difference;
	}
	return null;
}

module.exports = {
	runNativeAdapter,
	nativePolicyOutput,
	installProductionControlSurface,
	runInstalledNativeAdapter,
	shellCommand,
	nativeEnvelope,
	makeAttestor,
	projectedUnitSnapshot,
	firstDifference,
};
