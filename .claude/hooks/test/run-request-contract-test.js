#!/usr/bin/env node
/** Deterministic fault-injection suite for request-contract integrity. */

const assert = require("assert");
const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const core = require("../../../.agents/hooks/core/request-contract.js");
const adapter = require("../../../.agents/hooks/core/request-contract-adapter.js");
const reviewRunner = require("../../../.agents/hooks/core/request-contract-review-runner.js");

let passed = 0;
const runnerEvidenceByReview = new WeakMap();
const fixtureRoots = new Set();
const REVIEWER_EXTENSION = process.platform === "win32" ? ".cjs" : ".sh";
const EXPECTED_SANDBOX_ENGINE = process.platform === "win32" ? "codex-windows-elevated" : "bubblewrap";
const reviewerFixturePath = (name) => path.join(__dirname, "fixtures", name + REVIEWER_EXTENSION);
const CLIENT_VERSIONS = { claude: "2.1.207", codex: "0.144.1" };
const SANDBOX_EXECUTABLE = process.platform === "win32" ? reviewRunner.resolveCodexExecutable() : "/usr/bin/bwrap";
const SANDBOX_EXECUTABLE_DIGEST = core.sha256(fs.readFileSync(SANDBOX_EXECUTABLE));
function runSandbox(options) {
	return reviewRunner.runSandbox({ ...options, allowedSandboxDigests: options.allowedSandboxDigests || [SANDBOX_EXECUTABLE_DIGEST] });
}
function writeReviewer(cwd, name, posixSource, windowsSource) {
	const file = path.join(cwd, name + REVIEWER_EXTENSION);
	fs.writeFileSync(file, process.platform === "win32" ? windowsSource : posixSource, { mode: 0o700 });
	return file;
}
function test(name, fn) {
	if (process.env.TEST_FILTER && !name.includes(process.env.TEST_FILTER)) return;
	try {
		fn();
		passed += 1;
		process.stdout.write(`ok ${passed} - ${name}\n`);
	} catch (error) {
		process.stderr.write(`not ok - ${name}: ${error.stack || error}\n`);
		process.exitCode = 1;
	}
}

function withDeniedReaddir(target, fn) {
	const original = fs.readdirSync;
	fs.readdirSync = function deniedReaddir(candidate, ...args) {
		if (path.resolve(candidate) === path.resolve(target)) {
			const error = Object.assign(new Error("simulated access denial"), { code: "EACCES" });
			throw error;
		}
		return original.call(fs, candidate, ...args);
	};
	try {
		return fn();
	} finally {
		fs.readdirSync = original;
	}
}

function fixture() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "naia-request-contract-"));
	fixtureRoots.add(cwd);
	fs.mkdirSync(path.join(cwd, ".agents", "context"), { recursive: true });
	fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
	fs.mkdirSync(path.join(cwd, ".codex"), { recursive: true });
	fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
	fs.mkdirSync(path.join(cwd, "evidence"), { recursive: true });
	fs.writeFileSync(path.join(cwd, "src", "product.txt"), "baseline\n");
	fs.writeFileSync(path.join(cwd, "evidence", "test-report.txt"), "verified evidence\n");
	cp.execFileSync("git", ["init", "-q"], { cwd });
	cp.execFileSync("git", ["config", "core.autocrlf", "false"], { cwd });
	const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
	const { publicKey: reviewerPublicKey, privateKey: reviewerPrivateKey } = crypto.generateKeyPairSync("ed25519");
	const { publicKey: runnerPublicKey, privateKey: runnerPrivateKey } = crypto.generateKeyPairSync("ed25519");
	const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
	const reviewerPublicKeyPem = reviewerPublicKey.export({ type: "spki", format: "pem" });
	const runnerPublicKeyPem = runnerPublicKey.export({ type: "spki", format: "pem" });
	const reviewerFixtureDigest = core.sha256(fs.readFileSync(reviewerFixturePath("contract-reviewer")));
	const reviewerAttestor = makeAttestor({ cwd }, reviewerPrivateKey, "default-reviewer");
	const runnerAttestor = makeAttestor({ cwd }, runnerPrivateKey, "default-runner");
	const reviewerAttestorDigest = core.sha256(fs.readFileSync(reviewerAttestor));
	const runnerAttestorDigest = core.sha256(fs.readFileSync(runnerAttestor));
	fs.writeFileSync(path.join(cwd, ".agents", "context", "authority.pub"), publicKeyPem, { mode: 0o600 });
	fs.writeFileSync(path.join(cwd, ".agents", "context", "reviewer.pub"), reviewerPublicKeyPem, { mode: 0o600 });
	fs.writeFileSync(path.join(cwd, ".agents", "context", "runner.pub"), runnerPublicKeyPem, { mode: 0o600 });
	for (const [directory, file] of [[".claude", "settings.json"], [".codex", "hooks.json"]]) {
		const adapterFile = directory === ".claude" ? "request-contract.js" : "request-contract.cjs";
		const adapterPath = `${directory}/hooks/${adapterFile}`;
		const hooks = Object.fromEntries(["PreToolUse", "SessionStart", "UserPromptSubmit", "PostToolUse", "PreCompact", "PostCompact", "Stop"].map((eventName) => {
			const hook = directory === ".claude"
				? { type: "command", command: "node", args: [`${"${CLAUDE_PROJECT_DIR}"}/${adapterPath}`, eventName] }
				: {
					type: "command",
					command: `node \"$(git rev-parse --show-toplevel)/${adapterPath}\" ${eventName}`,
					commandWindows: `powershell -NoProfile -Command \"$root = git rev-parse --show-toplevel; node (Join-Path $root '${adapterPath}') ${eventName}\"`,
				};
			return [eventName, [{ ...(eventName === "PreToolUse" ? { matcher: "Bash|Edit|Write|NotebookEdit|apply_patch" } : {}), hooks: [hook] }]];
		}));
		fs.writeFileSync(path.join(cwd, directory, file), JSON.stringify({ hooks }));
	}
	fs.writeFileSync(
		path.join(cwd, ".agents", "context", "request-contract.json"),
		JSON.stringify({
			version: 1,
			enabled_by_default: true,
			minimum_clean_rounds: 2,
			stop_attempt_limit: 3,
			supported_clients: { claude: ">=2.1.207", codex: ">=0.144.1" },
				product_roots: ["."],
				exclusions: [".agents/harness", ".agents/context/authority.pub", ".agents/context/reviewer.pub", ".agents/context/runner.pub", "default-reviewer.key", "default-reviewer-attestor.cjs", "default-runner.key", "default-runner-attestor.cjs", "node_modules"],
				authority: { public_key_path: ".agents/context/authority.pub", credential_id: "test-platform-credential", require_user_presence: true, require_non_exportable: true },
				reviewer: { public_key_path: ".agents/context/reviewer.pub", credential_id: "test-review-executor", require_no_network: true, require_repository_blind: true, require_home_blind: true, allowed_attestor_digests: [reviewerAttestorDigest] },
				review_runner: { public_key_path: ".agents/context/runner.pub", credential_id: "test-isolation-runner", allowed_reviewer_digests: [reviewerFixtureDigest], allowed_sandbox_digests: [SANDBOX_EXECUTABLE_DIGEST], allowed_attestor_digests: [runnerAttestorDigest] },
				retention: { success_hours: 24 },
		}),
	);
	cp.execFileSync("git", ["config", "user.email", "request-contract@example.invalid"], { cwd });
	cp.execFileSync("git", ["config", "user.name", "Request Contract Fixture"], { cwd });
	cp.execFileSync("git", ["add", "."], { cwd });
	cp.execFileSync("git", ["commit", "-q", "-m", "fixture baseline"], { cwd });
	return { cwd, privateKey, publicKeyPem, reviewerPrivateKey, reviewerPublicKeyPem, runnerPrivateKey, runnerPublicKeyPem, reviewerFixtureDigest, reviewerAttestor, runnerAttestor, reviewerAttestorDigest, runnerAttestorDigest };
}

function start(fx, client = "claude", sessionId = "S1", prompt = "Implement the complete requested feature") {
	const startResult = core.handleEvent({ client, clientVersion: CLIENT_VERSIONS[client], eventName: "SessionStart", sessionId, cwd: fx.cwd });
	assert.equal(startResult.kind, "context");
	const promptResult = core.handleEvent({ client, eventName: "UserPromptSubmit", sessionId, cwd: fx.cwd, prompt, origin: "native_user" });
	assert.equal(promptResult.kind, "context");
	const unit = core.findUnit(fx.cwd, client, sessionId);
	assert(unit && !unit.error);
	return unit;
}

function signedReceipt(fx, fields) {
	const receipt = {
		operation: fields.operation,
		nonce: fields.nonce || crypto.randomBytes(16).toString("hex"),
		issued_at: fields.now || Date.now(),
		expires_at: (fields.now || Date.now()) + 60_000,
		prior_scope_digest: fields.prior_scope_digest,
		resulting_scope_digest: fields.resulting_scope_digest,
		resulting_scope_epoch: fields.resulting_scope_epoch,
		binding_epoch: fields.binding_epoch,
		challenge: fields.challenge,
		presentation_digest: fields.presentation_digest,
		target_directive_ids: fields.target_directive_ids || [],
		affected_source_ids: fields.affected_source_ids || [],
		affected_prior_ids: fields.affected_prior_ids || [],
		replacement_ids: fields.replacement_ids || [],
		tombstone_ids: fields.tombstone_ids || [],
		sign_count: fields.sign_count || 1,
		user_presence: { present: true, non_exportable: true, credential_id: "test-platform-credential", authenticator_kind: "platform" },
	};
	for (const key of Object.keys(receipt)) if (receipt[key] === undefined) delete receipt[key];
	receipt.signature = crypto.sign(null, Buffer.from(core.canonicalJson(receipt)), fx.privateKey).toString("base64");
	return receipt;
}

function traceGraph(suffix = "001", directiveId = `REQ-${suffix}`, obligationAtomIds = [`OBL-${suffix}`]) {
	const ids = {
		directives: directiveId,
		requirements: `RQM-${suffix}`,
		use_cases: `UC-${suffix}`,
		use_case_tests: `UCT-${suffix}`,
		features: `FE-${suffix}`,
		feature_tests: `FET-${suffix}`,
		implementations: `IMP-${suffix}`,
		evidence: `EVD-${suffix}`,
	};
	const artifacts = {};
	for (const category of core.TRACE_KEYS) artifacts[category] = [{ id: ids[category], statement: `${category} ${suffix}`, obligation_atom_ids: obligationAtomIds }];
	artifacts.evidence[0] = { ...artifacts.evidence[0], kind: "test-report", subject_id: ids.implementations, locator: "evidence/test-report.txt", digest: core.sha256("verified evidence\n") };
	const edges = core.TRACE_EDGES.map((spec, index) => ({ id: `EDGE-${suffix}-${index + 1}`, kind: spec.kind, from: ids[spec.from], to: ids[spec.to] }));
	return { trace: Object.fromEntries(core.TRACE_KEYS.map((key) => [key, [ids[key]]])), artifacts, edges };
}

function mergeGraph(contract, graph) {
	for (const key of core.TRACE_KEYS) contract.artifacts[key].push(...graph.artifacts[key]);
	contract.edges.push(...graph.edges);
}

function sourceDeclaration(record, directiveIds, classification = "directive") {
	return { id: record.source_id, classification, directive_ids: directiveIds, obligation_atoms: [{ id: `OBL-${record.source_id.slice(4).toUpperCase()}`, text: record.prompt, directive_ids: directiveIds }] };
}

function addContractSource(contract, record, directiveIds, classification = "directive", declareInStatement = false) {
	contract.sources.push(sourceDeclaration(record, directiveIds, classification));
	if (declareInStatement) for (const directiveId of directiveIds) {
		const directive = contract.directives.find((item) => item.id === directiveId);
		if (directive && !directive.statement.includes(record.prompt)) directive.statement += `\n${record.prompt}`;
	}
	synchronizeObligationCoverage(contract);
}

function synchronizeObligationCoverage(contract) {
	const referenced = Object.fromEntries(core.TRACE_KEYS.map((key) => [key, new Map()]));
	for (const directive of contract.directives || []) {
		const atomIds = [...new Set((contract.sources || []).flatMap((source) => (source.obligation_atoms || []).filter((atom) => (atom.directive_ids || []).includes(directive.id)).map((atom) => atom.id)))];
		for (const target of directive.targets || []) target.obligation_atom_ids = [...atomIds];
		for (const criterion of directive.acceptance_criteria || []) criterion.obligation_atom_ids = [...atomIds];
		for (const key of core.TRACE_KEYS) for (const artifactId of (directive.trace && directive.trace[key]) || []) {
			if (!referenced[key].has(artifactId)) referenced[key].set(artifactId, new Set());
			for (const atomId of atomIds) referenced[key].get(artifactId).add(atomId);
		}
	}
	for (const key of core.TRACE_KEYS) for (const artifact of (contract.artifacts && contract.artifacts[key]) || []) artifact.obligation_atom_ids = [...(referenced[key].get(artifact.id) || [])];
}

function makeContract(fx, unit, options = {}) {
	const head = core.readJson(unit.paths.head);
	const records = core.verifySourceChain(unit.paths, head).records;
	const directiveId = options.directiveId || "REQ-001";
	const obligationAtomIds = records.map((record) => `OBL-${record.source_id.slice(4).toUpperCase()}`);
	const graph = traceGraph("001", directiveId, obligationAtomIds);
	const contract = {
		kind: "request-contract",
		version: 1,
		id: options.id || "RC-TEST",
		status: options.status || "complete",
		sources: records.map((record) => sourceDeclaration(record, [directiveId])),
		directives: [
			{
				id: directiveId,
				statement: options.statement || records.map((record) => record.prompt).join("\n"),
				state: "done",
				source_ids: records.map((r) => r.source_id),
				targets: [{ id: "TGT-001", path: "src/product.txt", obligation_atom_ids: obligationAtomIds }],
				acceptance_criteria: [{ id: "AC-001", statement: "All requested behavior is verified", obligation_atom_ids: obligationAtomIds }],
				trace: graph.trace,
			},
		],
		artifacts: graph.artifacts,
		edges: graph.edges,
			authorities: [
			{
				id: "AUTH-001",
				operation: "authorize_contract",
				source_id: records[0].source_id,
				source_digest: records[0].prompt_digest,
				target_directive_ids: [directiveId],
				affected_source_ids: [],
				affected_prior_ids: [],
				replacement_ids: [directiveId],
				tombstone_ids: [],
				receipt: { operation: "authorize_contract", nonce: "initial-nonce-01" },
			},
		],
		tombstones: [],
		changes: [],
	};
	const scopeDigest = core.sha256(core.canonicalJson(core.scopeProjection(contract)));
	const presentation = core.authorityPresentation(contract.authorities[0], null, scopeDigest, 0, 1);
	const challenge = core.issueAuthorityChallenge(unit, fx.cwd, presentation);
	contract.authorities[0].receipt = signedReceipt(fx, {
		operation: "authorize_contract",
		nonce: "initial-nonce-01",
		resulting_scope_digest: scopeDigest,
		resulting_scope_epoch: 0,
		binding_epoch: 1,
		challenge: challenge.challenge,
		presentation_digest: challenge.presentation_digest,
		target_directive_ids: [directiveId],
		replacement_ids: [directiveId],
		sign_count: 1,
	});
	return contract;
}

function coverOccurrences(contract, unit) {
	for (const occurrence of core.readJson(unit.paths.state, { occurrences: [] }).occurrences || []) {
		if (!contract.changes.some((change) => change.id === occurrence.id)) contract.changes.push({ id: occurrence.id, directive_id: contract.directives[0].id, implementation_id: contract.directives[0].trace.implementations[0], evidence_id: contract.directives[0].trace.evidence[0] });
	}
	return contract;
}
function bind(fx, unit, contract = makeContract(fx, unit)) {
	for (const occurrence of core.readJson(unit.paths.state, { occurrences: [] }).occurrences || []) {
		if (!contract.changes.some((change) => change.id === occurrence.id)) contract.changes.push({ id: occurrence.id, directive_id: contract.directives[0].id, implementation_id: contract.directives[0].trace.implementations[0], evidence_id: contract.directives[0].trace.evidence[0] });
	}
	return core.bindContract(unit, contract, { publicKeyPem: fx.publicKeyPem, cwd: fx.cwd });
}

function runSyntheticReviewSandbox(options) {
	if (process.platform !== "win32") return runSandbox(options);
	const originalSpawnSync = cp.spawnSync;
	cp.spawnSync = function interceptNativeSandbox(executable, args, spawnOptions) {
		if (path.basename(String(executable)).toLowerCase() !== "codex.exe" || !Array.isArray(args) || args[0] !== "sandbox") return originalSpawnSync.call(this, executable, args, spawnOptions);
		const separator = args.indexOf("--");
		const cwdIndex = args.indexOf("-C");
		assert(separator >= 0 && cwdIndex >= 0);
		return originalSpawnSync.call(this, args[separator + 1], args.slice(separator + 2), { ...spawnOptions, cwd: args[cwdIndex + 1] });
	};
	try {
		return runSandbox(options);
	} finally {
		cp.spawnSync = originalSpawnSync;
	}
}

function cleanReview(fx, unit, runId, extras = {}) {
	const challenge = core.issueReviewInvocation(unit, fx.cwd, core.readJson(unit.paths.head).session_id);
	const reviewerPath = reviewerFixturePath("contract-reviewer");
	const isolated = runSyntheticReviewSandbox({
		bundlePath: path.resolve(fx.cwd, challenge.manifest.bundle_locator),
		expectedBundleDigest: challenge.manifest.bundle_digest,
		reviewerPath,
		allowedReviewerDigests: [fx.reviewerFixtureDigest],
		env: { REQUEST_CONTRACT_CHALLENGE: challenge.manifest.nonce, REQUEST_CONTRACT_CONTEXT_ID: `reviewer-${runId}-${challenge.manifest.nonce}` },
	});
	const review = {
		...isolated.output,
		run_id: challenge.manifest.review_run_id,
		reviewed_at: isolated.evidence.executed_at,
		bundle_digest: challenge.manifest.bundle_digest,
		source_head: challenge.manifest.source_head,
		contract_digest: challenge.manifest.contract_digest,
		workspace_digest: challenge.manifest.workspace_digest,
		config_digest: challenge.manifest.config_digest,
		scope_epoch: challenge.manifest.scope_epoch,
		work_revision: challenge.manifest.work_revision,
		binding_epoch: challenge.manifest.binding_epoch,
		sandbox: { no_network: true, repository_blind: true, home_blind: true },
		executor: { credential_id: "test-review-executor", context_id: `reviewer-${runId}-${challenge.manifest.nonce}`, process_id: isolated.evidence.launcher_process_id, process_identity: isolated.evidence.reviewer_process_identity, started_at: isolated.evidence.started_at, attestor_executable_digest: fx.reviewerAttestorDigest, signature: "" },
		...extras,
	};
	review.isolation = review.isolation || {
		credential_id: "test-isolation-runner",
		execution_id: `execution-${runId}-${crypto.randomBytes(8).toString("hex")}`,
		challenge: challenge.manifest.nonce,
		bundle_digest: challenge.manifest.bundle_digest,
		reviewer_context_id: review.executor.context_id,
		reviewer_process_id: review.executor.process_id,
		reviewer_process_identity: review.executor.process_identity,
		...isolated.evidence,
		attestor_executable_digest: fx.runnerAttestorDigest,
		signature: "",
	};
	if (review.reviewed_at === undefined) review.reviewed_at = review.isolation.executed_at;
	review.isolation.review_payload_digest = core.sha256(core.canonicalJson(core.reviewSignaturePayload(review)));
	review.isolation.signature = crypto.sign(null, Buffer.from(core.canonicalJson(core.isolationSignaturePayload(review.isolation))), fx.runnerPrivateKey).toString("base64");
	review.executor.signature = crypto.sign(null, Buffer.from(core.canonicalJson(core.reviewSignaturePayload(review))), fx.reviewerPrivateKey).toString("base64");
	runnerEvidenceByReview.set(review, isolated.evidence);
	return review;
}

function ingestReview(fx, unit, review) {
	return core.appendReview(unit, review, {
		expectedBundleDigest: review.bundle_digest,
		reviewerPublicKey: fx.reviewerPublicKeyPem,
		reviewerCredentialId: "test-review-executor",
		reviewRunnerPublicKey: fx.runnerPublicKeyPem,
		reviewRunnerCredentialId: "test-isolation-runner",
		runnerEvidence: runnerEvidenceByReview.get(review),
		cwd: fx.cwd,
	});
}

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
		".agents/hooks/core/request-contract.js",
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
		env: { ...process.env, REQUEST_CONTRACT: "on" },
	});
	return stdout ? JSON.parse(stdout) : null;
}

function shellCommand(words) {
	return words.map((word) => JSON.stringify(String(word))).join(" ");
}

function nativeEnvelope(client, fx, eventName, sessionId, fields = {}) {
	const common = { hook_event_name: eventName, session_id: sessionId, cwd: fx.cwd };
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

function makeResumeReceipt(fx, unit, signCount = 2) {
	const head = core.readJson(unit.paths.head);
	const binding = core.readJson(unit.paths.binding);
	const scope = core.sha256(core.canonicalJson(core.scopeProjection(core.readJson(unit.paths.contract))));
	const authority = { operation: "resume", target_directive_ids: [], affected_prior_ids: [], replacement_ids: [], tombstone_ids: [] };
	const presentation = core.authorityPresentation(authority, scope, scope, head.scope_epoch + 1, binding.binding_epoch + 1);
	const challenge = core.issueAuthorityChallenge(unit, fx.cwd, presentation);
	return signedReceipt(fx, {
		operation: "resume",
		prior_scope_digest: scope,
		resulting_scope_digest: scope,
		resulting_scope_epoch: head.scope_epoch + 1,
		binding_epoch: binding.binding_epoch + 1,
		challenge: challenge.challenge,
		presentation_digest: challenge.presentation_digest,
		target_directive_ids: [],
		sign_count: signCount,
	});
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

test("disabled mode is a silent allow", () => {
	const fx = fixture();
	const result = core.handleEvent({ client: "claude", eventName: "Stop", sessionId: "D", cwd: fx.cwd }, { env: { REQUEST_CONTRACT: "off" } });
	assert.equal(result.code, "request_contract_disabled");
});

test("governance remains sticky after an active marker or environment disable attempt", () => {
	const fx = fixture();
	const configPath = path.join(fx.cwd, ".agents", "context", "request-contract.json");
	const config = core.readJson(configPath);
	config.enabled_by_default = false;
	fs.writeFileSync(configPath, JSON.stringify(config));
	const marker = path.join(fx.cwd, ".agents", "harness", "request-contract-on");
	core.secureWrite(marker, "enabled\n");
	const unit = start(fx);
	bind(fx, unit);
	const root = path.resolve(__dirname, "..", "..", "..");
	const refused = cp.spawnSync(process.execPath, [path.join(root, "scripts", "request-contract.cjs"), "disable"], { encoding: "utf8", cwd: fx.cwd });
	assert.notEqual(refused.status, 0);
	assert.equal(JSON.parse(refused.stderr).error, "request_contract_disable_blocked_active_state");
	assert.equal(core.handleEvent({ client: "claude", eventName: "PreToolUse", sessionId: "S1", cwd: fx.cwd, toolName: "Bash", toolUseId: "disable-marker" }).code, "request_contract_mutation_preflight");
	fs.unlinkSync(marker);
	const post = core.handleEvent({ client: "claude", eventName: "PostToolUse", sessionId: "S1", cwd: fx.cwd, toolName: "Bash", toolUseId: "disable-marker" });
	assert.notEqual(post.code, "request_contract_disabled");
	assert.equal(core.governed(fx.cwd, { REQUEST_CONTRACT: "off" }), true);
	const stopped = core.handleEvent({ client: "claude", eventName: "Stop", sessionId: "S1", cwd: fx.cwd }, { env: { REQUEST_CONTRACT: "off" } });
	assert.equal(stopped.kind, "block");
	assert.notEqual(stopped.code, "request_contract_disabled");
});

test("successful uncompacted units stay governed and revalidate their proof", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	for (const id of ["SUCCESS-STICKY-R1", "SUCCESS-STICKY-R2"]) ingestReview(fx, unit, cleanReview(fx, unit, id));
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "allow");
	assert.equal(core.governed(fx.cwd, { REQUEST_CONTRACT: "off" }), true);
	fs.writeFileSync(path.join(fx.cwd, "src", "product.txt"), "changed after successful completion\n");
	for (const event of [
		{ client: "claude", eventName: "Stop", sessionId: "S1", cwd: fx.cwd },
		{ client: "claude", clientVersion: CLIENT_VERSIONS.claude, eventName: "SessionStart", sessionId: "S1", cwd: fx.cwd },
	]) {
		const result = core.handleEvent(event, { env: { REQUEST_CONTRACT: "off" } });
		assert.equal(result.kind, "block");
		assert.equal(result.code, "request_contract_completion_proof_invalid");
	}
});

