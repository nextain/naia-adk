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
function reconcileOpenMutationLeases(...args) { return api.reconcileOpenMutationLeases(...args); }
function stopResult(...args) { return api.stopResult(...args); }
function completionAssessment(...args) { return api.completionAssessment(...args); }
function completionAssessmentDigest(...args) { return api.completionAssessmentDigest(...args); }
function completionProofPayload(...args) { return api.completionProofPayload(...args); }
function verifyCompletionProof(...args) { return api.verifyCompletionProof(...args); }
function evaluateCompletion(...args) { return api.evaluateCompletion(...args); }
function validateSuccessfulTerminalUnlocked(...args) { return api.validateSuccessfulTerminalUnlocked(...args); }
function createCompactionAuthorization(...args) { return api.createCompactionAuthorization(...args); }
function validateCompactionAuthorization(...args) { return api.validateCompactionAuthorization(...args); }
function evaluatePreCompact(...args) { return api.evaluatePreCompact(...args); }
function evaluatePostCompact(...args) { return api.evaluatePostCompact(...args); }

function completionFailure(unit, errors, config, client, now, context, opts) {
	const codes = [...new Set(errors)].sort();
	if (opts.recordStopFailure === false) return { kind: "block", code: "request_contract_blocked", message: `Request contract incomplete (${codes.join(", ")}). Continue autonomously and resolve the recorded obligations.`, errors: codes };
	return stopResult(unit, codes, config, client, now, context);
}

function evaluateCompletionUnlocked(unit, cwd, client, now = Date.now(), sessionId = null, opts = {}) {
	const config = loadConfig(cwd);
	const head = requiredJson(unit.paths.head, "unit_head_corrupt");
	const initialState = readUnitState(unit, head);
	if (initialState.terminal && initialState.terminal.status === "incomplete") return { kind: "incomplete", code: "request_contract_incomplete", message: "Request contract remains incomplete.", terminal: initialState.terminal };
	if (initialState.terminal && initialState.terminal.status === "success") {
		const verified = validateSuccessfulTerminalUnlocked(unit, cwd);
		return verified.ok
			? { kind: "allow", code: "request_contract_complete", message: "Request contract is already complete and its proof is current." }
			: { kind: "block", code: "request_contract_completion_proof_invalid", message: "Completion cannot be reported because the successful proof is no longer current.", errors: verified.errors };
	}
	if (initialState.active_mutations && Object.keys(initialState.active_mutations).length) {
		const reconciliation = reconcileOpenMutationLeases(unit, cwd, client, sessionId, now);
		if (reconciliation.foreign.length) return { kind: "block", code: "request_contract_mutation_in_flight", message: "Another bound session still owns an in-flight governed mutation." };
	}
	const initial = completionAssessment(unit, cwd, config, now);
	const stopContext = { config_digest: config.digest, workspace_digest: initial.ws.current.digest, binding_epoch: initial.binding && initial.binding.binding_epoch };
	if (initial.errors.length) return completionFailure(unit, initial.errors, config, client, now, stopContext, opts);
	if (typeof opts.beforeFinalValidation === "function") opts.beforeFinalValidation();
	const final = completionAssessment(unit, cwd, config, now);
	if (completionAssessmentDigest(final) !== completionAssessmentDigest(initial)) final.errors.push("completion_state_changed_during_finalize");
	if (final.errors.length) return completionFailure(unit, final.errors, config, client, now, { config_digest: config.digest, workspace_digest: final.ws.current.digest, binding_epoch: final.binding && final.binding.binding_epoch }, opts);
	ensureDir(unit.paths.locks);
	try {
		secureWrite(path.join(unit.paths.locks, "success.lock"), JSON.stringify({ at: now, source_head: final.head.source_head, contract_digest: final.head.contract_digest }) + "\n", { exclusive: true });
	} catch (error) {
		if (error && error.code !== "EEXIST") return completionFailure(unit, ["success_lock_failed"], config, client, now, stopContext, opts);
	}
	const successHead = requiredJson(unit.paths.head, "unit_head_corrupt");
	const state = readUnitState(unit, successHead);
	const reviewChain = verifyReviewChain(unit.paths);
	const proof = {
		version: VERSION,
		validated_at: now,
		source_head: successHead.source_head,
		contract_digest: successHead.contract_digest,
		workspace_digest: final.ws.current.digest,
		config_digest: successHead.config_digest,
		scope_epoch: successHead.scope_epoch,
		work_revision: successHead.work_revision,
		binding_epoch: final.binding.binding_epoch,
		bundle_digest: final.reviewBundle.digest,
		scope_history_head: final.scopeHistory.head.chain_head,
		review_chain_head: reviewChain.head.chain_head,
		review_record_hashes: final.reviews.clean.map((record) => record.record_hash),
		review_roles: final.reviews.clean.map((record) => record.role),
		review_stages: final.reviews.clean.map((record) => record.review_stage),
		preservation_surface_digests: final.pv.surface_digests,
	};
	proof.digest = sha256(canonicalJson(proof));
	state.terminal = { id: opaqueId("TERM-"), status: "success", at: now, completion_proof: proof };
	writeUnitState(unit, state, successHead);
	return { kind: "allow", code: "request_contract_complete", message: "Request contract and two Clean review rounds are current." };
}

