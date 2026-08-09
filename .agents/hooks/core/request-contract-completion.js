"use strict";
module.exports = function createRequestContractModule(api) {
const {
	fs, path, preservationPolicy, VERSION, PRESERVATION_REVIEW_STAGES, closedObject, sha256, publicKeyFingerprint,
	opaqueId, canonicalJson, ensureDir, durableRename, durableRemoveTree, secureWrite, secureJson, readJson,
	requiredJson, optionalJson, stateDigest, readUnitState, writeUnitState, loadConfig, loadAuthorityKey, loadReviewerKey,
	loadReviewRunnerKey, preservationRunnerContext, harnessRoot, governed, unitPaths, withUnitLock, withRepositoryLock, transactionPath,
	applyResumeTransaction, recoverUnitTransactions, listUnits, successfulHandoffExists, workspaceManifest, quarantineRoot, listUnconsumedQuarantine, verifySourceChain,
	contractDigest, scopeProjection, authorityPresentation, consumeAuthorityReceipt, validateContract, verifyScopeHistory, scopeHistoryCoverage, buildReviewBundle,
	effectiveReviewRoles, expectedDeliveryState, requiredReviewSlots, planningSeal, cleanupExpiredReviewInvocations, captureWorkspaceOccurrences, verifyReviewChain, evaluateReviews,
} = api;
function reconcileOpenMutationLeases(unit, cwd, client, sessionId, now = Date.now()) {
	const head = requiredJson(unit.paths.head, "unit_head_corrupt");
	const state = readUnitState(unit, head);
	const leases = Object.entries(state.active_mutations || {});
	if (!leases.length) return { captured: null, foreign: [] };
	const effectiveSessionId = sessionId || head.session_id;
	const foreign = leases.filter(([, lease]) => lease.client !== client || lease.session_id !== effectiveSessionId);
	if (foreign.length) return { captured: null, foreign: foreign.map(([leaseId]) => leaseId) };
	const captured = captureWorkspaceOccurrences(unit, cwd);
	const nextHead = requiredJson(unit.paths.head, "unit_head_corrupt");
	const nextState = readUnitState(unit, nextHead);
	nextState.closed_mutations = nextState.closed_mutations || [];
	for (const [leaseId, lease] of Object.entries(nextState.active_mutations || {})) {
		nextState.closed_mutations.push({ lease_id: leaseId, ...lease, closed_at: now, close_reason: "stop_reconciliation" });
	}
	nextState.active_mutations = {};
	writeUnitState(unit, nextState, nextHead);
	return { captured, foreign: [] };
}

function stopResult(unit, errors, config, client, now = Date.now(), context = {}) {
	const head = requiredJson(unit.paths.head, "unit_head_corrupt");
	const state = readUnitState(unit, head);
	if (state.terminal && state.terminal.status === "incomplete") return { kind: "incomplete", code: "request_contract_incomplete", message: "Request contract remains incomplete.", terminal: state.terminal };
	const codes = [...new Set(errors)].sort();
	const failureFingerprint = sha256(canonicalJson({ codes, source_head: head.source_head, contract_digest: head.contract_digest, scope_epoch: head.scope_epoch, work_revision: head.work_revision, config_digest: context.config_digest || config.digest, workspace_digest: context.workspace_digest || null, binding_epoch: context.binding_epoch || null }));
	const sameFailure = Boolean(state.stop && state.stop.failure_fingerprint === failureFingerprint);
	const attempt = sameFailure ? state.stop.attempt + 1 : 1;
	state.stop = { episode_id: sameFailure ? state.stop.episode_id : opaqueId("EP-"), attempt, unresolved_codes: codes, failure_fingerprint: failureFingerprint, updated_at: now };
	if (attempt >= config.stop_attempt_limit) {
		state.terminal = { id: opaqueId("TERM-"), status: "incomplete", episode_id: state.stop.episode_id, at: now, error_codes: codes };
		writeUnitState(unit, state, head);
		return { kind: "incomplete", code: "request_contract_incomplete", message: "Request contract could not reach a valid completion state.", terminal: state.terminal };
	}
	writeUnitState(unit, state, head);
	return { kind: "block", code: "request_contract_blocked", message: `Request contract incomplete (${codes.join(", ")}). Continue autonomously and resolve the recorded obligations.`, errors: codes };
}

function completionAssessment(unit, cwd, config, now) {
	const errors = [];
	if (listUnconsumedQuarantine(cwd).length) errors.push("unconsumed_quarantine");
	const head = requiredJson(unit.paths.head, "unit_head_corrupt");
	const sources = verifySourceChain(unit.paths, head);
	if (!sources.ok) errors.push(...sources.errors);
	const scopeHistory = verifyScopeHistory(unit);
	if (!scopeHistory.ok) errors.push(...scopeHistory.errors);
	const ws = captureWorkspaceOccurrences(unit, cwd);
	const currentHead = requiredJson(unit.paths.head, "unit_head_corrupt");
	if (ws.configDrift) errors.push("product_root_config_drift");
	const binding = optionalJson(unit.paths.binding, null, "binding_state_corrupt");
	const contract = optionalJson(unit.paths.contract, null, "contract_state_corrupt");
	const lifecycleState = readUnitState(unit, currentHead);
	if (!binding || !contract) errors.push("request_contract_unbound");
	if (contract && (!scopeHistory.records.length || scopeHistory.records.at(-1).contract_digest !== contractDigest(contract))) errors.push("scope_history_current_contract_mismatch");
	let cv = { ok: false, errors: [], ids: { sourceIds: [], sourceMappings: [], directiveIds: [], targetIds: [], criterionIds: [], authorityIds: [], authorityMappings: [], tombstoneIds: [], tombstoneMappings: [], artifactIds: [], edgeIds: [], occurrenceIds: [], changeMappings: [] }, scope_digest: "" };
	let pv = { ok: false, errors: ["preservation_contract_unchecked"], surface_digests: {} };
	if (contract) {
		const digest = contractDigest(contract);
		if (digest !== head.contract_digest) errors.push("contract_digest_mismatch");
		cv = validateContract(contract, sources.records, ws.occurrences, { now, publicKeyPem: loadAuthorityKey(cwd, config), cwd, config });
		if (!cv.ok) errors.push(...cv.errors);
		pv = preservationPolicy.validateWorkspace(contract, { baseline: lifecycleState.baseline, current: ws.current.manifest, cwd, config, sourceRecords: sources.records, probeRunner: preservationRunnerContext(cwd, config) });
		if (!pv.ok) errors.push(...pv.errors);
		if (contract.preservation) {
			errors.push("preservation_real_entry_attestation_pending", "preservation_incident_history_pending", "preservation_review_convergence_pending", "external_effect_gate_pending");
			if ((contract.preservation.vendor_sources || []).length > 0) errors.push("preservation_vendor_origin_attestation_pending");
		}
		if (contract.status !== "complete") errors.push("contract_status_not_complete");
		for (const directive of contract.directives || []) if (!["done", "superseded", "deferred", "abandoned"].includes(directive.state)) errors.push(`contract_directive_not_disposed:${directive.id}`);
	}
	let reviewBundle = null;
	let reviews = { ok: false, errors: ["review_clean_streak_incomplete"], clean: [] };
	if (binding && contract) {
		reviewBundle = buildReviewBundle(unit, cwd);
		const currentPlanningSeal = planningSeal(unit, config, binding, currentHead, contract);
		reviews = evaluateReviews(
			unit,
			{
				source_head: currentHead.source_head,
				contract_digest: currentHead.contract_digest,
				workspace_digest: ws.current.digest,
				config_digest: currentHead.config_digest,
				scope_epoch: currentHead.scope_epoch,
				work_revision: currentHead.work_revision,
				binding_epoch: binding.binding_epoch,
				bundle_digest: reviewBundle.digest,
				cwd,
					reviewer_public_key: loadReviewerKey(cwd, config),
					reviewer_credential_id: config.reviewer.credential_id || null,
				review_runner_public_key: loadReviewRunnerKey(cwd, config),
					review_runner_credential_id: config.review_runner.credential_id || null,
				required_roles: effectiveReviewRoles(config, contract),
				required_stages: config.preservation.required || contract.preservation ? PRESERVATION_REVIEW_STAGES : ["integration"],
				expected_delivery_state: expectedDeliveryState(config, contract),
				planning_digest: binding.planning_digest,
				planning_seal_digest: currentPlanningSeal.digest,
				ids: { ...cv.ids, ...scopeHistoryCoverage(scopeHistory.records), preservationSurfaceMappings: Object.entries(pv.surface_digests || {}).sort(([a], [b]) => a.localeCompare(b)).map(([id, digest]) => `${id}:${digest}`) },
			},
			config.minimum_clean_rounds,
		);
		if (!reviews.ok) errors.push(...reviews.errors);
	}
	return { errors: [...new Set(errors)], head: currentHead, sources, scopeHistory, ws, binding, contract, cv, pv, reviewBundle, reviews };
}

function completionAssessmentDigest(assessment) {
	return sha256(canonicalJson({
		source_head: assessment.head.source_head,
		contract_digest: assessment.head.contract_digest,
		config_digest: assessment.head.config_digest,
		scope_epoch: assessment.head.scope_epoch,
		work_revision: assessment.head.work_revision,
		state_digest: assessment.head.state_digest,
		workspace_digest: assessment.ws.current.digest,
		binding: assessment.binding,
		scope_history_head: assessment.scopeHistory.head,
		review_bundle_digest: assessment.reviewBundle && assessment.reviewBundle.digest,
		review_record_hashes: (assessment.reviews.clean || []).map((record) => record.record_hash),
		coverage: assessment.cv.ids,
		preservation_surface_digests: assessment.pv && assessment.pv.surface_digests,
	}));
}

function completionProofPayload(proof) {
	const payload = { ...proof };
	delete payload.digest;
	return payload;
}

function verifyCompletionProof(unit, cwd, config, head, state, terminal) {
	const errors = [];
	const proof = terminal && terminal.completion_proof;
	if (!proof || proof.digest !== sha256(canonicalJson(completionProofPayload(proof)))) return { ok: false, errors: ["completion_proof_digest_invalid"] };
	const binding = optionalJson(unit.paths.binding, null, "binding_state_corrupt");
	const contract = optionalJson(unit.paths.contract, null, "contract_state_corrupt");
	const sources = verifySourceChain(unit.paths, head);
	const scopeHistory = verifyScopeHistory(unit);
	const reviewChain = verifyReviewChain(unit.paths);
	if (!sources.ok) errors.push(...sources.errors);
	if (!scopeHistory.ok) errors.push(...scopeHistory.errors);
	if (!reviewChain.ok) errors.push(...reviewChain.errors);
	if (!binding || !contract) errors.push("completion_proof_binding_missing");
	for (const field of ["source_head", "contract_digest", "config_digest", "scope_epoch", "work_revision"]) if (proof[field] !== head[field]) errors.push(`completion_proof_${field}_mismatch`);
	if (!binding || proof.binding_epoch !== binding.binding_epoch) errors.push("completion_proof_binding_epoch_mismatch");
	if (!contract || proof.contract_digest !== contractDigest(contract)) errors.push("completion_proof_contract_digest_mismatch");
	if (proof.scope_history_head !== (scopeHistory.head && scopeHistory.head.chain_head)) errors.push("completion_proof_scope_history_mismatch");
	if (proof.review_chain_head !== (reviewChain.head && reviewChain.head.chain_head)) errors.push("completion_proof_review_chain_mismatch");
	if (!Array.isArray(proof.review_record_hashes) || proof.review_record_hashes.length < Math.max(config.minimum_clean_rounds, requiredReviewSlots(config, contract).length)) errors.push("completion_proof_review_records_missing");
	let cv = { ok: false, errors: [], ids: { sourceIds: [], sourceMappings: [], directiveIds: [], targetIds: [], criterionIds: [], authorityIds: [], authorityMappings: [], tombstoneIds: [], tombstoneMappings: [], artifactIds: [], edgeIds: [], occurrenceIds: [], changeMappings: [] } };
	if (contract && sources.ok) {
		cv = validateContract(contract, sources.records, state.occurrences || [], { now: terminal.at, publicKeyPem: loadAuthorityKey(cwd, config), cwd, config });
		if (!cv.ok) errors.push(...cv.errors);
		const workspace = workspaceManifest(cwd, config);
		const preservation = preservationPolicy.validateWorkspace(contract, { baseline: state.baseline, current: workspace.manifest, cwd, config, sourceRecords: sources.records, probeRunner: preservationRunnerContext(cwd, config) });
		if (!preservation.ok) errors.push(...preservation.errors);
		if (canonicalJson(proof.preservation_surface_digests || {}) !== canonicalJson(preservation.surface_digests || {})) errors.push("completion_proof_preservation_digest_mismatch");
	}
	if (binding && contract && cv.ok && scopeHistory.ok) {
		const currentPlanningSeal = planningSeal(unit, config, binding, head, contract);
		const reviews = evaluateReviews(unit, {
			source_head: proof.source_head,
			contract_digest: proof.contract_digest,
			workspace_digest: proof.workspace_digest,
			config_digest: proof.config_digest,
			scope_epoch: proof.scope_epoch,
			work_revision: proof.work_revision,
			binding_epoch: proof.binding_epoch,
			bundle_digest: proof.bundle_digest,
			cwd,
			reviewer_public_key: loadReviewerKey(cwd, config),
			reviewer_credential_id: config.reviewer.credential_id || null,
			review_runner_public_key: loadReviewRunnerKey(cwd, config),
			review_runner_credential_id: config.review_runner.credential_id || null,
			required_roles: effectiveReviewRoles(config, contract),
			required_stages: config.preservation.required || contract.preservation ? PRESERVATION_REVIEW_STAGES : ["integration"],
			expected_delivery_state: expectedDeliveryState(config, contract),
			planning_digest: binding.planning_digest,
			planning_seal_digest: currentPlanningSeal.digest,
			ids: { ...cv.ids, ...scopeHistoryCoverage(scopeHistory.records), preservationSurfaceMappings: Object.entries((proof.preservation_surface_digests || {})).sort(([a], [b]) => a.localeCompare(b)).map(([id, digest]) => `${id}:${digest}`) },
		}, config.minimum_clean_rounds);
		if (!reviews.ok) errors.push(...reviews.errors);
		else if (canonicalJson(reviews.clean.map((record) => record.record_hash)) !== canonicalJson(proof.review_record_hashes)) errors.push("completion_proof_review_records_mismatch");
	}
	return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

function evaluateCompletion(unit, cwd, client, now = Date.now(), sessionId = null, opts = {}) {
	return withRepositoryLock(cwd, () => withUnitLock(unit, () => evaluateCompletionUnlocked(unit, cwd, client, now, sessionId, opts), now), now);
}

function validateSuccessfulTerminalUnlocked(unit, cwd, opts = {}) {
	const config = loadConfig(cwd);
	const head = requiredJson(unit.paths.head, "unit_head_corrupt");
	const state = readUnitState(unit, head);
	const terminal = state.terminal;
	if (!terminal || terminal.status !== "success") return { ok: false, errors: ["completion_proof_missing"] };
	const verified = verifyCompletionProof(unit, cwd, config, head, state, terminal);
	const errors = [...verified.errors];
	const handedOff = opts.allowHandoff === true && successfulHandoffExists(cwd, unit, head, terminal);
	if (!handedOff && config.digest !== head.config_digest) errors.push("completion_proof_config_digest_mismatch");
	if (!handedOff) {
		const workspace = workspaceManifest(cwd, config);
		if (!terminal.completion_proof || workspace.digest !== terminal.completion_proof.workspace_digest) errors.push("completion_proof_workspace_digest_mismatch");
	}
	return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

const COMPACTION_AUTHORIZATION_KEYS = ["version", "id", "unit_id", "terminal_id", "client", "session_id", "issued_at", "consumed_at", "completion_proof_digest", "source_head", "contract_digest", "workspace_digest", "config_digest", "scope_epoch", "work_revision", "binding_epoch"];

function createCompactionAuthorization(unit, head, state, client, sessionId, now) {
	const terminal = state.terminal;
	const proof = terminal && terminal.completion_proof;
	if (!proof || !/^[a-f0-9]{64}$/.test(proof.digest || "")) throw Object.assign(new Error("current completion proof is required"), { code: "completion_proof_missing" });
	return {
		version: VERSION,
		id: opaqueId("CMP-"),
		unit_id: unit.id,
		terminal_id: terminal.id,
		client,
		session_id: sessionId,
		issued_at: now,
		consumed_at: null,
		completion_proof_digest: proof.digest,
		source_head: head.source_head,
		contract_digest: head.contract_digest,
		workspace_digest: proof.workspace_digest,
		config_digest: head.config_digest,
		scope_epoch: head.scope_epoch,
		work_revision: head.work_revision,
		binding_epoch: proof.binding_epoch,
	};
}

function validateCompactionAuthorization(unit, head, state, client, sessionId) {
	const errors = [];
	const authorization = state.compaction_authorization;
	if (!authorization || typeof authorization !== "object" || Array.isArray(authorization)) return { ok: false, errors: ["compaction_authorization_missing"] };
	closedObject(authorization, COMPACTION_AUTHORIZATION_KEYS, errors, "compaction_authorization");
	const terminal = state.terminal;
	const proof = terminal && terminal.completion_proof;
	if (authorization.version !== VERSION || !/^CMP-[a-f0-9]{32}$/.test(authorization.id || "") || authorization.unit_id !== unit.id) errors.push("compaction_authorization_identity_invalid");
	if (!terminal || terminal.status !== "success" || authorization.terminal_id !== terminal.id) errors.push("compaction_authorization_terminal_mismatch");
	if (authorization.client !== client || authorization.session_id !== sessionId) errors.push("compaction_authorization_session_mismatch");
	if (!Number.isInteger(authorization.issued_at) || authorization.issued_at < 0) errors.push("compaction_authorization_time_invalid");
	if (authorization.consumed_at !== null) errors.push("compaction_authorization_consumed");
	if (!proof || authorization.completion_proof_digest !== proof.digest) errors.push("compaction_authorization_proof_mismatch");
	for (const [field, expected] of [
		["source_head", head.source_head],
		["contract_digest", head.contract_digest],
		["workspace_digest", proof && proof.workspace_digest],
		["config_digest", head.config_digest],
		["scope_epoch", head.scope_epoch],
		["work_revision", head.work_revision],
		["binding_epoch", proof && proof.binding_epoch],
	]) if (authorization[field] !== expected) errors.push(`compaction_authorization_${field}_mismatch`);
	return { ok: errors.length === 0, errors: [...new Set(errors)], authorization };
}

function evaluatePreCompact(unit, cwd, client, now = Date.now(), sessionId = null) {
	return withRepositoryLock(cwd, () => withUnitLock(unit, () => {
		let state = readUnitState(unit);
		if (!state.terminal || state.terminal.status !== "success") {
			const completion = evaluateCompletionUnlocked(unit, cwd, client, now, sessionId, { recordStopFailure: false });
			if (completion.kind !== "allow") return completion;
			state = readUnitState(unit);
		}
		const verified = validateSuccessfulTerminalUnlocked(unit, cwd);
		if (!verified.ok) return { kind: "block", code: "request_contract_completion_proof_invalid", message: "Compaction denied because the successful completion proof is no longer current.", errors: verified.errors };
		const head = requiredJson(unit.paths.head, "unit_head_corrupt");
		state = readUnitState(unit, head);
		state.compaction_authorization = createCompactionAuthorization(unit, head, state, client, sessionId, now);
		writeUnitState(unit, state, head);
		return { kind: "allow", code: "request_contract_compaction_ready", message: "Completion proof is current before compaction." };
	}, now), now);
}

function evaluatePostCompact(unit, cwd, client, now = Date.now(), sessionId = null) {
	return withRepositoryLock(cwd, () => withUnitLock(unit, () => {
		const head = requiredJson(unit.paths.head, "unit_head_corrupt");
		const state = readUnitState(unit, head);
		const authorization = validateCompactionAuthorization(unit, head, state, client, sessionId);
		if (!authorization.ok) return { kind: "block", code: "request_contract_postcompact_without_proof", message: "Post-compaction continuation denied because no current one-time pre-compaction authorization exists.", errors: authorization.errors };
		const verified = validateSuccessfulTerminalUnlocked(unit, cwd);
		if (!verified.ok) return { kind: "block", code: "request_contract_postcompact_without_proof", message: "Post-compaction continuation denied because the pre-compaction completion proof is no longer current.", errors: verified.errors };
		state.compaction_authorization.consumed_at = now;
		writeUnitState(unit, state, head);
		return { kind: "context", code: "request_contract_resume", message: "Reload the completed request contract and its verified completion proof before continuing." };
	}, now), now);
}

function completionFailure(...args) { return api.completionFailure(...args); }
function evaluateCompletionUnlocked(...args) { return api.evaluateCompletionUnlocked(...args); }
function resumeIncomplete(...args) { return api.resumeIncomplete(...args); }
function resumeIncompleteUnlocked(...args) { return api.resumeIncompleteUnlocked(...args); }
function cleanupConsumedQuarantines(...args) { return api.cleanupConsumedQuarantines(...args); }
function compactionReceipt(...args) { return api.compactionReceipt(...args); }
function validateCompactionReceipt(...args) { return api.validateCompactionReceipt(...args); }
function cleanupCompactionStaging(...args) { return api.cleanupCompactionStaging(...args); }
function compactExpiredUnits(...args) { return api.compactExpiredUnits(...args); }


	return {
		reconcileOpenMutationLeases,
		stopResult,
		completionAssessment,
		completionAssessmentDigest,
		completionProofPayload,
		verifyCompletionProof,
		evaluateCompletion,
		validateSuccessfulTerminalUnlocked,
		createCompactionAuthorization,
		validateCompactionAuthorization,
		evaluatePreCompact,
		evaluatePostCompact,
		completionFailure,
		evaluateCompletionUnlocked,
		resumeIncomplete,
		resumeIncompleteUnlocked,
		cleanupConsumedQuarantines,
		compactionReceipt,
		validateCompactionReceipt,
		cleanupCompactionStaging,
		compactExpiredUnits,
	};
};
