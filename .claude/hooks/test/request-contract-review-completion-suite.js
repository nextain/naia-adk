"use strict";

/** Request-contract tests: review ingestion, leases, and completion. */

const {
	test,
	assert,
	cp,
	crypto,
	fs,
	path,
	core,
	CLIENT_VERSIONS,
	fixture,
	start,
	makeContract,
	bind,
	cleanReview,
	ingestReview,
} = require("./request-contract-test-helpers.js");

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
