"use strict";

/** Request-contract tests: source, quarantine, trace, and terminal semantics. */

const {
	test,
	assert,
	crypto,
	fs,
	path,
	core,
	adapter,
	CLIENT_VERSIONS,
	fixture,
	start,
	signedReceipt,
	makeContract,
	bind,
	nativeEnvelope,
} = require("./request-contract-test-helpers.js");

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

test("a new lineage adopts only quarantine chains from its explicitly bound session", () => {
	const fx = fixture();
	core.handleEvent({ client: "codex", eventName: "UserPromptSubmit", sessionId: "NEW", cwd: fx.cwd, prompt: "owned prompt", origin: "native_user" });
	core.handleEvent({ client: "claude", eventName: "UserPromptSubmit", sessionId: "OLD2", cwd: fx.cwd, prompt: "orphan two", origin: "native_user" });
	core.handleEvent({ client: "codex", clientVersion: CLIENT_VERSIONS.codex, eventName: "SessionStart", sessionId: "NEW", cwd: fx.cwd });
	const unit = core.findUnit(fx.cwd, "codex", "NEW");
	const records = core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records;
	assert.deepEqual(records.map((r) => r.prompt), ["owned prompt"]);
	const remaining = core.listUnconsumedQuarantine(fx.cwd);
	assert.equal(remaining.length, 1);
	assert.equal(remaining[0].head.client, "claude");
	assert.equal(remaining[0].head.session_id, "OLD2");
	assert.deepEqual(core.readJsonl(path.join(remaining[0].dir, "sources.jsonl")).map((record) => record.prompt), ["orphan two"]);
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
	core.handleEvent({ client: "claude", eventName: "UserPromptSubmit", sessionId: "NEW", cwd: fx.cwd, prompt: "cross-bound source", origin: "native_user" });
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

test("a new client session starts a distinct lineage instead of implicitly joining", () => {
	const fx = fixture();
	const first = start(fx, "claude", "OLD");
	const result = core.handleEvent({ client: "codex", clientVersion: CLIENT_VERSIONS.codex, eventName: "SessionStart", sessionId: "NEW", cwd: fx.cwd });
	assert.equal(result.kind, "context");
	const separate = core.findUnit(fx.cwd, "codex", "NEW");
	assert.notEqual(separate.id, first.id);
	assert.equal(core.listUnits(fx.cwd).length, 2);
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
