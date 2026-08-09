"use strict";
module.exports = function createRequestContractModule(api) {
const {
	crypto, fs, path, preservationPolicy, VERSION, TRACE_KEYS, TRACE_EDGES, SCOPE_STATES,
	CLASSIFICATIONS, SOURCE_SUBJECTS, SOURCE_EFFECTS, RENDER_POLICIES, OUTPUT_KINDS, OUTPUT_AUDIENCES, OUTPUT_EXPOSURES, AUTH_OPS,
	TERMINAL_AUTHORITY_OP, closedObject, validId, sha256, opaqueId, canonicalJson, ensureDir, secureJson,
	readJson, readUnitState, loadConfig, loadAuthorityKey, preservationRunnerContext, withUnitLock, assertUnitMutable, governedWorkspacePath,
} = api;
function contractDigest(...args) { return api.contractDigest(...args); }
function directiveScopeProjection(...args) { return api.directiveScopeProjection(...args); }
function scopeProjection(...args) { return api.scopeProjection(...args); }
function directiveDisposedScopeIds(...args) { return api.directiveDisposedScopeIds(...args); }
function semanticSubset(...args) { return api.semanticSubset(...args); }
function validateAuthorityReceipt(...args) { return api.validateAuthorityReceipt(...args); }
function authorityPresentation(...args) { return api.authorityPresentation(...args); }
function issueAuthorityChallenge(...args) { return api.issueAuthorityChallenge(...args); }
function consumeAuthorityReceipt(...args) { return api.consumeAuthorityReceipt(...args); }

function validateContract(contract, sourceRecords = [], occurrences = [], opts = {}) {
	const errors = [];
	const workspaceConfig = opts.cwd ? opts.config || loadConfig(opts.cwd) : null;
	if (!contract || contract.kind !== "request-contract" || ![1, 2].includes(contract.version)) return { ok: false, errors: ["contract_shape_invalid"] };
	const contextOutputV2 = contract.version === 2;
	closedObject(contract, ["kind", "version", "id", "status", "sources", "directives", "artifacts", "edges", "authorities", "tombstones", "changes", "preservation"], errors, "contract");
	if (!contract.id || !Array.isArray(contract.sources) || !Array.isArray(contract.directives) || !contract.artifacts || !Array.isArray(contract.edges)) errors.push("contract_required_field_missing");
	if (!validId(contract.id)) errors.push("contract_id_invalid");
	if (!["draft", "active", "complete", "incomplete"].includes(contract.status)) errors.push("contract_status_invalid");
	for (const field of ["authorities", "tombstones", "changes"]) if (!Array.isArray(contract[field])) errors.push(`contract_${field}_missing`);
	const sourceIds = new Set(sourceRecords.map((s) => s.source_id));
	const sourceRecordMap = new Map(sourceRecords.map((source) => [source.source_id, source]));
	const declaredSources = new Map();
	const obligations = new Map();
	for (const s of contract.sources || []) {
		closedObject(s, ["id", "classification", "source_kind", "derived_from", "derivation_kind", "directive_ids", "obligation_atoms"], errors, "contract_source");
		if (!s.id || declaredSources.has(s.id)) errors.push("contract_source_id_duplicate");
		if (typeof s.id !== "string" || !/^SRC-[a-f0-9]{32}$/.test(s.id)) errors.push("contract_source_id_invalid");
		declaredSources.set(s.id, s);
		if (!CLASSIFICATIONS.has(s.classification)) errors.push("contract_source_classification_invalid");
		if (!Array.isArray(s.directive_ids)) errors.push("contract_source_mapping_missing");
		else if (new Set(s.directive_ids).size !== s.directive_ids.length || s.directive_ids.some((id) => !validId(id))) errors.push("contract_source_mapping_invalid");
		if (!Array.isArray(s.obligation_atoms) || s.obligation_atoms.length === 0) errors.push(`contract_source_obligations_missing:${s.id}`);
		else {
			for (const atom of s.obligation_atoms) {
				closedObject(atom, ["id", "text", "directive_ids", "subject", "effect", "render_policy"], errors, "contract_source_obligation");
				if (!atom || !validId(atom.id) || obligations.has(atom.id)) errors.push(`contract_source_obligation_id_invalid:${s.id}`);
				if (atom && atom.id && !obligations.has(atom.id)) obligations.set(atom.id, { source: s, atom });
				if (!atom || typeof atom.text !== "string" || atom.text.length === 0 || !Array.isArray(atom.directive_ids) || new Set(atom.directive_ids).size !== atom.directive_ids.length || atom.directive_ids.some((id) => !validId(id))) errors.push(`contract_source_obligation_invalid:${s.id}:${atom && atom.id}`);
				if (contextOutputV2 && (!SOURCE_SUBJECTS.has(atom.subject) || !SOURCE_EFFECTS.has(atom.effect) || !RENDER_POLICIES.has(atom.render_policy))) errors.push(`contract_source_render_metadata_invalid:${s.id}:${atom && atom.id}`);
			}
			const sourceRecord = sourceRecordMap.get(s.id);
			if (sourceRecord && s.obligation_atoms.map((atom) => atom.text || "").join("") !== sourceRecord.prompt) errors.push(`contract_source_obligation_coverage_mismatch:${s.id}`);
		}
		if (["directive", "approval", "authority"].includes(s.classification) && (!Array.isArray(s.directive_ids) || s.directive_ids.length === 0)) errors.push(`contract_actionable_source_unmapped:${s.id}`);
		if (contextOutputV2 && !["directive", "approval", "authority"].includes(s.classification)) {
			if ((s.directive_ids || []).length !== 0) errors.push(`contract_nonactionable_source_mapped:${s.id}`);
			for (const atom of s.obligation_atoms || []) if ((atom.directive_ids || []).length !== 0) errors.push(`contract_nonactionable_atom_mapped:${s.id}:${atom.id}`);
		}
	}
	for (const id of sourceIds) if (!declaredSources.has(id)) errors.push(`contract_source_uncovered:${id}`);
	for (const id of declaredSources.keys()) if (!sourceIds.has(id)) errors.push(`contract_source_unknown:${id}`);
	const declaredDirectiveIds = new Set((contract.directives || []).map((directive) => directive && directive.id).filter(Boolean));
	const validateObligationRefs = (refs, context) => {
		if (!Array.isArray(refs) || refs.length === 0) {
			errors.push(`contract_obligation_refs_missing:${context}`);
			return;
		}
		if (new Set(refs).size !== refs.length || refs.some((id) => !validId(id) || !obligations.has(id))) errors.push(`contract_obligation_refs_invalid:${context}`);
	};

	closedObject(contract.artifacts, TRACE_KEYS, errors, "contract_artifacts");
	const artifactMaps = {};
	const artifactIds = new Set();
	for (const category of TRACE_KEYS) {
		artifactMaps[category] = new Map();
		const entries = contract.artifacts && contract.artifacts[category];
		if (!Array.isArray(entries)) {
			errors.push(`contract_artifact_category_missing:${category}`);
			continue;
		}
		for (const artifact of entries) {
			closedObject(artifact, category === "evidence" ? ["id", "statement", "obligation_atom_ids", "kind", "subject_id", "locator", "digest"] : ["id", "statement", "obligation_atom_ids"], errors, `contract_artifact_${category}`);
			if (!artifact || !artifact.id || artifactMaps[category].has(artifact.id) || artifactIds.has(artifact.id) || declaredDirectiveIds.has(artifact.id)) errors.push(`contract_artifact_id_duplicate:${category}`);
			if (!artifact || !validId(artifact.id)) errors.push(`contract_artifact_id_invalid:${category}`);
			if (!artifact || typeof artifact.statement !== "string" || !artifact.statement.trim()) errors.push(`contract_artifact_definition_missing:${category}:${artifact && artifact.id}`);
			validateObligationRefs(artifact && artifact.obligation_atom_ids, `${category}:${artifact && artifact.id}`);
			if (category === "evidence" && (typeof artifact.kind !== "string" || !artifact.kind.trim() || !artifact.subject_id || typeof artifact.locator !== "string" || !artifact.locator.trim() || !/^[a-f0-9]{64}$/.test(artifact.digest || ""))) errors.push(`contract_evidence_definition_missing:${artifact && artifact.id}`);
			if (category === "evidence" && artifact && artifact.locator && workspaceConfig) {
				const location = governedWorkspacePath(opts.cwd, artifact.locator, workspaceConfig, { physical: true });
				if (!location.ok) errors.push(`contract_evidence_locator_${location.reason}:${artifact.id}`);
				else {
					try {
						if (sha256(fs.readFileSync(location.absolute)) !== artifact.digest) errors.push(`contract_evidence_digest_mismatch:${artifact.id}`);
					} catch {
						errors.push(`contract_evidence_unreadable:${artifact.id}`);
					}
				}
			}
			if (artifact && artifact.id) {
				artifactMaps[category].set(artifact.id, artifact);
				artifactIds.add(artifact.id);
			}
		}
	}
	const edgeIds = new Set();
	const edges = Array.isArray(contract.edges) ? contract.edges : [];
	const edgeByKind = new Map(TRACE_EDGES.map((spec) => [spec.kind, []]));
	for (const edge of edges) {
		closedObject(edge, ["id", "kind", "from", "to"], errors, "contract_edge");
		if (!edge || !edge.id || edgeIds.has(edge.id)) errors.push("contract_edge_id_duplicate");
		if (!edge || !validId(edge.id) || !validId(edge.from) || !validId(edge.to)) errors.push("contract_edge_id_invalid");
		if (edge && edge.id) edgeIds.add(edge.id);
		const spec = TRACE_EDGES.find((candidate) => candidate.kind === (edge && edge.kind));
		if (!spec) {
			errors.push(`contract_edge_kind_invalid:${edge && edge.id}`);
			continue;
		}
		if (spec.from === "directives" ? !declaredDirectiveIds.has(edge.from) : !artifactMaps[spec.from].has(edge.from)) errors.push(`contract_edge_from_unknown:${edge.id}`);
		if (!artifactMaps[spec.to].has(edge.to)) errors.push(`contract_edge_to_unknown:${edge.id}`);
		edgeByKind.get(spec.kind).push(edge);
	}
	for (const spec of TRACE_EDGES) if ((edgeByKind.get(spec.kind) || []).length === 0) errors.push(`contract_edge_kind_missing:${spec.kind}`);
	for (const evidence of artifactMaps.evidence.values()) {
		if (!artifactMaps.implementations.has(evidence.subject_id)) errors.push(`contract_evidence_subject_unknown:${evidence.id}`);
		if (!(edgeByKind.get("implementations_to_evidence") || []).some((edge) => edge.from === evidence.subject_id && edge.to === evidence.id)) errors.push(`contract_evidence_subject_edge_missing:${evidence.id}`);
	}

	const directives = new Map();
	const targetIds = new Set();
	const criterionIds = new Set();
	for (const d of contract.directives || []) {
		closedObject(d, ["id", "statement", "state", "source_ids", "targets", "acceptance_criteria", "trace", "authority_id"], errors, "contract_directive");
		if (!d.id || directives.has(d.id)) errors.push("contract_directive_id_duplicate");
		if (!validId(d.id)) errors.push("contract_directive_id_invalid");
		directives.set(d.id, d);
		if (!SCOPE_STATES.has(d.state)) errors.push(`contract_directive_state_invalid:${d.id}`);
		if (typeof d.statement !== "string" || !d.statement.trim() || !Array.isArray(d.source_ids) || d.source_ids.length === 0) errors.push(`contract_directive_definition_missing:${d.id}`);
		if (Array.isArray(d.source_ids) && new Set(d.source_ids).size !== d.source_ids.length) errors.push(`contract_directive_source_duplicate:${d.id}`);
		if (!Array.isArray(d.targets) || !Array.isArray(d.acceptance_criteria)) errors.push(`contract_directive_collections_invalid:${d.id}`);
		for (const sid of d.source_ids || []) if (!sourceIds.has(sid)) errors.push(`contract_directive_source_unknown:${d.id}:${sid}`);
		for (const t of d.targets || []) {
			closedObject(t, ["id", "path", "description", "obligation_atom_ids", "kind", "audience", "exposure", "objective_atom_ids", "content_source_atom_ids"], errors, "contract_target");
			if (!t.id || targetIds.has(t.id)) errors.push("contract_target_id_duplicate");
			if (!validId(t.id) || typeof t.path !== "string" || !t.path.trim()) errors.push(`contract_target_definition_missing:${d.id}`);
			if (t.description != null && typeof t.description !== "string") errors.push(`contract_target_description_invalid:${d.id}:${t.id}`);
			validateObligationRefs(t.obligation_atom_ids, `target:${d.id}:${t.id}`);
			for (const atomId of t.obligation_atom_ids || []) {
				const obligation = obligations.get(atomId);
				if (obligation && !(obligation.atom.directive_ids || []).includes(d.id)) errors.push(`contract_target_obligation_directive_mismatch:${d.id}:${t.id}:${atomId}`);
			}
			if (contextOutputV2) {
				if (!OUTPUT_KINDS.has(t.kind) || !OUTPUT_AUDIENCES.has(t.audience) || !OUTPUT_EXPOSURES.has(t.exposure)) errors.push(`contract_target_output_metadata_invalid:${d.id}:${t.id}`);
				for (const [field, refs] of [["objective", t.objective_atom_ids], ["content_source", t.content_source_atom_ids]]) {
					if (!Array.isArray(refs) || new Set(refs || []).size !== (refs || []).length || (refs || []).some((id) => !obligations.has(id))) errors.push(`contract_target_${field}_refs_invalid:${d.id}:${t.id}`);
				}
				for (const atomId of t.objective_atom_ids || []) {
					const obligation = obligations.get(atomId);
					if (obligation && !(obligation.atom.directive_ids || []).includes(d.id)) errors.push(`contract_target_objective_not_authorized:${d.id}:${t.id}:${atomId}`);
				}
				for (const atomId of t.content_source_atom_ids || []) {
					const obligation = obligations.get(atomId);
					if (!obligation) continue;
					const atom = obligation.atom;
					if (atom.render_policy === "deny") errors.push(`contract_target_content_render_denied:${d.id}:${t.id}:${atomId}`);
					const workflowContext = atom.subject === "agent_workflow" && ["background", "precondition"].includes(atom.effect);
					if (workflowContext && t.kind !== "developer_comment") errors.push(`contract_target_workflow_context_leak:${d.id}:${t.id}:${atomId}`);
					if (workflowContext && t.kind === "developer_comment" && (!["developer", "reviewer"].includes(t.audience) || !["derive", "quote"].includes(atom.render_policy))) errors.push(`contract_target_developer_comment_scope_invalid:${d.id}:${t.id}:${atomId}`);
				}
				if (t.exposure === "product_ui" && t.audience !== "end_user") errors.push(`contract_target_audience_surface_mismatch:${d.id}:${t.id}`);
				if (t.exposure === "external" && !["end_user", "partner", "public"].includes(t.audience)) errors.push(`contract_target_audience_surface_mismatch:${d.id}:${t.id}`);
			}
			targetIds.add(t.id);
			if (workspaceConfig && t.path) {
				const location = governedWorkspacePath(opts.cwd, t.path, workspaceConfig);
				if (!location.ok) errors.push(`contract_target_${location.reason}:${d.id}:${t.id}`);
			}
		}
		for (const a of d.acceptance_criteria || []) {
			closedObject(a, ["id", "statement", "obligation_atom_ids"], errors, "contract_acceptance");
			if (!a.id || criterionIds.has(a.id)) errors.push("contract_acceptance_id_duplicate");
			if (!validId(a.id) || typeof a.statement !== "string" || !a.statement.trim()) errors.push(`contract_acceptance_definition_missing:${d.id}`);
			validateObligationRefs(a.obligation_atom_ids, `acceptance:${d.id}:${a.id}`);
			for (const atomId of a.obligation_atom_ids || []) {
				const obligation = obligations.get(atomId);
				if (obligation && !(obligation.atom.directive_ids || []).includes(d.id)) errors.push(`contract_acceptance_obligation_directive_mismatch:${d.id}:${a.id}:${atomId}`);
			}
			criterionIds.add(a.id);
		}
		if (!Array.isArray(d.targets) || d.targets.length === 0) errors.push(`contract_target_missing:${d.id}`);
		if (!Array.isArray(d.acceptance_criteria) || d.acceptance_criteria.length === 0) errors.push(`contract_acceptance_missing:${d.id}`);
		if (d.trace != null || d.state === "active" || d.state === "done") {
			for (const key of TRACE_KEYS) {
				if (!d.trace || !Array.isArray(d.trace[key]) || d.trace[key].length === 0) errors.push(`contract_trace_missing:${d.id}:${key}`);
					else {
						if (new Set(d.trace[key]).size !== d.trace[key].length) errors.push(`contract_trace_duplicate:${d.id}:${key}`);
						for (const id of d.trace[key]) {
							const artifact = artifactMaps[key].get(id);
							if (!artifact) errors.push(`contract_trace_artifact_unknown:${d.id}:${key}:${id}`);
							else for (const atomId of artifact.obligation_atom_ids || []) {
								const obligation = obligations.get(atomId);
								if (obligation && !(obligation.atom.directive_ids || []).includes(d.id)) errors.push(`contract_artifact_obligation_directive_mismatch:${d.id}:${key}:${id}:${atomId}`);
							}
						}
					}
			}
			if (d.trace != null) closedObject(d.trace, TRACE_KEYS, errors, "contract_trace");
			for (const spec of TRACE_EDGES) {
				const fromIds = new Set(spec.from === "directives" ? [d.id] : (d.trace && d.trace[spec.from]) || []);
				const toIds = new Set((d.trace && d.trace[spec.to]) || []);
				const relevant = (edgeByKind.get(spec.kind) || []).filter((edge) => fromIds.has(edge.from) && toIds.has(edge.to));
				for (const id of fromIds) if (!relevant.some((edge) => edge.from === id)) errors.push(`contract_trace_edge_missing:${d.id}:${spec.kind}:${id}`);
				for (const id of toIds) if (!relevant.some((edge) => edge.to === id)) errors.push(`contract_trace_edge_missing:${d.id}:${spec.kind}:${id}`);
			}
		}
		if (["superseded", "deferred", "abandoned"].includes(d.state) && !d.authority_id) errors.push(`contract_terminal_authority_missing:${d.id}`);
	}
	for (const s of declaredSources.values()) {
		const actionable = ["directive", "approval", "authority"].includes(s.classification);
		const semanticSurfaces = new Map((s.directive_ids || []).filter((did) => directives.has(did)).map((did) => {
			const directive = directives.get(did);
			return [did, [directive.statement, ...(directive.targets || []).map((target) => target.description || ""), ...(directive.acceptance_criteria || []).map((criterion) => criterion.statement || "")].join("\n")];
		}));
		const atomDirectiveIds = [...new Set((s.obligation_atoms || []).flatMap((atom) => atom.directive_ids || []))].sort();
		if (actionable && canonicalJson(atomDirectiveIds) !== canonicalJson([...(s.directive_ids || [])].sort())) errors.push(`contract_source_obligation_mapping_mismatch:${s.id}`);
		for (const atom of s.obligation_atoms || []) {
			if (actionable && (!atom.directive_ids || atom.directive_ids.length === 0)) errors.push(`contract_source_obligation_unmapped:${s.id}:${atom.id}`);
			for (const did of atom.directive_ids || []) {
				if (!(s.directive_ids || []).includes(did)) errors.push(`contract_source_obligation_directive_mismatch:${s.id}:${atom.id}:${did}`);
				else if (!semanticSurfaces.has(did) || !semanticSurfaces.get(did).includes(atom.text)) errors.push(`contract_source_obligation_not_declared:${s.id}:${atom.id}:${did}`);
				const directive = directives.get(did);
				if (!directive) continue;
				if (!(directive.targets || []).some((target) => (target.obligation_atom_ids || []).includes(atom.id))) errors.push(`contract_source_obligation_target_uncovered:${s.id}:${atom.id}:${did}`);
				if (!(directive.acceptance_criteria || []).some((criterion) => (criterion.obligation_atom_ids || []).includes(atom.id))) errors.push(`contract_source_obligation_acceptance_uncovered:${s.id}:${atom.id}:${did}`);
				for (const key of TRACE_KEYS) {
					const coveredArtifacts = ((directive.trace && directive.trace[key]) || []).map((id) => artifactMaps[key].get(id)).filter((artifact) => artifact && (artifact.obligation_atom_ids || []).includes(atom.id));
					if (!coveredArtifacts.length) errors.push(`contract_source_obligation_artifact_uncovered:${s.id}:${atom.id}:${did}:${key}`);
				}
				for (const spec of TRACE_EDGES) {
					const fromIds = spec.from === "directives"
						? [did]
						: ((directive.trace && directive.trace[spec.from]) || []).filter((id) => (artifactMaps[spec.from].get(id)?.obligation_atom_ids || []).includes(atom.id));
					const toIds = ((directive.trace && directive.trace[spec.to]) || []).filter((id) => (artifactMaps[spec.to].get(id)?.obligation_atom_ids || []).includes(atom.id));
					const relevant = (edgeByKind.get(spec.kind) || []).filter((edge) => fromIds.includes(edge.from) && toIds.includes(edge.to));
					if (!fromIds.length || !toIds.length || !relevant.length) errors.push(`contract_source_obligation_edge_uncovered:${s.id}:${atom.id}:${did}:${spec.kind}`);
					for (const id of fromIds) if (!relevant.some((edge) => edge.from === id)) errors.push(`contract_source_obligation_edge_from_uncovered:${s.id}:${atom.id}:${did}:${spec.kind}:${id}`);
					for (const id of toIds) if (!relevant.some((edge) => edge.to === id)) errors.push(`contract_source_obligation_edge_to_uncovered:${s.id}:${atom.id}:${did}:${spec.kind}:${id}`);
				}
			}
		}
		for (const did of s.directive_ids || []) {
			if (!directives.has(did)) errors.push(`contract_source_directive_unknown:${s.id}:${did}`);
			else if (!(directives.get(did).source_ids || []).includes(s.id)) errors.push(`contract_source_mapping_not_reciprocal:${s.id}:${did}`);
		}
	}
	for (const d of directives.values()) {
		for (const sid of d.source_ids || []) if (declaredSources.has(sid) && !(declaredSources.get(sid).directive_ids || []).includes(d.id)) errors.push(`contract_directive_mapping_not_reciprocal:${d.id}:${sid}`);
	}

	const authIds = new Set();
	const authorities = new Map();
	for (const a of contract.authorities || []) {
		closedObject(a, ["id", "operation", "source_id", "source_digest", "target_directive_ids", "affected_source_ids", "affected_prior_ids", "replacement_ids", "tombstone_ids", "receipt"], errors, "contract_authority");
		if (!a.id || authIds.has(a.id)) errors.push("contract_authority_id_duplicate");
		if (!validId(a.id)) errors.push("contract_authority_id_invalid");
		authIds.add(a.id);
		authorities.set(a.id, a);
		if (!AUTH_OPS.has(a.operation)) errors.push(`contract_authority_operation_invalid:${a.id}`);
		if (typeof a.source_id !== "string" || !/^SRC-[a-f0-9]{32}$/.test(a.source_id) || !declaredSources.has(a.source_id)) errors.push(`contract_authority_source_invalid:${a.id}`);
		if (!/^[a-f0-9]{64}$/.test(a.source_digest || "") || !sourceRecordMap.has(a.source_id) || sourceRecordMap.get(a.source_id).prompt_digest !== a.source_digest) errors.push(`contract_authority_source_digest_invalid:${a.id}`);
		if (!sourceRecordMap.has(a.source_id) || sourceRecordMap.get(a.source_id).origin !== "native_user") errors.push(`contract_authority_source_origin_invalid:${a.id}`);
		for (const field of ["target_directive_ids", "affected_prior_ids", "replacement_ids", "tombstone_ids"]) {
			if (!Array.isArray(a[field])) errors.push(`contract_authority_${field}_missing:${a.id}`);
			else if (new Set(a[field]).size !== a[field].length || a[field].some((id) => !validId(id))) errors.push(`contract_authority_${field}_invalid:${a.id}`);
		}
		if (!Array.isArray(a.affected_source_ids)) errors.push(`contract_authority_affected_source_ids_missing:${a.id}`);
		else if (new Set(a.affected_source_ids).size !== a.affected_source_ids.length || a.affected_source_ids.some((id) => !/^SRC-[a-f0-9]{32}$/.test(id) || !declaredSources.has(id))) errors.push(`contract_authority_affected_source_ids_invalid:${a.id}`);
		for (const directiveId of a.target_directive_ids || []) if (!directives.has(directiveId)) errors.push(`contract_authority_target_unknown:${a.id}:${directiveId}`);
		if (declaredSources.has(a.source_id)) for (const directiveId of a.target_directive_ids || []) if (!(declaredSources.get(a.source_id).directive_ids || []).includes(directiveId)) errors.push(`contract_authority_source_target_mismatch:${a.id}:${directiveId}`);
		if (a.receipt && a.receipt.operation !== a.operation) errors.push(`contract_authority_wrapper_operation_mismatch:${a.id}`);
		if (a.receipt && canonicalJson([...(a.receipt.target_directive_ids || [])].sort()) !== canonicalJson([...(a.target_directive_ids || [])].sort())) errors.push(`contract_authority_wrapper_target_mismatch:${a.id}`);
		for (const field of ["affected_source_ids", "affected_prior_ids", "replacement_ids", "tombstone_ids"]) {
			if (a.receipt && canonicalJson([...(a.receipt[field] || [])].sort()) !== canonicalJson([...(a[field] || [])].sort())) errors.push(`contract_authority_wrapper_${field}_mismatch:${a.id}`);
		}
		if (!a.receipt) errors.push(`contract_authority_receipt_missing:${a.id}`);
		else {
			const ar = validateAuthorityReceipt(a.receipt, opts.publicKeyPem, opts.now, { checkExpiry: false });
			for (const e of ar.errors) errors.push(`${e}:${a.id}`);
		}
	}
	for (const d of directives.values()) if (d.authority_id && !authIds.has(d.authority_id)) errors.push(`contract_authority_unknown:${d.id}`);
	const tombstones = new Map();
	const tombstoneIds = new Set();
	for (const tombstone of contract.tombstones || []) {
		closedObject(tombstone, ["id", "directive_id", "state", "authority_id", "disposed_scope_ids", "statement"], errors, "contract_tombstone");
		if (!tombstone || !validId(tombstone.id) || tombstoneIds.has(tombstone.id) || !tombstone.directive_id || tombstones.has(tombstone.directive_id)) errors.push("contract_tombstone_duplicate");
		else tombstones.set(tombstone.directive_id, tombstone);
		if (tombstone && validId(tombstone.id)) tombstoneIds.add(tombstone.id);
		if (!tombstone || !validId(tombstone.directive_id) || !validId(tombstone.authority_id) || !["superseded", "deferred", "abandoned"].includes(tombstone.state) || !Array.isArray(tombstone.disposed_scope_ids) || new Set(tombstone.disposed_scope_ids || []).size !== (tombstone.disposed_scope_ids || []).length || (tombstone.disposed_scope_ids || []).some((id) => !validId(id)) || typeof tombstone.statement !== "string" || !tombstone.statement.trim()) errors.push("contract_tombstone_definition_invalid");
	}
	for (const d of directives.values()) {
		if (!["superseded", "deferred", "abandoned"].includes(d.state)) continue;
		const authority = authorities.get(d.authority_id);
		const tombstone = tombstones.get(d.id);
		if (!tombstone) errors.push(`contract_tombstone_missing:${d.id}`);
		else if (tombstone.state !== d.state || tombstone.authority_id !== d.authority_id || !tombstone.statement) errors.push(`contract_tombstone_mismatch:${d.id}`);
		if (tombstone) {
			const expectedDisposed = directiveDisposedScopeIds(d, contract.edges || []);
			if (canonicalJson([...(tombstone.disposed_scope_ids || [])].sort()) !== canonicalJson(expectedDisposed)) errors.push(`contract_tombstone_scope_mismatch:${d.id}`);
		}
		if (!authority || authority.operation !== TERMINAL_AUTHORITY_OP[d.state] || !(authority.target_directive_ids || []).includes(d.id)) errors.push(`contract_terminal_authority_mismatch:${d.id}`);
	}
	for (const directiveId of tombstones.keys()) if (!directives.has(directiveId)) errors.push(`contract_tombstone_directive_unknown:${directiveId}`);

	if (!(contract.authorities || []).some((a) => a.operation === "authorize_contract")) errors.push("contract_initial_authority_missing");

	const occurrenceIds = new Set(occurrences.map((o) => o.id));
	const mapped = new Set();
	const implementationIds = new Set();
	const evidenceIds = new Set();
	for (const d of directives.values()) {
		for (const id of (d.trace && d.trace.implementations) || []) implementationIds.add(id);
		for (const id of (d.trace && d.trace.evidence) || []) evidenceIds.add(id);
	}
	for (const c of contract.changes || []) {
		closedObject(c, ["id", "directive_id", "implementation_id", "evidence_id"], errors, "contract_change");
		if (!c.id || mapped.has(c.id)) errors.push("contract_change_duplicate");
		if (typeof c.id !== "string" || !/^CHG-[a-f0-9]{32}$/.test(c.id)) errors.push("contract_change_id_invalid");
		if (!validId(c.directive_id) || !validId(c.implementation_id) || !validId(c.evidence_id)) errors.push("contract_change_reference_invalid");
		mapped.add(c.id);
		if (!occurrenceIds.has(c.id)) errors.push(`contract_change_unknown:${c.id}`);
		const directive = directives.get(c.directive_id);
		if (!directive || !c.implementation_id || !c.evidence_id) errors.push(`contract_change_trace_missing:${c.id}`);
		if (c.implementation_id && !implementationIds.has(c.implementation_id)) errors.push(`contract_change_implementation_unknown:${c.id}`);
		if (c.evidence_id && !evidenceIds.has(c.evidence_id)) errors.push(`contract_change_evidence_unknown:${c.id}`);
		if (directive && (!(directive.trace && directive.trace.implementations || []).includes(c.implementation_id) || !(directive.trace && directive.trace.evidence || []).includes(c.evidence_id))) errors.push(`contract_change_cross_directive:${c.id}`);
		const evidence = artifactMaps.evidence.get(c.evidence_id);
		if (evidence && evidence.subject_id !== c.implementation_id) errors.push(`contract_change_evidence_subject_mismatch:${c.id}`);
	}
	for (const id of occurrenceIds) if (!mapped.has(id)) errors.push(`contract_change_uncovered:${id}`);
	const preservation = preservationPolicy.validateDeclaration(contract, {
		config: workspaceConfig,
		sourceRecords,
		probeRunner: opts.cwd && workspaceConfig ? preservationRunnerContext(opts.cwd, workspaceConfig, opts.env || process.env) : opts.probeRunner,
	});
	if (!preservation.ok) errors.push(...preservation.errors);
	return {
		ok: errors.length === 0,
		errors: [...new Set(errors)],
		ids: {
			sourceIds: [...sourceIds],
				sourceMappings: [...declaredSources.values()].map((s) => canonicalJson({ source_id: s.id, classification: s.classification, source_kind: s.source_kind, derived_from: s.derived_from, derivation_kind: s.derivation_kind, directive_ids: s.directive_ids || [], obligation_atoms: (s.obligation_atoms || []).map((atom) => ({ id: atom.id, subject: atom.subject, effect: atom.effect, render_policy: atom.render_policy, directive_ids: atom.directive_ids || [] })) })),
			directiveIds: [...directives.keys()],
			targetIds: [...targetIds],
			criterionIds: [...criterionIds],
			authorityIds: [...authIds],
			authorityMappings: [...authorities.values()].map((a) => canonicalJson({ authority_id: a.id, operation: a.operation, source_id: a.source_id, target_directive_ids: a.target_directive_ids || [], affected_source_ids: a.affected_source_ids || [], affected_prior_ids: a.affected_prior_ids || [], replacement_ids: a.replacement_ids || [], tombstone_ids: a.tombstone_ids || [] })),
			tombstoneIds: [...tombstones.values()].map((tombstone) => tombstone.id),
			tombstoneMappings: [...tombstones.values()].map((tombstone) => canonicalJson({ tombstone_id: tombstone.id, directive_id: tombstone.directive_id, state: tombstone.state, authority_id: tombstone.authority_id, disposed_scope_ids: tombstone.disposed_scope_ids || [] })),
			artifactIds: [...artifactIds],
			edgeIds: [...edgeIds],
			occurrenceIds: [...occurrenceIds],
			changeMappings: (contract.changes || []).map((change) => canonicalJson({ change_id: change.id, directive_id: change.directive_id, implementation_id: change.implementation_id, evidence_id: change.evidence_id })),
		},
		scope_digest: sha256(canonicalJson(scopeProjection(contract))),
	};
}

	return {
		validateContract,
	};
};
