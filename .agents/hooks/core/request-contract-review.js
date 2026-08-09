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
function collectReviewMaterials(cwd, contract, state, workspace) {
	const requested = new Set();
	for (const directive of contract.directives || []) for (const target of directive.targets || []) if (target.path) requested.add(normalizeRel(target.path));
	for (const evidence of ((contract.artifacts && contract.artifacts.evidence) || [])) if (evidence.locator) requested.add(normalizeRel(evidence.locator));
	for (const surface of ((contract.preservation && contract.preservation.surfaces) || [])) {
		for (const rel of [...(surface.baseline_paths || []), ...(surface.current_paths || [])]) requested.add(normalizeRel(rel));
	}
	for (const occurrence of state.occurrences || []) {
		const rel = occurrence.detail && (occurrence.detail.path || occurrence.detail.target);
		if (rel && !path.isAbsolute(rel)) requested.add(normalizeRel(rel));
	}
	const selected = Object.keys(workspace.manifest.files).filter((rel) => [...requested].some((target) => rel === target || rel.startsWith(target + "/")));
	return selected.sort().map((rel) => {
		const metadata = workspace.manifest.files[rel];
		const material = { path: rel, metadata };
		if (metadata.type === "file") {
			const bytes = fs.readFileSync(path.join(cwd, rel));
			if (sha256(bytes) !== metadata.digest || bytes.length !== metadata.size) throw Object.assign(new Error(`review material changed while snapshotting: ${rel}`), { code: "review_bundle_workspace_race" });
			material.content_base64 = bytes.toString("base64");
		}
		return material;
	});
}

function collectBaselineReviewMaterials(cwd, contract, state, currentManifest) {
	const baseline = state.baseline;
	if (!baseline || !baseline.head || !baseline.files) throw Object.assign(new Error("review bundle has no pinned baseline manifest"), { code: "review_bundle_baseline_missing" });
	const requested = new Set();
	for (const surface of ((contract.preservation && contract.preservation.surfaces) || [])) for (const rel of surface.baseline_paths || []) requested.add(normalizeRel(rel));
	for (const occurrence of state.occurrences || []) {
		const rel = occurrence.detail && (occurrence.detail.path || occurrence.detail.target);
		if (rel && !path.isAbsolute(rel)) requested.add(normalizeRel(rel));
	}
	const selected = Object.keys(baseline.files).filter((rel) => {
		const requestedPath = [...requested].some((target) => rel === target || rel.startsWith(target + "/"));
		const changed = canonicalJson(baseline.files[rel]) !== canonicalJson(currentManifest.files[rel] || null);
		return requestedPath || changed;
	});
	return selected.sort().map((rel) => {
		const metadata = baseline.files[rel];
		const material = { path: rel, metadata };
		if (metadata.type === "file") {
			const bytes = gitBufferStrict(cwd, ["show", `${baseline.head}:${rel}`]);
			if (sha256(bytes) !== metadata.digest || bytes.length !== metadata.size) throw Object.assign(new Error(`baseline review material does not match its manifest: ${rel}`), { code: "review_bundle_baseline_digest_mismatch" });
			material.content_base64 = bytes.toString("base64");
		}
		return material;
	});
}