function resumeIncomplete(unit, receipt, cwd, now = Date.now(), opts = {}) {
	return withUnitLock(unit, () => resumeIncompleteUnlocked(unit, receipt, cwd, now, opts), now);
}

function resumeIncompleteUnlocked(unit, receipt, cwd, now = Date.now(), opts = {}) {
	const priorHead = requiredJson(unit.paths.head, "unit_head_corrupt");
	const priorState = readUnitState(unit, priorHead);
	if (!priorState.terminal || priorState.terminal.status !== "incomplete") throw Object.assign(new Error("unit is not incomplete"), { code: "resume_state_invalid" });
	const config = loadConfig(cwd);
	if (config.digest !== priorHead.config_digest) throw Object.assign(new Error("request-contract configuration differs from genesis pin"), { code: "request_contract_config_drift" });
	const authorityKey = loadAuthorityKey(cwd, config);
	if (!authorityKey || publicKeyFingerprint(authorityKey) !== priorHead.authority_key_fingerprint) throw Object.assign(new Error("authority key differs from genesis pin"), { code: "authority_key_pin_mismatch" });
	const priorBinding = optionalJson(unit.paths.binding, null, "binding_state_corrupt");
	const contract = optionalJson(unit.paths.contract, null, "contract_state_corrupt");
	const scope = contract ? sha256(canonicalJson(scopeProjection(contract))) : null;
	const authority = { id: `AUTH-${opaqueId()}`, operation: "resume", target_directive_ids: [], receipt };
	const presentation = authorityPresentation(authority, scope, scope, priorHead.scope_epoch + 1, (priorBinding && priorBinding.binding_epoch + 1) || 1);
	const state = JSON.parse(JSON.stringify(priorState));
	const consumed = consumeAuthorityReceipt(unit, authority, presentation, cwd, state, now, { persistPending: false });
	state.episodes = state.episodes || [];
	state.episodes.push({ terminal: state.terminal, stop: state.stop || null });
	delete state.terminal;
	state.stop = { episode_id: opaqueId("EP-"), attempt: 0, unresolved_codes: [], resumed_at: now, authority_nonce: receipt.nonce };
	const head = { ...priorHead, scope_epoch: priorHead.scope_epoch + 1, work_revision: priorHead.work_revision + 1, state_digest: stateDigest(state) };
	const binding = priorBinding ? { ...priorBinding, binding_epoch: priorBinding.binding_epoch + 1 } : null;
	const transaction = {
		version: VERSION,
		kind: "resume",
		created_at: now,
		state,
		head,
		binding,
		pending_updates: [{ name: path.basename(consumed.pendingPath), value: consumed.pending }],
	};
	secureJson(transactionPath(unit, "resume"), transaction, { exclusive: true });
	if (opts.afterTransactionPrepared) opts.afterTransactionPrepared(transaction);
	applyResumeTransaction(unit, transaction);
	unit.head = head;
	return { episode_id: state.stop.episode_id, scope_epoch: head.scope_epoch };
}

