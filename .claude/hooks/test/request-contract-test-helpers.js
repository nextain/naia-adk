"use strict";

/** Shared runtime, fixtures, and helpers for the request-contract suites. */

const assert = require("assert");
const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const core = require("../../../.agents/hooks/core/request-contract.js");
const adapter = require("../../../.agents/hooks/core/request-contract-adapter.js");
const reviewRunner = require("../../../.agents/hooks/core/request-contract-review-runner.js");
const { CLIENT_VERSIONS, EXPECTED_SANDBOX_ENGINE } = require("./request-contract-test-constants.js");
const {
	runNativeAdapter,
	nativePolicyOutput,
	installProductionControlSurface,
	runInstalledNativeAdapter,
	shellCommand,
	nativeEnvelope,
	makeAttestor,
	projectedUnitSnapshot,
	firstDifference,
} = require("./request-contract-native-helpers.js");

let passed = 0;
const runnerEvidenceByReview = new WeakMap();
const fixtureRoots = new Set();
const REVIEWER_EXTENSION = process.platform === "win32" ? ".cjs" : ".sh";
const reviewerFixturePath = (name) => path.join(__dirname, "fixtures", name + REVIEWER_EXTENSION);
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
		const codexRootResolution = 'root=${ADK_PROJECT_ROOT:-}; if [ -n "$root" ]; then case "$root" in /*) ;; *) exit 1;; esac; root=$(CDPATH= cd -- "$root" 2>/dev/null && pwd -P) || exit 1; else root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 1; fi; [ -f "$root/.codex/hooks.json" ] || exit 1;';
		const codexWindowsRootResolution = '$root=$env:ADK_PROJECT_ROOT; if ($root) { if (-not [IO.Path]::IsPathRooted($root)) { exit 1 }; try { $root=(Resolve-Path -LiteralPath $root -ErrorAction Stop).Path } catch { exit 1 } } else { $root=git rev-parse --show-toplevel 2>$null; if ($LASTEXITCODE -ne 0 -or -not $root) { exit 1 }; $root=$root.Trim() }; if (-not (Test-Path -LiteralPath (Join-Path $root ".codex/hooks.json"))) { exit 1 };';
		const hooks = Object.fromEntries(["PreToolUse", "SessionStart", "UserPromptSubmit", "PostToolUse", "PreCompact", "PostCompact", "Stop"].map((eventName) => {
			const hook = directory === ".claude"
				? { type: "command", command: `node \"$CLAUDE_PROJECT_DIR/${adapterPath}\" ${eventName}` }
				: {
					type: "command",
					command: `${codexRootResolution} registry=\"$root/.codex/hooks.json\"; [ ! -f \"$registry\" ] && exit 0; hook=\"$root/${adapterPath}\"; if [ ! -f \"$hook\" ]; then echo \"Configured Codex hook is missing: $hook\" >&2; exit 1; fi; node \"$hook\" ${eventName}`,
					commandWindows: `powershell -NoProfile -Command '${codexWindowsRootResolution} $registry=Join-Path $root.Trim() \".codex/hooks.json\"; if (-not (Test-Path -LiteralPath $registry)) { exit 0 }; $hook=Join-Path $root.Trim() \"${adapterPath}\"; if (-not (Test-Path -LiteralPath $hook)) { Write-Error \"Configured Codex hook is missing: $hook\"; exit 1 }; node $hook ${eventName}'`,
				};
			const matcher = directory === ".codex"
				? "Bash|shell_command|exec_command|(?:.*[.:/]exec_command)|(?:.*[.:/]shell_command)|Edit|Write|NotebookEdit|apply_patch"
				: "Bash|shell_command|Edit|Write|NotebookEdit|apply_patch";
			return [eventName, [{ ...(eventName === "PreToolUse" ? { matcher } : {}), hooks: [hook] }]];
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
		env: { REQUEST_CONTRACT_CHALLENGE: challenge.manifest.nonce, REQUEST_CONTRACT_CONTEXT_ID: `reviewer-${runId}-${challenge.manifest.nonce}`, REQUEST_CONTRACT_REVIEW_STAGE: challenge.manifest.review_stage, REQUEST_CONTRACT_REVIEW_ROLE: challenge.manifest.required_role || "general", REQUEST_CONTRACT_DELIVERY_STATE: challenge.manifest.expected_delivery_state },
	});
	const review = {
		...isolated.output,
		review_stage: challenge.manifest.review_stage,
		role: challenge.manifest.required_role || "general",
		planning_digest: challenge.manifest.planning_digest,
		planning_seal_digest: challenge.manifest.planning_seal_digest,
		delivery_state: isolated.output.delivery_state,
		preservation_vetoes: isolated.output.preservation_vetoes || [],
		run_id: challenge.manifest.review_run_id,
		reviewed_at: isolated.evidence.executed_at,
		bundle_digest: challenge.manifest.bundle_digest,
		full_bundle_digest: challenge.manifest.full_bundle_digest,
		evidence_view_digest: challenge.manifest.evidence_view_digest,
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

process.on("exit", () => {
	for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true });
	if (!process.exitCode) process.stdout.write(`1..${passed}\nrequest-contract: PASS (${passed} cases)\n`);
});

module.exports = {
	test,
	assert,
	cp,
	crypto,
	fs,
	os,
	path,
	core,
	adapter,
	reviewRunner,
	runnerEvidenceByReview,
	fixtureRoots,
	REVIEWER_EXTENSION,
	EXPECTED_SANDBOX_ENGINE,
	reviewerFixturePath,
	CLIENT_VERSIONS,
	SANDBOX_EXECUTABLE,
	SANDBOX_EXECUTABLE_DIGEST,
	runSandbox,
	writeReviewer,
	withDeniedReaddir,
	fixture,
	start,
	signedReceipt,
	traceGraph,
	mergeGraph,
	sourceDeclaration,
	addContractSource,
	synchronizeObligationCoverage,
	makeContract,
	coverOccurrences,
	bind,
	runSyntheticReviewSandbox,
	cleanReview,
	ingestReview,
	runNativeAdapter,
	nativePolicyOutput,
	installProductionControlSurface,
	runInstalledNativeAdapter,
	shellCommand,
	nativeEnvelope,
	makeAttestor,
	makeResumeReceipt,
	projectedUnitSnapshot,
	firstDifference,
};