function buildReviewBundle(unit, cwd, opts = {}) {
	const head = requiredJson(unit.paths.head, "unit_head_corrupt");
	const sourceChain = verifySourceChain(unit.paths, head);
	const contract = requiredJson(unit.paths.contract, "contract_state_corrupt");
	const binding = requiredJson(unit.paths.binding, "binding_state_corrupt");
	const state = readUnitState(unit, head);
	const workspace = workspaceManifest(cwd, loadConfig(cwd));
	if (opts.afterWorkspaceSnapshot) opts.afterWorkspaceSnapshot(workspace);
	const scopeHistory = verifyScopeHistory(unit);
	if (!sourceChain.ok) throw Object.assign(new Error(sourceChain.errors.join(", ")), { code: "source_log_corrupt", errors: sourceChain.errors });
	if (!scopeHistory.ok) throw Object.assign(new Error(scopeHistory.errors.join(", ")), { code: "scope_history_corrupt", errors: scopeHistory.errors });
	const materials = collectReviewMaterials(cwd, contract, state, workspace);
	const baselineMaterials = collectBaselineReviewMaterials(cwd, contract, state, workspace.manifest);
	const preservationSurfaceMappings = Object.entries(Object.fromEntries(((contract.preservation && contract.preservation.surfaces) || []).map((surface) =>
		[surface.id, preservationPolicy.surfaceDiffDigest(state.baseline, workspace.manifest, surface)])))
		.sort(([a], [b]) => a.localeCompare(b)).map(([id, digest]) => `${id}:${digest}`);
	const confirmedWorkspace = workspaceManifest(cwd, loadConfig(cwd));
	if (confirmedWorkspace.digest !== workspace.digest) throw Object.assign(new Error("workspace changed while building the review bundle"), { code: "review_bundle_workspace_race" });
	const fullBundle = {
		version: VERSION,
		unit_id: unit.id,
		sources: sourceChain.records.map((r) => ({ source_id: r.source_id, seq: r.seq, origin: r.origin, prompt: r.prompt })),
		contract,
		scope_history: scopeHistory.records,
		binding,
		occurrences: state.occurrences,
		workspace_manifest: workspace.manifest,
		baseline_manifest: state.baseline,
		materials,
		baseline_materials: baselineMaterials,
		review_coverage: { ...contractCoverageIds(contract, state.occurrences), ...scopeHistoryCoverage(scopeHistory.records), preservationSurfaceMappings },
		required_review_roles: loadConfig(cwd).reviewer.required_roles,
		workspace_digest: workspace.digest,
		config_digest: head.config_digest,
		source_head: head.source_head,
		contract_digest: head.contract_digest,
		scope_epoch: head.scope_epoch,
		work_revision: head.work_revision,
		expected_delivery_state: expectedDeliveryState(loadConfig(cwd), contract),
	};
	const fullDigest = sha256(canonicalJson(fullBundle));
	const bundle = opts.stage && opts.role ? buildReviewEvidenceView(fullBundle, opts.stage, opts.role, fullDigest) : fullBundle;
	return { bundle, digest: sha256(canonicalJson(bundle)), full_digest: fullDigest, workspace };
}

function effectiveReviewRoles(config, contract = null) {
	const configured = [...new Set((config.reviewer && config.reviewer.required_roles) || [])];
	if (config.preservation && config.preservation.required || contract && contract.preservation) return [...new Set([...PRESERVATION_REVIEW_ROLES, ...configured])];
	return configured;
}

/** Preservation cannot become release-eligible before the pending signed controls exist. */
function expectedDeliveryState(config, contract = null) {
	return config.preservation && config.preservation.required || contract && contract.preservation ? "REVIEW_ONLY" : "RELEASE_ELIGIBLE";
}

function requiredReviewSlots(config, contract = null) {
	const roles = effectiveReviewRoles(config, contract);
	if (!roles.length) return [{ stage: "integration", role: "general" }];
	const stages = config.preservation && config.preservation.required || contract && contract.preservation ? PRESERVATION_REVIEW_STAGES : ["integration"];
	return stages.flatMap((stage) => roles.map((role) => ({ stage, role })));
}

