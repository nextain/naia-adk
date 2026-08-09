"use strict";
module.exports = function createRequestContractModule(api) {
const {
	crypto, fs, path, preservationPolicy, VERSION, ZERO_HASH, REVIEW_FINDING_CODES, PRESERVATION_REVIEW_STAGES,
	PRESERVATION_REVIEW_ROLES, closedObject, sha256, publicKeyFingerprint, opaqueId, canonicalJson, durableUnlink, secureWrite,
	secureJson, readJson, requiredJson, optionalJson, readUnitState, writeUnitState, readJsonlStrict, normalizeRel,
	loadConfig, loadAuthorityKey, loadReviewerKey, loadReviewRunnerKey, governed, withUnitLock, withRepositoryLock, claimGlobalId,
	claimGlobalIds, verifyGlobalClaim, transactionPath, applyReviewTransaction, assertUnitMutable, gitBufferStrict, workspaceManifest, diffManifests,
	verifySourceChain, validateContract, verifyScopeHistory, scopeHistoryCoverage, contractCoverageIds,
} = api;
function collectReviewMaterials(...args) { return api.collectReviewMaterials(...args); }
function collectBaselineReviewMaterials(...args) { return api.collectBaselineReviewMaterials(...args); }
function buildReviewBundle(...args) { return api.buildReviewBundle(...args); }
function effectiveReviewRoles(...args) { return api.effectiveReviewRoles(...args); }
function expectedDeliveryState(...args) { return api.expectedDeliveryState(...args); }
function requiredReviewSlots(...args) { return api.requiredReviewSlots(...args); }
function planningSeal(...args) { return api.planningSeal(...args); }
function buildReviewEvidenceView(...args) { return api.buildReviewEvidenceView(...args); }
function reviewSignaturePayload(...args) { return api.reviewSignaturePayload(...args); }
function isolationSignaturePayload(...args) { return api.isolationSignaturePayload(...args); }
function reviewInvocationProjection(...args) { return api.reviewInvocationProjection(...args); }
function reviewInvocationDigestValid(...args) { return api.reviewInvocationDigestValid(...args); }
function cleanupExpiredReviewInvocations(...args) { return api.cleanupExpiredReviewInvocations(...args); }
function issueReviewInvocation(...args) { return api.issueReviewInvocation(...args); }

function observeOccurrence(unit, detail, now = Date.now()) {
	return withUnitLock(unit, () => observeOccurrenceUnlocked(unit, detail, now), now);
}

function observeOccurrenceUnlocked(unit, detail, now = Date.now()) {
	assertUnitMutable(unit);
	const head = requiredJson(unit.paths.head, "unit_head_corrupt");
	const state = readUnitState(unit, head);
	const signature = sha256(canonicalJson(detail));
	const occurrence = { id: `CHG-${opaqueId()}`, ts: now, signature, detail };
	state.occurrences.push(occurrence);
	head.work_revision += 1;
	writeUnitState(unit, state, head);
	return occurrence;
}

function captureWorkspaceOccurrences(unit, cwd, opts = {}) {
	return withUnitLock(unit, () => {
		const head = requiredJson(unit.paths.head, "unit_head_corrupt");
		const lifecycle = readUnitState(unit, head);
		const terminalLease = opts.allowTerminalIncompleteLease && lifecycle.terminal && lifecycle.terminal.status === "incomplete" && lifecycle.active_mutations && lifecycle.active_mutations[opts.allowTerminalIncompleteLease];
		if (!terminalLease) assertUnitMutable(unit);
		const config = loadConfig(cwd);
		const state = lifecycle;
		const current = workspaceManifest(cwd, config);
		if (config.digest !== head.config_digest) return { current, configDrift: true, occurrences: state.occurrences };
		const prior = state.observed_workspace || state.baseline;
		const differences = diffManifests(prior, current.manifest);
		for (const detail of differences) {
			const normalized = { source: "workspace", ...detail };
			state.occurrences.push({ id: `CHG-${opaqueId()}`, ts: Date.now(), signature: sha256(canonicalJson(normalized)), detail: normalized });
		}
		state.observed_workspace = current.manifest;
		if (differences.length) head.work_revision += differences.length;
		writeUnitState(unit, state, head);
		return { current, configDrift: false, occurrences: state.occurrences };
	});
}

function verifyReviewChain(paths) {
	let records;
	try {
		records = readJsonlStrict(paths.reviews, "review_log_corrupt", { allowMissing: true });
	} catch (error) {
		return { ok: false, errors: [error.code], records: [], head: null };
	}
	const head = optionalJson(paths.reviewHead, { count: 0, chain_head: ZERO_HASH }, "review_head_corrupt");
	const errors = [];
	let prev = ZERO_HASH;
	for (let i = 0; i < records.length; i++) {
		const r = records[i];
		const payload = { ...r };
		delete payload.record_hash;
		if (r.seq !== i + 1 || r.prev_hash !== prev) errors.push("review_chain_sequence_invalid");
		if (sha256(canonicalJson(payload)) !== r.record_hash) errors.push("review_chain_hash_invalid");
		prev = r.record_hash;
	}
	if (records.length !== head.count || (records.length ? prev : ZERO_HASH) !== head.chain_head) errors.push("review_head_mismatch");
	return { ok: errors.length === 0, errors: [...new Set(errors)], records, head };
}

function appendReview(unit, review, opts = {}) {
	const cwd = opts.cwd || path.resolve(unit.paths.unit, "../../../..");
	return withRepositoryLock(cwd, () => withUnitLock(unit, () => appendReviewUnlocked(unit, review, { ...opts, cwd })), opts.now || Date.now());
}

function appendReviewUnlocked(unit, review, opts = {}) {
	assertUnitMutable(unit);
	const errors = [];
	const now = opts.now || Date.now();
	const cwd = opts.cwd || path.resolve(unit.paths.unit, "../../../..");
	const config = loadConfig(cwd);
	const boundContract = optionalJson(unit.paths.contract, null, "contract_state_corrupt");
	const preservationReview = Boolean(config.preservation.required || boundContract && boundContract.preservation);
	cleanupExpiredReviewInvocations(unit, now);
	closedObject(review, ["verdict", "review_stage", "role", "planning_digest", "planning_seal_digest", "delivery_state", "preservation_vetoes", "run_id", "invocation_nonce", "bundle_digest", "full_bundle_digest", "evidence_view_digest", "source_head", "contract_digest", "workspace_digest", "config_digest", "scope_epoch", "work_revision", "binding_epoch", "covered_source_ids", "covered_source_mappings", "covered_directive_ids", "covered_target_ids", "covered_criterion_ids", "covered_authority_ids", "covered_authority_mappings", "covered_tombstone_ids", "covered_tombstone_mappings", "covered_scope_version_ids", "covered_scope_version_mappings", "covered_artifact_ids", "covered_edge_ids", "covered_change_ids", "covered_change_mappings", "covered_preservation_surface_mappings", "finding_codes", "sandbox", "executor", "isolation", "reviewed_at"], errors, "review");
	if (!review || !["CLEAN", "DIRTY"].includes(review.verdict)) errors.push("review_verdict_invalid");
	if (!review || !/^RUN-[a-f0-9]{32}$/.test(review.run_id || "")) errors.push("review_run_id_invalid");
	if (!review || !review.bundle_digest) errors.push("review_bundle_digest_missing");
	if (!review || !review.invocation_nonce) errors.push("review_invocation_nonce_missing");
	if (opts.expectedBundleDigest && review.bundle_digest !== opts.expectedBundleDigest) errors.push("review_bundle_digest_mismatch");
	if (!review || !review.sandbox || review.sandbox.no_network !== true) errors.push("review_network_isolation_missing");
	if (!review || !review.sandbox || review.sandbox.repository_blind !== true) errors.push("review_repository_blindness_missing");
	if (!review || !review.sandbox || review.sandbox.home_blind !== true) errors.push("review_home_blindness_missing");
	if (review && review.sandbox) closedObject(review.sandbox, ["no_network", "repository_blind", "home_blind"], errors, "review_sandbox");
	if (!review || !Array.isArray(review.finding_codes) || review.finding_codes.some((code) => !REVIEW_FINDING_CODES.has(code))) errors.push("review_finding_codes_invalid");
	else if ((review.verdict === "CLEAN" && review.finding_codes.length !== 0) || (review.verdict === "DIRTY" && review.finding_codes.length === 0)) errors.push("review_verdict_findings_mismatch");
	if (!review || typeof review.role !== "string" || !/^[a-z][a-z0-9_-]{2,63}$/.test(review.role)) errors.push("review_role_invalid");
	if (!review || !PRESERVATION_REVIEW_STAGES.includes(review.review_stage)) errors.push("review_stage_invalid");
	if (!review || !/^[a-f0-9]{64}$/.test(review.planning_digest || "")) errors.push("review_planning_digest_invalid");
	if (review && review.review_stage === "integration" && preservationReview && !/^[a-f0-9]{64}$/.test(review.planning_seal_digest || "")) errors.push("review_planning_seal_missing");
	if (review && review.review_stage === "planning" && review.planning_seal_digest !== null) errors.push("review_planning_seal_premature");
	if (!review || !/^[a-f0-9]{64}$/.test(review.full_bundle_digest || "")) errors.push("review_full_bundle_digest_invalid");
	if (!review || review.evidence_view_digest !== review.bundle_digest) errors.push("review_evidence_view_digest_mismatch");
	if (!review || !["RELEASE_ELIGIBLE", "REVIEW_ONLY"].includes(review.delivery_state)) errors.push("review_delivery_state_invalid");
	if (!review || !Array.isArray(review.preservation_vetoes) || review.preservation_vetoes.some((code) => typeof code !== "string" || !code.trim())) errors.push("review_preservation_vetoes_invalid");
	else if (review.verdict === "CLEAN" && (review.delivery_state !== expectedDeliveryState(config, boundContract) || review.preservation_vetoes.length)) errors.push("review_clean_delivery_invalid");
	if (!review || !Number.isInteger(review.reviewed_at)) errors.push("review_reviewed_at_invalid");
	let invocation = null;
	if (review && review.invocation_nonce) {
		invocation = readJson(path.join(unit.paths.pending, `review-${review.invocation_nonce}.json`));
			if (!invocation) errors.push("review_invocation_unknown");
			else {
				if (!reviewInvocationDigestValid(invocation)) errors.push("review_invocation_manifest_tampered");
				if (invocation.consumed) errors.push("review_invocation_replayed");
			if (invocation.expired) errors.push("review_invocation_expired");
			if (now > invocation.expires_at) errors.push("review_invocation_expired");
				if (review.bundle_digest !== invocation.bundle_digest) errors.push("review_invocation_bundle_mismatch");
				if (review.run_id !== invocation.review_run_id) errors.push("review_run_id_not_issued");
				if (review.review_stage !== invocation.review_stage) errors.push("review_stage_not_issued");
				if (review.role !== invocation.required_role) errors.push("review_role_not_issued");
				if (review.delivery_state !== invocation.expected_delivery_state) errors.push("review_delivery_state_not_issued");
				if (review.planning_digest !== invocation.planning_digest) errors.push("review_planning_digest_not_issued");
				if (review.planning_seal_digest !== invocation.planning_seal_digest) errors.push("review_planning_seal_not_issued");
				if (review.full_bundle_digest !== invocation.full_bundle_digest) errors.push("review_full_bundle_digest_not_issued");
				if (review.evidence_view_digest !== invocation.evidence_view_digest) errors.push("review_evidence_view_not_issued");
				for (const field of ["source_head", "contract_digest", "workspace_digest", "config_digest", "scope_epoch", "work_revision", "binding_epoch"]) if (review[field] !== invocation[field]) errors.push(`review_${field}_not_issued`);
				if (Number.isInteger(review.reviewed_at) && (review.reviewed_at < invocation.issued_at || review.reviewed_at > now + 30_000)) errors.push("review_reviewed_at_invalid");
				const expectedBundlePath = path.join(unit.paths.pending, `bundle-${review.invocation_nonce}.json`);
				if (path.resolve(invocation.private_bundle_path || "") !== path.resolve(expectedBundlePath)) errors.push("review_invocation_bundle_path_invalid");
				try {
					if (sha256(fs.readFileSync(expectedBundlePath)) !== invocation.bundle_digest) errors.push("review_invocation_bundle_tampered");
				} catch {
					errors.push("review_invocation_bundle_unavailable");
				}
			}
	}
	const executor = review && review.executor;
	if (executor) closedObject(executor, ["credential_id", "context_id", "process_id", "process_identity", "started_at", "attestor_executable_digest", "signature"], errors, "review_executor");
	if (!executor || !executor.credential_id || !executor.context_id || !executor.process_id || !executor.process_identity || !executor.started_at || !executor.signature) errors.push("review_executor_attestation_missing");
	if (executor && (!/^[a-f0-9]{64}$/.test(executor.attestor_executable_digest || "") || !config.reviewer.allowed_attestor_digests.includes(executor.attestor_executable_digest))) errors.push("review_executor_attestor_not_allowed");
		if (executor && invocation && (invocation.writer_session_ids || [invocation.writer_session_id]).includes(executor.context_id)) errors.push("review_context_not_independent");
		if (executor && invocation && (invocation.writer_process_ids || []).includes(executor.process_id)) errors.push("review_process_not_independent");
		if (executor && invocation && (invocation.writer_process_identities || []).includes(executor.process_identity)) errors.push("review_process_not_independent");
	if (opts.reviewerCredentialId && executor && executor.credential_id !== opts.reviewerCredentialId) errors.push("review_executor_credential_mismatch");
	const isolation = review && review.isolation;
	if (isolation) closedObject(isolation, ["credential_id", "execution_id", "challenge", "bundle_digest", "reviewer_context_id", "reviewer_process_id", "reviewer_process_identity", "launcher_process_id", "sandbox_engine", "sandbox_profile_digest", "sandbox_executable_digest", "reviewer_executable_digest", "attestor_executable_digest", "review_payload_digest", "no_network", "repository_blind", "home_blind", "started_at", "executed_at", "signature"], errors, "review_isolation");
	if (!isolation || !isolation.credential_id || !isolation.execution_id || !isolation.signature) errors.push("review_isolation_attestation_missing");
	if (isolation && invocation) {
		if (isolation.challenge !== invocation.nonce) errors.push("review_isolation_challenge_mismatch");
		if (isolation.bundle_digest !== invocation.bundle_digest) errors.push("review_isolation_bundle_mismatch");
		if (!executor || isolation.reviewer_context_id !== executor.context_id || isolation.reviewer_process_id !== executor.process_id || isolation.reviewer_process_identity !== executor.process_identity) errors.push("review_isolation_executor_mismatch");
		if (review.reviewed_at !== isolation.executed_at) errors.push("review_reviewed_at_invalid");
	}
	if (isolation && (isolation.no_network !== true || isolation.repository_blind !== true || isolation.home_blind !== true)) errors.push("review_isolation_controls_missing");
	if (isolation && (!isolation.launcher_process_id || !["bubblewrap", "codex-windows-elevated"].includes(isolation.sandbox_engine) || !/^[a-f0-9]{64}$/.test(isolation.sandbox_profile_digest || "") || !/^[a-f0-9]{64}$/.test(isolation.sandbox_executable_digest || "") || !/^[a-f0-9]{64}$/.test(isolation.reviewer_executable_digest || ""))) errors.push("review_isolation_execution_evidence_missing");
	if (isolation && !config.review_runner.allowed_sandbox_digests.includes(isolation.sandbox_executable_digest)) errors.push("review_sandbox_executable_not_allowed");
	if (isolation && !config.review_runner.allowed_reviewer_digests.includes(isolation.reviewer_executable_digest)) errors.push("reviewer_executable_not_allowed");
	if (isolation && (!/^[a-f0-9]{64}$/.test(isolation.attestor_executable_digest || "") || !config.review_runner.allowed_attestor_digests.includes(isolation.attestor_executable_digest))) errors.push("review_isolation_attestor_not_allowed");
	if (isolation && isolation.review_payload_digest !== sha256(canonicalJson(reviewSignaturePayload(review)))) errors.push("review_isolation_payload_mismatch");
	if (opts.reviewRunnerCredentialId && isolation && isolation.credential_id !== opts.reviewRunnerCredentialId) errors.push("review_isolation_credential_mismatch");
	if (executor && isolation && executor.credential_id === isolation.credential_id) errors.push("review_isolation_credential_not_separate");
	if (!opts.reviewRunnerPublicKey) errors.push("review_isolation_public_key_unavailable");
	if (opts.reviewRunnerPublicKey && isolation && isolation.signature) {
		try {
			const ok = crypto.verify(null, Buffer.from(canonicalJson(isolationSignaturePayload(isolation))), opts.reviewRunnerPublicKey, Buffer.from(isolation.signature, "base64"));
			if (!ok) errors.push("review_isolation_signature_invalid");
		} catch {
			errors.push("review_isolation_signature_invalid");
		}
	}
	if (invocation && invocation.ids) {
		for (const [field, key] of [
			["covered_source_ids", "sourceIds"], ["covered_source_mappings", "sourceMappings"], ["covered_directive_ids", "directiveIds"], ["covered_target_ids", "targetIds"], ["covered_criterion_ids", "criterionIds"], ["covered_authority_ids", "authorityIds"], ["covered_authority_mappings", "authorityMappings"], ["covered_tombstone_ids", "tombstoneIds"], ["covered_tombstone_mappings", "tombstoneMappings"], ["covered_scope_version_ids", "scopeVersionIds"], ["covered_scope_version_mappings", "scopeVersionMappings"], ["covered_artifact_ids", "artifactIds"], ["covered_edge_ids", "edgeIds"], ["covered_change_ids", "occurrenceIds"], ["covered_change_mappings", "changeMappings"], ["covered_preservation_surface_mappings", "preservationSurfaceMappings"],
		]) if (!arrayExactly(review && review[field], invocation.ids[key] || [])) errors.push(`review_${field}_not_exact`);
	}
	const head = requiredJson(unit.paths.head, "unit_head_corrupt");
	if (config.digest !== head.config_digest) errors.push("review_config_drift");
	const currentState = readUnitState(unit, head);
	if (currentState.active_mutations && Object.keys(currentState.active_mutations).length) errors.push("review_mutation_in_flight");
	if (invocation) {
		try {
			const currentBinding = requiredJson(unit.paths.binding, "binding_state_corrupt");
			const currentContract = requiredJson(unit.paths.contract, "contract_state_corrupt");
			const currentBundle = invocation.required_role === "general" && !effectiveReviewRoles(config, currentContract).length
				? buildReviewBundle(unit, cwd)
				: buildReviewBundle(unit, cwd, { stage: invocation.review_stage, role: invocation.required_role });
			const currentPlanningSeal = planningSeal(unit, config, currentBinding, head, currentContract);
			const currentBindings = {
				bundle_digest: currentBundle.digest,
				full_bundle_digest: currentBundle.full_digest,
				evidence_view_digest: currentBundle.digest,
				source_head: head.source_head,
				contract_digest: head.contract_digest,
				workspace_digest: currentBundle.workspace.digest,
				config_digest: head.config_digest,
				scope_epoch: head.scope_epoch,
				work_revision: head.work_revision,
				binding_epoch: currentBinding.binding_epoch,
				planning_digest: currentBinding.planning_digest,
				planning_seal_digest: invocation.review_stage === "integration" ? currentPlanningSeal.digest : null,
			};
			if (Object.entries(currentBindings).some(([field, value]) => invocation[field] !== value)) errors.push("review_post_launch_drift");
		} catch {
			errors.push("review_post_launch_drift");
		}
	}
	if (opts.reviewerPublicKey && publicKeyFingerprint(opts.reviewerPublicKey) !== head.reviewer_key_fingerprint) errors.push("reviewer_key_pin_mismatch");
	if (opts.reviewRunnerPublicKey && publicKeyFingerprint(opts.reviewRunnerPublicKey) !== head.review_runner_key_fingerprint) errors.push("review_runner_key_pin_mismatch");
	if (!opts.reviewerPublicKey) errors.push("review_executor_public_key_unavailable");
	if (opts.reviewerPublicKey && executor && executor.signature) {
		try {
			const ok = crypto.verify(null, Buffer.from(canonicalJson(reviewSignaturePayload(review))), opts.reviewerPublicKey, Buffer.from(executor.signature, "base64"));
			if (!ok) errors.push("review_executor_signature_invalid");
		} catch {
			errors.push("review_executor_signature_invalid");
		}
	}
	const priorChain = verifyReviewChain(unit.paths);
	if (!priorChain.ok) errors.push(...priorChain.errors);
	if (priorChain.records.some((record) => record.run_id === (review && review.run_id))) errors.push("review_run_id_replayed");
	if (priorChain.records.some((record) => record.invocation_nonce === (review && review.invocation_nonce))) errors.push("review_invocation_replayed");
	if (priorChain.records.some((record) => record.isolation && review && review.isolation && record.isolation.execution_id === review.isolation.execution_id)) errors.push("review_execution_id_replayed");
	if (priorChain.records.some((record) => record.executor && review && review.executor && record.executor.context_id === review.executor.context_id)) errors.push("review_context_replayed");
	if (priorChain.records.some((record) => record.executor && review && review.executor && record.executor.process_id === review.executor.process_id && record.executor.started_at === review.executor.started_at)) errors.push("review_process_replayed");
	if (review && review.invocation_nonce) {
		try { verifyGlobalClaim(cwd, "review-invocation", review.invocation_nonce, { unit_id: unit.id, invocation_digest: invocation && invocation.invocation_digest }); } catch (error) { errors.push(error.code || "review_invocation_claim_invalid"); }
	}
	if (errors.length) throw Object.assign(new Error(errors.join(", ")), { code: "review_invalid", errors });
	const runner = require("./request-contract-review-runner.js");
	if (!runner.consumeRunEvidence(opts.runnerEvidence, review)) throw Object.assign(new Error("review receipt was not produced by a live trusted runner execution"), { code: "review_runner_provenance_missing" });
	const reviewDigest = sha256(canonicalJson(review));
	claimGlobalIds(cwd, [
		{ kind: "review-run", value: review.run_id, owner: { unit_id: unit.id, review_digest: reviewDigest } },
		{ kind: "review-execution", value: review.isolation.execution_id, owner: { unit_id: unit.id, review_digest: reviewDigest } },
		{ kind: "review-context", value: review.executor.context_id, owner: { unit_id: unit.id, review_digest: reviewDigest } },
		{ kind: "review-process", value: canonicalJson({ process_id: review.executor.process_id, process_identity: review.executor.process_identity, started_at: review.executor.started_at }), owner: { unit_id: unit.id, review_digest: reviewDigest } },
	]);
	const rh = optionalJson(unit.paths.reviewHead, { version: VERSION, count: 0, chain_head: ZERO_HASH }, "review_head_corrupt");
	const payload = { ...review, version: VERSION, seq: rh.count + 1, prev_hash: rh.chain_head };
	const record = { ...payload, record_hash: sha256(canonicalJson(payload)) };
	invocation.consumed = true;
	invocation.consumed_at = now;
	invocation.review_record_hash = record.record_hash;
	const transaction = {
		version: VERSION,
		kind: "review",
		created_at: now,
		expected_review: { count: rh.count, chain_head: rh.chain_head },
		record,
		review_head: { ...rh, count: record.seq, chain_head: record.record_hash },
		invocation_name: `review-${review.invocation_nonce}.json`,
		invocation,
		private_bundle_name: invocation.private_bundle_path ? path.basename(invocation.private_bundle_path) : null,
	};
	secureJson(transactionPath(unit, "review"), transaction, { exclusive: true });
	if (opts.afterTransactionPrepared) opts.afterTransactionPrepared(transaction);
	applyReviewTransaction(unit, transaction);
	return record;
}

function arrayCovers(actual, expected) {
	const set = new Set(actual || []);
	return expected.every((x) => set.has(x));
}

function arrayExactly(actual, expected) {
	return Array.isArray(actual) && actual.length === expected.length && arrayCovers(actual, expected);
}

function evaluateReviews(unit, bindings, minimum = 2) {
	const cwd = bindings.cwd || path.resolve(unit.paths.unit, "../../../..");
	const chain = verifyReviewChain(unit.paths);
	if (!chain.ok) return { ok: false, errors: chain.errors };
	const clean = [];
	const invocationNonces = new Set();
	const executionIds = new Set();
	const reviewerContexts = new Set();
	const reviewerProcesses = new Set();
	const requiredRoles = [...new Set(bindings.required_roles || [])];
	const requiredStages = [...new Set(bindings.required_stages || (requiredRoles.length ? ["integration"] : []))];
	const requiredSlots = requiredRoles.length ? requiredStages.flatMap((stage) => requiredRoles.map((role) => `${stage}:${role}`)) : ["integration:general"];
	const target = Math.max(minimum, requiredSlots.length);
	const coveredSlots = new Set();
	const evidenceViews = new Set();
	const runCounts = new Map();
	const executionCounts = new Map();
	for (const record of chain.records) {
		if (record.run_id) runCounts.set(record.run_id, (runCounts.get(record.run_id) || 0) + 1);
		if (record.isolation && record.isolation.execution_id) executionCounts.set(record.isolation.execution_id, (executionCounts.get(record.isolation.execution_id) || 0) + 1);
	}
	for (let i = chain.records.length - 1; i >= 0 && clean.length < target; i--) {
		const r = chain.records[i];
		if (r.verdict !== "CLEAN") break;
		const stableFields = ["source_head", "contract_digest", "config_digest", "scope_epoch", "binding_epoch"];
		const integrationFields = ["workspace_digest", "work_revision"];
		const same = stableFields.every((k) => r[k] === bindings[k]) && (r.review_stage === "planning" || integrationFields.every((k) => r[k] === bindings[k]));
		const covered =
			arrayExactly(r.covered_source_ids, bindings.ids.sourceIds) &&
			arrayExactly(r.covered_source_mappings, bindings.ids.sourceMappings) &&
			arrayExactly(r.covered_directive_ids, bindings.ids.directiveIds) &&
				arrayExactly(r.covered_target_ids, bindings.ids.targetIds) &&
				arrayExactly(r.covered_criterion_ids, bindings.ids.criterionIds) &&
				arrayExactly(r.covered_authority_ids, bindings.ids.authorityIds) &&
				arrayExactly(r.covered_authority_mappings, bindings.ids.authorityMappings) &&
				arrayExactly(r.covered_tombstone_ids, bindings.ids.tombstoneIds) &&
				arrayExactly(r.covered_tombstone_mappings, bindings.ids.tombstoneMappings) &&
				arrayExactly(r.covered_scope_version_ids, bindings.ids.scopeVersionIds) &&
				arrayExactly(r.covered_scope_version_mappings, bindings.ids.scopeVersionMappings) &&
				arrayExactly(r.covered_artifact_ids, bindings.ids.artifactIds) &&
				arrayExactly(r.covered_edge_ids, bindings.ids.edgeIds) &&
				arrayExactly(r.covered_change_ids, bindings.ids.occurrenceIds) &&
				arrayExactly(r.covered_change_mappings, bindings.ids.changeMappings) &&
				arrayExactly(r.covered_preservation_surface_mappings, bindings.ids.preservationSurfaceMappings || []);
		const isolated = r.sandbox && r.sandbox.no_network === true && r.sandbox.repository_blind === true && r.sandbox.home_blind === true;
		const findingsValid = Array.isArray(r.finding_codes) && r.finding_codes.length === 0;
		const preservationValid = Array.isArray(r.preservation_vetoes) && r.preservation_vetoes.length === 0 && r.delivery_state === (bindings.expected_delivery_state || "RELEASE_ELIGIBLE");
		const slot = `${r.review_stage}:${r.role}`;
		const uniqueSlotsRequired = requiredRoles.length > 0;
		const roleValid = requiredSlots.includes(slot) && (!uniqueSlotsRequired || !coveredSlots.has(slot));
		const viewValid = r.evidence_view_digest === r.bundle_digest && /^[a-f0-9]{64}$/.test(r.full_bundle_digest || "") && (!uniqueSlotsRequired || !evidenceViews.has(r.evidence_view_digest));
		const planningValid = r.planning_digest === bindings.planning_digest && (r.review_stage === "planning" ? r.planning_seal_digest === null : r.planning_seal_digest === bindings.planning_seal_digest);
		const sameBundle = requiredSlots.length > 1 || !bindings.bundle_digest || r.bundle_digest === bindings.bundle_digest;
		const invocation = r.invocation_nonce && readJson(path.join(unit.paths.pending, `review-${r.invocation_nonce}.json`));
		const invocationValid = invocation && reviewInvocationDigestValid(invocation) && invocation.consumed === true && invocation.review_record_hash === r.record_hash && !invocationNonces.has(r.invocation_nonce);
		let claimsValid = true;
		try {
			const originalReview = { ...r };
			for (const field of ["version", "seq", "prev_hash", "record_hash"]) delete originalReview[field];
			const reviewDigest = sha256(canonicalJson(originalReview));
			verifyGlobalClaim(cwd, "review-invocation", r.invocation_nonce, { unit_id: unit.id, invocation_digest: invocation && invocation.invocation_digest });
			verifyGlobalClaim(cwd, "review-run", r.run_id, { unit_id: unit.id, review_digest: reviewDigest });
			verifyGlobalClaim(cwd, "review-execution", r.isolation && r.isolation.execution_id, { unit_id: unit.id, review_digest: reviewDigest });
			verifyGlobalClaim(cwd, "review-context", r.executor && r.executor.context_id, { unit_id: unit.id, review_digest: reviewDigest });
			verifyGlobalClaim(cwd, "review-process", canonicalJson({ process_id: r.executor && r.executor.process_id, process_identity: r.executor && r.executor.process_identity, started_at: r.executor && r.executor.started_at }), { unit_id: unit.id, review_digest: reviewDigest });
		} catch {
			claimsValid = false;
		}
		const reviewerProcessIdentity = r.executor && canonicalJson({ process_id: r.executor.process_id, started_at: r.executor.started_at });
		let executorValid = Boolean(r.executor && r.executor.signature && r.executor.context_id && r.executor.credential_id && !reviewerContexts.has(r.executor.context_id) && !reviewerProcesses.has(reviewerProcessIdentity));
		if (bindings.reviewer_credential_id && r.executor && r.executor.credential_id !== bindings.reviewer_credential_id) executorValid = false;
		if (executorValid && bindings.reviewer_public_key) {
			try {
				executorValid = crypto.verify(null, Buffer.from(canonicalJson(reviewSignaturePayload(r))), bindings.reviewer_public_key, Buffer.from(r.executor.signature, "base64"));
			} catch {
				executorValid = false;
			}
		} else executorValid = false;
		let isolationValid = Boolean(r.isolation && r.isolation.signature && r.isolation.execution_id && !executionIds.has(r.isolation.execution_id) && executionCounts.get(r.isolation.execution_id) === 1);
		if (isolationValid && bindings.review_runner_credential_id && r.isolation.credential_id !== bindings.review_runner_credential_id) isolationValid = false;
		if (isolationValid && r.executor && r.isolation.credential_id === r.executor.credential_id) isolationValid = false;
		if (isolationValid && invocation) {
			isolationValid = r.isolation.challenge === invocation.nonce && r.isolation.bundle_digest === invocation.bundle_digest && r.isolation.reviewer_context_id === r.executor.context_id && r.isolation.reviewer_process_id === r.executor.process_id;
		}
		if (isolationValid && bindings.review_runner_public_key) {
			try {
				isolationValid = crypto.verify(null, Buffer.from(canonicalJson(isolationSignaturePayload(r.isolation))), bindings.review_runner_public_key, Buffer.from(r.isolation.signature, "base64"));
			} catch {
				isolationValid = false;
			}
		} else isolationValid = false;
		if (!same || !covered || !isolated || !findingsValid || !preservationValid || !roleValid || !viewValid || !planningValid || !sameBundle || !r.run_id || runCounts.get(r.run_id) !== 1 || !invocationValid || !claimsValid || !executorValid || !isolationValid) break;
		if (clean.some((x) => x.run_id === r.run_id)) break;
		invocationNonces.add(r.invocation_nonce);
		executionIds.add(r.isolation.execution_id);
		reviewerContexts.add(r.executor.context_id);
		reviewerProcesses.add(reviewerProcessIdentity);
		coveredSlots.add(slot);
		evidenceViews.add(r.evidence_view_digest);
		clean.push(r);
	}
	const slotCoverage = requiredSlots.every((slot) => coveredSlots.has(slot));
	const ok = clean.length >= target && slotCoverage;
	const incompleteCode = slotCoverage || !requiredRoles.length ? "review_clean_streak_incomplete" : "review_required_slots_incomplete";
	return { ok, errors: ok ? [] : [incompleteCode], clean };
}

	return {
		observeOccurrence,
		observeOccurrenceUnlocked,
		captureWorkspaceOccurrences,
		verifyReviewChain,
		appendReview,
		appendReviewUnlocked,
		arrayCovers,
		arrayExactly,
		evaluateReviews,
	};
};