function cleanupConsumedQuarantines(cwd, unitId) {
	try {
		for (const entry of fs.readdirSync(quarantineRoot(cwd), { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const dir = path.join(quarantineRoot(cwd), entry.name);
			const qhead = readJson(path.join(dir, "head.json"));
			if (qhead && qhead.consumed === true && qhead.consumed_by_unit === unitId) durableRemoveTree(dir);
		}
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
}

function compactionReceipt(unit, head, state, reviewHead) {
	const terminal = state && state.terminal;
	return {
		version: VERSION,
		receipt_id: head.compaction_receipt_id,
		status: terminal && terminal.status,
		started_at: head.created_at,
		terminal_at: terminal && terminal.at,
		compacted_at: head.compaction_started_at,
		source_count: head.source_count || 0,
		change_count: (state.occurrences || []).length,
		review_count: (reviewHead && reviewHead.count) || 0,
	};
}

function validateCompactionReceipt(receipt, expected) {
	const keys = ["change_count", "compacted_at", "receipt_id", "review_count", "source_count", "started_at", "status", "terminal_at", "version"];
	if (!receipt || canonicalJson(Object.keys(receipt).sort()) !== canonicalJson(keys)) return false;
	if (!/^RCPT-[a-f0-9]{32}$/.test(receipt.receipt_id || "") || receipt.status !== "success" || receipt.version !== VERSION) return false;
	for (const key of ["change_count", "review_count", "source_count"]) if (!Number.isInteger(receipt[key]) || receipt[key] < 0) return false;
	for (const key of ["compacted_at", "started_at", "terminal_at"]) if (!Number.isFinite(receipt[key])) return false;
	return canonicalJson(receipt) === canonicalJson(expected);
}

function cleanupCompactionStaging(cwd) {
	const unitsDir = path.join(harnessRoot(cwd), "units");
	let entries;
	try {
		entries = fs.readdirSync(unitsDir, { withFileTypes: true });
	} catch (error) {
		if (error.code === "ENOENT") return;
		throw Object.assign(new Error("request-contract unit storage cannot be read"), { code: "unit_storage_unreadable", cause: error });
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const match = entry.name.match(/^([a-f0-9]{32})\.compacted\.(RCPT-[a-f0-9]{32})$/);
		if (!match) continue;
		const [, unitId, receiptId] = match;
		const stagedDir = path.join(unitsDir, entry.name);
		const unit = { id: unitId, paths: unitPaths(cwd, unitId, stagedDir) };
		recoverUnitTransactions(unit);
		const head = requiredJson(unit.paths.head, "unit_head_corrupt");
		const state = readUnitState(unit, head);
		const reviewHead = optionalJson(unit.paths.reviewHead, { count: 0 }, "review_head_corrupt");
		const receipt = requiredJson(path.join(harnessRoot(cwd), "receipts-v2", `${receiptId}.json`), "compaction_receipt_corrupt");
		const expected = compactionReceipt(unit, head, state, reviewHead);
		if (head.lifecycle !== "compacting" || head.compaction_receipt_id !== receiptId || !validateCompactionReceipt(receipt, expected)) throw Object.assign(new Error("compaction staging has no exactly bound durable receipt"), { code: "compaction_staging_orphan" });
		const proof = validateSuccessfulTerminalUnlocked(unit, cwd, { allowHandoff: true });
		if (!proof.ok) throw Object.assign(new Error(proof.errors.join(", ")), { code: "completion_proof_invalid", errors: proof.errors });
		cleanupConsumedQuarantines(cwd, unitId);
		durableRemoveTree(stagedDir);
	}
}

function compactExpiredUnits(cwd, now = Date.now(), opts = {}) {
	return withRepositoryLock(cwd, () => {
		cleanupCompactionStaging(cwd);
		const config = loadConfig(cwd);
		const compacted = [];
		for (const id of listUnits(cwd)) {
		const paths = unitPaths(cwd, id);
		const unit = { id, paths };
		const result = withUnitLock(unit, () => {
			const head = requiredJson(paths.head, "unit_head_corrupt");
			const state = readUnitState(unit, head);
			const terminal = state.terminal;
			if (!terminal || terminal.status !== "success") return null;
				const proof = validateSuccessfulTerminalUnlocked(unit, cwd, { allowHandoff: true });
				if (!proof.ok) throw Object.assign(new Error(proof.errors.join(", ")), { code: "completion_proof_invalid", errors: proof.errors });
			const hours = config.retention.success_hours;
			if (now - terminal.at < hours * 60 * 60 * 1000) return null;
			head.lifecycle = "compacting";
			head.compaction_started_at = head.compaction_started_at || now;
			head.compaction_receipt_id = head.compaction_receipt_id || opaqueId("RCPT-");
			secureJson(paths.head, head);
			cleanupExpiredReviewInvocations(unit, now);
			const reviewHead = optionalJson(paths.reviewHead, { count: 0 }, "review_head_corrupt");
			const receiptId = head.compaction_receipt_id;
			const receipt = compactionReceipt(unit, head, state, reviewHead);
			const out = path.join(harnessRoot(cwd), "receipts-v2", `${receiptId}.json`);
			const existingReceipt = readJson(out);
			if (existingReceipt && !validateCompactionReceipt(existingReceipt, receipt)) throw Object.assign(new Error("compaction receipt conflict"), { code: "compaction_receipt_conflict" });
			if (!existingReceipt) secureJson(out, receipt, { exclusive: true });
			if (opts.afterReceiptWritten) opts.afterReceiptWritten({ receipt: out, receiptId });
			const finalProof = validateSuccessfulTerminalUnlocked(unit, cwd, { allowHandoff: true });
			if (!finalProof.ok) throw Object.assign(new Error(finalProof.errors.join(", ")), { code: "completion_proof_invalid", errors: finalProof.errors });
			const stagedUnit = `${paths.unit}.compacted.${receiptId}`;
			durableRename(paths.unit, stagedUnit);
			if (opts.afterUnitStaged) opts.afterUnitStaged({ stagedUnit, receipt: out, receiptId });
			cleanupConsumedQuarantines(cwd, id);
			durableRemoveTree(stagedUnit);
			return { receipt_id: receiptId };
		}, now);
			if (result) compacted.push(result);
		}
		return compacted;
	}, now);
}

	return {
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