function planningSeal(unit, config, binding, head, contract = null) {
	const roles = effectiveReviewRoles(config, contract);
	if (!(config.preservation && config.preservation.required || contract && contract.preservation) || !roles.length) return { ok: true, digest: null, records: [] };
	const chain = verifyReviewChain(unit.paths);
	if (!chain.ok) return { ok: false, digest: null, records: [], errors: chain.errors };
	const byRole = new Map();
	for (const record of chain.records) {
		if (record.verdict !== "CLEAN" || record.review_stage !== "planning" || !roles.includes(record.role)) continue;
		if (record.source_head !== head.source_head || record.contract_digest !== head.contract_digest || record.config_digest !== head.config_digest || record.scope_epoch !== head.scope_epoch || record.binding_epoch !== binding.binding_epoch) continue;
		if (record.planning_digest !== binding.planning_digest || record.work_revision !== binding.planning_work_revision) continue;
		byRole.set(record.role, record);
	}
	if (roles.some((role) => !byRole.has(role))) return { ok: false, digest: null, records: [], errors: ["review_planning_stage_incomplete"] };
	const records = roles.sort().map((role) => byRole.get(role));
	return { ok: true, digest: sha256(canonicalJson(records.map((record) => ({ role: record.role, record_hash: record.record_hash })))), records };
}

function buildReviewEvidenceView(full, stage, role, fullDigest = sha256(canonicalJson(full))) {
	if (!PRESERVATION_REVIEW_STAGES.includes(stage)) throw Object.assign(new Error(`unsupported review stage: ${stage}`), { code: "review_stage_invalid" });
	const roles = new Set(["source_fidelity", "baseline_preservation", "implementation_test", "authority_release", "general"]);
	if (!roles.has(role)) throw Object.assign(new Error(`unsupported review role: ${role}`), { code: "review_role_invalid" });
	const contract = full.contract || {};
	const common = {
		version: full.version,
		unit_id: full.unit_id,
		review_stage: stage,
		review_role: role,
		first_verdict_withheld: true,
		full_bundle_digest: fullDigest,
		review_coverage: full.review_coverage,
		config_digest: full.config_digest,
		source_head: full.source_head,
		contract_digest: full.contract_digest,
		scope_epoch: full.scope_epoch,
		work_revision: full.work_revision,
		expected_delivery_state: full.expected_delivery_state,
	};
	let evidence;
	if (role === "source_fidelity") evidence = {
		sources: full.sources,
		contract: { id: contract.id, status: contract.status, sources: contract.sources, directives: contract.directives, authorities: contract.authorities, tombstones: contract.tombstones },
		scope_history: full.scope_history,
		binding: full.binding,
	};
	else if (role === "baseline_preservation") evidence = {
		preservation: contract.preservation,
		baseline_manifest: full.baseline_manifest,
		workspace_manifest: stage === "integration" ? full.workspace_manifest : undefined,
		baseline_materials: full.baseline_materials,
		materials: stage === "integration" ? full.materials : undefined,
	};
	else if (role === "implementation_test") evidence = {
		contract: { id: contract.id, status: contract.status, directives: contract.directives, artifacts: contract.artifacts, edges: contract.edges, changes: contract.changes },
		occurrences: stage === "integration" ? full.occurrences : [],
		workspace_manifest: stage === "integration" ? full.workspace_manifest : undefined,
		materials: stage === "integration" ? full.materials : undefined,
	};
	else if (role === "authority_release") evidence = {
		contract: { id: contract.id, status: contract.status, authorities: contract.authorities, tombstones: contract.tombstones, preservation: contract.preservation },
		scope_history: full.scope_history,
		binding: full.binding,
		workspace_manifest: stage === "integration" ? full.workspace_manifest : undefined,
	};
	else evidence = full;
	const includedSections = Object.keys(evidence).filter((key) => evidence[key] !== undefined).sort();
	const allSections = ["sources", "contract", "scope_history", "binding", "occurrences", "workspace_manifest", "baseline_manifest", "materials", "baseline_materials", "preservation"];
	return {
		...common,
		included_sections: includedSections,
		withheld_sections: allSections.filter((key) => !includedSections.includes(key)),
		evidence,
	};
}

function reviewSignaturePayload(review) {
	const payload = JSON.parse(JSON.stringify(review));
	if (payload.executor) delete payload.executor.signature;
	delete payload.isolation;
	for (const key of ["version", "seq", "prev_hash", "record_hash"]) delete payload[key];
	return payload;
}

