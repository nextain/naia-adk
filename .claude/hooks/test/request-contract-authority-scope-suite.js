"use strict";

/** Request-contract tests: authority, scope history, and occurrence mapping. */

const {
	test,
	assert,
	crypto,
	fs,
	path,
	core,
	fixture,
	start,
	signedReceipt,
	traceGraph,
	mergeGraph,
	addContractSource,
	synchronizeObligationCoverage,
	makeContract,
	bind,
} = require("./request-contract-test-helpers.js");

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
