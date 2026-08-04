"use strict";

/** Request-contract tests: governance stickiness and review-runner controls. */

const {
	test,
	assert,
	cp,
	crypto,
	fs,
	os,
	path,
	core,
	reviewRunner,
	runnerEvidenceByReview,
	EXPECTED_SANDBOX_ENGINE,
	reviewerFixturePath,
	CLIENT_VERSIONS,
	runSandbox,
	writeReviewer,
	fixture,
	start,
	makeContract,
	coverOccurrences,
	bind,
	cleanReview,
	ingestReview,
	installProductionControlSurface,
	runInstalledNativeAdapter,
	shellCommand,
	nativeEnvelope,
} = require("./request-contract-test-helpers.js");

test("disabled mode is a silent allow", () => {
	const fx = fixture();
	const configPath = path.join(fx.cwd, ".agents", "context", "request-contract.json");
	const config = core.readJson(configPath);
	config.installation_state = "unprovisioned";
	config.enabled_by_default = false;
	fs.writeFileSync(configPath, JSON.stringify(config));
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
	const initialCompletion = core.evaluateCompletion(unit, fx.cwd, "claude");
	assert.equal(initialCompletion.kind, "allow", JSON.stringify(initialCompletion));
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
		const result = runSandbox({
			bundlePath,
			expectedBundleDigest: core.sha256(fs.readFileSync(bundlePath)),
			reviewerPath,
			allowedReviewerDigests: [core.sha256(fs.readFileSync(reviewerPath))],
			// A caller-supplied missing path would make a porous sandbox look blind if
			// it could replace the trusted repository probe.
			env: { REQUEST_CONTRACT_REPOSITORY_PROBE: path.join(fx.cwd, "caller-selected-missing-probe") },
		});
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
	assert.deepEqual(Object.keys(isolated.output).sort(), ["covered_artifact_ids", "covered_authority_ids", "covered_authority_mappings", "covered_change_ids", "covered_change_mappings", "covered_criterion_ids", "covered_directive_ids", "covered_edge_ids", "covered_preservation_surface_mappings", "covered_scope_version_ids", "covered_scope_version_mappings", "covered_source_ids", "covered_source_mappings", "covered_target_ids", "covered_tombstone_ids", "covered_tombstone_mappings", "delivery_state", "finding_codes", "invocation_nonce", "preservation_vetoes", "review_stage", "role", "verdict"].sort());
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
	const joinWords = ["node", operatorScript, "join-session", "--unit", unit.id, "--client", "codex", "--session", "JOINED-CODEX", "--client-version", CLIENT_VERSIONS.codex];
	envelope = { hook_event_name: "PreToolUse", session_id: "S1", cwd: fx.cwd, tool_name: "Bash", tool_use_id: "control-join", tool_input: { command: shellCommand(joinWords) } };
	assert.equal(runInstalledNativeAdapter("claude", fx, envelope, "PreToolUse"), null);
	cp.execFileSync(joinWords[0], joinWords.slice(1), { cwd: fx.cwd, encoding: "utf8" });
	assert.equal(runInstalledNativeAdapter("claude", fx, { ...envelope, hook_event_name: "PostToolUse" }, "PostToolUse"), null);
	assert.equal(core.findUnit(fx.cwd, "codex", "JOINED-CODEX").id, unit.id);
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
	const completion = core.evaluateCompletion(unit, fx.cwd, "claude");
	assert.equal(completion.kind, "allow", JSON.stringify(completion));
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