function isolationSignaturePayload(isolation) {
	const payload = JSON.parse(JSON.stringify(isolation || {}));
	delete payload.signature;
	return payload;
}

function reviewInvocationProjection(invocation) {
	const fields = ["version", "nonce", "review_run_id", "review_stage", "required_role", "expected_delivery_state", "planning_digest", "planning_seal_digest", "issued_at", "expires_at", "bundle_digest", "full_bundle_digest", "evidence_view_digest", "writer_session_id", "writer_session_ids", "writer_process_ids", "writer_process_identities", "source_head", "contract_digest", "workspace_digest", "config_digest", "scope_epoch", "work_revision", "binding_epoch", "ids"];
	return Object.fromEntries(fields.map((field) => [field, invocation && invocation[field]]));
}

function reviewInvocationDigestValid(invocation) {
	return Boolean(invocation && /^[a-f0-9]{64}$/.test(invocation.invocation_digest || "") && invocation.invocation_digest === sha256(canonicalJson(reviewInvocationProjection(invocation))));
}

function cleanupExpiredReviewInvocations(unit, now = Date.now()) {
	const cleaned = [];
	const retainedBundles = new Set();
	try {
		for (const entry of fs.readdirSync(unit.paths.pending, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.startsWith("review-") || !entry.name.endsWith(".json")) continue;
			const file = path.join(unit.paths.pending, entry.name);
			const invocation = readJson(file);
			const nonce = entry.name.slice("review-".length, -".json".length);
			const derivedBundle = path.join(unit.paths.pending, `bundle-${nonce}.json`);
				if (!invocation) {
					durableUnlink(derivedBundle);
					continue;
				}
				if (!reviewInvocationDigestValid(invocation)) {
					durableUnlink(derivedBundle);
					continue;
				}
			if (invocation.private_bundle_path && path.resolve(invocation.private_bundle_path) !== path.resolve(derivedBundle)) {
				durableUnlink(derivedBundle);
				continue;
			}
			if (!invocation.consumed && !invocation.expired && now <= invocation.expires_at) {
				retainedBundles.add(path.resolve(derivedBundle));
				continue;
			}
			if (invocation.consumed || invocation.expired) {
				durableUnlink(derivedBundle);
				continue;
			}
			durableUnlink(derivedBundle);
			invocation.expired = true;
			invocation.expired_at = now;
			delete invocation.private_bundle_path;
			secureJson(file, invocation);
			cleaned.push(invocation.nonce);
		}
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	try {
		for (const entry of fs.readdirSync(unit.paths.pending, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.startsWith("bundle-") || !entry.name.endsWith(".json")) continue;
			const file = path.resolve(unit.paths.pending, entry.name);
			if (!retainedBundles.has(file)) durableUnlink(file);
		}
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	return cleaned;
}

function issueReviewInvocation(unit, cwd, writerSessionId, now = Date.now()) {
	return withRepositoryLock(cwd, () => withUnitLock(unit, () => {
		assertUnitMutable(unit);
		cleanupExpiredReviewInvocations(unit, now);
			const head = requiredJson(unit.paths.head, "unit_head_corrupt");
			const config = loadConfig(cwd);
			if (config.digest !== head.config_digest) throw Object.assign(new Error("request-contract configuration differs from genesis pin"), { code: "request_contract_config_drift" });
			const state = readUnitState(unit, head);
			if (state.active_mutations && Object.keys(state.active_mutations).length) throw Object.assign(new Error("review cannot start while a governed mutation is in flight"), { code: "review_mutation_in_flight" });
		const reviewerKey = loadReviewerKey(cwd, config);
		const runnerKey = loadReviewRunnerKey(cwd, config);
		if (!reviewerKey || publicKeyFingerprint(reviewerKey) !== head.reviewer_key_fingerprint) throw Object.assign(new Error("reviewer key differs from genesis pin"), { code: "reviewer_key_pin_mismatch" });
		if (!runnerKey || publicKeyFingerprint(runnerKey) !== head.review_runner_key_fingerprint) throw Object.assign(new Error("review runner key differs from genesis pin"), { code: "review_runner_key_pin_mismatch" });
		const writerSessionIds = [...new Set((head.session_bindings || [{ session_id: head.session_id }]).map((binding) => binding.session_id))];
		const writerProcessIds = [...new Set((head.session_bindings || []).flatMap((binding) => binding.host_process_ids || []))].sort((a, b) => a - b);
		const writerProcessIdentities = [...new Set((head.session_bindings || []).flatMap((binding) => binding.host_process_identities || []))].sort();
		if (!writerSessionIds.includes(writerSessionId)) throw Object.assign(new Error("writer session is not bound to this request lineage"), { code: "review_writer_session_unbound" });
		const binding = requiredJson(unit.paths.binding, "binding_state_corrupt");
		const contract = requiredJson(unit.paths.contract, "contract_state_corrupt");
		const sources = verifySourceChain(unit.paths, head);
		const cv = validateContract(contract, sources.records, state.occurrences, { publicKeyPem: loadAuthorityKey(cwd), now, cwd });
		if (!cv.ok) throw Object.assign(new Error(cv.errors.join(", ")), { code: "review_contract_invalid", errors: cv.errors });
		const nonce = opaqueId("REV-");
		const reviewRunId = opaqueId("RUN-");
		const reviewChain = verifyReviewChain(unit.paths);
		if (!reviewChain.ok) throw Object.assign(new Error(reviewChain.errors.join(", ")), { code: "review_log_corrupt" });
		const currentWorkspace = workspaceManifest(cwd, config);
		const effectiveRoles = effectiveReviewRoles(config, contract);
		const preservationReview = Boolean(config.preservation.required || contract.preservation);
		const slots = requiredReviewSlots(config, contract);
		const currentRecords = reviewChain.records.filter((record) => {
			const stable = record.source_head === head.source_head && record.contract_digest === head.contract_digest && record.config_digest === head.config_digest && record.scope_epoch === head.scope_epoch && record.binding_epoch === binding.binding_epoch;
			if (!stable) return false;
			return record.review_stage === "planning" || (record.workspace_digest === currentWorkspace.digest && record.work_revision === head.work_revision);
		});
		const coveredSlots = new Set(currentRecords.filter((record) => record.verdict === "CLEAN").map((record) => `${record.review_stage}:${record.role}`));
		let requiredSlot = slots.find((slot) => !coveredSlots.has(`${slot.stage}:${slot.role}`));
		if (!requiredSlot && !preservationReview && currentRecords.filter((record) => record.verdict === "CLEAN").length < config.minimum_clean_rounds) requiredSlot = slots[currentRecords.length % slots.length];
		if (!requiredSlot) throw Object.assign(new Error("all required review slots already have current CLEAN records"), { code: "review_slots_complete" });
		if (requiredSlot.stage === "planning") {
			const baselineChanged = diffManifests(state.baseline, currentWorkspace.manifest).length > 0;
			if (head.work_revision !== binding.planning_work_revision || baselineChanged) throw Object.assign(new Error("planning review must be sealed before the first implementation mutation"), { code: "review_planning_window_closed" });
		}
		const currentPlanningSeal = planningSeal(unit, config, binding, head, contract);
		if (requiredSlot.stage === "integration") {
			const planningRoles = new Set(currentRecords.filter((record) => record.review_stage === "planning" && record.verdict === "CLEAN").map((record) => record.role));
			if (preservationReview && effectiveRoles.some((role) => !planningRoles.has(role))) throw Object.assign(new Error("integration review cannot begin before every planning role has a CLEAN first verdict"), { code: "review_planning_stage_incomplete" });
			if (!currentPlanningSeal.ok) throw Object.assign(new Error("integration review requires the current planning seal"), { code: "review_planning_stage_incomplete" });
		}
		const bundle = requiredSlot.role === "general" && !effectiveRoles.length
			? buildReviewBundle(unit, cwd)
			: buildReviewBundle(unit, cwd, { stage: requiredSlot.stage, role: requiredSlot.role });
		const requiredRole = requiredSlot.role;
		const bundlePath = path.join(unit.paths.pending, `bundle-${nonce}.json`);
			const manifest = {
			version: VERSION,
				nonce,
			review_run_id: reviewRunId,
			review_stage: requiredSlot.stage,
			required_role: requiredRole,
			expected_delivery_state: expectedDeliveryState(config, contract),
			planning_digest: binding.planning_digest,
			planning_seal_digest: requiredSlot.stage === "integration" ? currentPlanningSeal.digest : null,
			issued_at: now,
			expires_at: now + 10 * 60_000,
			bundle_digest: bundle.digest,
			full_bundle_digest: bundle.full_digest,
			evidence_view_digest: bundle.digest,
			writer_session_id: writerSessionId || "unknown-writer",
			writer_session_ids: writerSessionIds,
			writer_process_ids: writerProcessIds,
			writer_process_identities: writerProcessIdentities,
			source_head: head.source_head,
			contract_digest: head.contract_digest,
			workspace_digest: bundle.workspace.digest,
			config_digest: head.config_digest,
			scope_epoch: head.scope_epoch,
			work_revision: head.work_revision,
			binding_epoch: binding && binding.binding_epoch,
			ids: { ...cv.ids, ...scopeHistoryCoverage(verifyScopeHistory(unit).records), preservationSurfaceMappings: bundle.bundle.review_coverage.preservationSurfaceMappings },
			consumed: false,
				private_bundle_path: bundlePath,
			};
			manifest.invocation_digest = sha256(canonicalJson(reviewInvocationProjection(manifest)));
			secureJson(path.join(unit.paths.pending, `review-${nonce}.json`), manifest, { exclusive: true });
			claimGlobalId(cwd, "review-invocation", nonce, { unit_id: unit.id, invocation_digest: manifest.invocation_digest });
			secureWrite(bundlePath, canonicalJson(bundle.bundle), { exclusive: true });
		const publicManifest = { ...manifest, bundle_locator: normalizeRel(path.relative(cwd, bundlePath)) };
		delete publicManifest.private_bundle_path;
		delete publicManifest.writer_session_id;
		delete publicManifest.writer_session_ids;
		delete publicManifest.writer_process_ids;
		delete publicManifest.writer_process_identities;
		delete publicManifest.ids;
		return { manifest: publicManifest, bundle };
	}, now), now);
}

function observeOccurrence(...args) { return api.observeOccurrence(...args); }
function observeOccurrenceUnlocked(...args) { return api.observeOccurrenceUnlocked(...args); }
function captureWorkspaceOccurrences(...args) { return api.captureWorkspaceOccurrences(...args); }
function verifyReviewChain(...args) { return api.verifyReviewChain(...args); }
function appendReview(...args) { return api.appendReview(...args); }
function appendReviewUnlocked(...args) { return api.appendReviewUnlocked(...args); }
function arrayCovers(...args) { return api.arrayCovers(...args); }
function arrayExactly(...args) { return api.arrayExactly(...args); }
function evaluateReviews(...args) { return api.evaluateReviews(...args); }


	return {
		collectReviewMaterials,
		collectBaselineReviewMaterials,
		buildReviewBundle,
		effectiveReviewRoles,
		expectedDeliveryState,
		requiredReviewSlots,
		planningSeal,
		buildReviewEvidenceView,
		reviewSignaturePayload,
		isolationSignaturePayload,
		reviewInvocationProjection,
		reviewInvocationDigestValid,
		cleanupExpiredReviewInvocations,
		issueReviewInvocation,
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