test("a new governed lineage validates and records the prior successful workspace handoff", () => {
	const fx = fixture();
	const prior = start(fx, "claude", "PRIOR");
	bind(fx, prior);
	for (const id of ["HANDOFF-R1", "HANDOFF-R2"]) ingestReview(fx, prior, cleanReview(fx, prior, id));
	assert.equal(core.evaluateCompletion(prior, fx.cwd, "claude").kind, "allow");
	const priorProof = core.readJson(prior.paths.state).terminal.completion_proof;
	const started = core.handleEvent({ client: "codex", clientVersion: CLIENT_VERSIONS.codex, eventName: "SessionStart", sessionId: "SUCCESSOR", cwd: fx.cwd });
	assert.equal(started.kind, "context");
	core.handleEvent({ client: "codex", eventName: "UserPromptSubmit", sessionId: "SUCCESSOR", cwd: fx.cwd, prompt: "Implement the next independently governed request", origin: "native_user" });
	const successor = core.findUnit(fx.cwd, "codex", "SUCCESSOR");
	assert(successor && successor.id !== prior.id);
	assert.equal(core.readJson(successor.paths.state).genesis_workspace_digest, priorProof.workspace_digest);
	bind(fx, successor);
	const pre = core.handleEvent({ client: "codex", eventName: "PreToolUse", sessionId: "SUCCESSOR", cwd: fx.cwd, toolName: "apply_patch", toolUseId: "successor-change", toolInput: { command: "product mutation" } });
	assert.equal(pre.kind, "allow");
	fs.writeFileSync(path.join(fx.cwd, "src", "product.txt"), "successor workspace\n");
	assert.notEqual(core.handleEvent({ client: "codex", eventName: "PostToolUse", sessionId: "SUCCESSOR", cwd: fx.cwd, toolName: "apply_patch", toolUseId: "successor-change", toolInput: { command: "product mutation" }, toolResponse: { ok: true } }).kind, "block");
	assert.equal(core.evaluateCompletion(prior, fx.cwd, "claude").code, "request_contract_completion_proof_invalid");
	const terminalAt = core.readJson(prior.paths.state).terminal.at;
	const compacted = core.compactExpiredUnits(fx.cwd, terminalAt + 200 * 60 * 60 * 1000);
	assert.equal(compacted.length, 1);
	assert(!fs.existsSync(prior.paths.unit));
	assert(fs.existsSync(successor.paths.unit));
});

test("review runner enforces a real network, repository, home, and environment sandbox", () => {
	const fx = fixture();
	const bundlePath = path.join(fx.cwd, "review-input.json");
	fs.writeFileSync(bundlePath, JSON.stringify({ exact: "private source" }), { mode: 0o600 });
	const reviewerPath = reviewerFixturePath("isolated-reviewer");
	const priorSecret = process.env.LEAK_SECRET;
	process.env.LEAK_SECRET = "must-not-cross";
	try {
		const result = runSandbox({ bundlePath, expectedBundleDigest: core.sha256(fs.readFileSync(bundlePath)), reviewerPath, allowedReviewerDigests: [core.sha256(fs.readFileSync(reviewerPath))] });
		assert.equal(path.basename(result.output.cwd), "scratch");
		assert.deepEqual({ ...result.output, cwd: "<scratch>" }, { secret_absent: true, home_blind: true, repository_blind: true, home_read_only: true, review_read_only: true, network_blocked: true, scratch_writable: true, bundle_readable: true, cwd: "<scratch>" });
		assert.equal(result.evidence.sandbox_engine, EXPECTED_SANDBOX_ENGINE);
		assert(Number.isInteger(result.evidence.launcher_process_id));
	} finally {
		if (priorSecret === undefined) delete process.env.LEAK_SECRET;
		else process.env.LEAK_SECRET = priorSecret;
	}
});

test("review runner snapshots exact digest-verified bundle bytes before execution", () => {
	const fx = fixture();
	const bundlePath = path.join(fx.cwd, "review-snapshot.json");
	const original = JSON.stringify({ value: "original" });
	fs.writeFileSync(bundlePath, original, { mode: 0o600 });
	const reviewerPath = writeReviewer(fx.cwd, "delayed-reviewer",
		"#!/usr/bin/bash\nset -eu\nsleep 0.2\njq -c . \"$REQUEST_CONTRACT_BUNDLE\"\n",
		'#!/usr/bin/env node\nconst fs=require("fs");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200);process.stdout.write(fs.readFileSync(process.env.REQUEST_CONTRACT_BUNDLE,"utf8"));\n');
	const mutator = process.platform === "win32"
		? cp.spawn(process.execPath, ["-e", 'setTimeout(()=>require("fs").writeFileSync(process.argv[1],JSON.stringify({value:"replaced"})),50)', bundlePath], { stdio: "ignore" })
		: cp.spawn("bash", ["-c", "sleep 0.05; printf '%s' '{\"value\":\"replaced\"}' > \"$1\"", "_", bundlePath], { stdio: "ignore" });
	const result = runSandbox({ bundlePath, expectedBundleDigest: core.sha256(original), reviewerPath, allowedReviewerDigests: [core.sha256(fs.readFileSync(reviewerPath))] });
	assert.deepEqual(result.output, { value: "original" });
	assert.equal(result.evidence.bundle_digest, core.sha256(original));
	mutator.kill();
	assert.throws(() => runSandbox({ bundlePath, expectedBundleDigest: core.sha256(original), reviewerPath, allowedReviewerDigests: [core.sha256(fs.readFileSync(reviewerPath))] }), (error) => error.code === "review_bundle_digest_mismatch");
});

test("review runner executes anonymous sealed snapshots even if former paths are replaced", () => {
	const fx = fixture();
	const bundlePath = path.join(fx.cwd, "review-sealed.json");
	const original = JSON.stringify({ value: "sealed-original" });
	fs.writeFileSync(bundlePath, original, { mode: 0o600 });
	const reviewerPath = writeReviewer(fx.cwd, "sealed-reviewer",
		"#!/usr/bin/bash\nset -eu\njq -c . \"$REQUEST_CONTRACT_BUNDLE\"\n",
		'#!/usr/bin/env node\nprocess.stdout.write(require("fs").readFileSync(process.env.REQUEST_CONTRACT_BUNDLE,"utf8"));\n');
	const result = runSandbox({
		bundlePath,
		expectedBundleDigest: core.sha256(original),
		reviewerPath,
		allowedReviewerDigests: [core.sha256(fs.readFileSync(reviewerPath))],
		afterSnapshotSealed: () => {
			fs.writeFileSync(reviewerPath, process.platform === "win32" ? 'process.stdout.write(JSON.stringify({value:"substituted-reviewer"}));\n' : "#!/usr/bin/bash\nprintf '%s' '{\"value\":\"substituted-reviewer\"}'\n", { mode: 0o700 });
			fs.writeFileSync(bundlePath, JSON.stringify({ value: "substituted-bundle" }));
		},
	});
	assert.deepEqual(result.output, { value: "sealed-original" });
});

test("review runner destroys a private snapshot when setup fails before spawn", () => {
	const fx = fixture();
	const bundlePath = path.join(fx.cwd, "review-cleanup.json");
	fs.writeFileSync(bundlePath, JSON.stringify({ exact: "private setup failure" }), { mode: 0o600 });
	const reviewerPath = reviewerFixturePath("isolated-reviewer");
	if (process.platform === "win32") {
		const staging = path.join(path.parse(process.cwd()).root, "tmp", "naia-request-contract-review");
		const before = fs.existsSync(staging) ? fs.readdirSync(staging).sort() : [];
		const originalWrite = fs.writeFileSync;
		let snapshotWrites = 0;
		fs.writeFileSync = function injectedWrite(file, ...args) {
			if (String(file).includes("naia-request-contract-review") && ++snapshotWrites === 2) throw Object.assign(new Error("injected snapshot setup failure"), { code: "INJECTED" });
			return originalWrite.call(this, file, ...args);
		};
		try {
			assert.throws(() => runSandbox({ bundlePath, expectedBundleDigest: core.sha256(fs.readFileSync(bundlePath)), reviewerPath, allowedReviewerDigests: [core.sha256(fs.readFileSync(reviewerPath))] }), (error) => error.code === "review_runner_snapshot_unavailable");
		} finally {
			fs.writeFileSync = originalWrite;
		}
		assert.deepEqual(fs.existsSync(staging) ? fs.readdirSync(staging).sort() : [], before);
	} else {
		const before = fs.readdirSync("/proc/self/fd").sort();
		const originalOpen = fs.openSync;
		let anonymousOpens = 0;
		fs.openSync = function injectedOpen(file, ...args) {
			if (file === os.tmpdir() && ++anonymousOpens === 2) throw Object.assign(new Error("injected snapshot setup failure"), { code: "INJECTED" });
			return originalOpen.call(this, file, ...args);
		};
		try {
			assert.throws(() => runSandbox({ bundlePath, expectedBundleDigest: core.sha256(fs.readFileSync(bundlePath)), reviewerPath, allowedReviewerDigests: [core.sha256(fs.readFileSync(reviewerPath))] }), (error) => error.code === "review_runner_snapshot_unavailable");
		} finally {
			fs.openSync = originalOpen;
		}
		assert.deepEqual(fs.readdirSync("/proc/self/fd").sort(), before);
	}
});

test("trusted review runner launches, independently signs, and ingests an isolated protocol review", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	const reviewerAttestor = fx.reviewerAttestor;
	const runnerAttestor = fx.runnerAttestor;
	const root = path.resolve(__dirname, "..", "..", "..");
	const stdout = cp.execFileSync(process.execPath, [
		path.join(root, "scripts", "request-contract-review-runner.cjs"),
		"--cwd", fx.cwd,
		"--unit", unit.id,
		"--writer-session", "S1",
		"--reviewer", reviewerFixturePath("contract-reviewer"),
		"--reviewer-attestor", reviewerAttestor,
		"--runner-attestor", runnerAttestor,
	], { encoding: "utf8", cwd: root });
	const publicResult = JSON.parse(stdout);
	assert.equal(publicResult.verdict, "CLEAN");
	assert.deepEqual(Object.keys(publicResult).sort(), ["run_id", "verdict"]);
	assert.equal(publicResult.record_hash, undefined);
	const record = core.verifyReviewChain(unit.paths).records[0];
	assert.equal(record.isolation.sandbox_engine, EXPECTED_SANDBOX_ENGINE);
	assert.equal(record.isolation.reviewer_executable_digest, core.loadConfig(fx.cwd).review_runner.allowed_reviewer_digests[0]);
	assert.equal(record.executor.attestor_executable_digest, fx.reviewerAttestorDigest);
	assert.equal(record.isolation.attestor_executable_digest, fx.runnerAttestorDigest);
	assert.equal(record.isolation.review_payload_digest, core.sha256(core.canonicalJson(core.reviewSignaturePayload(record))));
	assert.equal(record.reviewed_at, record.isolation.executed_at);
	assert(Number.isInteger(record.reviewed_at));
});

test("isolated reviewer stdout contains only opaque coverage and closed verdict fields", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	const challenge = core.issueReviewInvocation(unit, fx.cwd, "S1");
	const reviewerPath = reviewerFixturePath("contract-reviewer");
	const isolated = runSandbox({
		bundlePath: path.resolve(fx.cwd, challenge.manifest.bundle_locator),
		expectedBundleDigest: challenge.manifest.bundle_digest,
		reviewerPath,
		allowedReviewerDigests: [fx.reviewerFixtureDigest],
		env: { REQUEST_CONTRACT_CHALLENGE: challenge.manifest.nonce, REQUEST_CONTRACT_CONTEXT_ID: "privacy-check" },
	});
	const serialized = JSON.stringify(isolated.output);
	for (const forbidden of ["prompt", "text", "statement", "description", "path", "locator", "digest", "signature", "receipt"]) assert(!serialized.includes(`\"${forbidden}\"`), `reviewer stdout leaked ${forbidden}`);
	assert(!serialized.includes("Implement every requested target"));
	assert.deepEqual(Object.keys(isolated.output).sort(), ["covered_artifact_ids", "covered_authority_ids", "covered_authority_mappings", "covered_change_ids", "covered_change_mappings", "covered_criterion_ids", "covered_directive_ids", "covered_edge_ids", "covered_scope_version_ids", "covered_scope_version_mappings", "covered_source_ids", "covered_source_mappings", "covered_target_ids", "covered_tombstone_ids", "covered_tombstone_mappings", "finding_codes", "invocation_nonce", "verdict"].sort());
});

test("signed caller-authored review JSON has no live runner provenance", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	const review = cleanReview(fx, unit, "NO-LIVE-RUNNER");
	assert.equal(reviewRunner.consumeRunEvidence(runnerEvidenceByReview.get(review), review), true);
	assert.throws(() => ingestReview(fx, unit, review), (error) => error.code === "review_runner_provenance_missing");
});

test("operator CLI exposes no direct review JSON ingestion command", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	const root = path.resolve(__dirname, "..", "..", "..");
	const result = cp.spawnSync(process.execPath, [path.join(root, "scripts", "request-contract.cjs"), "review", "--unit", unit.id, "--file", "untrusted-review.json"], { encoding: "utf8", cwd: fx.cwd });
	assert.notEqual(result.status, 0);
	assert.equal(core.verifyReviewChain(unit.paths).records.length, 0);
});

test("registered native control preflight reaches initial bind and the pinned review runner", () => {
	const fx = fixture();
	installProductionControlSurface(fx);
	const unit = start(fx);
	const contract = makeContract(fx, unit);
	const contractInput = core.controlInputPath(unit, "contract");
	let toolUseId = "control-write";
	let envelope = { hook_event_name: "PreToolUse", session_id: "S1", cwd: fx.cwd, tool_name: "Write", tool_use_id: toolUseId, tool_input: { file_path: contractInput } };
	assert.equal(runInstalledNativeAdapter("claude", fx, envelope, "PreToolUse"), null);
	assert.deepEqual(core.readJson(unit.paths.state).active_mutations || {}, {});
	core.secureJson(contractInput, contract);
	envelope = { ...envelope, hook_event_name: "PostToolUse" };
	assert.equal(runInstalledNativeAdapter("claude", fx, envelope, "PostToolUse"), null);
	coverOccurrences(contract, unit);
	core.secureJson(contractInput, contract);
	const operatorScript = path.join(fx.cwd, "scripts", "request-contract.cjs");
	const bindWords = ["node", operatorScript, "bind", "--unit", unit.id, "--file", contractInput];
	const injected = runInstalledNativeAdapter("claude", { ...fx }, { hook_event_name: "PreToolUse", session_id: "S1", cwd: fx.cwd, tool_name: "Bash", tool_use_id: "control-injected", tool_input: { command: `${shellCommand(bindWords)}; touch escaped` } }, "PreToolUse");
	assert.equal(injected.decision, "block");
	assert(injected.reason.includes("request_contract_unbound"));
	toolUseId = "control-bind";
	envelope = { hook_event_name: "PreToolUse", session_id: "S1", cwd: fx.cwd, tool_name: "Bash", tool_use_id: toolUseId, tool_input: { command: shellCommand(bindWords) } };
	assert.equal(runInstalledNativeAdapter("claude", fx, envelope, "PreToolUse"), null);
	assert.deepEqual(core.readJson(unit.paths.state).active_mutations || {}, {});
	cp.execFileSync(bindWords[0], bindWords.slice(1), { cwd: fx.cwd, encoding: "utf8" });
	assert.equal(runInstalledNativeAdapter("claude", fx, { ...envelope, hook_event_name: "PostToolUse" }, "PostToolUse"), null);
	assert.equal(core.readJson(unit.paths.binding).state, "active");
	const reviewScript = path.join(fx.cwd, "scripts", "request-contract-review-runner.cjs");
	const reviewer = reviewerFixturePath("contract-reviewer");
	const reviewWords = [process.execPath, reviewScript, "--cwd", fx.cwd, "--unit", unit.id, "--writer-session", "S1", "--reviewer", reviewer, "--reviewer-attestor", fx.reviewerAttestor, "--runner-attestor", fx.runnerAttestor];
	for (const toolId of ["control-review-one", "control-review-two"]) {
		envelope = { hook_event_name: "PreToolUse", session_id: "S1", cwd: fx.cwd, tool_name: "Bash", tool_use_id: toolId, tool_input: { command: shellCommand(reviewWords) } };
		assert.equal(runInstalledNativeAdapter("claude", fx, envelope, "PreToolUse"), null);
		assert.deepEqual(core.readJson(unit.paths.state).active_mutations || {}, {});
		cp.execFileSync(reviewWords[0], reviewWords.slice(1), { cwd: fx.cwd, encoding: "utf8" });
		assert.equal(runInstalledNativeAdapter("claude", fx, { ...envelope, hook_event_name: "PostToolUse" }, "PostToolUse"), null);
	}
	assert.equal(core.verifyReviewChain(unit.paths).records.length, 2);
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "allow");
});

test("native Codex apply_patch can bootstrap only one exact private control input", () => {
	const fx = fixture();
	installProductionControlSurface(fx);
	const unit = start(fx, "codex", "CX-CONTROL");
	const contract = makeContract(fx, unit);
	const contractInput = core.controlInputPath(unit, "contract");
	const relative = path.relative(fx.cwd, contractInput).replace(/\\/g, "/");
	const patch = `*** Begin Patch\n*** Add File: ${relative}\n+{}\n*** End Patch`;
	let envelope = nativeEnvelope("codex", fx, "PreToolUse", "CX-CONTROL", { tool_name: "apply_patch", tool_use_id: "codex-control-patch", tool_input: { command: patch } });
	assert.equal(runInstalledNativeAdapter("codex", fx, envelope, "PreToolUse"), null);
	assert.deepEqual(core.readJson(unit.paths.state).active_mutations || {}, {});
	core.secureJson(contractInput, contract);
	assert.equal(runInstalledNativeAdapter("codex", fx, { ...envelope, hook_event_name: "PostToolUse", tool_response: { ok: true } }, "PostToolUse"), null);
	coverOccurrences(contract, unit);
	core.secureJson(contractInput, contract);
	for (const invalidPatch of [
		`*** Begin Patch\n*** Delete File: ${relative}\n*** End Patch`,
		`*** Begin Patch\n*** Update File: ${relative}\n@@\n-{}\n+{}\n*** Add File: src/escape.txt\n+escape\n*** End Patch`,
		`*** Begin Patch\n*** Add File: src/escape.txt\n+escape\n*** End Patch`,
	]) {
		const blocked = runInstalledNativeAdapter("codex", fx, nativeEnvelope("codex", fx, "PreToolUse", "CX-CONTROL", { tool_name: "apply_patch", tool_use_id: crypto.randomBytes(8).toString("hex"), tool_input: { command: invalidPatch } }), "PreToolUse");
		assert.equal(blocked.decision, "block");
		assert(blocked.reason.includes("request_contract_unbound"));
	}
	const operatorScript = path.join(fx.cwd, "scripts", "request-contract.cjs");
	const bindWords = ["node", operatorScript, "bind", "--unit", unit.id, "--file", contractInput];
	envelope = nativeEnvelope("codex", fx, "PreToolUse", "CX-CONTROL", { tool_name: "Bash", tool_use_id: "codex-control-bind", tool_input: { command: shellCommand(bindWords) } });
	assert.equal(runInstalledNativeAdapter("codex", fx, envelope, "PreToolUse"), null);
	cp.execFileSync(bindWords[0], bindWords.slice(1), { cwd: fx.cwd, encoding: "utf8" });
	assert.equal(runInstalledNativeAdapter("codex", fx, { ...envelope, hook_event_name: "PostToolUse", tool_response: { ok: true } }, "PostToolUse"), null);
	assert.equal(core.readJson(unit.paths.binding).state, "active");
});

test("the core rejects a source obligation narrowed before review", () => {
	const fx = fixture();
	const unit = start(fx, "claude", "S1", "Deliver TARGET[CASCADE] and TARGET[VIDEO_EDITOR]");
	const contract = makeContract(fx, unit, { statement: "Deliver TARGET[CASCADE]" });
	const structural = core.validateContract(contract, core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records, core.readJson(unit.paths.state).occurrences, { publicKeyPem: fx.publicKeyPem, cwd: fx.cwd });
	assert.equal(structural.ok, false);
	assert(structural.errors.some((error) => error.startsWith("contract_source_obligation_not_declared")));
	assert.throws(() => bind(fx, unit, contract), /contract_source_obligation_not_declared/);
});

test("a quoted compound request is rejected when one atom disappears after the directive", () => {
	const fx = fixture();
	const unit = start(fx, "claude", "S1", "Deliver A and B");
	const contract = makeContract(fx, unit);
	contract.sources[0].obligation_atoms = [
		{ id: "OBL-COMPOUND-A", text: "Deliver A", directive_ids: ["REQ-001"] },
		{ id: "OBL-COMPOUND-B", text: " and B", directive_ids: ["REQ-001"] },
	];
	for (const target of contract.directives[0].targets) target.obligation_atom_ids = ["OBL-COMPOUND-A"];
	for (const criterion of contract.directives[0].acceptance_criteria) criterion.obligation_atom_ids = ["OBL-COMPOUND-A"];
	for (const key of core.TRACE_KEYS) for (const artifact of contract.artifacts[key]) artifact.obligation_atom_ids = ["OBL-COMPOUND-A"];
	const result = core.validateContract(contract, core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records, [], { publicKeyPem: fx.publicKeyPem, cwd: fx.cwd });
	assert(result.errors.some((error) => error.includes("OBL-COMPOUND-B") && /_(target|acceptance|artifact|edge)_uncovered/.test(error)));
});

test("approval and authority sources cannot carry unmapped obligation atoms", () => {
	for (const classification of ["approval", "authority"]) {
		const fx = fixture();
		const unit = start(fx);
		const contract = makeContract(fx, unit);
		contract.sources[0].classification = classification;
		contract.sources[0].obligation_atoms[0].directive_ids = [];
		const structural = core.validateContract(contract, core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records, core.readJson(unit.paths.state).occurrences, { publicKeyPem: fx.publicKeyPem, cwd: fx.cwd });
		assert.equal(structural.ok, false);
		assert(structural.errors.some((error) => error.startsWith("contract_source_obligation_unmapped")));
		assert(structural.errors.some((error) => error.startsWith("contract_source_obligation_mapping_mismatch")));
		assert.throws(() => bind(fx, unit, contract), /contract_source_obligation_/);
	}
});

test("missing genesis quarantines the exact prompt", () => {
	const fx = fixture();
	const result = core.handleEvent({ client: "codex", eventName: "UserPromptSubmit", sessionId: "Q", cwd: fx.cwd, prompt: "do not lose this", origin: "native_user" });
	assert.equal(result.code, "request_contract_missing_genesis");
	const q = core.listUnconsumedQuarantine(fx.cwd);
	assert.equal(q.length, 1);
	assert.equal(core.readJsonl(path.join(q[0].dir, "sources.jsonl"))[0].prompt, "do not lose this");
});

