"use strict";
module.exports = function createRequestContractModule(api) {
const {
	path, VERSION, ZERO_HASH, TRACE_KEYS, TERMINAL_AUTHORITY_OP, sha256, publicKeyFingerprint, opaqueId,
	canonicalJson, secureJson, appendJsonl, requiredJson, optionalJson, stateDigest, readUnitState, readJsonlStrict,
	loadConfig, loadAuthorityKey, withUnitLock, transactionPath, applyBindTransaction, assertUnitMutable, verifySourceChain, contractDigest,
	directiveScopeProjection, scopeProjection, semanticSubset, authorityPresentation, consumeAuthorityReceipt, validateContract,
} = api;
function bindContract(unit, contract, opts = {}) {
	return withUnitLock(unit, () => bindContractUnlocked(unit, contract, opts));
}

function bindContractUnlocked(unit, contract, opts = {}) {
	assertUnitMutable(unit);
	const cwd = opts.cwd || path.resolve(unit.paths.unit, "../../../..");
	const head = requiredJson(unit.paths.head, "unit_head_corrupt");
	const config = loadConfig(cwd);
	if (config.digest !== head.config_digest) throw Object.assign(new Error("request-contract configuration differs from genesis pin"), { code: "request_contract_config_drift" });
	const authorityKey = loadAuthorityKey(cwd, config);
	if (!authorityKey || !head.authority_key_fingerprint || publicKeyFingerprint(authorityKey) !== head.authority_key_fingerprint) {
		throw Object.assign(new Error("authority key differs from genesis pin"), { code: "authority_key_pin_mismatch" });
	}
	const existing = optionalJson(unit.paths.binding, null, "binding_state_corrupt");
	const storedContract = optionalJson(unit.paths.contract, null, "contract_state_corrupt");
	const verifiedScope = verifyScopeHistory(unit);
	if (!verifiedScope.ok) throw Object.assign(new Error(verifiedScope.errors.join(", ")), { code: "scope_history_corrupt", errors: verifiedScope.errors });
	let priorContract = null;
	if (existing) {
		const latestScope = verifiedScope.records.at(-1);
		if (!storedContract || !latestScope || latestScope.contract_digest !== contractDigest(storedContract) || head.contract_digest !== latestScope.contract_digest) throw Object.assign(new Error("stored contract differs from the last verified scope record"), { code: "contract_state_drift" });
		priorContract = latestScope.contract;
	} else if (storedContract || verifiedScope.records.length) {
		throw Object.assign(new Error("unbound contract or scope history already exists"), { code: "contract_state_drift" });
	}
	if (existing && existing.contract_id !== contract.id && existing.state === "active") throw Object.assign(new Error("active binding conflict"), { code: "binding_conflict" });
	const sources = verifySourceChain(unit.paths, head);
	const state = readUnitState(unit, head);
	const validation = validateContract(contract, sources.records, state.occurrences, { ...opts, publicKeyPem: authorityKey, cwd, config });
	if (!validation.ok) throw Object.assign(new Error(validation.errors.join(", ")), { code: "contract_invalid", errors: validation.errors });
	const priorScope = priorContract ? sha256(canonicalJson(scopeProjection(priorContract))) : null;
	const nextScope = validation.scope_digest;
	const nextEpoch = priorContract && priorScope !== nextScope ? head.scope_epoch + 1 : head.scope_epoch;
	const nextBindingEpoch = existing ? existing.binding_epoch + (priorContract && contractDigest(priorContract) !== contractDigest(contract) ? 1 : 0) : 1;
	const priorAuthorityMap = new Map(((priorContract && priorContract.authorities) || []).map((authority) => [authority.id, authority]));
	const nextAuthorityMap = new Map((contract.authorities || []).map((authority) => [authority.id, authority]));
	for (const [id, authority] of priorAuthorityMap) {
		if (!nextAuthorityMap.has(id)) throw Object.assign(new Error("scope authority history cannot disappear"), { code: "scope_authority_removed" });
		if (canonicalJson(authority) !== canonicalJson(nextAuthorityMap.get(id))) throw Object.assign(new Error("scope authority history is immutable; append a new authority"), { code: "scope_authority_history_mutated" });
	}
	const newAuthorities = (contract.authorities || []).filter((authority) => !priorAuthorityMap.has(authority.id));
	const priorDirectiveMap = new Map(((priorContract && priorContract.directives) || []).map((directive) => [directive.id, directive]));
	const nextDirectiveMap = new Map((contract.directives || []).map((directive) => [directive.id, directive]));
	const addedDirectiveIds = [...nextDirectiveMap.keys()].filter((id) => !priorDirectiveMap.has(id));
	for (const id of priorDirectiveMap.keys()) if (!nextDirectiveMap.has(id)) throw Object.assign(new Error("directives must transition to a retained terminal record, not disappear"), { code: "scope_directive_removed" });
	for (const [id, directive] of priorDirectiveMap) {
		if (TERMINAL_AUTHORITY_OP[directive.state] && canonicalJson(nextDirectiveMap.get(id)) !== canonicalJson(directive)) {
			throw Object.assign(new Error("a disposed directive record is canonically immutable; append a new disposition record"), { code: "scope_terminal_directive_immutable" });
		}
	}
	const changedDirectiveIds = [...priorDirectiveMap].filter(([id, directive]) => nextDirectiveMap.has(id) && canonicalJson(directiveScopeProjection(directive)) !== canonicalJson(directiveScopeProjection(nextDirectiveMap.get(id)))).map(([id]) => id);
	const additiveChangedDirectiveIds = changedDirectiveIds.filter((id) => {
		const prior = priorDirectiveMap.get(id);
		const next = nextDirectiveMap.get(id);
		const priorTargetIds = new Set((prior.targets || []).map((target) => target.id));
		const priorCriterionIds = new Set((prior.acceptance_criteria || []).map((criterion) => criterion.id));
		const addsScopedEntity = (next.targets || []).some((target) => !priorTargetIds.has(target.id)) || (next.acceptance_criteria || []).some((criterion) => !priorCriterionIds.has(criterion.id));
		return addsScopedEntity && semanticSubset(directiveScopeProjection(prior), directiveScopeProjection(next));
	});
	const addedTargetIds = changedDirectiveIds.flatMap((id) => {
		const priorIds = new Set((priorDirectiveMap.get(id).targets || []).map((target) => target.id));
		return (nextDirectiveMap.get(id).targets || []).filter((target) => !priorIds.has(target.id)).map((target) => target.id);
	});
	const addedCriterionIds = changedDirectiveIds.flatMap((id) => {
		const priorIds = new Set((priorDirectiveMap.get(id).acceptance_criteria || []).map((criterion) => criterion.id));
		return (nextDirectiveMap.get(id).acceptance_criteria || []).filter((criterion) => !priorIds.has(criterion.id)).map((criterion) => criterion.id);
	});
	const removedTargetIds = [...priorDirectiveMap].flatMap(([id, directive]) => {
		const nextIds = new Set((nextDirectiveMap.get(id).targets || []).map((target) => target.id));
		return (directive.targets || []).filter((target) => !nextIds.has(target.id)).map((target) => target.id);
	});
	const removedCriterionIds = [...priorDirectiveMap].flatMap(([id, directive]) => {
		const nextIds = new Set((nextDirectiveMap.get(id).acceptance_criteria || []).map((criterion) => criterion.id));
		return (directive.acceptance_criteria || []).filter((criterion) => !nextIds.has(criterion.id)).map((criterion) => criterion.id);
	});
	if (removedTargetIds.length || removedCriterionIds.length) throw Object.assign(new Error("target or acceptance-criterion removal must retain and terminally tombstone the prior directive, then add a replacement directive"), { code: "scope_child_removed" });
	const priorSourceMap = new Map(((priorContract && priorContract.sources) || []).map((source) => [source.id, source]));
	const nextSourceMap = new Map((contract.sources || []).map((source) => [source.id, source]));
	for (const id of priorSourceMap.keys()) if (!nextSourceMap.has(id)) throw Object.assign(new Error("classified sources cannot disappear from scope"), { code: "scope_source_removed" });
	const changedSourceIds = [...priorSourceMap].filter(([id, source]) => nextSourceMap.has(id) && canonicalJson(source) !== canonicalJson(nextSourceMap.get(id))).map(([id]) => id);
	const priorTombstoneMap = new Map(((priorContract && priorContract.tombstones) || []).map((tombstone) => [tombstone.id, tombstone]));
	const nextTombstoneMap = new Map((contract.tombstones || []).map((tombstone) => [tombstone.id, tombstone]));
	for (const id of priorTombstoneMap.keys()) if (!nextTombstoneMap.has(id)) throw Object.assign(new Error("scope tombstones cannot disappear"), { code: "scope_tombstone_removed" });
	const changedTombstones = [...nextTombstoneMap].filter(([id, tombstone]) => !priorTombstoneMap.has(id) || canonicalJson(priorTombstoneMap.get(id)) !== canonicalJson(tombstone));
	const modifiedTombstones = changedTombstones.filter(([id]) => priorTombstoneMap.has(id));
	if (modifiedTombstones.length) throw Object.assign(new Error("a terminal tombstone record is canonically immutable; append a new disposition record"), { code: "scope_tombstone_identity_mutated" });
	const replacementOwner = new Map(addedDirectiveIds.map((id) => [id, id]));
	for (const id of changedDirectiveIds) {
		const priorTargetIds = new Set((priorDirectiveMap.get(id).targets || []).map((target) => target.id));
		const priorCriterionIds = new Set((priorDirectiveMap.get(id).acceptance_criteria || []).map((criterion) => criterion.id));
		for (const target of nextDirectiveMap.get(id).targets || []) if (!priorTargetIds.has(target.id)) replacementOwner.set(target.id, id);
		for (const criterion of nextDirectiveMap.get(id).acceptance_criteria || []) if (!priorCriterionIds.has(criterion.id)) replacementOwner.set(criterion.id, id);
	}
	const exactSet = (actual, expected) => canonicalJson([...(actual || [])].sort()) === canonicalJson([...expected].sort());
	if (!priorContract) {
		if (newAuthorities.length !== 1 || newAuthorities[0].operation !== "authorize_contract") throw Object.assign(new Error("initial scope requires exactly one authorize_contract authority"), { code: "initial_authority_missing" });
		const authority = newAuthorities[0];
		const initialIds = [...nextDirectiveMap.keys()];
		if (!exactSet(authority.target_directive_ids, initialIds) || !exactSet(authority.replacement_ids, initialIds) || !exactSet(authority.affected_source_ids, []) || !exactSet(authority.affected_prior_ids, []) || !exactSet(authority.tombstone_ids, [])) throw Object.assign(new Error("initial authority metadata must exactly own the initial directive set"), { code: "initial_authority_target_mismatch" });
	} else {
		if (newAuthorities.some((authority) => authority.operation === "authorize_contract")) throw Object.assign(new Error("authorize_contract is valid only for genesis scope"), { code: "authority_operation_metadata_mismatch" });
		const additionIds = [...addedDirectiveIds, ...addedTargetIds, ...addedCriterionIds];
		const terminalTargetIds = [...new Set([...changedDirectiveIds.filter((id) => TERMINAL_AUTHORITY_OP[nextDirectiveMap.get(id).state]), ...modifiedTombstones.map(([, tombstone]) => tombstone.directive_id)])];
		const replacementChangeIds = changedDirectiveIds.filter((id) => !additiveChangedDirectiveIds.includes(id) && !terminalTargetIds.includes(id));
		const coveredAdditions = new Set();
		const coveredReplacementChanges = new Set();
		const coveredSources = new Set();
		const coveredTerminalTargets = new Set();
		const coveredTombstones = new Set();
		const operationTargets = new Set();
		for (const authority of newAuthorities) {
			const targets = [...(authority.target_directive_ids || [])];
			if (!targets.length) throw Object.assign(new Error(`authority ${authority.id} has no exact target`), { code: "authority_operation_metadata_mismatch" });
			const targetSet = new Set(targets);
			for (const target of targets) {
				const key = `${authority.operation}:${target}`;
				if (operationTargets.has(key)) throw Object.assign(new Error(`authority operation target is owned more than once: ${key}`), { code: "authority_operation_metadata_mismatch" });
				operationTargets.add(key);
			}
			if (authority.operation === "amend_scope_add") {
				const owned = additionIds.filter((id) => replacementOwner.has(id) && targetSet.has(replacementOwner.get(id)));
				const expectedTargets = [...new Set(owned.map((id) => replacementOwner.get(id)))];
				const expectedAffected = expectedTargets.filter((id) => priorDirectiveMap.has(id));
				if (!owned.length || !exactSet(targets, expectedTargets) || !exactSet(authority.replacement_ids, owned) || !exactSet(authority.affected_prior_ids, expectedAffected) || !exactSet(authority.affected_source_ids, []) || !exactSet(authority.tombstone_ids, [])) throw Object.assign(new Error(`additive authority ${authority.id} does not exactly own its additions`), { code: "authority_operation_metadata_mismatch" });
				for (const id of owned) coveredAdditions.add(id);
				continue;
			}
			if (authority.operation === "amend_scope_replace") {
				if (targets.some((id) => !priorDirectiveMap.has(id) || terminalTargetIds.includes(id)) || !exactSet(authority.affected_prior_ids, targets) || !exactSet(authority.replacement_ids, []) || !exactSet(authority.tombstone_ids, [])) throw Object.assign(new Error(`replacement authority ${authority.id} does not exactly own its prior targets`), { code: "authority_operation_metadata_mismatch" });
				for (const sourceId of authority.affected_source_ids || []) {
					const source = nextSourceMap.get(sourceId) || priorSourceMap.get(sourceId);
					const mapped = source && source.directive_ids || [];
					if (!changedSourceIds.includes(sourceId) || (mapped.length && !mapped.some((id) => targetSet.has(id)))) throw Object.assign(new Error(`replacement authority ${authority.id} owns an unrelated source`), { code: "authority_operation_metadata_mismatch" });
					coveredSources.add(sourceId);
				}
				for (const target of targets) {
					const sourceContribution = (authority.affected_source_ids || []).some((sourceId) => {
						const source = nextSourceMap.get(sourceId) || priorSourceMap.get(sourceId);
						const mapped = source && source.directive_ids || [];
						return !mapped.length || mapped.includes(target);
					});
					if (!replacementChangeIds.includes(target) && !sourceContribution) throw Object.assign(new Error(`replacement authority ${authority.id} target has no replacement delta`), { code: "authority_operation_metadata_mismatch" });
					if (replacementChangeIds.includes(target)) coveredReplacementChanges.add(target);
				}
				continue;
			}
			if (["supersede", "defer", "abandon"].includes(authority.operation)) {
				const expectedTombstones = changedTombstones.filter(([, tombstone]) => targetSet.has(tombstone.directive_id) && TERMINAL_AUTHORITY_OP[tombstone.state] === authority.operation).map(([id]) => id);
				if (!expectedTombstones.length || targets.some((id) => !terminalTargetIds.includes(id) || TERMINAL_AUTHORITY_OP[nextDirectiveMap.get(id).state] !== authority.operation) || !exactSet(authority.affected_prior_ids, targets) || !exactSet(authority.affected_source_ids, []) || !exactSet(authority.tombstone_ids, expectedTombstones)) throw Object.assign(new Error(`terminal authority ${authority.id} does not exactly own its dispositions`), { code: "authority_operation_metadata_mismatch" });
				if (authority.operation === "supersede") {
					if ((authority.replacement_ids || []).some((id) => !addedDirectiveIds.includes(id))) throw Object.assign(new Error("supersede replacements must be newly added directive IDs"), { code: "authority_operation_metadata_mismatch" });
					for (const id of authority.replacement_ids || []) coveredAdditions.add(id);
				} else if (!exactSet(authority.replacement_ids, [])) throw Object.assign(new Error("defer/abandon cannot carry replacement IDs"), { code: "authority_operation_metadata_mismatch" });
				for (const id of targets) coveredTerminalTargets.add(id);
				for (const id of expectedTombstones) coveredTombstones.add(id);
				continue;
			}
			throw Object.assign(new Error(`unsupported scope authority operation: ${authority.operation}`), { code: "authority_operation_metadata_mismatch" });
		}
		for (const [name, actual, expected] of [
			["replacement_ids", [...coveredAdditions], additionIds],
			["affected_prior_ids", [...coveredReplacementChanges], replacementChangeIds],
			["affected_source_ids", [...coveredSources], changedSourceIds],
			["terminal_targets", [...coveredTerminalTargets], terminalTargetIds],
			["tombstone_ids", [...coveredTombstones], changedTombstones.map(([id]) => id)],
		]) if (!exactSet(actual, expected)) throw Object.assign(new Error(`authority ${name} do not exactly match scope delta`), { code: `authority_${name}_mismatch` });
	}
	for (const authority of newAuthorities) {
		const receipt = authority.receipt || {};
		if (priorContract && priorSourceMap.has(authority.source_id)) throw Object.assign(new Error("scope authority must cite an exact later source"), { code: "authority_source_not_later" });
		if (receipt.resulting_scope_digest !== nextScope) throw Object.assign(new Error("authority resulting scope mismatch"), { code: "authority_resulting_scope_mismatch" });
		if (receipt.resulting_scope_epoch !== nextEpoch) throw Object.assign(new Error("authority scope epoch mismatch"), { code: "authority_scope_epoch_mismatch" });
		if (receipt.binding_epoch !== nextBindingEpoch) throw Object.assign(new Error("authority binding epoch mismatch"), { code: "authority_binding_epoch_mismatch" });
		if (priorContract && receipt.prior_scope_digest !== priorScope) throw Object.assign(new Error("authority prior scope mismatch"), { code: "authority_prior_scope_mismatch" });
	}
	if (priorContract && priorScope !== nextScope) {
		head.scope_epoch += 1;
	}
	const nextState = JSON.parse(JSON.stringify(state));
	const pendingCache = new Map();
	for (const authority of newAuthorities) {
		const presentation = authorityPresentation(authority, priorScope, nextScope, nextEpoch, nextBindingEpoch);
		consumeAuthorityReceipt(unit, authority, presentation, cwd, nextState, opts.now || Date.now(), { persistPending: false, pendingCache });
	}
	const digest = contractDigest(contract);
	const binding = existing ? JSON.parse(JSON.stringify(existing)) : { version: VERSION, contract_id: contract.id, binding_epoch: 1, state: "active" };
	if (priorContract && contractDigest(priorContract) !== digest) binding.binding_epoch += 1;
	const scopePlan = planScopeVersion(unit, contract, { scope_epoch: head.scope_epoch, binding_epoch: binding.binding_epoch });
	const nextHead = { ...head, contract_digest: digest, work_revision: head.work_revision + 1, state_digest: stateDigest(nextState) };
	binding.planning_work_revision = nextHead.work_revision;
	binding.planning_digest = sha256(canonicalJson({
		source_head: nextHead.source_head,
		contract_digest: digest,
		config_digest: nextHead.config_digest,
		scope_epoch: nextHead.scope_epoch,
		binding_epoch: binding.binding_epoch,
		baseline_digest: sha256(canonicalJson(nextState.baseline)),
		surface_inventory_digest: contract.preservation && contract.preservation.inventory && contract.preservation.inventory.surface_inventory_digest || null,
	}));
	const transaction = {
		version: VERSION,
		kind: "bind",
		created_at: opts.now || Date.now(),
		expected_scope: { count: scopePlan.prior.count, chain_head: scopePlan.prior.chain_head },
		scope_record: scopePlan.record,
		scope_head: scopePlan.head,
		contract,
		binding,
		head: nextHead,
		state: nextState,
		pending_updates: [...pendingCache].map(([pendingPath, pending]) => ({ name: path.basename(pendingPath), value: pending })),
	};
	secureJson(transactionPath(unit, "bind"), transaction, { exclusive: true });
	if (opts.afterTransactionPrepared) opts.afterTransactionPrepared(transaction);
	applyBindTransaction(unit, transaction);
	unit.head = nextHead;
	return { digest, binding };
}

function planScopeVersion(unit, contract, epochs) {
	const scopeHead = optionalJson(unit.paths.scopeHead, { version: VERSION, count: 0, chain_head: ZERO_HASH }, "scope_head_corrupt");
	const payload = {
		version: VERSION,
		scope_version_id: `SCP-${opaqueId()}`,
		seq: scopeHead.count + 1,
		prev_hash: scopeHead.chain_head,
		contract_digest: contractDigest(contract),
		scope_digest: sha256(canonicalJson(scopeProjection(contract))),
		scope_epoch: epochs.scope_epoch,
		binding_epoch: epochs.binding_epoch,
		contract,
	};
	const record = { ...payload, record_hash: sha256(canonicalJson(payload)) };
	return { prior: scopeHead, record, head: { ...scopeHead, count: record.seq, chain_head: record.record_hash } };

}

function appendScopeVersion(unit, contract, epochs) {
	const plan = planScopeVersion(unit, contract, epochs);
	appendJsonl(unit.paths.scopeHistory, plan.record);
	secureJson(unit.paths.scopeHead, plan.head);
	return plan.record;
}

function verifyScopeHistory(unit) {
	let records;
	try {
		records = readJsonlStrict(unit.paths.scopeHistory, "scope_history_corrupt", { allowMissing: true });
	} catch (error) {
		return { ok: false, errors: [error.code], records: [], head: null };
	}
	const head = optionalJson(unit.paths.scopeHead, { count: 0, chain_head: ZERO_HASH }, "scope_head_corrupt");
	const errors = [];
	let prev = ZERO_HASH;
	for (let i = 0; i < records.length; i++) {
		const r = records[i];
		const payload = { ...r };
		delete payload.record_hash;
		if (r.seq !== i + 1 || r.prev_hash !== prev) errors.push("scope_history_sequence_invalid");
		if (!/^SCP-[a-f0-9]{32}$/.test(r.scope_version_id || "") || records.slice(0, i).some((prior) => prior.scope_version_id === r.scope_version_id)) errors.push("scope_history_version_id_invalid");
		if (contractDigest(r.contract) !== r.contract_digest) errors.push("scope_history_contract_digest_invalid");
		if (sha256(canonicalJson(scopeProjection(r.contract))) !== r.scope_digest) errors.push("scope_history_scope_digest_invalid");
		if (sha256(canonicalJson(payload)) !== r.record_hash) errors.push("scope_history_record_hash_invalid");
		prev = r.record_hash;
	}
	if (records.length !== head.count || (records.length ? prev : ZERO_HASH) !== head.chain_head) errors.push("scope_history_head_mismatch");
	return { ok: errors.length === 0, errors: [...new Set(errors)], records, head };
}

function scopeHistoryCoverage(records) {
	const scopeVersionIds = [];
	const scopeVersionMappings = [];
	for (const record of records || []) {
		const contract = record.contract || {};
		scopeVersionIds.push(record.scope_version_id);
		scopeVersionMappings.push(canonicalJson({
			scope_version_id: record.scope_version_id,
			// The reviewer attests the complete opaque relationship graph. Exact text,
			// paths, locators, and digests stay inside the signed private bundle.
			contract: contractCoverageProjection(contract),
		}));
	}
	return { scopeVersionIds, scopeVersionMappings };
}

function contractCoverageProjection(contract) {
	const directives = contract.directives || [];
	const artifacts = contract.artifacts || {};
	const projection = {
		sources: (contract.sources || []).map((source) => ({ source_id: source.id, classification: source.classification, source_kind: source.source_kind, derived_from: source.derived_from, derivation_kind: source.derivation_kind, directive_ids: source.directive_ids || [], obligation_atoms: (source.obligation_atoms || []).map((atom) => ({ id: atom.id, subject: atom.subject, effect: atom.effect, render_policy: atom.render_policy, directive_ids: atom.directive_ids || [] })) })),
		directives: directives.map((directive) => ({
			directive_id: directive.id,
			state: directive.state,
			source_ids: directive.source_ids || [],
			obligation_atom_ids: directive.obligation_atom_ids || [],
			target_ids: (directive.targets || []).map((target) => target.id),
			criterion_ids: (directive.acceptance_criteria || []).map((criterion) => criterion.id),
			trace: Object.fromEntries(TRACE_KEYS.map((key) => [key, (directive.trace && directive.trace[key]) || []])),
		})),
		targets: directives.flatMap((directive) => (directive.targets || []).map((target) => ({ target_id: target.id, directive_id: directive.id, obligation_atom_ids: target.obligation_atom_ids || [], kind: target.kind, audience: target.audience, exposure: target.exposure, objective_atom_ids: target.objective_atom_ids || [], content_source_atom_ids: target.content_source_atom_ids || [] }))),
		criteria: directives.flatMap((directive) => (directive.acceptance_criteria || []).map((criterion) => ({ criterion_id: criterion.id, directive_id: directive.id, obligation_atom_ids: criterion.obligation_atom_ids || [] }))),
		artifacts: TRACE_KEYS.flatMap((kind) => (artifacts[kind] || []).map((artifact) => ({ kind, artifact_id: artifact.id, subject_id: artifact.subject_id, obligation_atom_ids: artifact.obligation_atom_ids || [] }))),
		edges: (contract.edges || []).map((edge) => ({ edge_id: edge.id, kind: edge.kind, from: edge.from, to: edge.to, obligation_atom_ids: edge.obligation_atom_ids || [] })),
		authorities: (contract.authorities || []).map((authority) => ({ authority_id: authority.id, operation: authority.operation, source_id: authority.source_id, target_directive_ids: authority.target_directive_ids || [], affected_source_ids: authority.affected_source_ids || [], affected_prior_ids: authority.affected_prior_ids || [], replacement_ids: authority.replacement_ids || [], tombstone_ids: authority.tombstone_ids || [] })),
		tombstones: (contract.tombstones || []).map((tombstone) => ({ tombstone_id: tombstone.id, directive_id: tombstone.directive_id, state: tombstone.state, authority_id: tombstone.authority_id, disposed_scope_ids: tombstone.disposed_scope_ids || [] })),
		changes: (contract.changes || []).map((change) => ({ change_id: change.id, directive_id: change.directive_id, implementation_id: change.implementation_id, evidence_id: change.evidence_id })),
	};
	if (contract.preservation) projection.preservation = contract.preservation;
	return projection;
}

function contractCoverageIds(contract, occurrences = []) {
	const projection = contractCoverageProjection(contract || {});
	return {
		sourceIds: projection.sources.map((item) => item.source_id),
		sourceMappings: projection.sources.map((item) => canonicalJson(item)),
		directiveIds: projection.directives.map((item) => item.directive_id),
		targetIds: projection.targets.map((item) => item.target_id),
		criterionIds: projection.criteria.map((item) => item.criterion_id),
		authorityIds: projection.authorities.map((item) => item.authority_id),
		authorityMappings: projection.authorities.map((item) => canonicalJson(item)),
		tombstoneIds: projection.tombstones.map((item) => item.tombstone_id),
		tombstoneMappings: projection.tombstones.map((item) => canonicalJson(item)),
		artifactIds: projection.artifacts.map((item) => item.artifact_id),
		edgeIds: projection.edges.map((item) => item.edge_id),
		occurrenceIds: (occurrences || []).map((item) => item.id),
		changeMappings: projection.changes.map((item) => canonicalJson(item)),
	};
}

	return {
		bindContract,
		bindContractUnlocked,
		planScopeVersion,
		appendScopeVersion,
		verifyScopeHistory,
		scopeHistoryCoverage,
		contractCoverageProjection,
		contractCoverageIds,
	};
};
