"use strict";
module.exports = function createRequestContractModule(api) {
const {
	crypto, fs, path, preservationPolicy, VERSION, TRACE_KEYS, TRACE_EDGES, SCOPE_STATES,
	CLASSIFICATIONS, SOURCE_SUBJECTS, SOURCE_EFFECTS, RENDER_POLICIES, OUTPUT_KINDS, OUTPUT_AUDIENCES, OUTPUT_EXPOSURES, AUTH_OPS,
	TERMINAL_AUTHORITY_OP, closedObject, validId, sha256, opaqueId, canonicalJson, ensureDir, secureJson,
	readJson, readUnitState, loadConfig, loadAuthorityKey, preservationRunnerContext, withUnitLock, assertUnitMutable, governedWorkspacePath,
} = api;
function contractDigest(contract) {
	return sha256(canonicalJson(contract));
}

function directiveScopeProjection(d) {
	return {
		id: d.id,
		statement: d.statement,
		state: TERMINAL_AUTHORITY_OP[d.state] ? d.state : "open",
		source_ids: d.source_ids || [],
		targets: d.targets || [],
		acceptance_criteria: d.acceptance_criteria || [],
	};
}

function scopeProjection(contract) {
	const projection = {
		sources: (contract.sources || []).map((s) => ({ id: s.id, classification: s.classification, source_kind: s.source_kind, derived_from: s.derived_from, derivation_kind: s.derivation_kind, directive_ids: s.directive_ids || [], obligation_atoms: s.obligation_atoms || [] })),
		directives: (contract.directives || []).map(directiveScopeProjection),
		authorities: (contract.authorities || []).map((a) => ({
			id: a.id,
			operation: a.operation,
			source_id: a.source_id,
			source_digest: a.source_digest,
			target_directive_ids: a.target_directive_ids || [],
			affected_source_ids: a.affected_source_ids || [],
			affected_prior_ids: a.affected_prior_ids || [],
			replacement_ids: a.replacement_ids || [],
			tombstone_ids: a.tombstone_ids || [],
			receipt_nonce: a.receipt && a.receipt.nonce,
		})),
		tombstones: contract.tombstones || [],
	};
	if (contract.preservation) projection.preservation = contract.preservation;
	return projection;
}

function directiveDisposedScopeIds(directive, edges = []) {
	const ids = new Set([
		directive.id,
		...(directive.targets || []).map((target) => target.id),
		...(directive.acceptance_criteria || []).map((criterion) => criterion.id),
	]);
	for (const key of TRACE_KEYS) for (const id of (directive.trace && directive.trace[key]) || []) ids.add(id);
	for (const spec of TRACE_EDGES) {
		const fromIds = new Set(spec.from === "directives" ? [directive.id] : (directive.trace && directive.trace[spec.from]) || []);
		const toIds = new Set((directive.trace && directive.trace[spec.to]) || []);
		for (const edge of edges || []) if (edge.kind === spec.kind && fromIds.has(edge.from) && toIds.has(edge.to)) ids.add(edge.id);
	}
	return [...ids].sort();
}

function semanticSubset(prior, next) {
	if (Array.isArray(prior)) {
		if (!Array.isArray(next)) return false;
		return prior.every((item) => {
			if (item && typeof item === "object" && item.id) return next.some((candidate) => candidate && candidate.id === item.id && semanticSubset(item, candidate));
			return next.some((candidate) => canonicalJson(candidate) === canonicalJson(item));
		});
	}
	if (prior && typeof prior === "object") {
		if (!next || typeof next !== "object" || Array.isArray(next)) return false;
		return Object.keys(prior).every((key) => Object.prototype.hasOwnProperty.call(next, key) && semanticSubset(prior[key], next[key]));
	}
	return prior === next;
}

function validateAuthorityReceipt(receipt, publicKeyPem, now = Date.now(), opts = {}) {
	const errors = [];
	closedObject(receipt, ["operation", "nonce", "issued_at", "expires_at", "prior_scope_digest", "resulting_scope_digest", "resulting_scope_epoch", "binding_epoch", "challenge", "presentation_digest", "target_directive_ids", "affected_source_ids", "affected_prior_ids", "replacement_ids", "tombstone_ids", "sign_count", "user_presence", "signature"], errors, "authority_receipt");
	if (!receipt || !AUTH_OPS.has(receipt.operation)) errors.push("authority_operation_invalid");
	if (!receipt || !receipt.user_presence || receipt.user_presence.present !== true) errors.push("authority_user_presence_missing");
	if (!receipt || !receipt.user_presence || receipt.user_presence.non_exportable !== true) errors.push("authority_non_exportable_missing");
	if (!receipt || !receipt.user_presence || !receipt.user_presence.credential_id) errors.push("authority_credential_missing");
	if (!receipt || typeof receipt.nonce !== "string" || receipt.nonce.length < 16 || typeof receipt.signature !== "string" || !receipt.signature) errors.push("authority_signature_missing");
	if (receipt && (!Number.isInteger(receipt.issued_at) || !Number.isInteger(receipt.expires_at) || receipt.expires_at <= receipt.issued_at)) errors.push("authority_time_window_invalid");
	if (!receipt || typeof receipt.challenge !== "string" || receipt.challenge.length < 16 || !/^[a-f0-9]{64}$/.test(receipt.presentation_digest || "")) errors.push("authority_challenge_missing");
	if (!receipt || !Number.isInteger(receipt.sign_count) || receipt.sign_count < 1) errors.push("authority_sign_counter_invalid");
	if (!receipt || !Array.isArray(receipt.target_directive_ids)) errors.push("authority_target_set_missing");
	for (const field of ["target_directive_ids", "affected_prior_ids", "replacement_ids", "tombstone_ids"]) {
		if (!receipt || !Array.isArray(receipt[field])) errors.push(`authority_${field}_missing`);
		else if (new Set(receipt[field]).size !== receipt[field].length || receipt[field].some((id) => !validId(id))) errors.push(`authority_${field}_invalid`);
	}
	if (!receipt || !Array.isArray(receipt.affected_source_ids)) errors.push("authority_affected_source_ids_missing");
	else if (new Set(receipt.affected_source_ids).size !== receipt.affected_source_ids.length || receipt.affected_source_ids.some((id) => !/^SRC-[a-f0-9]{32}$/.test(id))) errors.push("authority_affected_source_ids_invalid");
	if (receipt && receipt.user_presence) {
		closedObject(receipt.user_presence, ["present", "non_exportable", "credential_id", "authenticator_kind"], errors, "authority_user_presence");
		if (!['platform', 'passkey', 'hardware'].includes(receipt.user_presence.authenticator_kind)) errors.push("authority_authenticator_kind_invalid");
	}
	if (opts.checkExpiry !== false && receipt && receipt.expires_at != null && now > receipt.expires_at) errors.push("authority_expired");
	if (receipt && receipt.issued_at != null && receipt.issued_at > now + 60_000) errors.push("authority_issued_in_future");
	if (receipt && receipt.operation !== "authorize_contract") {
		for (const f of ["prior_scope_digest", "resulting_scope_digest", "resulting_scope_epoch", "binding_epoch"]) {
			if (receipt[f] == null) errors.push(`authority_${f}_missing`);
		}
	}
	if (receipt && (!/^[a-f0-9]{64}$/.test(receipt.resulting_scope_digest || "") || !Number.isInteger(receipt.resulting_scope_epoch) || !Number.isInteger(receipt.binding_epoch) || receipt.binding_epoch < 1)) errors.push("authority_scope_binding_invalid");
	if (receipt && receipt.prior_scope_digest != null && !/^[a-f0-9]{64}$/.test(receipt.prior_scope_digest)) errors.push("authority_prior_scope_digest_invalid");
	if (!publicKeyPem) errors.push("authority_public_key_unavailable");
	if (publicKeyPem && receipt && receipt.signature) {
		try {
			const payload = { ...receipt };
			delete payload.signature;
			const ok = crypto.verify(null, Buffer.from(canonicalJson(payload)), publicKeyPem, Buffer.from(receipt.signature, "base64"));
			if (!ok) errors.push("authority_signature_invalid");
		} catch {
			errors.push("authority_signature_invalid");
		}
	}
	return { ok: errors.length === 0, errors };
}

function authorityPresentation(authority, priorScope, nextScope, nextEpoch, nextBindingEpoch) {
	return {
		operation: authority.operation,
		source_id: authority.source_id,
		source_digest: authority.source_digest,
		target_directive_ids: [...(authority.target_directive_ids || [])].sort(),
		affected_source_ids: [...(authority.affected_source_ids || [])].sort(),
		affected_prior_ids: [...(authority.affected_prior_ids || [])].sort(),
		replacement_ids: [...(authority.replacement_ids || [])].sort(),
		tombstone_ids: [...(authority.tombstone_ids || [])].sort(),
		prior_scope_digest: priorScope,
		resulting_scope_digest: nextScope,
		resulting_scope_epoch: nextEpoch,
		binding_epoch: nextBindingEpoch,
	};
}

function issueAuthorityChallenge(unit, cwd, presentation, now = Date.now()) {
	return withUnitLock(unit, () => {
		const presentations = Array.isArray(presentation) ? presentation : [presentation];
		if (!presentations.length || presentations.some((item) => !item || typeof item !== "object" || Array.isArray(item))) throw Object.assign(new Error("one or more canonical authority presentations are required"), { code: "authority_presentation_invalid" });
			const terminal = readUnitState(unit).terminal;
		if (terminal && !(terminal.status === "incomplete" && presentations.length === 1 && presentations[0].operation === "resume")) assertUnitMutable(unit);
		const key = loadAuthorityKey(cwd);
		if (!key) throw Object.assign(new Error("authority public key unavailable"), { code: "authority_public_key_unavailable" });
		const presentationDigests = presentations.map((item) => sha256(canonicalJson(item))).sort();
		if (new Set(presentationDigests).size !== presentationDigests.length) throw Object.assign(new Error("authority transaction contains a duplicate presentation"), { code: "authority_presentation_invalid" });
		const bindingEpochs = [...new Set(presentations.map((item) => item.binding_epoch))];
		if (bindingEpochs.length !== 1) throw Object.assign(new Error("authority transaction presentations must share one binding epoch"), { code: "authority_presentation_invalid" });
		const requestDigest = sha256(canonicalJson({ unit_id: unit.id, binding_epoch: bindingEpochs[0], presentation_digests: presentationDigests }));
		ensureDir(unit.paths.pending);
		for (const entry of fs.readdirSync(unit.paths.pending, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.startsWith("authority-") || !entry.name.endsWith(".json")) continue;
			const file = path.join(unit.paths.pending, entry.name);
			const prior = readJson(file);
			if (!prior || prior.consumed || prior.superseded) continue;
			if (prior.request_digest === requestDigest && now <= prior.expires_at) return prior;
			prior.superseded = true;
			prior.superseded_at = now;
			prior.superseded_by_request_digest = requestDigest;
			secureJson(file, prior);
		}
		const challenge = opaqueId("AUT-");
		const pending = {
			version: VERSION,
			challenge,
			issued_at: now,
			expires_at: now + 10 * 60_000,
			presentation_digest: presentations.length === 1 ? presentationDigests[0] : null,
			presentation_digests: presentationDigests,
			request_digest: requestDigest,
			binding_epoch: bindingEpochs[0],
			operation: presentations.length === 1 ? presentations[0].operation : "mixed",
			target_directive_ids: [...new Set(presentations.flatMap((item) => item.target_directive_ids || []))].sort(),
			consumed_presentation_digests: [],
			consumed: false,
		};
		secureJson(path.join(unit.paths.pending, `authority-${challenge}.json`), pending, { exclusive: true });
		return pending;
	}, now);
}

function consumeAuthorityReceipt(unit, authority, presentation, cwd, state, now = Date.now(), opts = {}) {
	const receipt = authority.receipt || {};
	const config = loadConfig(cwd);
	const errors = validateAuthorityReceipt(receipt, loadAuthorityKey(cwd, config), now).errors;
	const expectedDigest = sha256(canonicalJson(presentation));
	if (receipt.presentation_digest !== expectedDigest) errors.push("authority_presentation_digest_mismatch");
	if (canonicalJson([...(receipt.target_directive_ids || [])].sort()) !== canonicalJson(presentation.target_directive_ids)) errors.push("authority_target_set_mismatch");
	for (const field of ["affected_source_ids", "affected_prior_ids", "replacement_ids", "tombstone_ids"]) {
		if (canonicalJson([...(receipt[field] || [])].sort()) !== canonicalJson(presentation[field] || [])) errors.push(`authority_${field}_mismatch`);
	}
	let pending = null;
	let pendingPath = null;
	if (receipt.challenge) {
		pendingPath = path.join(unit.paths.pending, `authority-${receipt.challenge}.json`);
		pending = opts.pendingCache && opts.pendingCache.get(pendingPath) || readJson(pendingPath);
		if (!pending) errors.push("authority_challenge_unknown");
		else {
			if (pending.consumed || (pending.consumed_presentation_digests || []).includes(expectedDigest)) errors.push("authority_challenge_replayed");
			if (pending.superseded) errors.push("authority_challenge_superseded");
			if (now > pending.expires_at) errors.push("authority_challenge_expired");
			if (!(pending.presentation_digests || [pending.presentation_digest]).includes(expectedDigest)) errors.push("authority_challenge_presentation_mismatch");
		}
	}
	const credentialId = receipt.user_presence && receipt.user_presence.credential_id;
	if (config.authority.credential_id && credentialId !== config.authority.credential_id) errors.push("authority_credential_mismatch");
	state.authority_counters = state.authority_counters || {};
	if (credentialId && receipt.sign_count <= (state.authority_counters[credentialId] || 0)) errors.push("authority_sign_counter_rollback");
	state.consumed_authority_nonces = state.consumed_authority_nonces || [];
	if (state.consumed_authority_nonces.includes(receipt.nonce)) errors.push("authority_nonce_replayed");
	if (errors.length) throw Object.assign(new Error(errors.join(", ")), { code: "authority_receipt_invalid", errors });
	pending.consumed_presentation_digests = [...new Set([...(pending.consumed_presentation_digests || []), expectedDigest])].sort();
	pending.authority_ids = [...new Set([...(pending.authority_ids || []), authority.id])].sort();
	pending.consumed = pending.consumed_presentation_digests.length === (pending.presentation_digests || [pending.presentation_digest]).length;
	if (pending.consumed) pending.consumed_at = now;
	state.authority_counters[credentialId] = receipt.sign_count;
	state.consumed_authority_nonces.push(receipt.nonce);
	if (opts.pendingCache) opts.pendingCache.set(pendingPath, pending);
	if (opts.persistPending !== false) secureJson(pendingPath, pending);
	return { pendingPath, pending };
}

function validateContract(...args) { return api.validateContract(...args); }


	return {
		contractDigest,
		directiveScopeProjection,
		scopeProjection,
		directiveDisposedScopeIds,
		semanticSubset,
		validateAuthorityReceipt,
		authorityPresentation,
		issueAuthorityChallenge,
		consumeAuthorityReceipt,
		validateContract,
	};
};