test("duplicate runtime bindings fail closed without losing a valid prompt envelope", () => {
	const fx = fixture();
	const unit = start(fx, "claude", "DUPLICATE", "original prompt");
	const duplicateId = crypto.randomBytes(16).toString("hex");
	fs.cpSync(unit.paths.unit, core.unitPaths(fx.cwd, duplicateId).unit, { recursive: true });
	const result = adapter.processEnvelope("claude", nativeEnvelope("claude", fx, "UserPromptSubmit", "DUPLICATE", { prompt: "exact prompt during duplicate binding" }), "UserPromptSubmit");
	assert.equal(result.output.decision, "block");
	assert.equal(result.result.code, "duplicate_runtime_binding");
	const records = core.listUnconsumedQuarantine(fx.cwd).flatMap((q) => core.readJsonl(path.join(q.dir, "sources.jsonl")));
	assert.deepEqual(records.map((record) => record.prompt), ["exact prompt during duplicate binding"]);
});

test("next genesis adopts every unconsumed quarantine chain", () => {
	const fx = fixture();
	core.handleEvent({ client: "codex", eventName: "UserPromptSubmit", sessionId: "OLD", cwd: fx.cwd, prompt: "orphan one", origin: "native_user" });
	core.handleEvent({ client: "claude", eventName: "UserPromptSubmit", sessionId: "OLD2", cwd: fx.cwd, prompt: "orphan two", origin: "native_user" });
	core.handleEvent({ client: "codex", clientVersion: CLIENT_VERSIONS.codex, eventName: "SessionStart", sessionId: "NEW", cwd: fx.cwd });
	const unit = core.findUnit(fx.cwd, "codex", "NEW");
	const records = core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records;
	assert.deepEqual(records.map((r) => r.prompt).sort(), ["orphan one", "orphan two"]);
	assert.equal(core.listUnconsumedQuarantine(fx.cwd).length, 0);
});

test("a mutable quarantine consumed flag cannot hide an unadopted prompt", () => {
	const fx = fixture();
	core.handleEvent({ client: "codex", eventName: "UserPromptSubmit", sessionId: "OLD", cwd: fx.cwd, prompt: "must remain visible", origin: "native_user" });
	const q = core.listUnconsumedQuarantine(fx.cwd)[0];
	const headPath = path.join(q.dir, "head.json");
	const forged = core.readJson(headPath);
	forged.consumed = true;
	forged.consumed_by_unit = "0".repeat(32);
	forged.consumption_digest = "1".repeat(64);
	core.secureJson(headPath, forged);
	const unresolved = core.listUnconsumedQuarantine(fx.cwd);
	assert.equal(unresolved.length, 1);
	assert.equal(unresolved[0].corrupt, "quarantine_consumption_unbound");
	const result = core.handleEvent({ client: "claude", clientVersion: CLIENT_VERSIONS.claude, eventName: "SessionStart", sessionId: "NEW", cwd: fx.cwd });
	assert.equal(result.code, "quarantine_chain_corrupt");
});

test("consumed quarantine is cross-bound to the exact destination head", () => {
	const fx = fixture();
	core.handleEvent({ client: "codex", eventName: "UserPromptSubmit", sessionId: "OLD", cwd: fx.cwd, prompt: "cross-bound source", origin: "native_user" });
	core.handleEvent({ client: "claude", clientVersion: CLIENT_VERSIONS.claude, eventName: "SessionStart", sessionId: "NEW", cwd: fx.cwd });
	const unit = core.findUnit(fx.cwd, "claude", "NEW");
	const head = core.readJson(unit.paths.head);
	assert.equal(head.adopted_quarantines.length, 1);
	delete head.adopted_quarantines;
	core.secureJson(unit.paths.head, head);
	const unresolved = core.listUnconsumedQuarantine(fx.cwd);
	assert.equal(unresolved.length, 1);
	assert.equal(unresolved[0].corrupt, "quarantine_consumption_unbound");
});

test("a new client session reuses the one unresolved global lineage", () => {
	const fx = fixture();
	const first = start(fx, "claude", "OLD");
	const result = core.handleEvent({ client: "codex", clientVersion: CLIENT_VERSIONS.codex, eventName: "SessionStart", sessionId: "NEW", cwd: fx.cwd });
	assert.equal(result.kind, "context");
	const rebound = core.findUnit(fx.cwd, "codex", "NEW");
	assert.equal(rebound.id, first.id);
	assert.equal(core.listUnits(fx.cwd).length, 1);
});

test("recursive Git reference does not invent baseline additions in a clean repository", () => {
	const fx = fixture();
	const unit = start(fx);
	assert.deepEqual(core.readJson(unit.paths.state).occurrences, []);
	const reference = core.referenceManifest(fx.cwd);
	assert(reference.manifest.files["src/product.txt"]);
	assert(reference.manifest.files["evidence/test-report.txt"]);
});

test("source-chain tampering is detected", () => {
	const fx = fixture();
	const unit = start(fx);
	const records = core.readJsonl(unit.paths.sources);
	records[0].prompt = "narrowed replacement";
	fs.writeFileSync(unit.paths.sources, JSON.stringify(records[0]) + "\n");
	assert(core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).errors.includes("source_prompt_digest_mismatch"));
});

test("actionable source omission is rejected", () => {
	const fx = fixture();
	const unit = start(fx);
	core.handleEvent({ client: "claude", eventName: "UserPromptSubmit", sessionId: "S1", cwd: fx.cwd, prompt: "also build the editor", origin: "native_user" });
	const contract = makeContract(fx, unit);
	contract.sources.pop();
	const state = core.readJson(unit.paths.state);
	const result = core.validateContract(contract, core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records, state.occurrences, { publicKeyPem: fx.publicKeyPem });
	assert(result.errors.some((e) => e.startsWith("contract_source_uncovered:")));
});

test("authority validation fails closed without pinned key", () => {
	const fx = fixture();
	const unit = start(fx);
	const contract = makeContract(fx, unit);
	const result = core.validateContract(contract, core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records, [], {});
	assert(result.errors.some((e) => e.startsWith("authority_public_key_unavailable")));
});

test("signed user-presence assertions cannot be altered after external signing", () => {
	const fx = fixture();
	const unit = start(fx);
	for (const field of ["present", "non_exportable"]) {
		const contract = makeContract(fx, unit);
		contract.authorities[0].receipt.user_presence[field] = false;
		const result = core.validateContract(contract, core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records, [], { publicKeyPem: fx.publicKeyPem });
		assert(result.errors.some((error) => error.startsWith(field === "present" ? "authority_user_presence_missing:" : "authority_non_exportable_missing:")));
		assert(result.errors.some((error) => error.startsWith("authority_signature_invalid:")));
	}
});

test("governed genesis requires three distinct provisioned trust credentials", () => {
	const fx = fixture();
	const configFile = path.join(fx.cwd, ".agents", "context", "request-contract.json");
	const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
	config.review_runner.credential_id = "test-review-executor";
	fs.writeFileSync(configFile, JSON.stringify(config));
	const result = core.handleEvent({ client: "claude", clientVersion: CLIENT_VERSIONS.claude, eventName: "SessionStart", sessionId: "S1", cwd: fx.cwd });
	assert.equal(result.code, "request_contract_credentials_unprovisioned");
});

test("trace ids must resolve to concrete artifacts and a complete edge chain", () => {
	const fx = fixture();
	const unit = start(fx);
	const missingArtifact = makeContract(fx, unit);
	missingArtifact.artifacts.features = [];
	let result = core.validateContract(missingArtifact, core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records, [], { publicKeyPem: fx.publicKeyPem });
	assert(result.errors.some((error) => error.startsWith("contract_trace_artifact_unknown:")));
	const missingEdge = makeContract(fx, unit);
	missingEdge.edges = missingEdge.edges.filter((edge) => edge.kind !== "features_to_feature_tests");
	result = core.validateContract(missingEdge, core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records, [], { publicKeyPem: fx.publicKeyPem });
	assert(result.errors.some((error) => error.includes("contract_trace_edge_missing:")));
	const wrongSubject = makeContract(fx, unit);
	wrongSubject.artifacts.evidence[0].subject_id = "IMP-NOT-THERE";
	result = core.validateContract(wrongSubject, core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records, [], { publicKeyPem: fx.publicKeyPem });
	assert(result.errors.includes("contract_evidence_subject_unknown:EVD-001"));
	for (const spec of core.TRACE_EDGES) {
		const broken = makeContract(fx, unit);
		broken.edges = broken.edges.filter((edge) => edge.kind !== spec.kind);
		result = core.validateContract(broken, core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records, [], { publicKeyPem: fx.publicKeyPem });
		assert(result.errors.some((error) => error.includes(`contract_trace_edge_missing:REQ-001:${spec.kind}`)));
	}
});

test("source and directive mappings must be exactly reciprocal", () => {
	const fx = fixture();
	const unit = start(fx);
	core.handleEvent({ client: "claude", eventName: "UserPromptSubmit", sessionId: "S1", cwd: fx.cwd, prompt: "second source", origin: "native_user" });
	const contract = makeContract(fx, unit);
	contract.directives[0].source_ids = [contract.sources[1].id];
	const result = core.validateContract(contract, core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records, [], { publicKeyPem: fx.publicKeyPem });
	assert(result.errors.some((error) => error.startsWith("contract_source_mapping_not_reciprocal:")));
});

test("done directives require targets, criteria, and governed evidence locators", () => {
	const fx = fixture();
	const unit = start(fx);
	const contract = makeContract(fx, unit);
	contract.directives[0].targets = [];
	contract.directives[0].acceptance_criteria = [];
	contract.artifacts.evidence[0].locator = "node_modules/hidden-proof.txt";
	const result = core.validateContract(contract, core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records, [], { publicKeyPem: fx.publicKeyPem, cwd: fx.cwd });
	assert(result.errors.includes("contract_target_missing:REQ-001"));
	assert(result.errors.includes("contract_acceptance_missing:REQ-001"));
	assert(result.errors.includes("contract_evidence_locator_excluded:EVD-001"));
});

test("terminal disposal requires a matching authority target and tombstone", () => {
	const fx = fixture();
	const unit = start(fx);
	const contract = makeContract(fx, unit);
	contract.directives[0].state = "abandoned";
	contract.directives[0].authority_id = "AUTH-001";
	contract.tombstones.push({ id: "TOMB-001", directive_id: "REQ-001", state: "abandoned", authority_id: "AUTH-001", disposed_scope_ids: core.directiveDisposedScopeIds(contract.directives[0], contract.edges), statement: "Explicit disposal" });
	const result = core.validateContract(contract, core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records, [], { publicKeyPem: fx.publicKeyPem });
	assert(result.errors.includes("contract_terminal_authority_mismatch:REQ-001"));
});

test("terminal tombstones cover every disposed trace entity and edge", () => {
	const fx = fixture();
	const unit = start(fx);
	const contract = makeContract(fx, unit);
	contract.directives[0].state = "abandoned";
	contract.directives[0].authority_id = "AUTH-001";
	const disposed = core.directiveDisposedScopeIds(contract.directives[0], contract.edges);
	assert(disposed.includes("EVD-001"));
	assert(disposed.includes("EDGE-001-7"));
	contract.tombstones.push({ id: "TOMB-001", directive_id: "REQ-001", state: "abandoned", authority_id: "AUTH-001", disposed_scope_ids: disposed.slice(0, -1), statement: "Incomplete disposal" });
	const result = core.validateContract(contract, core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records, [], { publicKeyPem: fx.publicKeyPem });
	assert(result.errors.includes("contract_tombstone_scope_mismatch:REQ-001"));
});

test("terminal state names map to their signed authority operations", () => {
	const fx = fixture();
	const unit = start(fx);
	const contract = makeContract(fx, unit);
	contract.directives[0].state = "abandoned";
	contract.directives[0].authority_id = "AUTH-002";
	contract.tombstones.push({ id: "TOMB-001", directive_id: "REQ-001", state: "abandoned", authority_id: "AUTH-002", disposed_scope_ids: core.directiveDisposedScopeIds(contract.directives[0], contract.edges), statement: "Explicitly abandoned" });
	contract.authorities.push({
		id: "AUTH-002",
		operation: "abandon",
		source_id: contract.sources[0].id,
		source_digest: contract.authorities[0].source_digest,
		target_directive_ids: ["REQ-001"],
		affected_source_ids: [],
		affected_prior_ids: ["REQ-001"],
		replacement_ids: [],
		tombstone_ids: ["TOMB-001"],
		receipt: signedReceipt(fx, {
			operation: "abandon",
			prior_scope_digest: "1".repeat(64),
			resulting_scope_digest: "2".repeat(64),
			resulting_scope_epoch: 1,
			binding_epoch: 2,
			challenge: "AUT-structural-challenge",
			presentation_digest: "3".repeat(64),
			target_directive_ids: ["REQ-001"],
			affected_prior_ids: ["REQ-001"],
			tombstone_ids: ["TOMB-001"],
			sign_count: 2,
		}),
	});
	const result = core.validateContract(contract, core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records, [], { publicKeyPem: fx.publicKeyPem });
	assert(!result.errors.includes("contract_terminal_authority_mismatch:REQ-001"));
});

test("initial signed authority binds a complete contract", () => {
	const fx = fixture();
	const unit = start(fx);
	const result = bind(fx, unit);
	assert.equal(result.binding.binding_epoch, 1);
	assert.equal(core.readJson(unit.paths.head).scope_epoch, 0);
	assert.equal(core.verifyScopeHistory(unit).records.length, 1);
});

test("every authority structurally cites an exact mapped source", () => {
	const fx = fixture();
	const unit = start(fx);
	const contract = makeContract(fx, unit);
	delete contract.authorities[0].source_id;
	const result = core.validateContract(contract, core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records, [], { publicKeyPem: fx.publicKeyPem, cwd: fx.cwd });
	assert(result.errors.includes("contract_authority_source_invalid:AUTH-001"));
	const wrongDigest = makeContract(fx, unit);
	wrongDigest.authorities[0].source_digest = "0".repeat(64);
	const digestResult = core.validateContract(wrongDigest, core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records, [], { publicKeyPem: fx.publicKeyPem, cwd: fx.cwd });
	assert(digestResult.errors.includes("contract_authority_source_digest_invalid:AUTH-001"));
});

test("consumed authority history is append-only and immutable", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	const changed = core.readJson(unit.paths.contract);
	changed.authorities[0].replacement_ids = [];
	changed.authorities[0].receipt.replacement_ids = [];
	delete changed.authorities[0].receipt.signature;
	changed.authorities[0].receipt.signature = crypto.sign(null, Buffer.from(core.canonicalJson(changed.authorities[0].receipt)), fx.privateKey).toString("base64");
	assert.throws(() => bind(fx, unit, changed), (error) => error.code === "scope_authority_history_mutated");
});

test("a consumed authority remains valid evidence after its presentation window expires", () => {
	const fx = fixture();
	const unit = start(fx);
	const contract = makeContract(fx, unit);
	bind(fx, unit, contract);
	const validation = core.validateContract(contract, core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records, [], {
		publicKeyPem: fx.publicKeyPem,
		now: Date.now() + 120_000,
	});
	assert(!validation.errors.some((error) => error.startsWith("authority_expired")));
});

test("later pure additions require and accept a signed amendment epoch", () => {
	const fx = fixture();
	const unit = start(fx);
	const first = makeContract(fx, unit);
	bind(fx, unit, first);
	core.handleEvent({ client: "claude", eventName: "UserPromptSubmit", sessionId: "S1", cwd: fx.cwd, prompt: "also add the editor", origin: "native_user" });
	const records = core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records;
	const second = JSON.parse(JSON.stringify(first));
	const secondGraph = traceGraph("002", "REQ-002");
	addContractSource(second, records[1], ["REQ-002"]);
	second.directives.push({
		id: "REQ-002",
		statement: records[1].prompt,
		state: "done",
		source_ids: [records[1].source_id],
		targets: [{ id: "TGT-002", path: "src/editor.txt" }],
		acceptance_criteria: [{ id: "AC-002", statement: "Editor is implemented and tested" }],
		trace: secondGraph.trace,
	});
	mergeGraph(second, secondGraph);
	synchronizeObligationCoverage(second);
	second.authorities.push({ id: "AUTH-002", operation: "amend_scope_add", source_id: records[1].source_id, source_digest: records[1].prompt_digest, target_directive_ids: ["REQ-002"], affected_source_ids: [], affected_prior_ids: [], replacement_ids: ["REQ-002"], tombstone_ids: [], receipt: { operation: "amend_scope_add", nonce: "addition-nonce-01" } });
	const wronglyTargeted = JSON.parse(JSON.stringify(second));
	wronglyTargeted.authorities[1].target_directive_ids = ["REQ-001"];
	const badScope = core.sha256(core.canonicalJson(core.scopeProjection(wronglyTargeted)));
	const badPresentation = core.authorityPresentation(wronglyTargeted.authorities[1], core.sha256(core.canonicalJson(core.scopeProjection(first))), badScope, 1, 2);
	const badChallenge = core.issueAuthorityChallenge(unit, fx.cwd, badPresentation);
	wronglyTargeted.authorities[1].receipt = signedReceipt(fx, {
		operation: "amend_scope_add",
		nonce: "addition-nonce-01",
		prior_scope_digest: core.sha256(core.canonicalJson(core.scopeProjection(first))),
		resulting_scope_digest: badScope,
		resulting_scope_epoch: 1,
		binding_epoch: 2,
		challenge: badChallenge.challenge,
		presentation_digest: badChallenge.presentation_digest,
		target_directive_ids: ["REQ-001"],
		replacement_ids: ["REQ-002"],
		sign_count: 2,
	});
	assert.throws(() => bind(fx, unit, wronglyTargeted), /authority source|source_target_mismatch|targets do not exactly match changed directives/);
	const nextScope = core.sha256(core.canonicalJson(core.scopeProjection(second)));
	const presentation = core.authorityPresentation(second.authorities[1], core.sha256(core.canonicalJson(core.scopeProjection(first))), nextScope, 1, 2);
	const challenge = core.issueAuthorityChallenge(unit, fx.cwd, presentation);
	second.authorities[1].receipt = signedReceipt(fx, {
		operation: "amend_scope_add",
		nonce: "addition-nonce-01",
		prior_scope_digest: core.sha256(core.canonicalJson(core.scopeProjection(first))),
		resulting_scope_digest: nextScope,
		resulting_scope_epoch: 1,
		binding_epoch: 2,
		challenge: challenge.challenge,
		presentation_digest: challenge.presentation_digest,
		target_directive_ids: ["REQ-002"],
		replacement_ids: ["REQ-002"],
		sign_count: 2,
	});
	const result = bind(fx, unit, second);
	assert.equal(result.binding.binding_epoch, 2);
	assert.equal(core.readJson(unit.paths.head).scope_epoch, 1);
	assert.equal(core.verifyScopeHistory(unit).records.length, 2);
});

test("target and acceptance additions use amend_scope_add with exact replacement ownership", () => {
	const fx = fixture();
	const unit = start(fx);
	const first = makeContract(fx, unit);
	bind(fx, unit, first);
	core.handleEvent({ client: "claude", eventName: "UserPromptSubmit", sessionId: "S1", cwd: fx.cwd, prompt: "Add another target and acceptance criterion", origin: "native_user" });
	const records = core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records;
	const second = JSON.parse(JSON.stringify(first));
	addContractSource(second, records[1], ["REQ-001"]);
	second.directives[0].source_ids.push(records[1].source_id);
	second.directives[0].targets.push({ id: "TGT-002", path: "src/second.txt", description: records[1].prompt });
	second.directives[0].acceptance_criteria.push({ id: "AC-002", statement: "Second target is verified" });
	synchronizeObligationCoverage(second);
	second.authorities.push({ id: "AUTH-002", operation: "amend_scope_add", source_id: records[1].source_id, source_digest: records[1].prompt_digest, target_directive_ids: ["REQ-001"], affected_source_ids: [], affected_prior_ids: ["REQ-001"], replacement_ids: ["TGT-002", "AC-002"], tombstone_ids: [], receipt: { operation: "amend_scope_add", nonce: "target-add-nonce" } });
	const priorScope = core.sha256(core.canonicalJson(core.scopeProjection(first)));
	const nextScope = core.sha256(core.canonicalJson(core.scopeProjection(second)));
	const presentation = core.authorityPresentation(second.authorities[1], priorScope, nextScope, 1, 2);
	const challenge = core.issueAuthorityChallenge(unit, fx.cwd, presentation);
	second.authorities[1].receipt = signedReceipt(fx, { operation: "amend_scope_add", nonce: "target-add-nonce", prior_scope_digest: priorScope, resulting_scope_digest: nextScope, resulting_scope_epoch: 1, binding_epoch: 2, challenge: challenge.challenge, presentation_digest: challenge.presentation_digest, target_directive_ids: ["REQ-001"], affected_prior_ids: ["REQ-001"], replacement_ids: ["TGT-002", "AC-002"], sign_count: 2 });
	assert.doesNotThrow(() => bind(fx, unit, second));
});

test("target or acceptance removal cannot be laundered as a generic replacement", () => {
	const fx = fixture();
	const unit = start(fx);
	const first = makeContract(fx, unit);
	first.directives[0].targets.push({ id: "TGT-REMOVABLE", path: "src/removable.txt" });
	first.directives[0].acceptance_criteria.push({ id: "AC-REMOVABLE", statement: "Removable scope remains explicit" });
	synchronizeObligationCoverage(first);
	const firstScope = core.sha256(core.canonicalJson(core.scopeProjection(first)));
	const firstPresentation = core.authorityPresentation(first.authorities[0], null, firstScope, 0, 1);
	const firstChallenge = core.issueAuthorityChallenge(unit, fx.cwd, firstPresentation);
	first.authorities[0].receipt = signedReceipt(fx, { operation: "authorize_contract", nonce: "initial-nonce-01", resulting_scope_digest: firstScope, resulting_scope_epoch: 0, binding_epoch: 1, challenge: firstChallenge.challenge, presentation_digest: firstChallenge.presentation_digest, target_directive_ids: ["REQ-001"], replacement_ids: ["REQ-001"], sign_count: 1 });
	bind(fx, unit, first);
	for (const field of ["targets", "acceptance_criteria"]) {
		const narrowed = JSON.parse(JSON.stringify(first));
		narrowed.directives[0][field].pop();
		assert.throws(() => bind(fx, unit, narrowed), (error) => error.code === "scope_child_removed");
	}
});

