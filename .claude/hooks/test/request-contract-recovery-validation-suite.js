"use strict";

/** Request-contract tests: recovery, schema validation, and review isolation. */

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
	reviewerFixturePath,
	CLIENT_VERSIONS,
	runSandbox,
	writeReviewer,
	fixture,
	start,
	signedReceipt,
	makeContract,
	coverOccurrences,
	bind,
	cleanReview,
	ingestReview,
	makeAttestor,
	makeResumeReceipt,
} = require("./request-contract-test-helpers.js");

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
			const encodedPrefix = "powershell -NoProfile -NonInteractive -EncodedCommand ";
			if (hook.commandWindows.startsWith(encodedPrefix)) {
				args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", hook.commandWindows.slice(encodedPrefix.length)];
			} else {
				let script = hook.commandWindows.replace(/^powershell(?:\.exe)?\s+-NoProfile\s+-Command\s+/, "");
				if (script.startsWith('"') && script.endsWith('"')) script = script.slice(1, -1);
				args = ["-NoProfile", "-Command", script];
			}
		} else {
			executable = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
			args = ["-c", hook.command];
		}
		const output = cp.execFileSync(executable, args, { cwd: nested, input, encoding: "utf8", env: { ...process.env, REQUEST_CONTRACT: "off", CLAUDE_PROJECT_DIR: root } });
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