test("mixed authorities cannot swap exact metadata between signed operations", () => {
	const fx = fixture();
	const unit = start(fx);
	core.handleEvent({ client: "claude", eventName: "UserPromptSubmit", sessionId: "S1", cwd: fx.cwd, prompt: "background context", origin: "native_user" });
	const initial = makeContract(fx, unit);
	initial.sources[1] = { ...initial.sources[1], classification: "context", directive_ids: [], obligation_atoms: initial.sources[1].obligation_atoms.map((atom) => ({ ...atom, directive_ids: [] })) };
	initial.directives[0].source_ids = [initial.sources[0].id];
	synchronizeObligationCoverage(initial);
	const initialScope = core.sha256(core.canonicalJson(core.scopeProjection(initial)));
	let presentation = core.authorityPresentation(initial.authorities[0], null, initialScope, 0, 1);
	let challenge = core.issueAuthorityChallenge(unit, fx.cwd, presentation);
	initial.authorities[0].receipt = signedReceipt(fx, { operation: "authorize_contract", nonce: "initial-nonce-01", resulting_scope_digest: initialScope, resulting_scope_epoch: 0, binding_epoch: 1, challenge: challenge.challenge, presentation_digest: challenge.presentation_digest, target_directive_ids: ["REQ-001"], replacement_ids: ["REQ-001"], sign_count: 1 });
	bind(fx, unit, initial);
	core.handleEvent({ client: "claude", eventName: "UserPromptSubmit", sessionId: "S1", cwd: fx.cwd, prompt: "Add a target and correct the context classification", origin: "native_user" });
	const records = core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records;
	const next = JSON.parse(JSON.stringify(initial));
	next.sources[1].classification = "conversation";
	addContractSource(next, records[2], ["REQ-001"]);
	next.directives[0].source_ids.push(records[2].source_id);
	next.directives[0].targets.push({ id: "TGT-MIXED", path: "src/mixed.txt", description: records[2].prompt });
	next.directives[0].acceptance_criteria.push({ id: "AC-MIXED", statement: "Mixed addition verified" });
	synchronizeObligationCoverage(next);
	next.authorities.push({ id: "AUTH-002", operation: "amend_scope_add", source_id: records[2].source_id, source_digest: records[2].prompt_digest, target_directive_ids: ["REQ-001"], affected_source_ids: [], affected_prior_ids: ["REQ-001"], replacement_ids: ["TGT-MIXED", "AC-MIXED"], tombstone_ids: [], receipt: { operation: "amend_scope_add", nonce: "mixed-add-nonce-01" } });
	next.authorities.push({ id: "AUTH-003", operation: "amend_scope_replace", source_id: records[2].source_id, source_digest: records[2].prompt_digest, target_directive_ids: ["REQ-001"], affected_source_ids: [records[1].source_id], affected_prior_ids: ["REQ-001"], replacement_ids: [], tombstone_ids: [], receipt: { operation: "amend_scope_replace", nonce: "mixed-replace-nonce-01" } });
	const priorScope = core.sha256(core.canonicalJson(core.scopeProjection(initial)));
	const signAuthorities = (contract) => {
		const scope = core.sha256(core.canonicalJson(core.scopeProjection(contract)));
		const presentations = contract.authorities.slice(1, 3).map((authority) => core.authorityPresentation(authority, priorScope, scope, 1, 2));
		challenge = core.issueAuthorityChallenge(unit, fx.cwd, presentations);
		for (let index = 1; index <= 2; index++) {
			const authority = contract.authorities[index];
			presentation = presentations[index - 1];
			authority.receipt = signedReceipt(fx, { operation: authority.operation, nonce: authority.receipt.nonce, prior_scope_digest: priorScope, resulting_scope_digest: scope, resulting_scope_epoch: 1, binding_epoch: 2, challenge: challenge.challenge, presentation_digest: core.sha256(core.canonicalJson(presentation)), target_directive_ids: authority.target_directive_ids, affected_source_ids: authority.affected_source_ids, affected_prior_ids: authority.affected_prior_ids, replacement_ids: authority.replacement_ids, tombstone_ids: authority.tombstone_ids, sign_count: index + 1 });
		}
	};
	const swapped = JSON.parse(JSON.stringify(next));
	swapped.authorities[1].affected_source_ids = [records[1].source_id];
	swapped.authorities[1].replacement_ids = [];
	swapped.authorities[2].affected_source_ids = [];
	swapped.authorities[2].replacement_ids = ["TGT-MIXED", "AC-MIXED"];
	signAuthorities(swapped);
	assert.throws(() => bind(fx, unit, swapped), (error) => error.code === "authority_operation_metadata_mismatch");
	signAuthorities(next);
	assert.doesNotThrow(() => bind(fx, unit, next));
});

test("silent removal or reclassification without a new authority is rejected", () => {
	const fx = fixture();
	const unit = start(fx);
	const first = makeContract(fx, unit);
	bind(fx, unit, first);
	const narrowed = JSON.parse(JSON.stringify(first));
	narrowed.sources[0].classification = "context";
	assert.throws(() => bind(fx, unit, narrowed), /authority affected_(source|prior)_ids|scope changed without amendment authority/);
	core.handleEvent({ client: "claude", eventName: "UserPromptSubmit", sessionId: "S1", cwd: fx.cwd, prompt: "Authorize correcting the original source classification", origin: "native_user" });
	const records = core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records;
	const corrected = JSON.parse(JSON.stringify(narrowed));
	addContractSource(corrected, records[1], ["REQ-001"], "authority", true);
	corrected.directives[0].source_ids.push(records[1].source_id);
	corrected.authorities.push({ id: "AUTH-002", operation: "amend_scope_replace", source_id: records[1].source_id, source_digest: records[1].prompt_digest, target_directive_ids: ["REQ-001"], affected_source_ids: [first.sources[0].id], affected_prior_ids: ["REQ-001"], replacement_ids: [], tombstone_ids: [], receipt: { operation: "amend_scope_replace", nonce: "replace-nonce-01" } });
	const priorScope = core.sha256(core.canonicalJson(core.scopeProjection(first)));
	const nextScope = core.sha256(core.canonicalJson(core.scopeProjection(corrected)));
	const presentation = core.authorityPresentation(corrected.authorities[1], priorScope, nextScope, 1, 2);
	const challenge = core.issueAuthorityChallenge(unit, fx.cwd, presentation);
	corrected.authorities[1].receipt = signedReceipt(fx, { operation: "amend_scope_replace", nonce: "replace-nonce-01", prior_scope_digest: priorScope, resulting_scope_digest: nextScope, resulting_scope_epoch: 1, binding_epoch: 2, challenge: challenge.challenge, presentation_digest: challenge.presentation_digest, target_directive_ids: ["REQ-001"], affected_source_ids: [first.sources[0].id], affected_prior_ids: ["REQ-001"], sign_count: 2 });
	assert.doesNotThrow(() => bind(fx, unit, corrected));
});

test("reclassifying an unmapped context source still requires exact source authority", () => {
	const fx = fixture();
	const unit = start(fx);
	core.handleEvent({ client: "claude", eventName: "UserPromptSubmit", sessionId: "S1", cwd: fx.cwd, prompt: "background only", origin: "native_user" });
	const first = makeContract(fx, unit);
	first.sources[1] = { ...first.sources[1], classification: "context", directive_ids: [], obligation_atoms: first.sources[1].obligation_atoms.map((atom) => ({ ...atom, directive_ids: [] })) };
	first.directives[0].source_ids = [first.sources[0].id];
	synchronizeObligationCoverage(first);
	const firstScope = core.sha256(core.canonicalJson(core.scopeProjection(first)));
	const firstPresentation = core.authorityPresentation(first.authorities[0], null, firstScope, 0, 1);
	const firstChallenge = core.issueAuthorityChallenge(unit, fx.cwd, firstPresentation);
	first.authorities[0].receipt = signedReceipt(fx, { operation: "authorize_contract", nonce: "initial-nonce-01", resulting_scope_digest: firstScope, resulting_scope_epoch: 0, binding_epoch: 1, challenge: firstChallenge.challenge, presentation_digest: firstChallenge.presentation_digest, target_directive_ids: ["REQ-001"], replacement_ids: ["REQ-001"], sign_count: 1 });
	bind(fx, unit, first);
	const reclassified = JSON.parse(JSON.stringify(first));
	reclassified.sources[1].classification = "conversation";
	assert.throws(() => bind(fx, unit, reclassified), /affected_source_ids|reclassification requires amend_scope_replace/);
});

test("terminal directives and tombstones remain canonically immutable under later authority", () => {
	const fx = fixture();
	const unit = start(fx);
	const first = makeContract(fx, unit);
	bind(fx, unit, first);
	core.handleEvent({ client: "claude", eventName: "UserPromptSubmit", sessionId: "S1", cwd: fx.cwd, prompt: "Explicitly abandon the original request", origin: "native_user" });
	const records = core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records;
	const second = JSON.parse(JSON.stringify(first));
	addContractSource(second, records[1], ["REQ-001"], "authority", true);
	second.directives[0].source_ids.push(records[1].source_id);
	second.directives[0].state = "abandoned";
	second.directives[0].authority_id = "AUTH-002";
	second.tombstones.push({ id: "TOMB-001", directive_id: "REQ-001", state: "abandoned", authority_id: "AUTH-002", disposed_scope_ids: core.directiveDisposedScopeIds(second.directives[0], second.edges), statement: "Explicit user-authorized abandonment" });
	second.authorities.push({ id: "AUTH-002", operation: "abandon", source_id: records[1].source_id, source_digest: records[1].prompt_digest, target_directive_ids: ["REQ-001"], affected_source_ids: [], affected_prior_ids: ["REQ-001"], replacement_ids: [], tombstone_ids: ["TOMB-001"], receipt: { operation: "abandon", nonce: "abandon-nonce-01" } });
	const priorScope = core.sha256(core.canonicalJson(core.scopeProjection(first)));
	const nextScope = core.sha256(core.canonicalJson(core.scopeProjection(second)));
	const presentation = core.authorityPresentation(second.authorities[1], priorScope, nextScope, 1, 2);
	const challenge = core.issueAuthorityChallenge(unit, fx.cwd, presentation);
	second.authorities[1].receipt = signedReceipt(fx, { operation: "abandon", nonce: "abandon-nonce-01", prior_scope_digest: priorScope, resulting_scope_digest: nextScope, resulting_scope_epoch: 1, binding_epoch: 2, challenge: challenge.challenge, presentation_digest: challenge.presentation_digest, target_directive_ids: ["REQ-001"], affected_prior_ids: ["REQ-001"], tombstone_ids: ["TOMB-001"], sign_count: 2 });
	bind(fx, unit, second);
	const reactivated = JSON.parse(JSON.stringify(second));
	reactivated.directives[0].state = "active";
	assert.throws(() => bind(fx, unit, reactivated), (error) => error.code === "scope_terminal_directive_immutable");
	const tampered = JSON.parse(JSON.stringify(second));
	tampered.tombstones[0].statement = "A different disposition";
	assert.throws(() => bind(fx, unit, tampered), (error) => error.code === "scope_tombstone_identity_mutated");
	const rewrittenIdentity = JSON.parse(JSON.stringify(second));
	const replacementGraph = traceGraph("009", "REQ-001");
	rewrittenIdentity.directives[0].trace = replacementGraph.trace;
	rewrittenIdentity.artifacts = replacementGraph.artifacts;
	rewrittenIdentity.edges = replacementGraph.edges;
	synchronizeObligationCoverage(rewrittenIdentity);
	rewrittenIdentity.tombstones[0].disposed_scope_ids = core.directiveDisposedScopeIds(rewrittenIdentity.directives[0], rewrittenIdentity.edges);
	assert.throws(() => bind(fx, unit, rewrittenIdentity), (error) => ["contract_invalid", "scope_terminal_directive_immutable", "scope_tombstone_identity_mutated"].includes(error.code));
	core.handleEvent({ client: "claude", eventName: "UserPromptSubmit", sessionId: "S1", cwd: fx.cwd, prompt: "Replace the recorded abandonment disposition", origin: "native_user" });
	const laterRecords = core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records;
	const authorized = JSON.parse(JSON.stringify(second));
	addContractSource(authorized, laterRecords[2], ["REQ-001"], "authority", true);
	authorized.directives[0].source_ids.push(laterRecords[2].source_id);
	authorized.directives[0].authority_id = "AUTH-003";
	authorized.tombstones[0] = { ...authorized.tombstones[0], authority_id: "AUTH-003", statement: "Replacement user-authorized abandonment" };
	authorized.authorities.push({ id: "AUTH-003", operation: "abandon", source_id: laterRecords[2].source_id, source_digest: laterRecords[2].prompt_digest, target_directive_ids: ["REQ-001"], affected_source_ids: [], affected_prior_ids: ["REQ-001"], replacement_ids: [], tombstone_ids: ["TOMB-001"], receipt: { operation: "abandon", nonce: "abandon-nonce-02" } });
	const replacementPriorScope = core.sha256(core.canonicalJson(core.scopeProjection(second)));
	const replacementScope = core.sha256(core.canonicalJson(core.scopeProjection(authorized)));
	const replacementPresentation = core.authorityPresentation(authorized.authorities[2], replacementPriorScope, replacementScope, 2, 3);
	const replacementChallenge = core.issueAuthorityChallenge(unit, fx.cwd, replacementPresentation);
	authorized.authorities[2].receipt = signedReceipt(fx, { operation: "abandon", nonce: "abandon-nonce-02", prior_scope_digest: replacementPriorScope, resulting_scope_digest: replacementScope, resulting_scope_epoch: 2, binding_epoch: 3, challenge: replacementChallenge.challenge, presentation_digest: replacementChallenge.presentation_digest, target_directive_ids: ["REQ-001"], affected_prior_ids: ["REQ-001"], tombstone_ids: ["TOMB-001"], sign_count: 3 });
	assert.throws(() => bind(fx, unit, authorized), (error) => error.code === "scope_terminal_directive_immutable");
});

test("scope-history tampering is detected independently of current contract", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	const records = core.readJsonl(unit.paths.scopeHistory);
	records[0].contract.directives[0].statement = "tampered history";
	fs.writeFileSync(unit.paths.scopeHistory, JSON.stringify(records[0]) + "\n");
	assert(core.verifyScopeHistory(unit).errors.includes("scope_history_contract_digest_invalid"));
});

test("a directly edited contract cannot become its own prior scope through Stop then bind", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	const edited = core.readJson(unit.paths.contract);
	edited.directives[0].statement = "Unauthorized narrowed scope";
	fs.writeFileSync(unit.paths.contract, JSON.stringify(edited, null, 2));
	const stop = core.evaluateCompletion(unit, fx.cwd, "claude");
	assert(stop.errors.includes("contract_digest_mismatch"));
	assert.throws(() => core.bindContract(unit, edited, { publicKeyPem: fx.publicKeyPem, cwd: fx.cwd }), (error) => error.code === "contract_state_drift");
});

test("change occurrences require directive, implementation, and evidence mapping", () => {
	const fx = fixture();
	const unit = start(fx);
	const occurrence = core.observeOccurrence(unit, { source: "tool", tool: "Edit", target: "src/product.txt" });
	const contract = makeContract(fx, unit);
	let result = core.validateContract(contract, core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records, [occurrence], { publicKeyPem: fx.publicKeyPem });
	assert(result.errors.includes(`contract_change_uncovered:${occurrence.id}`));
	contract.changes.push({ id: occurrence.id, directive_id: "REQ-001", implementation_id: "IMP-001", evidence_id: "EVD-001" });
	result = core.validateContract(contract, core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records, [occurrence], { publicKeyPem: fx.publicKeyPem });
	assert(!result.errors.some((e) => e.startsWith("contract_change_")));
});

test("workspace transitions preserve modification, reversion, and repeated modification as distinct occurrences", () => {
	const fx = fixture();
	const unit = start(fx);
	fs.writeFileSync(path.join(fx.cwd, "src", "product.txt"), "changed\n");
	core.captureWorkspaceOccurrences(unit, fx.cwd);
	fs.writeFileSync(path.join(fx.cwd, "src", "product.txt"), "baseline\n");
	core.captureWorkspaceOccurrences(unit, fx.cwd);
	fs.writeFileSync(path.join(fx.cwd, "src", "product.txt"), "changed\n");
	core.captureWorkspaceOccurrences(unit, fx.cwd);
	const transitions = core.readJson(unit.paths.state).occurrences.filter((occurrence) => occurrence.detail.path === "src/product.txt");
	assert.equal(transitions.length, 3);
	assert.equal(new Set(transitions.map((occurrence) => occurrence.id)).size, 3);
	assert.equal(transitions[0].signature, transitions[2].signature);
	assert.notEqual(transitions[0].signature, transitions[1].signature);
});

test("a change cannot borrow implementation or evidence from another directive", () => {
	const fx = fixture();
	const unit = start(fx);
	core.handleEvent({ client: "claude", eventName: "UserPromptSubmit", sessionId: "S1", cwd: fx.cwd, prompt: "second directive", origin: "native_user" });
	const occurrence = core.observeOccurrence(unit, { source: "workspace", path: "src/product.txt", kind: "modify" });
	const contract = makeContract(fx, unit);
	const graph = traceGraph("002", "REQ-002");
	contract.sources[0].directive_ids = ["REQ-001"];
	contract.sources[1].directive_ids = ["REQ-002"];
	contract.directives[0].source_ids = [contract.sources[0].id];
	contract.directives.push({ id: "REQ-002", statement: "Second directive", state: "done", source_ids: [contract.sources[1].id], targets: [{ id: "TGT-002", path: "src/product.txt" }], acceptance_criteria: [{ id: "AC-002", statement: "Verified" }], trace: graph.trace });
	mergeGraph(contract, graph);
	synchronizeObligationCoverage(contract);
	contract.authorities[0].target_directive_ids = ["REQ-001", "REQ-002"];
	contract.authorities[0].receipt.target_directive_ids = ["REQ-001", "REQ-002"];
	contract.changes.push({ id: occurrence.id, directive_id: "REQ-001", implementation_id: "IMP-002", evidence_id: "EVD-002" });
	const result = core.validateContract(contract, core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records, [occurrence], { publicKeyPem: fx.publicKeyPem });
	assert(result.errors.includes(`contract_change_cross_directive:${occurrence.id}`));
});

test("review bundle contains every exact source and full contract", () => {
	const fx = fixture();
	const unit = start(fx, "codex", "B", "first exact request");
	core.handleEvent({ client: "codex", eventName: "UserPromptSubmit", sessionId: "B", cwd: fx.cwd, prompt: "second exact request", origin: "native_user" });
	bind(fx, unit);
	const { bundle, digest } = core.buildReviewBundle(unit, fx.cwd);
	assert.deepEqual(bundle.sources.map((s) => s.prompt), ["first exact request", "second exact request"]);
	assert.equal(digest.length, 64);
	assert.equal(bundle.contract.directives[0].statement, "first exact request\nsecond exact request");
	assert.equal(bundle.scope_history.length, 1);
	assert(bundle.workspace_manifest.files["src/product.txt"]);
	assert.equal(Buffer.from(bundle.materials.find((material) => material.path === "src/product.txt").content_base64, "base64").toString(), "baseline\n");
	assert.equal(Buffer.from(bundle.materials.find((material) => material.path === "evidence/test-report.txt").content_base64, "base64").toString(), "verified evidence\n");
});

test("review bundle creation rejects workspace and material snapshot races", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	assert.throws(() => core.buildReviewBundle(unit, fx.cwd, { afterWorkspaceSnapshot: () => fs.writeFileSync(path.join(fx.cwd, "src", "product.txt"), "raced\n") }), (error) => error.code === "review_bundle_workspace_race");
});

test("review challenge stdout exposes only a manifest and opaque bundle locator", () => {
	const fx = fixture();
	const exactPrompt = "private source prompt must not reach stdout";
	const unit = start(fx, "claude", "CLI", exactPrompt);
	bind(fx, unit);
	const root = path.resolve(__dirname, "..", "..", "..");
	const stdout = cp.execFileSync(process.execPath, [path.join(root, "scripts", "request-contract.cjs"), "review-challenge", "--unit", unit.id, "--writer-session", "CLI", "--cwd", fx.cwd], { encoding: "utf8", cwd: root });
	assert(!stdout.includes(exactPrompt));
	const locator = JSON.parse(stdout).bundle_locator;
	assert(!path.isAbsolute(locator));
	const out = path.join(fx.cwd, locator);
	assert(fs.readFileSync(out, "utf8").includes(exactPrompt));
	if (process.platform === "win32") assert(fs.lstatSync(out).isFile() && !fs.lstatSync(out).isSymbolicLink());
	else assert.equal(fs.statSync(out).mode & 0o777, 0o600);
});

test("review ingestion requires the pinned runner to attest all isolation controls", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	const review = cleanReview(fx, unit, "R1");
	review.isolation.no_network = false;
	review.isolation.signature = crypto.sign(null, Buffer.from(core.canonicalJson(core.isolationSignaturePayload(review.isolation))), fx.runnerPrivateKey).toString("base64");
	review.executor.signature = crypto.sign(null, Buffer.from(core.canonicalJson(core.reviewSignaturePayload(review))), fx.reviewerPrivateKey).toString("base64");
	assert.throws(() => ingestReview(fx, unit, review), /review_isolation_controls_missing/);
});

test("review ingestion rejects reviewer-controlled timestamps and never reflects rejected field names", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	const timestamp = cleanReview(fx, unit, "TIMESTAMP", { reviewed_at: "PRIVATE_PROMPT_VALUE" });
	let timestampError;
	try { ingestReview(fx, unit, timestamp); } catch (error) { timestampError = error; }
	assert(timestampError && timestampError.errors.includes("review_reviewed_at_invalid"));
	assert(!JSON.stringify(timestampError.errors).includes("PRIVATE_PROMPT_VALUE"));
	const field = cleanReview(fx, unit, "FIELD");
	field.PRIVATE_PROMPT_FIELD_NAME = true;
	field.executor.signature = crypto.sign(null, Buffer.from(core.canonicalJson(core.reviewSignaturePayload(field))), fx.reviewerPrivateKey).toString("base64");
	let fieldError;
	try { ingestReview(fx, unit, field); } catch (error) { fieldError = error; }
	assert(fieldError && fieldError.errors.includes("review_extra_field"));
	assert(!JSON.stringify(fieldError.errors).includes("PRIVATE_PROMPT_FIELD_NAME"));
});

test("reviewer and isolation-runner keys are pinned at genesis", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	const { publicKey } = crypto.generateKeyPairSync("ed25519");
	fs.writeFileSync(path.join(fx.cwd, ".agents", "context", "reviewer.pub"), publicKey.export({ type: "spki", format: "pem" }));
	assert.throws(() => core.issueReviewInvocation(unit, fx.cwd, "S1"), /reviewer key differs from genesis pin/);
});

test("Clean review records require the pinned external signer and one-time invocation", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	const forged = cleanReview(fx, unit, "FORGED");
	forged.executor.signature = Buffer.from("forged").toString("base64");
	assert.throws(() => ingestReview(fx, unit, forged), /review_executor_signature_invalid/);
	const valid = cleanReview(fx, unit, "VALID");
	const privateBundle = core.readJson(path.join(unit.paths.pending, `review-${valid.invocation_nonce}.json`)).private_bundle_path;
	ingestReview(fx, unit, valid);
	assert(!fs.existsSync(privateBundle));
	assert.throws(() => ingestReview(fx, unit, valid), /review_invocation_replayed/);
});

test("review ingestion rejects altered invocation manifests and bundle bytes", () => {
	let fx = fixture();
	let unit = start(fx);
	bind(fx, unit);
	let review = cleanReview(fx, unit, "MANIFEST-TAMPER");
	const manifestPath = path.join(unit.paths.pending, `review-${review.invocation_nonce}.json`);
	const manifest = core.readJson(manifestPath);
	manifest.writer_session_ids = ["forged-writer"];
	fs.writeFileSync(manifestPath, JSON.stringify(manifest));
	assert.throws(() => ingestReview(fx, unit, review), (error) => error.errors.includes("review_invocation_manifest_tampered"));

	fx = fixture();
	unit = start(fx);
	bind(fx, unit);
	review = cleanReview(fx, unit, "BUNDLE-TAMPER");
	const invocation = core.readJson(path.join(unit.paths.pending, `review-${review.invocation_nonce}.json`));
	fs.writeFileSync(invocation.private_bundle_path, JSON.stringify({ narrowed: true }));
	assert.throws(() => ingestReview(fx, unit, review), (error) => error.errors.includes("review_invocation_bundle_tampered"));
});

test("reviewer context cannot equal the writer session", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	assert.throws(() => core.issueReviewInvocation(unit, fx.cwd, "forged-writer"), /writer session is not bound/);
	const review = cleanReview(fx, unit, "COLLISION", { executor: { credential_id: "test-review-executor", context_id: "S1", process_id: process.pid, started_at: Date.now(), signature: "" } });
	review.executor.signature = crypto.sign(null, Buffer.from(core.canonicalJson(core.reviewSignaturePayload(review))), fx.reviewerPrivateKey).toString("base64");
	assert.throws(() => ingestReview(fx, unit, review), /review_context_not_independent/);
});

test("reviewer process cannot equal any writer host process", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	const review = cleanReview(fx, unit, "PROCESS-COLLISION");
	const invocation = core.readJson(path.join(unit.paths.pending, `review-${review.invocation_nonce}.json`));
	assert(invocation.writer_process_ids.includes(process.pid));
	review.executor.process_id = process.pid;
	review.executor.process_identity = invocation.writer_process_identities[0];
	review.isolation.reviewer_process_id = process.pid;
	review.isolation.reviewer_process_identity = review.executor.process_identity;
	review.isolation.review_payload_digest = core.sha256(core.canonicalJson(core.reviewSignaturePayload(review)));
	review.isolation.signature = crypto.sign(null, Buffer.from(core.canonicalJson(core.isolationSignaturePayload(review.isolation))), fx.runnerPrivateKey).toString("base64");
	review.executor.signature = crypto.sign(null, Buffer.from(core.canonicalJson(core.reviewSignaturePayload(review))), fx.reviewerPrivateKey).toString("base64");
	assert.throws(() => ingestReview(fx, unit, review), (error) => error.errors.includes("review_process_not_independent"));
});

test("two current, distinct, exact-coverage Clean reviews allow completion", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	for (const id of ["R1", "R2"]) {
		const review = cleanReview(fx, unit, id);
		ingestReview(fx, unit, review);
	}
	const result = core.evaluateCompletion(unit, fx.cwd, "claude");
	assert.equal(result.kind, "allow");
});

test("completion revalidates the repository after the Clean decision and before success", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	ingestReview(fx, unit, cleanReview(fx, unit, "FINAL-R1"));
	ingestReview(fx, unit, cleanReview(fx, unit, "FINAL-R2"));
	const result = core.evaluateCompletion(unit, fx.cwd, "claude", Date.now(), null, {
		beforeFinalValidation: () => fs.writeFileSync(path.join(fx.cwd, "src", "product.txt"), "mutated during finalization\n"),
	});
	assert.equal(result.kind, "block");
	assert(result.errors.includes("completion_state_changed_during_finalize"));
	assert.notEqual(core.readJson(unit.paths.state).terminal && core.readJson(unit.paths.state).terminal.status, "success");
});

test("review ingestion rejects any source or workspace drift after launch", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	const review = cleanReview(fx, unit, "POST-LAUNCH-DRIFT");
	fs.writeFileSync(path.join(fx.cwd, "src", "product.txt"), "changed after review launch\n");
	assert.throws(() => ingestReview(fx, unit, review), (error) => error.errors.includes("review_post_launch_drift"));
	assert.equal(core.verifyReviewChain(unit.paths).records.length, 0);
});

test("a completed lineage cannot be revised by a later SessionStart", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	ingestReview(fx, unit, cleanReview(fx, unit, "TERMINAL-ONE"));
	ingestReview(fx, unit, cleanReview(fx, unit, "TERMINAL-TWO"));
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "allow");
	const before = fs.readFileSync(unit.paths.head, "utf8");
	const result = core.handleEvent({ client: "claude", clientVersion: "2.2.0", eventName: "SessionStart", sessionId: "S1", cwd: fx.cwd });
	assert.equal(result.code, "request_contract_complete");
	assert.equal(fs.readFileSync(unit.paths.head, "utf8"), before);
	const post = core.handleEvent({ client: "claude", eventName: "PostToolUse", sessionId: "S1", cwd: fx.cwd, toolName: "Bash", toolUseId: "late-tool" });
	assert.equal(post.kind, "block");
	assert.equal(fs.readFileSync(unit.paths.head, "utf8"), before);
});

test("adding a client session advances binding and work revisions and stales prior reviews", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	ingestReview(fx, unit, cleanReview(fx, unit, "BEFORE-SESSION-ONE"));
	ingestReview(fx, unit, cleanReview(fx, unit, "BEFORE-SESSION-TWO"));
	const beforeBinding = core.readJson(unit.paths.binding).binding_epoch;
	const beforeRevision = core.readJson(unit.paths.head).work_revision;
	const result = core.handleEvent({ client: "codex", clientVersion: CLIENT_VERSIONS.codex, eventName: "SessionStart", sessionId: "SECOND-CLIENT", cwd: fx.cwd });
	assert.equal(result.kind, "context");
	assert.equal(core.readJson(unit.paths.binding).binding_epoch, beforeBinding + 1);
	assert.equal(core.readJson(unit.paths.head).work_revision, beforeRevision + 1);
	assert(core.evaluateCompletion(unit, fx.cwd, "codex").errors.includes("review_clean_streak_incomplete"));
});

test("mutation leases prevent completion between PreToolUse and matching PostToolUse", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	ingestReview(fx, unit, cleanReview(fx, unit, "LEASE-ONE"));
	ingestReview(fx, unit, cleanReview(fx, unit, "LEASE-TWO"));
	const pre = core.handleEvent({ client: "claude", eventName: "PreToolUse", sessionId: "S1", cwd: fx.cwd, toolName: "Bash", toolUseId: "tool-lease-1" });
	assert.equal(pre.kind, "allow");
	const stop = core.evaluateCompletion(unit, fx.cwd, "claude");
	assert.equal(stop.code, "request_contract_blocked");
	assert(stop.errors.includes("review_clean_streak_incomplete"));
	assert.equal(core.readJson(unit.paths.state).stop.attempt, 1);
	assert.equal(Object.keys(core.readJson(unit.paths.state).active_mutations).length, 0);
	assert.equal(core.readJson(unit.paths.state).closed_mutations.at(-1).close_reason, "stop_reconciliation");
	const post = core.handleEvent({ client: "claude", eventName: "PostToolUse", sessionId: "S1", cwd: fx.cwd, toolName: "Bash", toolUseId: "tool-lease-1" });
	assert.equal(post.code, "request_contract_mutation_lease_missing");
	assert(!core.readJson(unit.paths.state).terminal);
});

test("only the owning session can close a mutation lease and reviews wait for all leases", () => {
	const fx = fixture();
	const unit = start(fx, "claude", "S1");
	bind(fx, unit);
	assert.equal(core.handleEvent({ client: "codex", clientVersion: CLIENT_VERSIONS.codex, eventName: "SessionStart", sessionId: "S2", cwd: fx.cwd }).kind, "context");
	assert.equal(core.handleEvent({ client: "claude", eventName: "PreToolUse", sessionId: "S1", cwd: fx.cwd, toolName: "Bash", toolUseId: "owned-by-s1" }).kind, "allow");
	assert.throws(() => core.issueReviewInvocation(unit, fx.cwd, "S2"), (error) => error.code === "review_mutation_in_flight");
	const foreignStop = core.handleEvent({ client: "codex", eventName: "Stop", sessionId: "S2", cwd: fx.cwd });
	assert.equal(foreignStop.code, "request_contract_mutation_in_flight");
	assert(core.readJson(unit.paths.state).active_mutations["owned-by-s1"]);
	assert.equal(core.readJson(unit.paths.state).stop, null);
	fs.writeFileSync(path.join(fx.cwd, "src", "product.txt"), "owner completed mutation\n");
	const post = core.handleEvent({ client: "claude", eventName: "PostToolUse", sessionId: "S1", cwd: fx.cwd, toolName: "Bash", toolUseId: "owned-by-s1" });
	assert.equal(post.code, "request_contract_change_captured");
	assert.equal(Object.keys(core.readJson(unit.paths.state).active_mutations).length, 0);
});

test("a canceled mutation lease cannot permanently trap repeated Stops", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	const pre = core.handleEvent({ client: "claude", eventName: "PreToolUse", sessionId: "S1", cwd: fx.cwd, toolName: "Bash", toolUseId: "terminal-lease" });
	assert.equal(pre.kind, "allow");
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "block");
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "block");
	const third = core.evaluateCompletion(unit, fx.cwd, "claude");
	assert.equal(third.kind, "incomplete");
	assert.equal(Object.keys(core.readJson(unit.paths.state).active_mutations).length, 0);
	assert(!third.terminal.error_codes.includes("request_contract_mutation_in_flight"));
	const fourth = core.evaluateCompletion(unit, fx.cwd, "claude");
	assert.equal(fourth.kind, "incomplete");
	assert.equal(fourth.terminal.id, third.terminal.id);
});

test("success is terminal under the shared lifecycle lock", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	for (const id of ["R1", "R2"]) ingestReview(fx, unit, cleanReview(fx, unit, id));
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "allow");
	assert.throws(() => core.appendSource(unit, "late mutation", "directive"), /unit is terminal/);
	assert.throws(() => core.observeOccurrence(unit, { source: "late" }), /unit is terminal/);
	assert.throws(() => core.appendReview(unit, cleanReview(fx, unit, "R3"), { reviewerPublicKey: fx.reviewerPublicKeyPem }), /unit is terminal/);
});

test("duplicate Clean run id cannot form a two-round streak", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	const first = cleanReview(fx, unit, "SAME-ONE");
	ingestReview(fx, unit, first);
	const second = cleanReview(fx, unit, "SAME-TWO");
	second.run_id = first.run_id;
	second.executor.signature = crypto.sign(null, Buffer.from(core.canonicalJson(core.reviewSignaturePayload(second))), fx.reviewerPrivateKey).toString("base64");
	assert.throws(() => ingestReview(fx, unit, second), /review_run_id_(not_issued|replayed)/);
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "block");
});

test("reviewer-controlled text cannot escape through run or finding identifiers", () => {
	const fx = fixture();
	const unit = start(fx, "claude", "S1", "PRIVATEPROMPTMUSTNOTLEAK");
	bind(fx, unit);
	const runLeak = cleanReview(fx, unit, "RUN-LEAK");
	runLeak.run_id = "RUN-PRIVATEPROMPTMUSTNOTLEAK";
	runLeak.executor.signature = crypto.sign(null, Buffer.from(core.canonicalJson(core.reviewSignaturePayload(runLeak))), fx.reviewerPrivateKey).toString("base64");
	assert.throws(() => ingestReview(fx, unit, runLeak), /review_run_id_invalid/);
	const findingLeak = cleanReview(fx, unit, "FINDING-LEAK");
	findingLeak.finding_codes = ["FINDING-PRIVATEPROMPTMUSTNOTLEAK"];
	findingLeak.executor.signature = crypto.sign(null, Buffer.from(core.canonicalJson(core.reviewSignaturePayload(findingLeak))), fx.reviewerPrivateKey).toString("base64");
	assert.throws(() => ingestReview(fx, unit, findingLeak), /review_finding_codes_invalid/);
});

test("review verdict and closed finding codes must agree", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	for (const [label, mutate] of [
		["CLEAN-WITH-FINDING", (review) => { review.finding_codes = ["FINDING-OTHER"]; }],
		["DIRTY-WITHOUT-FINDING", (review) => { review.verdict = "DIRTY"; review.finding_codes = []; }],
		["MISSING-FINDINGS", (review) => { delete review.finding_codes; }],
	]) {
		const review = cleanReview(fx, unit, label);
		mutate(review);
		review.executor.signature = crypto.sign(null, Buffer.from(core.canonicalJson(core.reviewSignaturePayload(review))), fx.reviewerPrivateKey).toString("base64");
		assert.throws(() => ingestReview(fx, unit, review), /review_(verdict_findings_mismatch|finding_codes_invalid)/);
	}
});

test("two Clean receipts cannot reuse one isolated execution", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	const first = cleanReview(fx, unit, "R1");
	ingestReview(fx, unit, first);
	const second = cleanReview(fx, unit, "R2");
	second.isolation.execution_id = first.isolation.execution_id;
	second.isolation.signature = crypto.sign(null, Buffer.from(core.canonicalJson(core.isolationSignaturePayload(second.isolation))), fx.runnerPrivateKey).toString("base64");
	second.executor.signature = crypto.sign(null, Buffer.from(core.canonicalJson(core.reviewSignaturePayload(second))), fx.reviewerPrivateKey).toString("base64");
	assert.throws(() => ingestReview(fx, unit, second), /review_execution_id_replayed/);
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "block");
});

test("two Clean rounds require distinct reviewer contexts and process identities", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	const first = cleanReview(fx, unit, "CONTEXT-ONE");
	ingestReview(fx, unit, first);
	for (const reuse of ["context", "process"]) {
		const second = cleanReview(fx, unit, `CONTEXT-${reuse}`);
		if (reuse === "context") second.executor.context_id = first.executor.context_id;
		else {
			second.executor.process_id = first.executor.process_id;
			second.executor.process_identity = first.executor.process_identity;
			second.executor.started_at = first.executor.started_at;
		}
		second.isolation.reviewer_context_id = second.executor.context_id;
		second.isolation.reviewer_process_id = second.executor.process_id;
		second.isolation.reviewer_process_identity = second.executor.process_identity;
		second.isolation.signature = crypto.sign(null, Buffer.from(core.canonicalJson(core.isolationSignaturePayload(second.isolation))), fx.runnerPrivateKey).toString("base64");
		second.executor.signature = crypto.sign(null, Buffer.from(core.canonicalJson(core.reviewSignaturePayload(second))), fx.reviewerPrivateKey).toString("base64");
		assert.throws(() => ingestReview(fx, unit, second), reuse === "context" ? /review_context_replayed/ : /review_process_replayed/);
	}
});

test("extra stale coverage ids invalidate a Clean streak", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	for (const id of ["R1", "R2"]) {
		const review = cleanReview(fx, unit, id);
		review.covered_source_ids.push("SRC-STALE");
		review.executor.signature = crypto.sign(null, Buffer.from(core.canonicalJson(core.reviewSignaturePayload(review))), fx.reviewerPrivateKey).toString("base64");
		assert.throws(() => ingestReview(fx, unit, review), /covered_source_ids_not_exact/);
	}
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "block");
});

test("ordinary pending to done progress is autonomous and every prior scope version needs exact review coverage", () => {
	const fx = fixture();
	const unit = start(fx);
	const active = makeContract(fx, unit);
	active.status = "active";
	active.directives[0].state = "pending";
	bind(fx, unit, active);
	const completed = JSON.parse(JSON.stringify(active));
	completed.status = "complete";
	completed.directives[0].state = "done";
	assert.doesNotThrow(() => bind(fx, unit, completed));
	assert.equal(core.readJson(unit.paths.head).scope_epoch, 0);
	assert.equal(core.verifyScopeHistory(unit).records.length, 2);
	const omitted = cleanReview(fx, unit, "HISTORY-OMITTED");
	omitted.covered_scope_version_ids.pop();
	omitted.covered_scope_version_mappings.pop();
	omitted.executor.signature = crypto.sign(null, Buffer.from(core.canonicalJson(core.reviewSignaturePayload(omitted))), fx.reviewerPrivateKey).toString("base64");
	assert.throws(() => ingestReview(fx, unit, omitted), /covered_scope_version/);
	ingestReview(fx, unit, cleanReview(fx, unit, "HISTORY-ONE"));
	ingestReview(fx, unit, cleanReview(fx, unit, "HISTORY-TWO"));
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "allow");
});

test("historical coverage commits exact opaque atom, artifact, and trace-edge mappings", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	for (const [label, mutate] of [
		["ATOM", (contract) => { contract.sources[0].obligation_atom_ids[0] = "OBL-forged"; }],
		["ARTIFACT", (contract) => { contract.artifacts[0].subject_id = "REQ-forged"; }],
		["EDGE", (contract) => { contract.edges[0].to = contract.edges[1].to; }],
	]) {
		const review = cleanReview(fx, unit, `HISTORICAL-${label}`);
		const mapping = JSON.parse(review.covered_scope_version_mappings[0]);
		mutate(mapping.contract);
		review.covered_scope_version_mappings[0] = core.canonicalJson(mapping);
		review.isolation.review_payload_digest = core.sha256(core.canonicalJson(core.reviewSignaturePayload(review)));
		review.isolation.signature = crypto.sign(null, Buffer.from(core.canonicalJson(core.isolationSignaturePayload(review.isolation))), fx.runnerPrivateKey).toString("base64");
		review.executor.signature = crypto.sign(null, Buffer.from(core.canonicalJson(core.reviewSignaturePayload(review))), fx.reviewerPrivateKey).toString("base64");
		assert.throws(() => ingestReview(fx, unit, review), /covered_scope_version_mappings_not_exact/);
	}
});

test("Clean coverage binds exact authority and change mappings, not ids alone", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	const forged = cleanReview(fx, unit, "FORGED-MAPPING", { covered_authority_mappings: [core.canonicalJson({ authority_id: "AUTH-001", operation: "abandon", source_id: "SRC-forged", target_directive_ids: ["REQ-001"], affected_prior_ids: [], replacement_ids: ["REQ-001"], tombstone_ids: [] })] });
	assert.throws(() => ingestReview(fx, unit, forged), /covered_authority_mappings_not_exact/);
	ingestReview(fx, unit, cleanReview(fx, unit, "VALID-MAPPING"));
	assert(core.evaluateCompletion(unit, fx.cwd, "claude").errors.includes("review_clean_streak_incomplete"));
});

test("completion revalidates compaction-persistent review claims", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	const first = cleanReview(fx, unit, "CLAIM-ONE");
	ingestReview(fx, unit, first);
	ingestReview(fx, unit, cleanReview(fx, unit, "CLAIM-TWO"));
	fs.unlinkSync(path.join(core.harnessRoot(fx.cwd), "claims", "review-run", `${core.sha256(first.run_id)}.json`));
	assert(core.evaluateCompletion(unit, fx.cwd, "claude").errors.includes("review_clean_streak_incomplete"));
});

test("new prompt invalidates prior contract and review evidence", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	for (const id of ["R1", "R2"]) {
		const review = cleanReview(fx, unit, id);
		ingestReview(fx, unit, review);
	}
	core.handleEvent({ client: "claude", eventName: "UserPromptSubmit", sessionId: "S1", cwd: fx.cwd, prompt: "one more required feature", origin: "native_user" });
	const result = core.evaluateCompletion(unit, fx.cwd, "claude");
	assert.equal(result.kind, "block");
	assert(result.errors.some((e) => e.startsWith("contract_source_uncovered:")));
});

test("product-root configuration drift invalidates completion", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	for (const id of ["R1", "R2"]) {
		const review = cleanReview(fx, unit, id);
		ingestReview(fx, unit, review);
	}
	const configFile = path.join(fx.cwd, ".agents", "context", "request-contract.json");
	const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
	config.product_roots.push("docs");
	fs.writeFileSync(configFile, JSON.stringify(config));
	const result = core.evaluateCompletion(unit, fx.cwd, "claude");
	assert.equal(result.kind, "block");
	assert(result.errors.includes("product_root_config_drift"));
});

test("whole-repository scope captures changes under skills and docs", () => {
	const fx = fixture();
	const configFile = path.join(fx.cwd, ".agents", "context", "request-contract.json");
	const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
	config.product_roots = ["."];
	config.exclusions.push("node_modules");
	fs.writeFileSync(configFile, JSON.stringify(config));
	const unit = start(fx);
	fs.mkdirSync(path.join(fx.cwd, "skills"), { recursive: true });
	fs.writeFileSync(path.join(fx.cwd, "skills", "new-skill.md"), "new governed content\n");
	fs.mkdirSync(path.join(fx.cwd, "packages", "demo", "node_modules", "ignored"), { recursive: true });
	fs.writeFileSync(path.join(fx.cwd, "packages", "demo", "node_modules", "ignored", "index.js"), "ignored\n");
	const captured = core.captureWorkspaceOccurrences(unit, fx.cwd);
	assert(captured.occurrences.some((occurrence) => occurrence.detail.path === "skills/new-skill.md"));
	assert(!captured.occurrences.some((occurrence) => occurrence.detail.path.includes("node_modules")));
});

test("workspace manifests fail closed on unreadable directories and unsupported file types", () => {
	const fx = fixture();
	const unreadable = path.join(fx.cwd, "src", "unreadable");
	fs.mkdirSync(unreadable);
	fs.writeFileSync(path.join(unreadable, "hidden.txt"), "must not disappear from the manifest\n");
	withDeniedReaddir(unreadable, () => assert.throws(() => core.workspaceManifest(fx.cwd), (error) => error.code === "workspace_manifest_unreadable"));
	if (process.platform === "win32") {
		const unsupported = path.join(fx.cwd, "src", "unsupported.entry");
		fs.writeFileSync(unsupported, "simulated unsupported type\n");
		const original = fs.lstatSync;
		fs.lstatSync = function unsupportedLstat(candidate, ...args) {
			if (path.resolve(candidate) === path.resolve(unsupported)) return { isSymbolicLink: () => false, isFile: () => false, isDirectory: () => false };
			return original.call(fs, candidate, ...args);
		};
		try {
			assert.throws(() => core.workspaceManifest(fx.cwd), (error) => error.code === "workspace_manifest_unsupported_type");
		} finally {
			fs.lstatSync = original;
		}
	} else {
		const fifo = path.join(fx.cwd, "src", "unsupported.fifo");
		cp.execFileSync("mkfifo", [fifo]);
		assert.throws(() => core.workspaceManifest(fx.cwd), (error) => error.code === "workspace_manifest_unsupported_type");
	}
});

test("POSIX backslashes remain distinct workspace path bytes", () => {
	if (process.platform === "win32") return;
	const fx = fixture();
	fs.mkdirSync(path.join(fx.cwd, "collision"), { recursive: true });
	fs.writeFileSync(path.join(fx.cwd, "collision", "path.txt"), "slash\n");
	fs.writeFileSync(path.join(fx.cwd, "collision\\path.txt"), "backslash\n");
	const first = core.workspaceManifest(fx.cwd).manifest;
	assert(first.files["collision/path.txt"]);
	assert(first.files["collision\\path.txt"]);
	assert.notEqual(first.files["collision/path.txt"].digest, first.files["collision\\path.txt"].digest);
	fs.writeFileSync(path.join(fx.cwd, "collision\\path.txt"), "changed backslash\n");
	const second = core.workspaceManifest(fx.cwd);
	assert.notEqual(second.digest, core.sha256(core.canonicalJson(first)));
});

test("malformed numeric lifecycle settings fail closed", () => {
	for (const [pathParts, value, code] of [
		[["stop_attempt_limit"], "invalid", "stop_attempt_limit_invalid"],
		[["minimum_clean_rounds"], 1.5, "minimum_clean_rounds_invalid"],
		[["retention", "success_hours"], 0, "retention_success_hours_invalid"],
	]) {
		const fx = fixture();
		const file = path.join(fx.cwd, ".agents", "context", "request-contract.json");
		const config = JSON.parse(fs.readFileSync(file, "utf8"));
		let target = config;
		for (const part of pathParts.slice(0, -1)) target = target[part];
		target[pathParts.at(-1)] = value;
		fs.writeFileSync(file, JSON.stringify(config));
		assert(core.loadConfig(fx.cwd).errors.includes(code));
		assert.throws(() => core.workspaceManifest(fx.cwd), (error) => error.code === "request_contract_config_invalid");
	}
});

test("unreadable unit and quarantine storage can never disengage sticky governance", () => {
	let fx = fixture();
	start(fx);
	const units = path.join(core.harnessRoot(fx.cwd), "units");
	withDeniedReaddir(units, () => {
		assert.throws(() => core.hasStickyGovernanceState(fx.cwd), (error) => error.code === "unit_storage_unreadable");
		const processed = adapter.processEnvelope("claude", { hook_event_name: "UserPromptSubmit", session_id: "S1", cwd: fx.cwd, prompt: "preserve during unreadable unit storage" });
		assert.equal(processed.output.decision, "block");
	});
	const preserved = core.listUnconsumedQuarantine(fx.cwd);
	assert.equal(core.readJsonl(path.join(preserved[0].dir, "sources.jsonl"))[0].prompt, "preserve during unreadable unit storage");
	fx = fixture();
	core.handleEvent({ client: "claude", eventName: "UserPromptSubmit", sessionId: "Q", cwd: fx.cwd, prompt: "preserve me", origin: "native_user" });
	const quarantine = path.join(core.harnessRoot(fx.cwd), "quarantine");
	withDeniedReaddir(quarantine, () => assert.throws(() => core.hasStickyGovernanceState(fx.cwd), (error) => error.code === "quarantine_storage_unreadable"));
});

test("Git index and object failures abort manifests instead of hashing empty output", () => {
	const fx = fixture();
	const index = path.join(fx.cwd, ".git", "index");
	const savedIndex = fs.readFileSync(index);
	fs.writeFileSync(index, "corrupt index\n");
	try {
		assert.throws(() => core.workspaceManifest(fx.cwd), (error) => error.code === "workspace_manifest_git_error");
	} finally {
		fs.writeFileSync(index, savedIndex);
	}
	const oid = cp.execFileSync("git", ["rev-parse", "HEAD:src/product.txt"], { cwd: fx.cwd, encoding: "utf8" }).trim();
	const object = path.join(fx.cwd, ".git", "objects", oid.slice(0, 2), oid.slice(2));
	const hidden = `${object}.missing`;
	fs.renameSync(object, hidden);
	try {
		assert.throws(() => core.referenceManifest(fx.cwd), (error) => error.code === "workspace_manifest_git_error");
	} finally {
		fs.renameSync(hidden, object);
	}
});

test("atomic writes fsync content before rename and parent metadata after rename or unlink", () => {
	const fx = fixture();
	const dir = path.join(fx.cwd, "durability");
	fs.mkdirSync(dir);
	const target = path.join(dir, "state.json");
	const events = [];
	const fdPaths = new Map();
	const original = { openSync: fs.openSync, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync, unlinkSync: fs.unlinkSync, closeSync: fs.closeSync };
	fs.openSync = function(file, ...args) {
		const fd = original.openSync.call(fs, file, ...args);
		fdPaths.set(fd, String(file));
		return fd;
	};
	fs.fsyncSync = function(fd) {
		events.push({ kind: "fsync", file: fdPaths.get(fd) });
		return original.fsyncSync.call(fs, fd);
	};
	fs.renameSync = function(from, to) {
		events.push({ kind: "rename", from: String(from), to: String(to) });
		return original.renameSync.call(fs, from, to);
	};
	fs.unlinkSync = function(file) {
		events.push({ kind: "unlink", file: String(file) });
		return original.unlinkSync.call(fs, file);
	};
	fs.closeSync = function(fd) {
		try { return original.closeSync.call(fs, fd); } finally { fdPaths.delete(fd); }
	};
	try {
		core.secureWrite(target, "durable\n");
		core.durableUnlink(target);
	} finally {
		Object.assign(fs, original);
	}
	const rename = events.findIndex((event) => event.kind === "rename" && event.to === target);
	assert(rename > 0);
	assert(events.slice(0, rename).some((event) => event.kind === "fsync" && event.file && event.file.endsWith(".tmp")));
	assert(events.slice(rename + 1).some((event) => event.kind === "fsync" && event.file === dir));
	const unlink = events.findIndex((event) => event.kind === "unlink" && event.file === target);
	assert(unlink > rename);
	assert(events.slice(unlink + 1).some((event) => event.kind === "fsync" && event.file === dir));
});

test("dirty tracked content inside a gitlink is captured", () => {
	const fx = fixture();
	const configFile = path.join(fx.cwd, ".agents", "context", "request-contract.json");
	const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
	config.product_roots = ["."];
	fs.writeFileSync(configFile, JSON.stringify(config));
	const sub = path.join(fx.cwd, "vendor", "child");
	fs.mkdirSync(sub, { recursive: true });
	cp.execFileSync("git", ["init", "-q"], { cwd: sub });
	fs.writeFileSync(path.join(sub, "tracked.txt"), "clean\n");
	cp.execFileSync("git", ["add", "tracked.txt"], { cwd: sub });
	cp.execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"], { cwd: sub });
	const commit = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: sub, encoding: "utf8" }).trim();
	cp.execFileSync("git", ["update-index", "--add", "--cacheinfo", `160000,${commit},vendor/child`], { cwd: fx.cwd });
	const unit = start(fx);
	fs.writeFileSync(path.join(sub, "tracked.txt"), "dirty\n");
	const captured = core.captureWorkspaceOccurrences(unit, fx.cwd);
	assert(captured.occurrences.some((occurrence) => occurrence.detail.path === "vendor/child" && occurrence.detail.after.dirty === true));
	const priorCount = captured.occurrences.length;
	fs.writeFileSync(path.join(sub, "tracked.txt"), "different dirty bytes\n");
	const recaptured = core.captureWorkspaceOccurrences(unit, fx.cwd);
	assert.equal(recaptured.occurrences.length, priorCount + 1);
	assert.notEqual(recaptured.occurrences.at(-1).detail.before.dirty_digest, recaptured.occurrences.at(-1).detail.after.dirty_digest);
});

test("third unchanged failed Stop writes an honest incomplete terminal", () => {
	const fx = fixture();
	const unit = start(fx);
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "block");
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "block");
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "incomplete");
	assert.equal(core.readJson(unit.paths.state).terminal.status, "incomplete");
});

test("a changed failure fingerprint starts a fresh consecutive Stop episode", () => {
	const fx = fixture();
	const unit = start(fx);
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "block");
	const firstEpisode = core.readJson(unit.paths.state).stop.episode_id;
	bind(fx, unit);
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "block");
	const secondStop = core.readJson(unit.paths.state).stop;
	assert.equal(secondStop.attempt, 1);
	assert.notEqual(secondStop.episode_id, firstEpisode);
	core.handleEvent({ client: "claude", eventName: "UserPromptSubmit", sessionId: "S1", cwd: fx.cwd, prompt: "new required scope", origin: "native_user" });
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "block");
	const thirdStop = core.readJson(unit.paths.state).stop;
	assert.equal(thirdStop.attempt, 1);
	assert.notEqual(thirdStop.episode_id, secondStop.episode_id);
	assert.equal(core.readJson(unit.paths.state).terminal, undefined);
});

test("incomplete lineage requires a fresh signed resume and rejects replay", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	for (let i = 0; i < 3; i++) core.evaluateCompletion(unit, fx.cwd, "claude");
	assert.equal(core.handleEvent({ client: "codex", clientVersion: CLIENT_VERSIONS.codex, eventName: "SessionStart", sessionId: "S2", cwd: fx.cwd }).code, "incomplete_lineage_requires_resume");
	const head = core.readJson(unit.paths.head);
	const binding = core.readJson(unit.paths.binding);
	const scope = core.sha256(core.canonicalJson(core.scopeProjection(core.readJson(unit.paths.contract))));
	const authority = { operation: "resume", target_directive_ids: [] };
	const presentation = core.authorityPresentation(authority, scope, scope, head.scope_epoch + 1, binding.binding_epoch + 1);
	const challenge = core.issueAuthorityChallenge(unit, fx.cwd, presentation);
	const receipt = signedReceipt(fx, {
		operation: "resume",
		prior_scope_digest: scope,
		resulting_scope_digest: scope,
		resulting_scope_epoch: head.scope_epoch + 1,
		binding_epoch: binding.binding_epoch + 1,
		challenge: challenge.challenge,
		presentation_digest: challenge.presentation_digest,
		target_directive_ids: [],
		sign_count: 2,
	});
	core.resumeIncomplete(unit, receipt, fx.cwd);
	assert.equal(core.handleEvent({ client: "codex", clientVersion: CLIENT_VERSIONS.codex, eventName: "SessionStart", sessionId: "S2", cwd: fx.cwd }).kind, "context");
	for (let i = 0; i < 3; i++) core.evaluateCompletion(unit, fx.cwd, "claude");
	assert.throws(() => core.resumeIncomplete(unit, receipt, fx.cwd), /authority_/);
});

test("adapter parity is policy-equivalent for Claude Code and Codex", () => {
	const results = [];
	for (const client of ["claude", "codex"]) {
		const fx = fixture();
		const input = nativeEnvelope(client, fx, "UserPromptSubmit", "P", { prompt: "same" });
		const processed = adapter.processEnvelope(client, input);
		results.push({ result: core.canonicalParityProjection(processed.result), quarantine: core.canonicalParityProjection(core.readJsonl(path.join(core.listUnconsumedQuarantine(fx.cwd)[0].dir, "sources.jsonl"))) });
	}
	assert.deepEqual(results[0], results[1]);
});

test("client-native capability maps reject undeclared aliases and map native outputs explicitly", () => {
	assert.notStrictEqual(adapter.CLIENT_NATIVE_CAPABILITIES.claude, adapter.CLIENT_NATIVE_CAPABILITIES.codex);
	for (const client of ["claude", "codex"]) {
		const fx = fixture();
		const prompt = adapter.processEnvelope(client, nativeEnvelope(client, fx, "UserPromptSubmit", "NATIVE", { prompt: "native exact prompt" }), "UserPromptSubmit", { env: { REQUEST_CONTRACT: "on" } });
		assert.equal(prompt.event.prompt, "native exact prompt");
		assert.equal(prompt.event.origin, "native_user");
		assert.equal(prompt.output.decision, "block");
		const callerSpoof = adapter.normalizeInput(client, nativeEnvelope(client, fx, "PostToolUse", "NATIVE", { origin: "native_user", tool_name: "Read", tool_use_id: "spoof" }), "PostToolUse");
		assert.equal(callerSpoof.origin, "ambiguous");
		const context = adapter.formatOutput(client, "SessionStart", { kind: "context", code: "CTX", message: "mapped" });
		assert.deepEqual(context, { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "[request-contract:CTX] mapped" } });
		const block = adapter.formatOutput(client, "PreToolUse", { kind: "block", code: "DENY", message: "mapped" });
		assert.deepEqual(block, { decision: "block", reason: "[request-contract:DENY] mapped" });
		const aliasOnly = nativeEnvelope(client, fx, "UserPromptSubmit", "NATIVE");
		aliasOnly.user_prompt = "unsupported alias";
		const rejected = adapter.processEnvelope(client, aliasOnly, "UserPromptSubmit", { env: { REQUEST_CONTRACT: "on" } });
		assert.equal(rejected.result.code, "native_prompt_missing");
	}
	assert.deepEqual(
		adapter.formatOutput("codex", "PreCompact", { kind: "block", code: "DENY", message: "mapped" }),
		{ continue: false, stopReason: "[request-contract:DENY] mapped" },
	);
	assert.deepEqual(
		adapter.formatOutput("codex", "PostCompact", { kind: "context", code: "CTX", message: "mapped" }),
		{ systemMessage: "[request-contract:CTX] mapped" },
	);
	assert.deepEqual(
		adapter.formatOutput("codex", "SessionStart", { kind: "block", code: "DENY", message: "mapped" }),
		{ continue: false, stopReason: "[request-contract:DENY] mapped" },
	);
	assert.deepEqual(
		adapter.failureOutput("codex", "PreCompact", { code: "adapter_failure" }),
		{ continue: false, stopReason: "[request-contract:adapter_failure] Governed request-contract evaluation failed closed during PreCompact." },
	);
	assert.equal(adapter.formatOutput("codex", "Stop", { kind: "allow", code: "DONE", message: "complete" }), null);
});

test("scope authority rejects a source without native user-event provenance", () => {
	const fx = fixture();
	const unit = start(fx);
	const contract = makeContract(fx, unit);
	const records = core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records.map((record) => ({ ...record }));
	records[0].origin = "user";
	const result = core.validateContract(contract, records, core.readJson(unit.paths.state).occurrences, { publicKeyPem: fx.publicKeyPem, cwd: fx.cwd });
	assert(result.errors.includes("contract_authority_source_origin_invalid:AUTH-001"));
});

test("registered lifecycle event cannot be reclassified by the native envelope", () => {
	const fx = fixture();
	const input = { hook_event_name: "PostToolUse", session_id: "S1", cwd: fx.cwd, tool_name: "Read", prompt: "must be captured" };
	for (const client of ["claude", "codex"]) {
		const result = adapter.processEnvelope(client, input, "UserPromptSubmit");
		assert.equal(result.output.decision, "block");
		assert(result.output.reason.includes("native_event_mismatch"));
	}
	const captured = core.listUnconsumedQuarantine(fx.cwd).flatMap((item) => core.readJsonl(path.join(item.dir, "sources.jsonl"))).map((record) => record.prompt);
	assert.deepEqual(captured, ["must be captured", "must be captured"]);
});

test("native Claude Code and Codex processes discover the same nested project root", () => {
	const fx = fixture();
	const nested = path.join(fx.cwd, "src", "nested");
	fs.mkdirSync(nested, { recursive: true });
	for (const [client, sessionId] of [["claude", "NATIVE-C"], ["codex", "NATIVE-X"]]) {
		const output = runNativeAdapter(client, fx, { hook_event_name: "SessionStart", session_id: sessionId, cwd: nested }, "SessionStart");
		assert(output.hookSpecificOutput.additionalContext.includes("request_contract_genesis"));
	}
	const claudeUnit = core.findUnit(fx.cwd, "claude", "NATIVE-C");
	const codexUnit = core.findUnit(fx.cwd, "codex", "NATIVE-X");
	assert.equal(claudeUnit.id, codexUnit.id);
	for (const binding of claudeUnit.head.session_bindings) {
		assert(binding.host_process_ids.includes(process.pid));
		assert(binding.host_process_identities.includes(core.processIdentity(process.pid)));
	}
	for (const [client, sessionId] of [["claude", "NATIVE-C"], ["codex", "NATIVE-X"]]) {
		const output = runNativeAdapter(client, fx, { hook_event_name: "Stop", session_id: sessionId, cwd: nested }, "Stop");
		assert.equal(output.decision, "block");
	}
});

test("malformed native stdin fails closed for both clients when governed", () => {
	for (const client of ["claude", "codex"]) {
		const fx = fixture();
		const output = runNativeAdapter(client, fx, "{not-json", "Stop");
		assert.equal(output.decision, "block");
		assert(output.reason.includes("native_envelope_parse_error"));
	}
});

test("native PreCompact blocks incomplete work before compaction for both clients", () => {
	for (const client of ["claude", "codex"]) {
		const fx = fixture();
		const sessionId = `PRECOMPACT-${client}`;
		runNativeAdapter(client, fx, nativeEnvelope(client, fx, "SessionStart", sessionId), "SessionStart");
		runNativeAdapter(client, fx, nativeEnvelope(client, fx, "UserPromptSubmit", sessionId, { prompt: "Implement the complete requested feature" }), "UserPromptSubmit");
		const pre = runNativeAdapter(client, fx, nativeEnvelope(client, fx, "PreCompact", sessionId), "PreCompact");
		if (client === "codex") {
			assert.equal(pre.continue, false);
			assert(pre.stopReason.includes("request_contract_blocked"));
		} else {
			assert.equal(pre.decision, "block");
			assert(pre.reason.includes("request_contract_blocked"));
		}
		const unit = core.findUnit(fx.cwd, client, sessionId);
		assert.equal(core.readJson(unit.paths.state).stop, undefined);
		assert.equal(core.readJson(unit.paths.state).terminal, undefined);
		const post = runNativeAdapter(client, fx, nativeEnvelope(client, fx, "PostCompact", sessionId), "PostCompact");
		if (client === "codex") {
			assert.equal(post.continue, false);
			assert(post.stopReason.includes("request_contract_postcompact_without_proof"));
		} else {
			assert.equal(post.decision, "block");
			assert(post.reason.includes("request_contract_postcompact_without_proof"));
		}
	}
});

test("PreCompact failures never consume Stop attempts", () => {
	const fx = fixture();
	const unit = start(fx);
	for (let attempt = 0; attempt < 3; attempt++) {
		const result = core.handleEvent({ client: "claude", eventName: "PreCompact", sessionId: "S1", cwd: fx.cwd });
		assert.equal(result.kind, "block");
	}
	let state = core.readJson(unit.paths.state);
	assert.equal(state.stop, undefined);
	assert.equal(state.terminal, undefined);
	assert.equal(core.handleEvent({ client: "claude", eventName: "Stop", sessionId: "S1", cwd: fx.cwd }).kind, "block");
	state = core.readJson(unit.paths.state);
	assert.equal(state.stop.attempt, 1);
	assert.equal(state.terminal, undefined);
});

test("PostCompact requires and consumes one matching PreCompact authorization", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	for (const id of ["COMPACT-R1", "COMPACT-R2"]) ingestReview(fx, unit, cleanReview(fx, unit, id));
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude", Date.now(), "S1").kind, "allow");
	let result = core.handleEvent({ client: "claude", eventName: "PostCompact", sessionId: "S1", cwd: fx.cwd });
	assert.equal(result.code, "request_contract_postcompact_without_proof");
	result = core.handleEvent({ client: "claude", eventName: "PreCompact", sessionId: "S1", cwd: fx.cwd });
	assert.equal(result.code, "request_contract_compaction_ready");
	const authorization = core.readJson(unit.paths.state).compaction_authorization;
	assert.equal(authorization.client, "claude");
	assert.equal(authorization.session_id, "S1");
	assert.equal(authorization.consumed_at, null);
	result = core.handleEvent({ client: "claude", eventName: "PostCompact", sessionId: "S1", cwd: fx.cwd });
	assert.equal(result.code, "request_contract_resume");
	assert(Number.isInteger(core.readJson(unit.paths.state).compaction_authorization.consumed_at));
	result = core.handleEvent({ client: "claude", eventName: "PostCompact", sessionId: "S1", cwd: fx.cwd });
	assert.equal(result.code, "request_contract_postcompact_without_proof");
});

test("successful native Codex Stop intentionally emits empty stdout", () => {
	const fx = fixture();
	const sessionId = "CODEX-EMPTY-SUCCESS";
	const unit = start(fx, "codex", sessionId);
	bind(fx, unit);
	for (const id of ["CODEX-R1", "CODEX-R2"]) ingestReview(fx, unit, cleanReview(fx, unit, id));
	assert.equal(runNativeAdapter("codex", fx, nativeEnvelope("codex", fx, "Stop", sessionId), "Stop"), null);
});

test("native PreCompact creates or revalidates a current completion proof", () => {
	const fx = fixture();
	const sessionId = "PRECOMPACT-COMPLETE";
	const unit = start(fx, "claude", sessionId);
	bind(fx, unit);
	for (const id of ["PRECOMPACT-R1", "PRECOMPACT-R2"]) ingestReview(fx, unit, cleanReview(fx, unit, id));
	let result = adapter.processEnvelope("claude", nativeEnvelope("claude", fx, "PreCompact", sessionId), "PreCompact");
	assert.equal(result.output, null);
	assert.equal(core.readJson(unit.paths.state).terminal.status, "success");
	result = adapter.processEnvelope("claude", nativeEnvelope("claude", fx, "PostCompact", sessionId), "PostCompact");
	assert(result.output.hookSpecificOutput.additionalContext.includes("request_contract_resume"));
	result = adapter.processEnvelope("claude", nativeEnvelope("claude", fx, "PostCompact", sessionId), "PostCompact");
	assert.equal(result.output.decision, "block");
	assert(result.output.reason.includes("request_contract_postcompact_without_proof"));
	fs.writeFileSync(path.join(fx.cwd, "src", "product.txt"), "out-of-band mutation after success\n");
	result = adapter.processEnvelope("claude", nativeEnvelope("claude", fx, "Stop", sessionId), "Stop");
	assert.equal(result.output.decision, "block");
	assert(result.output.reason.includes("request_contract_completion_proof_invalid"));
	result = adapter.processEnvelope("claude", nativeEnvelope("claude", fx, "SessionStart", sessionId), "SessionStart");
	assert.equal(result.output.decision, "block");
	assert(result.output.reason.includes("request_contract_completion_proof_invalid"));
	result = adapter.processEnvelope("claude", nativeEnvelope("claude", fx, "PreCompact", sessionId), "PreCompact");
	assert.equal(result.output.decision, "block");
	assert(result.output.reason.includes("request_contract_completion_proof_invalid"));
});

test("argv fallback cannot replace a missing native event field for either client", () => {
	for (const client of ["claude", "codex"]) {
		const fx = fixture();
		const output = runNativeAdapter(client, fx, { session_id: `MISSING-${client}`, cwd: fx.cwd }, "Stop");
		assert.equal(output.decision, "block");
		assert(output.reason.includes("native_event_missing"));
	}
});

test("both client registries cover all governed lifecycle events", () => {
	const root = path.resolve(__dirname, "..", "..", "..");
	const claude = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"));
	const codex = JSON.parse(fs.readFileSync(path.join(root, ".codex", "hooks.json"), "utf8"));
	for (const event of ["PreToolUse", "SessionStart", "UserPromptSubmit", "PostToolUse", "PreCompact", "PostCompact", "Stop"]) {
		for (const registry of [claude, codex]) {
			assert(registry.hooks[event]);
			const hooks = registry.hooks[event].flatMap((entry) => entry.hooks).filter((hook) => hook.command.includes("request-contract") || (hook.args || []).some((arg) => arg.includes("request-contract")));
			assert.equal(hooks.length, 1);
			const registeredEvent = Array.isArray(hooks[0].args) ? hooks[0].args.at(-1) : hooks[0].command.split(/\s+/).at(-1);
			assert.equal(registeredEvent, event);
			if (Array.isArray(hooks[0].args)) assert(hooks[0].args[0].includes("$" + "{CLAUDE_PROJECT_DIR}"));
			else assert(hooks[0].command.includes("git rev-parse --show-toplevel"));
		}
	}
});

test("governed adapter fails closed when source state is corrupted", () => {
	const fx = fixture();
	const unit = start(fx);
	fs.writeFileSync(unit.paths.head, "not json");
	const result = adapter.processEnvelope("claude", { hook_event_name: "UserPromptSubmit", session_id: "S1", cwd: fx.cwd, prompt: "still capture" });
	assert.equal(result.output.decision, "block");
});

test("a corrupt unresolved head blocks every new session lineage", () => {
	const fx = fixture();
	const unit = start(fx, "claude", "OLD", "original scope");
	fs.writeFileSync(unit.paths.head, "not json");
	const result = core.handleEvent({ client: "codex", clientVersion: CLIENT_VERSIONS.codex, eventName: "SessionStart", sessionId: "NEW", cwd: fx.cwd });
	assert.equal(result.code, "corrupt_unresolved_unit");
	assert.equal(core.listUnits(fx.cwd).length, 1);
});

test("corrupt unit state fails closed without losing the submitted prompt", () => {
	const fx = fixture();
	const unit = start(fx);
	const originalState = fs.readFileSync(unit.paths.state, "utf8");
	fs.writeFileSync(unit.paths.state, "not json");
	const result = adapter.processEnvelope("claude", { hook_event_name: "UserPromptSubmit", session_id: "S1", cwd: fx.cwd, prompt: "preserve during corruption" });
	assert.equal(result.output.decision, "block");
	const quarantine = core.listUnconsumedQuarantine(fx.cwd);
	assert.equal(core.readJsonl(path.join(quarantine[0].dir, "sources.jsonl"))[0].prompt, "preserve during corruption");
	fs.writeFileSync(unit.paths.state, originalState);
	assert.equal(core.handleEvent({ client: "claude", clientVersion: CLIENT_VERSIONS.claude, eventName: "SessionStart", sessionId: "S1", cwd: fx.cwd }).kind, "context");
	const prompts = core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records.map((record) => record.prompt);
	assert(prompts.includes("preserve during corruption"));
});

test("single-file lifecycle rewrites cannot erase occurrences or reset Stop attempts", () => {
	const fx = fixture();
	const unit = start(fx);
	fs.writeFileSync(path.join(fx.cwd, "src", "product.txt"), "captured before tamper\n");
	core.captureWorkspaceOccurrences(unit, fx.cwd);
	bind(fx, unit);
	core.evaluateCompletion(unit, fx.cwd, "claude");
	const state = core.readJson(unit.paths.state);
	assert(state.occurrences.length > 0);
	state.occurrences = [];
	state.stop.attempt = 0;
	core.secureJson(unit.paths.state, state);
	assert.throws(() => core.evaluateCompletion(unit, fx.cwd, "claude"), (error) => error.code === "unit_state_digest_mismatch");
});

test("baseline manifest is independently self-digested inside protected lifecycle state", () => {
	const fx = fixture();
	const unit = start(fx);
	const state = core.readJson(unit.paths.state);
	const head = core.readJson(unit.paths.head);
	state.baseline.head = "forged-baseline";
	head.state_digest = core.sha256(core.canonicalJson(state));
	core.secureJson(unit.paths.state, state);
	core.secureJson(unit.paths.head, head);
	assert.throws(() => core.readUnitState(unit), (error) => error.code === "unit_baseline_digest_mismatch");
});

test("successful units compact to non-sensitive receipts after retention", () => {
	const fx = fixture();
	core.handleEvent({ client: "claude", eventName: "UserPromptSubmit", sessionId: "PRE", cwd: fx.cwd, prompt: "quarantined private source", origin: "native_user" });
	core.handleEvent({ client: "claude", clientVersion: CLIENT_VERSIONS.claude, eventName: "SessionStart", sessionId: "S1", cwd: fx.cwd });
	const unit = core.findUnit(fx.cwd, "claude", "S1");
	const consumedQuarantineDir = path.join(core.harnessRoot(fx.cwd), "quarantine");
	bind(fx, unit);
	ingestReview(fx, unit, cleanReview(fx, unit, "COMPACT-R1"));
	ingestReview(fx, unit, cleanReview(fx, unit, "COMPACT-R2"));
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "allow");
	const terminalId = core.readJson(unit.paths.state).terminal.id;
	const compacted = core.compactExpiredUnits(fx.cwd, Date.now() + 200 * 60 * 60 * 1000);
	assert.equal(compacted.length, 1);
	assert(!fs.existsSync(unit.paths.unit));
	assert.equal(fs.existsSync(consumedQuarantineDir) ? fs.readdirSync(consumedQuarantineDir).length : 0, 0);
	assert.deepEqual(Object.keys(compacted[0]), ["receipt_id"]);
	const receiptPath = path.join(core.harnessRoot(fx.cwd), "receipts-v2", `${compacted[0].receipt_id}.json`);
	const receipt = core.readJson(receiptPath);
	assert.equal(receipt.status, "success");
	assert.match(receipt.receipt_id, /^RCPT-[a-f0-9]{32}$/);
	assert.notEqual(receipt.receipt_id, `RCPT-${core.sha256(`${unit.id}:${terminalId}`).slice(0, 32)}`);
	assert.deepEqual(Object.keys(receipt).sort(), ["change_count", "compacted_at", "receipt_id", "review_count", "source_count", "started_at", "status", "terminal_at", "version"]);
});

test("a fabricated success terminal without completion reviews cannot compact", () => {
	const fx = fixture();
	const unit = start(fx);
	const state = core.readJson(unit.paths.state);
	state.terminal = { id: "TERM-FORGED", status: "success", at: Date.now() - 200 * 60 * 60 * 1000 };
	core.writeUnitState(unit, state);
	assert.throws(() => core.compactExpiredUnits(fx.cwd, Date.now()), (error) => error.code === "completion_proof_invalid");
	assert(fs.existsSync(unit.paths.unit));
});

test("retention compaction rejects a stale successful workspace or config", () => {
	for (const mutate of [
		(fx) => fs.writeFileSync(path.join(fx.cwd, "src", "product.txt"), "changed after successful completion\n"),
		(fx) => {
			const file = path.join(fx.cwd, ".agents", "context", "request-contract.json");
			const config = JSON.parse(fs.readFileSync(file, "utf8"));
			config.retention.success_hours += 1;
			fs.writeFileSync(file, JSON.stringify(config));
		},
	]) {
		const fx = fixture();
		const unit = start(fx);
		bind(fx, unit);
		for (const id of ["STALE-COMPACT-R1", "STALE-COMPACT-R2"]) ingestReview(fx, unit, cleanReview(fx, unit, id));
		assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "allow");
		const terminalAt = core.readJson(unit.paths.state).terminal.at;
		mutate(fx);
		assert.throws(() => core.compactExpiredUnits(fx.cwd, terminalAt + 200 * 60 * 60 * 1000), (error) => error.code === "completion_proof_invalid");
		assert(fs.existsSync(unit.paths.unit));
	}
});

test("retention compaction revalidates immediately before removing a successful unit", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	for (const id of ["COMPACT-RACE-R1", "COMPACT-RACE-R2"]) ingestReview(fx, unit, cleanReview(fx, unit, id));
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "allow");
	const terminalAt = core.readJson(unit.paths.state).terminal.at;
	assert.throws(
		() => core.compactExpiredUnits(fx.cwd, terminalAt + 200 * 60 * 60 * 1000, {
			afterReceiptWritten: () => fs.writeFileSync(path.join(fx.cwd, "src", "product.txt"), "drift during compaction\n"),
		}),
		(error) => error.code === "completion_proof_invalid",
	);
	assert(fs.existsSync(unit.paths.unit));
});

test("failed final compaction validation preserves consumed quarantine evidence", () => {
	const fx = fixture();
	core.handleEvent({ client: "claude", eventName: "UserPromptSubmit", sessionId: "PRE", cwd: fx.cwd, prompt: "quarantined source evidence", origin: "native_user" });
	core.handleEvent({ client: "claude", clientVersion: CLIENT_VERSIONS.claude, eventName: "SessionStart", sessionId: "S1", cwd: fx.cwd });
	core.handleEvent({ client: "claude", eventName: "UserPromptSubmit", sessionId: "S1", cwd: fx.cwd, prompt: "complete the adopted request", origin: "native_user" });
	const unit = core.findUnit(fx.cwd, "claude", "S1");
	bind(fx, unit);
	for (const id of ["QUARANTINE-COMPACT-R1", "QUARANTINE-COMPACT-R2"]) ingestReview(fx, unit, cleanReview(fx, unit, id));
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "allow");
	const quarantineDirs = fs.readdirSync(path.join(core.harnessRoot(fx.cwd), "quarantine"));
	assert.equal(quarantineDirs.length, 1);
	const terminalAt = core.readJson(unit.paths.state).terminal.at;
	assert.throws(
		() => core.compactExpiredUnits(fx.cwd, terminalAt + 200 * 60 * 60 * 1000, { afterReceiptWritten: () => fs.writeFileSync(path.join(fx.cwd, "src", "product.txt"), "late drift\n") }),
		(error) => error.code === "completion_proof_invalid",
	);
	assert(fs.existsSync(unit.paths.unit));
	assert(fs.existsSync(path.join(core.harnessRoot(fx.cwd), "quarantine", quarantineDirs[0])));
});

test("receipt-journaled unit staging finishes private cleanup after a crash", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	for (const id of ["STAGED-COMPACT-R1", "STAGED-COMPACT-R2"]) ingestReview(fx, unit, cleanReview(fx, unit, id));
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "allow");
	const terminalAt = core.readJson(unit.paths.state).terminal.at;
	let staged;
	assert.throws(
		() => core.compactExpiredUnits(fx.cwd, terminalAt + 200 * 60 * 60 * 1000, { afterUnitStaged: (value) => { staged = value; throw new Error("simulated staged cleanup crash"); } }),
		/simulated staged cleanup crash/,
	);
	assert(staged && fs.existsSync(staged.stagedUnit));
	assert.equal(core.hasStickyGovernanceState(fx.cwd), true);
	assert.deepEqual(core.compactExpiredUnits(fx.cwd, terminalAt + 200 * 60 * 60 * 1000 + 1), []);
	assert(!fs.existsSync(staged.stagedUnit));
	assert(fs.existsSync(staged.receipt));
});

test("staged compaction recovery revalidates the complete private proof", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	for (const id of ["STAGED-PROOF-R1", "STAGED-PROOF-R2"]) ingestReview(fx, unit, cleanReview(fx, unit, id));
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "allow");
	const terminalAt = core.readJson(unit.paths.state).terminal.at;
	let staged;
	assert.throws(
		() => core.compactExpiredUnits(fx.cwd, terminalAt + 200 * 60 * 60 * 1000, { afterUnitStaged: (value) => { staged = value; throw new Error("simulated proof recovery crash"); } }),
		/simulated proof recovery crash/,
	);
	fs.appendFileSync(path.join(staged.stagedUnit, "sources.jsonl"), "{}\n");
	assert.throws(
		() => core.compactExpiredUnits(fx.cwd, terminalAt + 200 * 60 * 60 * 1000 + 1),
		(error) => error.code === "completion_proof_invalid",
	);
	assert(fs.existsSync(staged.stagedUnit));
	assert(fs.existsSync(staged.receipt));
});

test("incomplete units never compact and remain governed until signed resume", () => {
	const fx = fixture();
	const unit = start(fx);
	const old = Date.now() - 10_000 * 60 * 60 * 1000;
	const state = core.readJson(unit.paths.state);
	state.terminal = { id: "TERM-INCOMPLETE-PRESERVED", status: "incomplete", at: old, error_codes: ["test"] };
	core.writeUnitState(unit, state);
	assert.deepEqual(core.compactExpiredUnits(fx.cwd, Date.now()), []);
	assert(fs.existsSync(unit.paths.unit));
	assert.equal(core.governed(fx.cwd, { REQUEST_CONTRACT: "off" }), true);
	assert.equal(fs.existsSync(path.join(core.harnessRoot(fx.cwd), "receipts-v2")), false);
});

test("random compaction receipt identity survives a crash and retry", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	ingestReview(fx, unit, cleanReview(fx, unit, "RETRY-R1"));
	ingestReview(fx, unit, cleanReview(fx, unit, "RETRY-R2"));
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "allow");
	const retentionTime = Date.now() + 200 * 60 * 60 * 1000;
	let prepared;
	assert.throws(() => core.compactExpiredUnits(fx.cwd, retentionTime, { afterReceiptWritten: (value) => { prepared = value; throw new Error("simulated compaction crash"); } }), /simulated compaction crash/);
	assert(fs.existsSync(unit.paths.unit));
	assert(fs.existsSync(prepared.receipt));
	const first = core.readJson(prepared.receipt);
	const compacted = core.compactExpiredUnits(fx.cwd, retentionTime + 1_000);
	assert.equal(compacted.length, 1);
	assert.deepEqual(compacted[0], { receipt_id: prepared.receiptId });
	assert.deepEqual(core.readJson(prepared.receipt), first);
});

test("changes already present before genesis receive traceable occurrence ids", () => {
	const fx = fixture();
	fs.writeFileSync(path.join(fx.cwd, "src", "product.txt"), "dirty before session\n");
	const unit = start(fx);
	const occurrence = core.readJson(unit.paths.state).occurrences.find((item) => item.detail.path === "src/product.txt");
	assert(occurrence && /^CHG-[a-f0-9]{32}$/.test(occurrence.id));
	const contract = makeContract(fx, unit);
	bind(fx, unit, contract);
	assert(core.readJson(unit.paths.contract).changes.some((change) => change.id === occurrence.id));
});

test("index-only staging after Clean review invalidates completion", () => {
	const fx = fixture();
	const unit = start(fx);
	fs.writeFileSync(path.join(fx.cwd, "src", "product.txt"), "changed and reviewed\n");
	core.captureWorkspaceOccurrences(unit, fx.cwd);
	bind(fx, unit);
	ingestReview(fx, unit, cleanReview(fx, unit, "INDEX-R1"));
	ingestReview(fx, unit, cleanReview(fx, unit, "INDEX-R2"));
	cp.execFileSync("git", ["add", "src/product.txt"], { cwd: fx.cwd });
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "block");
});

test("corrupt or truncated quarantine chains can never be adopted or consumed", () => {
	for (const corruption of ["truncate", "missing-head"]) {
		const fx = fixture();
		core.handleEvent({ client: "claude", eventName: "UserPromptSubmit", sessionId: "Q", cwd: fx.cwd, prompt: "preserve exactly", origin: "native_user" });
		const q = core.listUnconsumedQuarantine(fx.cwd)[0];
		if (corruption === "truncate") fs.appendFileSync(path.join(q.dir, "sources.jsonl"), "{\"broken\":");
		else fs.unlinkSync(path.join(q.dir, "head.json"));
		const result = core.handleEvent({ client: "claude", clientVersion: CLIENT_VERSIONS.claude, eventName: "SessionStart", sessionId: "S", cwd: fx.cwd });
		assert.equal(result.code, "quarantine_chain_corrupt");
		assert(fs.existsSync(q.dir));
	}
});

test("identical authority requests reuse one challenge and changed requests supersede it", () => {
	const fx = fixture();
	const unit = start(fx);
	const presentation = { operation: "resume", target_directive_ids: [], affected_prior_ids: [], replacement_ids: [], tombstone_ids: [], prior_scope_digest: null, resulting_scope_digest: null, resulting_scope_epoch: 1, binding_epoch: 1 };
	const first = core.issueAuthorityChallenge(unit, fx.cwd, presentation);
	const retry = core.issueAuthorityChallenge(unit, fx.cwd, presentation);
	assert.equal(retry.challenge, first.challenge);
	const changed = core.issueAuthorityChallenge(unit, fx.cwd, { ...presentation, affected_prior_ids: ["REQ-CHANGED"] });
	assert.notEqual(changed.challenge, first.challenge);
	assert.equal(core.readJson(path.join(unit.paths.pending, `authority-${first.challenge}.json`)).superseded, true);
	const mixed = core.issueAuthorityChallenge(unit, fx.cwd, [
		{ ...presentation, operation: "amend_scope_add", target_directive_ids: ["REQ-ONE"], replacement_ids: ["REQ-ONE"] },
		{ ...presentation, operation: "amend_scope_replace", target_directive_ids: ["REQ-TWO"], affected_prior_ids: ["REQ-TWO"] },
	]);
	assert.equal(mixed.operation, "mixed");
	assert.equal(mixed.presentation_digests.length, 2);
	const live = fs.readdirSync(unit.paths.pending).map((name) => core.readJson(path.join(unit.paths.pending, name))).filter((item) => item && item.challenge && !item.superseded && !item.consumed);
	assert.equal(live.length, 1);
	assert.equal(live[0].challenge, mixed.challenge);
});

test("resume rejects an environment-substituted authority key", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	for (let index = 0; index < 3; index++) core.evaluateCompletion(unit, fx.cwd, "claude");
	const head = core.readJson(unit.paths.head);
	const binding = core.readJson(unit.paths.binding);
	const scope = core.sha256(core.canonicalJson(core.scopeProjection(core.readJson(unit.paths.contract))));
	const authority = { operation: "resume", target_directive_ids: [], affected_prior_ids: [], replacement_ids: [], tombstone_ids: [] };
	const presentation = core.authorityPresentation(authority, scope, scope, head.scope_epoch + 1, binding.binding_epoch + 1);
	const challenge = core.issueAuthorityChallenge(unit, fx.cwd, presentation);
	const rogue = crypto.generateKeyPairSync("ed25519");
	fs.writeFileSync(path.join(fx.cwd, ".agents", "context", "authority.pub"), rogue.publicKey.export({ type: "spki", format: "pem" }));
	const receipt = signedReceipt({ ...fx, privateKey: rogue.privateKey }, { operation: "resume", prior_scope_digest: scope, resulting_scope_digest: scope, resulting_scope_epoch: head.scope_epoch + 1, binding_epoch: binding.binding_epoch + 1, challenge: challenge.challenge, presentation_digest: challenge.presentation_digest, sign_count: 2 });
	assert.throws(() => core.resumeIncomplete(unit, receipt, fx.cwd), /authority key differs from genesis pin/);
});

test("review records are closed and expired private bundles are destroyed", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	const review = cleanReview(fx, unit, "CLOSED");
	review.path_summary = "/private/leak";
	review.executor.signature = crypto.sign(null, Buffer.from(core.canonicalJson(core.reviewSignaturePayload(review))), fx.reviewerPrivateKey).toString("base64");
	assert.throws(() => ingestReview(fx, unit, review), /review_extra_field/);
	const now = Date.now();
	const issued = core.issueReviewInvocation(unit, fx.cwd, "S1", now);
	const bundlePath = path.resolve(fx.cwd, issued.manifest.bundle_locator);
	assert(fs.existsSync(bundlePath));
	core.issueReviewInvocation(unit, fx.cwd, "S1", now + 11 * 60_000);
	assert(!fs.existsSync(bundlePath));
	assert.equal(core.readJson(path.join(unit.paths.pending, `review-${issued.manifest.nonce}.json`)).expired, true);
});

test("governed mutation events without genesis fail closed", () => {
	const fx = fixture();
	const result = core.handleEvent({ client: "codex", eventName: "PostToolUse", sessionId: "NO-GENESIS", cwd: fx.cwd, toolName: "Bash" });
	assert.equal(result.kind, "block");
	assert.equal(result.code, "request_contract_missing_genesis");
});

test("runtime contract validation rejects schema-invalid shapes and extra fields", () => {
	const fx = fixture();
	const unit = start(fx);
	const contract = makeContract(fx, unit);
	contract.unexpected = true;
	delete contract.directives[0].targets[0].path;
	contract.directives[0].acceptance_criteria[0].statement = "";
	contract.authorities[0].receipt.extra_secret = "leak";
	const result = core.validateContract(contract, core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records, [], { publicKeyPem: fx.publicKeyPem, cwd: fx.cwd });
	assert(result.errors.includes("contract_extra_field"));
	assert(result.errors.some((error) => error.startsWith("contract_target_definition_missing")));
	assert(result.errors.some((error) => error.startsWith("contract_acceptance_definition_missing")));
	assert(result.errors.includes("authority_receipt_extra_field:AUTH-001"));
});

test("registered hook commands resolve their adapters from a nested directory", () => {
	const root = path.resolve(__dirname, "..", "..", "..");
	for (const [client, registryPath] of [["claude", path.join(root, ".claude", "settings.json")], ["codex", path.join(root, ".codex", "hooks.json")]]) {
		const nested = path.join(root, "packages", "artifacts-spec");
		const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
		const hook = registry.hooks.SessionStart.flatMap((entry) => entry.hooks).find((candidate) => candidate.command.includes("request-contract") || (candidate.args || []).some((arg) => arg.includes("request-contract")));
		const input = JSON.stringify({ hook_event_name: "SessionStart", session_id: "NESTED-" + client, cwd: nested });
		let executable;
		let args;
		if (Array.isArray(hook.args)) {
			executable = hook.command;
			args = hook.args.map((arg) => arg.replace("$" + "{CLAUDE_PROJECT_DIR}", root));
		} else if (process.platform === "win32" && hook.commandWindows) {
			executable = "powershell.exe";
			let script = hook.commandWindows.replace(/^powershell(?:\.exe)?\s+-NoProfile\s+-Command\s+/, "");
			if (script.startsWith('"') && script.endsWith('"')) script = script.slice(1, -1);
			args = ["-NoProfile", "-Command", script];
		} else {
			executable = "bash";
			args = ["-c", hook.command];
		}
		const output = cp.execFileSync(executable, args, { cwd: nested, input, encoding: "utf8", env: { ...process.env, REQUEST_CONTRACT: "off" } });
		assert.equal(output, "");
	}
});

test("live lifecycle lock owners are never evicted only because the lock is old", () => {
	const fx = fixture();
	const unit = start(fx);
	const lock = path.join(unit.paths.locks, "lifecycle");
	fs.mkdirSync(lock, { recursive: true });
	fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid }));
	const old = new Date(Date.now() - 120_000);
	fs.utimesSync(lock, old, old);
	assert.throws(() => core.withUnitLock({ ...unit, lockTimeoutMs: 50 }, () => null), /lifecycle lock busy/);
	fs.rmSync(lock, { recursive: true, force: true });
});

test("product roots cannot escape the repository", () => {
	const fx = fixture();
	const configPath = path.join(fx.cwd, ".agents", "context", "request-contract.json");
	const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
	config.product_roots = ["../private-sibling"];
	fs.writeFileSync(configPath, JSON.stringify(config));
	const result = core.handleEvent({ client: "claude", clientVersion: CLIENT_VERSIONS.claude, eventName: "SessionStart", sessionId: "ESCAPE", cwd: fx.cwd });
	assert.equal(result.code, "request_contract_config_invalid");
});

test("manifest metadata changes create traceable occurrences", () => {
	const fx = fixture();
	const unit = start(fx);
	fs.writeFileSync(path.join(fx.cwd, "src", "product.txt"), "staged-only\n");
	cp.execFileSync("git", ["add", "src/product.txt"], { cwd: fx.cwd });
	core.captureWorkspaceOccurrences(unit, fx.cwd);
	const paths = core.readJson(unit.paths.state).occurrences.map((occurrence) => occurrence.detail.path);
	assert(paths.includes("@workspace/index_digest"));
});

test("directive and trace-artifact ids must be globally distinct", () => {
	const fx = fixture();
	const unit = start(fx);
	const contract = makeContract(fx, unit);
	contract.artifacts.requirements[0].id = contract.directives[0].id;
	contract.directives[0].trace.requirements = [contract.directives[0].id];
	contract.edges[0].to = contract.directives[0].id;
	const result = core.validateContract(contract, core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records, [], { publicKeyPem: fx.publicKeyPem, cwd: fx.cwd });
	assert(result.errors.some((error) => error.startsWith("contract_artifact_id_duplicate:requirements")));
});

test("trace-only derived work revisions do not require new scope authority", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	const contract = core.readJson(unit.paths.contract);
	contract.artifacts.implementations[0].statement = "implementation evidence refined without changing scope";
	assert.doesNotThrow(() => core.bindContract(unit, contract, { publicKeyPem: fx.publicKeyPem, cwd: fx.cwd }));
	assert.equal(core.readJson(unit.paths.head).scope_epoch, 0);
	assert.equal(core.readJson(unit.paths.binding).binding_epoch, 2);
});

test("runtime and schema agree that every directive has nonempty scope fields", () => {
	const fx = fixture();
	const unit = start(fx);
	for (const state of ["pending", "deferred"]) {
		const contract = makeContract(fx, unit);
		contract.directives[0].state = state;
		contract.directives[0].targets = [];
		contract.directives[0].acceptance_criteria = [];
		if (state === "deferred") contract.directives[0].authority_id = "AUTH-001";
		const result = core.validateContract(contract, core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records, [], { publicKeyPem: fx.publicKeyPem, cwd: fx.cwd });
		assert(result.errors.includes("contract_target_missing:REQ-001"));
		assert(result.errors.includes("contract_acceptance_missing:REQ-001"));
	}
	const missingAuthorityTargets = makeContract(fx, unit);
	delete missingAuthorityTargets.authorities[0].target_directive_ids;
	const authorityResult = core.validateContract(missingAuthorityTargets, core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records, [], { publicKeyPem: fx.publicKeyPem, cwd: fx.cwd });
	assert(authorityResult.errors.includes("contract_authority_target_directive_ids_missing:AUTH-001"));
});

test("review ids remain globally unique after unit compaction", () => {
	const fx = fixture();
	let unit = start(fx, "claude", "FIRST");
	bind(fx, unit);
	const original = cleanReview(fx, unit, "GLOBAL-RUN");
	ingestReview(fx, unit, original);
	ingestReview(fx, unit, cleanReview(fx, unit, "GLOBAL-RUN-2"));
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "allow");
	const terminalAt = core.readJson(unit.paths.state).terminal.at;
	core.compactExpiredUnits(fx.cwd, terminalAt + 25 * 60 * 60 * 1000);
	assert.equal(core.listUnits(fx.cwd).length, 0);
	unit = start(fx, "claude", "SECOND");
	bind(fx, unit);
	const replay = cleanReview(fx, unit, "GLOBAL-RUN");
	replay.executor.context_id = original.executor.context_id;
	replay.isolation.reviewer_context_id = replay.executor.context_id;
	replay.isolation.review_payload_digest = core.sha256(core.canonicalJson(core.reviewSignaturePayload(replay)));
	replay.isolation.signature = crypto.sign(null, Buffer.from(core.canonicalJson(core.isolationSignaturePayload(replay.isolation))), fx.runnerPrivateKey).toString("base64");
	replay.executor.signature = crypto.sign(null, Buffer.from(core.canonicalJson(core.reviewSignaturePayload(replay))), fx.reviewerPrivateKey).toString("base64");
	assert.throws(() => ingestReview(fx, unit, replay), /already used/);
});

test("reviewer allowlisting happens before any executable receives the bundle", () => {
	const fx = fixture();
	const bundlePath = path.join(fx.cwd, "private-review.json");
	const marker = path.join(fx.cwd, "should-not-exist");
	const reviewer = writeReviewer(fx.cwd, "untrusted-reviewer",
		`#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`,
		`require("fs").writeFileSync(${JSON.stringify(marker)},"ran");\n`);
	fs.writeFileSync(bundlePath, "secret");
	assert.throws(() => runSandbox({ bundlePath, reviewerPath: reviewer, allowedReviewerDigests: ["0".repeat(64)] }), /not pinned/);
	assert(!fs.existsSync(marker));
});

test("sandbox executable allowlisting happens before the reviewer starts", () => {
	const fx = fixture();
	const bundlePath = path.join(fx.cwd, "sandbox-pin-review.json");
	const bytes = Buffer.from("sandbox pin secret");
	fs.writeFileSync(bundlePath, bytes);
	assert.throws(() => reviewRunner.runSandbox({
		bundlePath,
		expectedBundleDigest: core.sha256(bytes),
		reviewerPath: reviewerFixturePath("contract-reviewer"),
		allowedReviewerDigests: [fx.reviewerFixtureDigest],
		allowedSandboxDigests: ["0".repeat(64)],
	}), (error) => error.code === "sandbox_executable_not_allowed");
});

test("an argv-supplied attestor cannot sign unless its exact bytes are pinned", () => {
	const fx = fixture();
	const rogue = makeAttestor(fx, fx.reviewerPrivateKey, "rogue");
	assert.throws(() => reviewRunner.externalSign(rogue, "{}", [fx.reviewerAttestorDigest]), (error) => error.code === "review_attestor_not_allowed");
	const payload = core.canonicalJson({ reviewed_at: 1, sandbox: { no_network: true, repository_blind: true, home_blind: true }, executor: { attestor_executable_digest: fx.reviewerAttestorDigest } });
	const signed = reviewRunner.externalSign(fx.reviewerAttestor, payload, [fx.reviewerAttestorDigest]);
	assert.equal(signed.executableDigest, fx.reviewerAttestorDigest);
	assert(crypto.verify(null, Buffer.from(payload), fx.reviewerPublicKeyPem, Buffer.from(signed.signature, "base64")));
});

test("review runner never reflects reviewer stderr", () => {
	const fx = fixture();
	const bundlePath = path.join(fx.cwd, "private-review.json");
	const reviewer = writeReviewer(fx.cwd, "failing-reviewer",
		"#!/bin/sh\necho RAW_PRIVATE_PROMPT >&2\nexit 7\n",
		'process.stderr.write("RAW_PRIVATE_PROMPT");process.exit(7);\n');
	fs.writeFileSync(bundlePath, "secret");
	const digest = core.sha256(fs.readFileSync(reviewer));
	let error;
	try { runSandbox({ bundlePath, reviewerPath: reviewer, allowedReviewerDigests: [digest] }); } catch (caught) { error = caught; }
	assert(error);
	assert(!error.message.includes("RAW_PRIVATE_PROMPT"));
});

test("review runner stderr never reflects rejected reviewer JSON fields", () => {
	const fx = fixture();
	const reviewer = writeReviewer(fx.cwd, "malicious-reviewer",
		"#!/bin/sh\nprintf '%s' '{\"PRIVATE_PROMPT_FIELD_NAME\":true}'\n",
		'process.stdout.write(JSON.stringify({PRIVATE_PROMPT_FIELD_NAME:true}));\n');
	const configPath = path.join(fx.cwd, ".agents", "context", "request-contract.json");
	const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
	config.review_runner.allowed_reviewer_digests.push(core.sha256(fs.readFileSync(reviewer)));
	fs.writeFileSync(configPath, JSON.stringify(config));
	const unit = start(fx);
	bind(fx, unit);
	const reviewerAttestor = fx.reviewerAttestor;
	const runnerAttestor = fx.runnerAttestor;
	const root = path.resolve(__dirname, "..", "..", "..");
	const result = cp.spawnSync(process.execPath, [path.join(root, "scripts", "request-contract-review-runner.cjs"), "--cwd", fx.cwd, "--unit", unit.id, "--writer-session", "S1", "--reviewer", reviewer, "--reviewer-attestor", reviewerAttestor, "--runner-attestor", runnerAttestor], { encoding: "utf8", cwd: root });
	assert.notEqual(result.status, 0);
	assert(!result.stderr.includes("PRIVATE_PROMPT_FIELD_NAME"));
	assert.deepEqual(Object.keys(JSON.parse(result.stderr)), ["error"]);
});

test("operator CLI errors never reflect rejected private contract fields", () => {
	const fx = fixture();
	const unit = start(fx);
	const contract = makeContract(fx, unit);
	contract.PRIVATE_PROMPT_FIELD_NAME = "RAW_PRIVATE_PROMPT_VALUE";
	const input = core.controlInputPath(unit, "contract");
	core.secureJson(input, contract);
	const root = path.resolve(__dirname, "..", "..", "..");
	const result = cp.spawnSync(process.execPath, [path.join(root, "scripts", "request-contract.cjs"), "bind", "--unit", unit.id, "--file", input], { encoding: "utf8", cwd: fx.cwd });
	assert.notEqual(result.status, 0);
	assert(!result.stderr.includes("PRIVATE_PROMPT_FIELD_NAME"));
	assert(!result.stderr.includes("RAW_PRIVATE_PROMPT_VALUE"));
	assert.deepEqual(Object.keys(JSON.parse(result.stderr)), ["error"]);
});

test("distinct credential labels cannot reuse one public key", () => {
	const fx = fixture();
	fs.writeFileSync(path.join(fx.cwd, ".agents", "context", "reviewer.pub"), fx.publicKeyPem);
	const result = core.handleEvent({ client: "claude", clientVersion: CLIENT_VERSIONS.claude, eventName: "SessionStart", sessionId: "KEY-REUSE", cwd: fx.cwd });
	assert.equal(result.code, "request_contract_credentials_unprovisioned");
});

test("prepared contract binding recovers atomically after interruption", () => {
	const fx = fixture();
	const unit = start(fx);
	const contract = makeContract(fx, unit);
	coverOccurrences(contract, unit);
	assert.throws(() => core.bindContract(unit, contract, { publicKeyPem: fx.publicKeyPem, cwd: fx.cwd, afterTransactionPrepared: () => { throw new Error("simulated bind crash"); } }), /simulated bind crash/);
	assert(fs.existsSync(path.join(unit.paths.transactions, "bind.json")));
	core.withUnitLock(unit, () => null);
	assert.equal(core.readJson(unit.paths.contract).id, contract.id);
	assert(core.verifyScopeHistory(unit).ok);
	assert(!fs.existsSync(path.join(unit.paths.transactions, "bind.json")));
});

test("prepared resume recovers its state and one-time receipt atomically", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	for (let index = 0; index < 3; index++) core.evaluateCompletion(unit, fx.cwd, "claude");
	const receipt = makeResumeReceipt(fx, unit);
	assert.throws(() => core.resumeIncomplete(unit, receipt, fx.cwd, Date.now(), { afterTransactionPrepared: () => { throw new Error("simulated resume crash"); } }), /simulated resume crash/);
	core.withUnitLock(unit, () => null);
	const state = core.readJson(unit.paths.state);
	assert(!state.terminal);
	assert(state.consumed_authority_nonces.includes(receipt.nonce));
	assert(!fs.existsSync(path.join(unit.paths.transactions, "resume.json")));
});

test("prepared source append recovers without duplication", () => {
	const fx = fixture();
	const unit = start(fx);
	assert.throws(() => core.appendSource(unit, "transactional source", "ambiguous", Date.now(), { sourceId: "SRC-11111111111111111111111111111111", afterTransactionPrepared: () => { throw new Error("simulated source crash"); } }), /simulated source crash/);
	core.withUnitLock(unit, () => null);
	core.appendSource(unit, "transactional source", "ambiguous", Date.now(), { sourceId: "SRC-11111111111111111111111111111111" });
	const matches = core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records.filter((record) => record.source_id === "SRC-11111111111111111111111111111111");
	assert.equal(matches.length, 1);
});

test("prepared state and head replacement recovers after a crash between durable writes", () => {
	const fx = fixture();
	const unit = start(fx);
	const head = core.readJson(unit.paths.head);
	const state = core.readJson(unit.paths.state);
	state.stop = { episode_id: "EP-STATE-RECOVERY", attempt: 1, unresolved_codes: ["test"], failure_fingerprint: "f".repeat(64) };
	assert.throws(
		() => core.writeUnitState(unit, state, head, { afterStateWritten: () => { throw new Error("simulated state/head crash"); } }),
		/simulated state\/head crash/,
	);
	assert(fs.existsSync(path.join(unit.paths.transactions, "state.json")));
	assert.throws(() => core.readUnitState(unit), (error) => error.code === "unit_state_digest_mismatch");
	core.withUnitLock(unit, () => null);
	assert.equal(core.readUnitState(unit).stop.episode_id, "EP-STATE-RECOVERY");
	assert(!fs.existsSync(path.join(unit.paths.transactions, "state.json")));
});

test("physical evidence paths reject symlink traversal", () => {
	const fx = fixture();
	const unit = start(fx);
	const outside = path.join(os.tmpdir(), `outside-evidence-${crypto.randomBytes(8).toString("hex")}`);
	fs.writeFileSync(outside, "outside secret\n");
	fs.symlinkSync(outside, path.join(fx.cwd, "evidence", "linked-report.txt"));
	const contract = makeContract(fx, unit);
	contract.artifacts.evidence[0].locator = "evidence/linked-report.txt";
	contract.artifacts.evidence[0].digest = core.sha256("outside secret\n");
	const result = core.validateContract(contract, core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records, [], { publicKeyPem: fx.publicKeyPem, cwd: fx.cwd });
	assert(result.errors.some((error) => error.startsWith("contract_evidence_locator_symlink")));
});

test("PreToolUse requires genesis, an active binding, and classified sources", () => {
	const fx = fixture();
	let result = core.handleEvent({ client: "codex", eventName: "PreToolUse", sessionId: "NO-GENESIS", cwd: fx.cwd, toolName: "Bash" });
	assert.equal(result.kind, "block");
	const unit = start(fx, "codex", "WITH-GENESIS");
	result = core.handleEvent({ client: "codex", eventName: "PreToolUse", sessionId: "WITH-GENESIS", cwd: fx.cwd, toolName: "Bash" });
	assert.equal(result.code, "request_contract_unbound");
	bind(fx, unit);
	result = core.handleEvent({ client: "codex", eventName: "PreToolUse", sessionId: "WITH-GENESIS", cwd: fx.cwd, toolName: "Bash" });
	assert.equal(result.code, "request_contract_mutation_preflight");
	assert(unit);
});

test("unsupported client versions fail closed", () => {
	const fx = fixture();
	const result = core.handleEvent({ client: "codex", clientVersion: "0.100.0", eventName: "SessionStart", sessionId: "OLD", cwd: fx.cwd });
	assert.equal(result.code, "request_contract_client_version_unsupported");
});

test("checked-in client registries satisfy the exact native lifecycle contract", () => {
	const root = path.resolve(__dirname, "..", "..", "..");
	assert.equal(core.clientRegistrySupports(root, "claude"), true);
	assert.equal(core.clientRegistrySupports(root, "codex"), true);
});

test("both client registries reject every missing event plus wrong adapters, arguments, roots, native Windows commands, matchers, duplicates, and conflicts", () => {
	const requiredEvents = ["PreToolUse", "SessionStart", "UserPromptSubmit", "PostToolUse", "PreCompact", "PostCompact", "Stop"];
	for (const client of ["claude", "codex"]) {
		const relativeRegistry = client === "claude" ? [".claude", "settings.json"] : [".codex", "hooks.json"];
		const adapterName = client === "claude" ? "request-contract.js" : "request-contract.cjs";
		const adapterPath = client === "claude" ? ".claude/hooks/request-contract.js" : ".codex/hooks/request-contract.cjs";
		const locate = (registry, event) => {
			for (const entry of registry.hooks[event] || []) {
				const hook = (entry.hooks || []).find((candidate) => [candidate.command, candidate.commandWindows, ...(candidate.args || [])].some((value) => typeof value === "string" && value.includes(adapterPath)));
				if (hook) return { entry, hook };
			}
			throw new Error(`missing request-contract fixture hook for ${client}:${event}`);
		};
		const replaceEverywhere = (hook, pattern, replacement) => {
			if (typeof hook.command === "string") hook.command = hook.command.replace(pattern, replacement);
			if (typeof hook.commandWindows === "string") hook.commandWindows = hook.commandWindows.replace(pattern, replacement);
			if (Array.isArray(hook.args)) hook.args = hook.args.map((arg) => arg.replace(pattern, replacement));
		};
		const mutations = requiredEvents.flatMap((event) => [
			{ name: `${event}:missing`, mutate: (registry) => { delete registry.hooks[event]; } },
			{ name: `${event}:wrong-adapter`, mutate: (registry) => { const { hook } = locate(registry, event); replaceEverywhere(hook, adapterName, `wrong-${adapterName}`); } },
			{ name: `${event}:wrong-event-argument`, mutate: (registry) => { const { hook } = locate(registry, event); const replacement = event === "Stop" ? "PostCompact" : "Stop"; replaceEverywhere(hook, new RegExp(`${event}$`), replacement); } },
			{ name: `${event}:wrong-root`, mutate: (registry) => { const { hook } = locate(registry, event); if (client === "claude") hook.args[0] = adapterPath; else { hook.command = `node ${adapterPath} ${event}`; hook.commandWindows = `node ${adapterPath} ${event}`; } } },
			{ name: `${event}:wrong-matcher`, mutate: (registry) => { const { entry } = locate(registry, event); entry.matcher = event === "PreToolUse" ? "Bash" : "Bash|Edit"; } },
			{ name: `${event}:duplicate`, mutate: (registry) => { const { entry, hook } = locate(registry, event); entry.hooks.push({ ...hook }); } },
			{ name: `${event}:conflicting-registration`, mutate: (registry) => { const { hook } = locate(registry, event); registry.hooks[`Conflict${event}`] = [{ hooks: [{ ...hook }] }]; } },
			...(client === "claude" ? [{ name: `${event}:unexpected-commandWindows`, mutate: (registry) => { locate(registry, event).hook.commandWindows = `node wrong-${adapterName} ${event}`; } }] : []),
			...(client === "codex" ? [{ name: `${event}:missing-commandWindows`, mutate: (registry) => { delete locate(registry, event).hook.commandWindows; } }] : []),
		]);
		for (const { name, mutate } of mutations) {
			const fx = fixture();
			const registryPath = path.join(fx.cwd, ...relativeRegistry);
			const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
			mutate(registry);
			fs.writeFileSync(registryPath, JSON.stringify(registry));
			const result = core.handleEvent({ client, clientVersion: CLIENT_VERSIONS[client], eventName: "SessionStart", sessionId: `REG-${crypto.randomBytes(4).toString("hex")}`, cwd: fx.cwd });
			assert.equal(result.code, "request_contract_client_capability_missing", `${client} registry mutation was accepted: ${name}`);
		}
	}
});

test("prepared review ingestion recovers its log, head, invocation, and bundle", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	const review = cleanReview(fx, unit, "CRASH-REVIEW");
	assert.throws(() => core.appendReview(unit, review, { expectedBundleDigest: review.bundle_digest, reviewerPublicKey: fx.reviewerPublicKeyPem, reviewerCredentialId: "test-review-executor", reviewRunnerPublicKey: fx.runnerPublicKeyPem, reviewRunnerCredentialId: "test-isolation-runner", runnerEvidence: runnerEvidenceByReview.get(review), cwd: fx.cwd, afterTransactionPrepared: () => { throw new Error("simulated review crash"); } }), /simulated review crash/);
	core.withUnitLock(unit, () => null);
	assert(core.verifyReviewChain(unit.paths).ok);
	assert.equal(core.verifyReviewChain(unit.paths).records.length, 1);
	assert(!fs.existsSync(path.join(unit.paths.transactions, "review.json")));
});

test("cleanup destroys bundles whose invocation manifest is corrupt", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	const issued = core.issueReviewInvocation(unit, fx.cwd, "S1");
	const bundle = path.resolve(fx.cwd, issued.manifest.bundle_locator);
	fs.writeFileSync(path.join(unit.paths.pending, `review-${issued.manifest.nonce}.json`), "not json");
	core.issueReviewInvocation(unit, fx.cwd, "S1");
	assert(!fs.existsSync(bundle));
});

test("a stale lock with a recycled pid identity is reclaimed safely", () => {
	const fx = fixture();
	const unit = start(fx);
	const lock = path.join(unit.paths.locks, "lifecycle");
	fs.mkdirSync(lock, { recursive: true });
	fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, process_identity: "different-boot:1", nonce: "old" }));
	const old = new Date(Date.now() - 120_000);
	fs.utimesSync(lock, old, old);
	assert.equal(core.withUnitLock(unit, () => "reclaimed"), "reclaimed");
});

test("a lock owner is complete before publication and cannot enter through a replaced pathname", () => {
	const fx = fixture();
	const lock = path.join(fx.cwd, ".agents", "harness", "locks", "publication-test");
	const corePath = path.resolve(__dirname, "..", "..", "..", ".agents", "hooks", "core", "request-contract.js");
	const entered = core.withDirectoryLock(lock, () => "parent", Date.now(), 5_000, {
		afterCandidatePrepared: () => {
			assert(!fs.existsSync(lock));
			const output = cp.execFileSync(process.execPath, ["-e", "const core=require(process.argv[1]);core.withDirectoryLock(process.argv[2],()=>process.stdout.write('child'));", corePath, lock], { encoding: "utf8" });
			assert.equal(output, "child");
			assert(!fs.existsSync(lock));
		},
	});
	assert.equal(entered, "parent");
	assert(!fs.existsSync(lock));
});

test("Windows lock retries preserve the underlying publication diagnostic", () => {
	if (process.platform !== "win32") return;
	const fx = fixture();
	const lock = path.join(fx.cwd, ".agents", "harness", "locks", "diagnostic-test");
	assert.throws(
		() => core.withDirectoryLock(lock, () => "never", Date.now(), 30, {
			afterCandidatePrepared: () => { throw Object.assign(new Error("simulated access denial"), { code: "EPERM" }); },
		}),
		(error) => error.code === "lifecycle_lock_busy"
			&& error.publication_error?.code === "EPERM"
			&& /last publication error EPERM/.test(error.message),
	);
});

test("an index change starts a fresh consecutive Stop episode", () => {
	const fx = fixture();
	const unit = start(fx);
	core.evaluateCompletion(unit, fx.cwd, "claude");
	const firstStop = core.readJson(unit.paths.state).stop;
	assert.equal(firstStop.attempt, 1);
	fs.writeFileSync(path.join(fx.cwd, "src", "product.txt"), "staged mutation\n");
	cp.execFileSync("git", ["add", "src/product.txt"], { cwd: fx.cwd });
	core.evaluateCompletion(unit, fx.cwd, "claude");
	const secondStop = core.readJson(unit.paths.state).stop;
	assert.equal(secondStop.attempt, 1);
	assert.notEqual(secondStop.episode_id, firstStop.episode_id);
});

test("repository locking serializes concurrent genesis and quarantine writers", () => {
	let fx = fixture();
	const worker = path.join(os.tmpdir(), `request-contract-worker-${crypto.randomBytes(8).toString("hex")}.cjs`);
	const coordinator = path.join(os.tmpdir(), `request-contract-coordinator-${crypto.randomBytes(8).toString("hex")}.cjs`);
	const corePath = path.resolve(__dirname, "..", "..", "..", ".agents", "hooks", "core", "request-contract.js");
	fs.writeFileSync(worker, `const core=require(${JSON.stringify(corePath)});const [mode,cwd,client,session,prompt]=process.argv.slice(2);const event=mode==="start"?{client,clientVersion:client==="claude"?"2.1.207":"0.144.1",eventName:"SessionStart",sessionId:session,cwd}:{client,eventName:"UserPromptSubmit",sessionId:session,cwd,prompt,origin:"native_user"};const result=core.handleEvent(event);if(mode==="start"&&result.kind!=="context")process.exit(2);if(mode==="prompt"&&result.code!=="request_contract_missing_genesis")process.exit(3);\n`);
	fs.writeFileSync(coordinator, 'const cp=require("child_process");const [worker,cwd,mode]=process.argv.slice(2);const specs=mode==="start"?[["start",cwd,"claude","A"],["start",cwd,"codex","B"]]:Array.from({length:6},(_,i)=>["prompt",cwd,"codex","Q","prompt-"+(i+1)]);Promise.all(specs.map(args=>new Promise(resolve=>{const child=cp.spawn(process.execPath,[worker,...args],{stdio:["ignore","ignore","pipe"]});let stderr="";child.stderr.on("data",x=>stderr+=x);child.on("exit",code=>resolve({code,stderr}));}))).then(results=>{for(const result of results)if(result.code!==0){process.stderr.write(result.stderr);process.exit(result.code)}process.exit(0)});\n');
	let result = cp.spawnSync(process.execPath, [coordinator, worker, fx.cwd, "start"], { encoding: "utf8", timeout: 20_000 });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(core.listUnits(fx.cwd).length, 1);
	const unit = { id: core.listUnits(fx.cwd)[0], paths: core.unitPaths(fx.cwd, core.listUnits(fx.cwd)[0]) };
	assert.equal(core.readJson(unit.paths.head).session_bindings.length, 2);

	fx = fixture();
	result = cp.spawnSync(process.execPath, [coordinator, worker, fx.cwd, "prompt"], { encoding: "utf8", timeout: 20_000 });
	assert.equal(result.status, 0, result.stderr);
	const quarantine = core.listUnconsumedQuarantine(fx.cwd);
	assert.equal(quarantine.length, 1);
	assert.equal(quarantine[0].head.count, 6);
	fs.unlinkSync(worker);
	fs.unlinkSync(coordinator);
});

test("full persisted lifecycle is policy-equivalent across Claude Code and Codex", () => {
	if (!process.env.TEST_FILTER) {
		return;
	}
	const snapshots = [];
	for (const client of ["claude", "codex"]) {
		const fx = fixture();
		const sessionId = `${client}-SESSION`;
		const nativeOutputs = [];
		nativeOutputs.push(runNativeAdapter(client, fx, nativeEnvelope(client, fx, "SessionStart", sessionId), "SessionStart"));
		nativeOutputs.push(runNativeAdapter(client, fx, nativeEnvelope(client, fx, "UserPromptSubmit", sessionId, { prompt: "Implement the complete requested feature" }), "UserPromptSubmit"));
		const unit = core.findUnit(fx.cwd, client, sessionId);
		assert(unit && !unit.error);
		bind(fx, unit);
		nativeOutputs.push(runNativeAdapter(client, fx, nativeEnvelope(client, fx, "PreToolUse", sessionId, { tool_name: "apply_patch", tool_input: { patch: "mutate" }, tool_use_id: "native-tool-1" }), "PreToolUse"));
		fs.writeFileSync(path.join(fx.cwd, "src", "product.txt"), "native lifecycle mutation\n");
		nativeOutputs.push(runNativeAdapter(client, fx, nativeEnvelope(client, fx, "PostToolUse", sessionId, { tool_name: "apply_patch", tool_input: { patch: "mutate" }, tool_response: { ok: true }, tool_use_id: "native-tool-1" }), "PostToolUse"));
		bind(fx, unit, core.readJson(unit.paths.contract));
		for (let index = 0; index < 3; index++) nativeOutputs.push(runNativeAdapter(client, fx, nativeEnvelope(client, fx, "Stop", sessionId), "Stop"));
		core.resumeIncomplete(unit, makeResumeReceipt(fx, unit), fx.cwd);
		ingestReview(fx, unit, cleanReview(fx, unit, "PARITY-ONE"));
		ingestReview(fx, unit, cleanReview(fx, unit, "PARITY-TWO"));
		nativeOutputs.push(runNativeAdapter(client, fx, nativeEnvelope(client, fx, "Stop", sessionId), "Stop"));
		assert(core.readJson(unit.paths.state).terminal);
		nativeOutputs.push(runNativeAdapter(client, fx, nativeEnvelope(client, fx, "PreCompact", sessionId), "PreCompact"));
		nativeOutputs.push(runNativeAdapter(client, fx, nativeEnvelope(client, fx, "PostCompact", sessionId), "PostCompact"));
		const before = projectedUnitSnapshot(unit, fx);
		const terminalAt = core.readJson(unit.paths.state).terminal.at;
		core.compactExpiredUnits(fx.cwd, terminalAt + 25 * 60 * 60 * 1000);
		const receiptsDir = path.join(core.harnessRoot(fx.cwd), "receipts-v2");
		const receipts = fs.readdirSync(receiptsDir).map((name) => ({ mode: fs.statSync(path.join(receiptsDir, name)).mode & 0o777, value: core.readJson(path.join(receiptsDir, name)) }));
		const claimsRoot = path.join(core.harnessRoot(fx.cwd), "claims");
		const claims = fs.readdirSync(claimsRoot).sort().map((kind) => ({ kind, values: fs.readdirSync(path.join(claimsRoot, kind)).sort().map((name) => core.readJson(path.join(claimsRoot, kind, name))) }));
		snapshots.push(core.canonicalParityProjection({ nativeOutputs: nativeOutputs.map(nativePolicyOutput), before, receipts, claims }));
	}
	const difference = firstDifference(snapshots[0], snapshots[1]);
	assert.equal(difference, null, difference && JSON.stringify(difference));
});

process.on("exit", () => {
	for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true });
	if (!process.exitCode) process.stdout.write(`1..${passed}\nrequest-contract: PASS (${passed} cases)\n`);
});
