/**
 * Project-neutral product-surface preservation policy for request contracts.
 *
 * Projects describe logical surfaces and emit opaque capability probes. This
 * module never assumes a web framework, API style, CLI layout, or file type.
 */

const crypto = require("crypto");
const cp = require("child_process");
const fs = require("fs");
const path = require("path");

const INTENTS = new Set(["add", "integrate", "extend", "modify", "migrate", "replace", "remove"]);
const DISPOSITIONS = new Set(["preserve", "extend", "replace", "remove", "disable", "redirect", "migrate"]);
const DESTRUCTIVE = new Set(["replace", "remove", "disable", "redirect", "migrate"]);
const SOURCE_KINDS = new Set(["human", "derived", "candidate"]);
const DERIVATION_KINDS = new Set(["preserve", "clarify", "expand", "narrow", "replace"]);
const DESTRUCTIVE_AUTHORITY_OPS = new Set(["authorize_contract", "amend_scope_replace", "supersede", "abandon"]);
const ID_PATTERN = /^[A-Z][A-Z0-9_-]{2,127}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40,64}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const IMMUTABLE_SOURCE_REF_PATTERN = /^(?:git:[a-f0-9]{40,64}|sha256:[a-f0-9]{64}|(?:https:\/\/|ssh:\/\/|git\+https:\/\/).+@[a-f0-9]{40,64})$/;
const VENDOR_DISPOSITIONS = new Set(["import", "preserve"]);
const TEST_PATH_PATTERN = /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i;
const VENDOR_PATH_PATTERN = /(?:^|\/)(?:vendor|third[_-]?party|external)(?:\/|$)/i;

function exactObject(value, allowed, errors, code) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		errors.push(`${code}_shape_invalid`);
		return false;
	}
	for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push(`${code}_extra_field`);
	return true;
}

function surfaceInventoryDigest(surfaces) {
	return sha256(canonicalJson((surfaces || []).filter((surface) => surface && typeof surface === "object" && !Array.isArray(surface)).map((surface) => ({
		id: surface.id,
		directive_id: surface.directive_id,
		kind: surface.kind,
		locator: surface.locator,
		disposition: surface.disposition,
		baseline_paths: surface.baseline_paths,
		current_paths: surface.current_paths,
		baseline_evidence_id: surface.baseline_evidence_id,
		current_evidence_id: surface.current_evidence_id,
		expected_diff_digest: surface.expected_diff_digest,
		authority_id: surface.authority_id,
	})).sort((a, b) => String(a.id).localeCompare(String(b.id)))));
}

function signedProbePayload(probe) {
	return {
		version: probe.version,
		surface_id: probe.surface_id,
		phase: probe.phase,
		subject_digest: probe.subject_digest,
		reachable: probe.reachable,
		capabilities: probe.capabilities,
		execution: {
			credential_id: probe.execution && probe.execution.credential_id,
			runner_digest: probe.execution && probe.execution.runner_digest,
			executed_at: probe.execution && probe.execution.executed_at,
			command_digest: probe.execution && probe.execution.command_digest,
			result_digest: probe.execution && probe.execution.result_digest,
		},
	};
}

function signedVendorPayload(vendor) {
	const attestation = vendor && vendor.attestation || {};
	return {
		version: attestation.version,
		vendor_id: vendor && vendor.id,
		source_ref: vendor && vendor.source_ref,
		pristine_path: normalizeRel(vendor && vendor.pristine_path),
		tree_digest: vendor && vendor.tree_digest,
		credential_id: attestation.credential_id,
		runner_digest: attestation.runner_digest,
		executed_at: attestation.executed_at,
		resolved_tree_digest: attestation.resolved_tree_digest,
		imported_tree_digest: attestation.imported_tree_digest,
	};
}

function signedInventoryPayload(inventory) {
	return {
		version: inventory && inventory.version,
		origin: inventory && inventory.origin,
		adapter_id: inventory && inventory.adapter_id,
		adapter_digest: inventory && inventory.adapter_digest,
		baseline_ref: inventory && inventory.baseline_ref,
		baseline_manifest_digest: inventory && inventory.baseline_manifest_digest,
		current_manifest_digest: inventory && inventory.current_manifest_digest,
		surface_ids: inventory && inventory.surface_ids,
		surface_inventory_digest: inventory && inventory.surface_inventory_digest,
		test_roots: inventory && inventory.test_roots,
		vendor_roots: inventory && inventory.vendor_roots,
		release_operation_ids: inventory && inventory.release_operation_ids,
		credential_id: inventory && inventory.credential_id,
		runner_digest: inventory && inventory.runner_digest,
		executed_at: inventory && inventory.executed_at,
	};
}

function verifyRunnerSignature(payload, signature, context, errors, code) {
	const runner = context && context.probeRunner || {};
	if (!runner.public_key || !runner.credential_id || !Array.isArray(runner.allowed_digests)) {
		errors.push(`${code}_runner_unprovisioned`);
		return false;
	}
	const execution = payload.execution || payload;
	if (execution.credential_id !== runner.credential_id || !runner.allowed_digests.includes(execution.runner_digest)) {
		errors.push(`${code}_runner_not_allowed`);
		return false;
	}
	try {
		if (!crypto.verify(null, Buffer.from(canonicalJson(payload)), runner.public_key, Buffer.from(signature || "", "base64"))) {
			errors.push(`${code}_signature_invalid`);
			return false;
		}
		return true;
	} catch {
		errors.push(`${code}_signature_invalid`);
		return false;
	}
}

function canonicalize(value) {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		const out = {};
		for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
		return out;
	}
	return value;
}

function canonicalJson(value) {
	return JSON.stringify(canonicalize(value));
}

function sha256(value) {
	return crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : String(value)).digest("hex");
}

function normalizeRel(value) {
	return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function uniqueStrings(values) {
	return Array.isArray(values) && new Set(values).size === values.length && values.every((value) => typeof value === "string" && value.length > 0);
}

function pathWithin(candidate, root) {
	return candidate === root || candidate.startsWith(root + "/");
}

function anyPathWithin(candidate, roots) {
	return (roots || []).some((root) => pathWithin(candidate, normalizeRel(root)));
}

function safeRelativeRoot(value) {
	if (typeof value !== "string" || !value.trim() || path.isAbsolute(value)) return false;
	const normalized = normalizeRel(value);
	return Boolean(normalized) && normalized !== ".." && !normalized.startsWith("../") && !normalized.includes("/../");
}

function filesWithin(manifest, roots) {
	return Object.fromEntries(Object.entries((manifest && manifest.files) || {})
		.filter(([rel]) => anyPathWithin(rel, roots))
		.sort(([a], [b]) => a.localeCompare(b)));
}

function vendorTreeDigest(manifest, pristinePath) {
	const prefix = normalizeRel(pristinePath);
	const tree = Object.fromEntries(Object.entries(filesWithin(manifest, [prefix])).map(([rel, metadata]) => [rel === prefix ? "." : rel.slice(prefix.length + 1), metadata]));
	return sha256(canonicalJson(tree));
}

function surfaceContentDigest(manifest, paths) {
	return sha256(canonicalJson(filesWithin(manifest, paths)));
}

function changedPaths(baseline, current) {
	const paths = new Set([...Object.keys((baseline && baseline.files) || {}), ...Object.keys((current && current.files) || {})]);
	return [...paths].filter((rel) => canonicalJson(baseline.files && baseline.files[rel] || null) !== canonicalJson(current.files && current.files[rel] || null)).sort();
}

function diffForPaths(baseline, current, baselinePaths, currentPaths) {
	const roots = [...(baselinePaths || []), ...(currentPaths || [])].map(normalizeRel);
	const paths = new Set([...Object.keys((baseline && baseline.files) || {}), ...Object.keys((current && current.files) || {})]
		.filter((rel) => anyPathWithin(rel, roots)));
	const diffs = [];
	for (const rel of [...paths].sort()) {
		const before = baseline.files && baseline.files[rel] || null;
		const after = current.files && current.files[rel] || null;
		if (canonicalJson(before) !== canonicalJson(after)) diffs.push({ path: rel, before, after });
	}
	return diffs;
}

function surfaceDiffDigest(baseline, current, surface) {
	return sha256(canonicalJson(diffForPaths(baseline, current, surface.baseline_paths, surface.current_paths)));
}

function evidenceMap(contract) {
	return new Map((((contract.artifacts || {}).evidence) || []).map((item) => [item.id, item]));
}

function authorityMap(contract) {
	return new Map((contract.authorities || []).map((item) => [item.id, item]));
}

function directiveMap(contract) {
	return new Map((contract.directives || []).map((item) => [item.id, item]));
}

function validateSourceAuthority(contract, sourceRecords = [], preservation = null) {
	const errors = [];
	const records = new Map(sourceRecords.map((record) => [record.source_id, record]));
	const sources = new Map((contract.sources || []).map((source) => [source.id, source]));
	const authorities = authorityMap(contract);
	const destructiveSurfaces = (preservation && preservation.surfaces || []).filter((surface) => surface && DESTRUCTIVE.has(surface.disposition));
	const visiting = new Set();
	const visited = new Set();
	function cyclic(sourceId) {
		if (visiting.has(sourceId)) return true;
		if (visited.has(sourceId)) return false;
		visiting.add(sourceId);
		const source = sources.get(sourceId);
		const result = Boolean(source && source.source_kind === "derived" && source.derived_from && cyclic(source.derived_from));
		visiting.delete(sourceId);
		visited.add(sourceId);
		return result;
	}
	for (const source of contract.sources || []) {
		if (!SOURCE_KINDS.has(source.source_kind)) errors.push(`preservation_source_kind_invalid:${source.id}`);
		if (source.source_kind === "human" && (!records.has(source.id) || records.get(source.id).origin !== "native_user")) {
			errors.push(`preservation_human_source_origin_invalid:${source.id}`);
		}
		if (source.source_kind === "derived") {
			if (typeof source.derived_from !== "string" || !sources.has(source.derived_from) || source.derived_from === source.id) {
				errors.push(`preservation_derived_source_parent_invalid:${source.id}`);
			}
			if (!DERIVATION_KINDS.has(source.derivation_kind)) errors.push(`preservation_derivation_kind_invalid:${source.id}`);
			const record = records.get(source.id);
			const parentRecord = records.get(source.derived_from);
			if (!record || !parentRecord || !Number.isInteger(record.seq) || !Number.isInteger(parentRecord.seq) || parentRecord.seq >= record.seq) {
				errors.push(`preservation_derived_source_order_invalid:${source.id}`);
			}
			if (cyclic(source.id)) errors.push(`preservation_derived_source_cycle:${source.id}`);
			if (["narrow", "replace"].includes(source.derivation_kind)) {
				const ownsDirective = (source.directive_ids || []).some((directiveId) => [...authorities.values()].some((authority) => {
					const authoritySource = records.get(authority.source_id);
					const laterNativeHuman = authoritySource && authoritySource.origin === "native_user" && record && Number.isInteger(authoritySource.seq) && authoritySource.seq > record.seq;
					const explicitlyAffected = (authority.affected_source_ids || []).includes(source.id);
					const ownsSurface = destructiveSurfaces.some((surface) => surface.authority_id === authority.id && surface.directive_id === directiveId);
					return laterNativeHuman && explicitlyAffected && ownsSurface &&
					["amend_scope_replace", "supersede", "abandon"].includes(authority.operation) &&
					(authority.target_directive_ids || []).includes(directiveId);
				}));
				if (!ownsDirective) errors.push(`preservation_derived_scope_escalation:${source.id}`);
			}
		} else if (source.derived_from != null || source.derivation_kind != null) {
			errors.push(`preservation_non_derived_metadata_invalid:${source.id}`);
		}
	}
	return errors;
}

function validateDeclaration(contract, context = {}) {
	const errors = [];
	const required = Boolean(context.config && context.config.preservation && context.config.preservation.required);
	const preservation = contract && contract.preservation;
	if (!preservation) {
		const hasSourceAuthorityMetadata = ((contract && contract.sources) || []).some((source) => source && (source.source_kind != null || source.derived_from != null || source.derivation_kind != null));
		const sourceErrors = hasSourceAuthorityMetadata ? validateSourceAuthority(contract, context.sourceRecords || [], { surfaces: [] }) : [];
		return { ok: !required && sourceErrors.length === 0, errors: required ? ["preservation_contract_missing", ...sourceErrors] : sourceErrors, projection: null };
	}
	exactObject(preservation, ["version", "baseline_ref", "intent", "surfaces", "vendor_sources", "inventory"], errors, "preservation_contract");
	if (preservation.version !== 1 || !COMMIT_PATTERN.test(preservation.baseline_ref || "") || !INTENTS.has(preservation.intent)) {
		errors.push("preservation_contract_invalid");
	}
	if (!Array.isArray(preservation.surfaces) || !Array.isArray(preservation.vendor_sources)) errors.push("preservation_collections_missing");
	const inventory = preservation.inventory;
	if (inventory) exactObject(inventory, ["version", "origin", "adapter_id", "adapter_digest", "baseline_ref", "baseline_manifest_digest", "current_manifest_digest", "surface_ids", "surface_inventory_digest", "test_roots", "vendor_roots", "release_operation_ids", "credential_id", "runner_digest", "executed_at", "signature"], errors, "preservation_inventory");
	if (!inventory || inventory.version !== 1 || inventory.origin !== "existing" ||
		!ID_PATTERN.test(inventory.adapter_id || "") || !DIGEST_PATTERN.test(inventory.adapter_digest || "") ||
		inventory.baseline_ref !== preservation.baseline_ref || !DIGEST_PATTERN.test(inventory.baseline_manifest_digest || "") ||
		!DIGEST_PATTERN.test(inventory.current_manifest_digest || "") || !uniqueStrings(inventory.surface_ids) || !DIGEST_PATTERN.test(inventory.surface_inventory_digest || "") ||
		!uniqueStrings(inventory.test_roots) || !uniqueStrings(inventory.vendor_roots) || !uniqueStrings(inventory.release_operation_ids) ||
		!inventory.test_roots.every(safeRelativeRoot) || !inventory.vendor_roots.every(safeRelativeRoot) ||
		!inventory.release_operation_ids.every((item) => ID_PATTERN.test(item)) || typeof inventory.credential_id !== "string" || !inventory.credential_id || !DIGEST_PATTERN.test(inventory.runner_digest || "") ||
		!Number.isInteger(inventory.executed_at)) {
		errors.push("preservation_inventory_invalid");
	} else {
		const allowedAdapters = context.config && context.config.preservation && context.config.preservation.allowed_adapter_digests || [];
		if (!allowedAdapters.includes(inventory.adapter_digest)) errors.push("preservation_inventory_adapter_not_allowed");
		verifyRunnerSignature(signedInventoryPayload(inventory), inventory.signature, context, errors, "preservation_inventory");
	}
	const directives = directiveMap(contract);
	const evidence = evidenceMap(contract);
	const authorities = authorityMap(contract);
	const surfaceIds = new Set();
	for (const surface of preservation.surfaces || []) {
		if (!exactObject(surface, ["id", "directive_id", "kind", "locator", "disposition", "baseline_paths", "current_paths", "baseline_evidence_id", "current_evidence_id", "expected_diff_digest", "authority_id"], errors, "preservation_surface")) continue;
		if (!surface || !ID_PATTERN.test(surface.id || "") || surfaceIds.has(surface.id)) errors.push("preservation_surface_id_invalid");
		else surfaceIds.add(surface.id);
		if (!ID_PATTERN.test(surface.directive_id || "") || !directives.has(surface.directive_id)) errors.push(`preservation_surface_directive_invalid:${surface && surface.id}`);
		if (typeof surface.kind !== "string" || !surface.kind.trim() || typeof surface.locator !== "string" || !surface.locator.trim()) errors.push(`preservation_surface_locator_invalid:${surface && surface.id}`);
		if (!DISPOSITIONS.has(surface.disposition)) errors.push(`preservation_surface_disposition_invalid:${surface && surface.id}`);
		for (const field of ["baseline_paths", "current_paths"]) {
			if (!uniqueStrings(surface[field])) errors.push(`preservation_surface_${field}_invalid:${surface && surface.id}`);
			else for (const rel of surface[field]) {
				const normalized = normalizeRel(rel);
				if (!normalized || path.isAbsolute(rel) || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) errors.push(`preservation_surface_path_escape:${surface.id}`);
			}
		}
		if (!(surface.baseline_paths || []).length) errors.push(`preservation_surface_baseline_paths_missing:${surface && surface.id}`);
		if (surface.disposition !== "remove" && !(surface.current_paths || []).length) errors.push(`preservation_surface_current_paths_missing:${surface && surface.id}`);
		for (const field of ["baseline_evidence_id", "current_evidence_id"]) {
			if (!ID_PATTERN.test(surface[field] || "") || !evidence.has(surface[field])) errors.push(`preservation_surface_${field}_invalid:${surface && surface.id}`);
		}
		if (surface.baseline_evidence_id && surface.baseline_evidence_id === surface.current_evidence_id) errors.push(`preservation_probe_reused:${surface.id}`);
		if (DESTRUCTIVE.has(surface.disposition)) {
			const authority = authorities.get(surface.authority_id);
			if (!authority || !DESTRUCTIVE_AUTHORITY_OPS.has(authority.operation) || !(authority.target_directive_ids || []).includes(surface.directive_id)) {
				errors.push(`preservation_destructive_authority_missing:${surface.id}`);
			}
			if (!DIGEST_PATTERN.test(surface.expected_diff_digest || "")) errors.push(`preservation_expected_diff_digest_missing:${surface.id}`);
		} else if (surface.authority_id != null && !authorities.has(surface.authority_id)) {
			errors.push(`preservation_surface_authority_invalid:${surface.id}`);
		}
	}
	if (inventory && uniqueStrings(inventory.surface_ids)) {
		const declaredSurfaceIds = [...surfaceIds].sort();
		if (canonicalJson([...inventory.surface_ids].sort()) !== canonicalJson(declaredSurfaceIds)) errors.push("preservation_inventory_surface_mismatch");
		if (inventory.surface_inventory_digest !== surfaceInventoryDigest(preservation.surfaces || [])) errors.push("preservation_inventory_descriptor_mismatch");
	}
	const vendorIds = new Set();
	for (const vendor of preservation.vendor_sources || []) {
		if (!exactObject(vendor, ["id", "directive_id", "authority_id", "disposition", "source_ref", "pristine_path", "tree_digest", "attestation"], errors, "preservation_vendor")) continue;
		if (!vendor || !ID_PATTERN.test(vendor.id || "") || vendorIds.has(vendor.id)) errors.push("preservation_vendor_id_invalid");
		else vendorIds.add(vendor.id);
		const rel = normalizeRel(vendor && vendor.pristine_path);
		if (!rel || path.isAbsolute(vendor.pristine_path || "") || rel === ".." || rel.startsWith("../") || rel.includes("/../")) errors.push(`preservation_vendor_path_invalid:${vendor && vendor.id}`);
		if (!VENDOR_DISPOSITIONS.has(vendor.disposition) || !IMMUTABLE_SOURCE_REF_PATTERN.test(vendor.source_ref || "") || !DIGEST_PATTERN.test(vendor.tree_digest || "")) errors.push(`preservation_vendor_provenance_invalid:${vendor && vendor.id}`);
		const attestation = vendor && vendor.attestation;
		if (attestation) exactObject(attestation, ["version", "credential_id", "runner_digest", "executed_at", "resolved_tree_digest", "imported_tree_digest", "signature"], errors, "preservation_vendor_attestation");
		if (!attestation || attestation.version !== 1 || !DIGEST_PATTERN.test(attestation.runner_digest || "") ||
			!Number.isInteger(attestation.executed_at) || !DIGEST_PATTERN.test(attestation.resolved_tree_digest || "") ||
			!DIGEST_PATTERN.test(attestation.imported_tree_digest || "") || attestation.resolved_tree_digest !== vendor.tree_digest ||
			attestation.imported_tree_digest !== vendor.tree_digest) {
			errors.push(`preservation_vendor_attestation_invalid:${vendor && vendor.id}`);
		} else {
			verifyRunnerSignature(signedVendorPayload(vendor), attestation.signature, context, errors, `preservation_vendor_attestation:${vendor.id}`);
		}
		const authority = authorities.get(vendor.authority_id);
		const allowedAuthorityOps = vendor.disposition === "import"
			? new Set(["authorize_contract", "amend_scope_add"])
			: DESTRUCTIVE_AUTHORITY_OPS;
		if (!ID_PATTERN.test(vendor.directive_id || "") || !directives.has(vendor.directive_id) || !authority ||
			!allowedAuthorityOps.has(authority.operation) || !(authority.target_directive_ids || []).includes(vendor.directive_id)) {
			errors.push(`preservation_vendor_authority_invalid:${vendor && vendor.id}`);
		}
	}
	errors.push(...validateSourceAuthority(contract, context.sourceRecords || [], preservation));
	return {
		ok: errors.length === 0,
		errors: [...new Set(errors)],
		projection: {
			version: preservation.version,
			baseline_ref: preservation.baseline_ref,
			intent: preservation.intent,
			surfaces: preservation.surfaces || [],
			vendor_sources: preservation.vendor_sources || [],
			inventory: preservation.inventory || null,
		},
	};
}

function readBaselineBytes(cwd, baselineRef, locator, context) {
	if (typeof context.readBaselineFile === "function") return Buffer.from(context.readBaselineFile(locator));
	return cp.execFileSync("git", ["-C", cwd, "show", `${baselineRef}:${normalizeRel(locator)}`], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
}

function readProbe(cwd, evidence, expectedSurfaceId, expectedPhase, expectedSubjectDigest, errors, context) {
	if (!evidence) return null;
	try {
		const locator = normalizeRel(evidence.locator);
		if (!locator || path.isAbsolute(evidence.locator || "") || locator === ".." || locator.startsWith("../") || locator.includes("/../")) throw new Error("escape");
		let bytes;
		if (expectedPhase === "baseline") bytes = readBaselineBytes(cwd, context.baseline.head, locator, context);
		else {
			const absolute = path.resolve(cwd, locator);
			if (absolute !== cwd && !absolute.startsWith(cwd + path.sep)) throw new Error("escape");
			bytes = fs.readFileSync(absolute);
		}
		if (sha256(bytes) !== evidence.digest) throw new Error("digest");
		const probe = JSON.parse(bytes.toString("utf8"));
		exactObject(probe, ["version", "surface_id", "phase", "subject_digest", "reachable", "capabilities", "execution"], errors, `preservation_${expectedPhase}_probe`);
		if (probe && probe.execution) exactObject(probe.execution, ["credential_id", "runner_digest", "executed_at", "command_digest", "result_digest", "signature"], errors, `preservation_${expectedPhase}_probe_execution`);
		if (!probe || probe.version !== 1 || probe.surface_id !== expectedSurfaceId || probe.phase !== expectedPhase ||
			probe.subject_digest !== expectedSubjectDigest || typeof probe.reachable !== "boolean" || !uniqueStrings(probe.capabilities) ||
			!probe.execution || typeof probe.execution.credential_id !== "string" || !probe.execution.credential_id ||
			!DIGEST_PATTERN.test(probe.execution.runner_digest || "") ||
			!Number.isInteger(probe.execution.executed_at) || !DIGEST_PATTERN.test(probe.execution.command_digest || "") ||
			!DIGEST_PATTERN.test(probe.execution.result_digest || "")) throw new Error("shape");
		const observedResultDigest = sha256(canonicalJson({ reachable: probe.reachable, capabilities: probe.capabilities }));
		if (probe.execution.result_digest !== observedResultDigest) throw new Error("result");
		if (!verifyRunnerSignature(signedProbePayload(probe), probe.execution.signature, context, errors, `preservation_${expectedPhase}_probe:${expectedSurfaceId}`)) return null;
		return probe;
	} catch {
		errors.push(`preservation_${expectedPhase}_probe_invalid:${expectedSurfaceId}`);
		return null;
	}
}

function validateWorkspace(contract, context = {}) {
	const errors = [];
	const baseline = context.baseline;
	const current = context.current;
	const declaration = validateDeclaration(contract, context);
	errors.push(...declaration.errors);
	if (!declaration.projection || !baseline || !current) return { ok: errors.length === 0, errors: [...new Set(errors)], surface_digests: {} };
	if (declaration.projection.baseline_ref !== baseline.head) errors.push("preservation_baseline_ref_mismatch");
	const inventory = declaration.projection.inventory;
	if (inventory) {
		if (inventory.baseline_manifest_digest !== sha256(canonicalJson(baseline))) errors.push("preservation_inventory_baseline_mismatch");
		if (inventory.current_manifest_digest !== sha256(canonicalJson(current))) errors.push("preservation_inventory_current_mismatch");
	}
	const evidence = evidenceMap(contract);
	const changed = changedPaths(baseline, current);
	const allSurfaceRoots = [];
	const surfaceDigests = {};
	for (const surface of declaration.projection.surfaces) {
		for (const rel of surface.baseline_paths || []) {
			const normalized = normalizeRel(rel);
			allSurfaceRoots.push(normalized);
			if (!Object.keys((baseline && baseline.files) || {}).some((candidate) => pathWithin(candidate, normalized))) errors.push(`preservation_baseline_path_unknown:${surface.id}:${normalized}`);
		}
		for (const rel of surface.current_paths || []) {
			const normalized = normalizeRel(rel);
			allSurfaceRoots.push(normalized);
			if (!Object.keys((current && current.files) || {}).some((candidate) => pathWithin(candidate, normalized))) errors.push(`preservation_current_path_missing:${surface.id}:${normalized}`);
		}
		const digest = surfaceDiffDigest(baseline, current, surface);
		surfaceDigests[surface.id] = digest;
		if (DESTRUCTIVE.has(surface.disposition) && digest !== surface.expected_diff_digest) errors.push(`preservation_authority_diff_mismatch:${surface.id}`);
		const baselineProbe = readProbe(context.cwd, evidence.get(surface.baseline_evidence_id), surface.id, "baseline", surfaceContentDigest(baseline, surface.baseline_paths), errors, { ...context, baseline });
		const currentProbe = readProbe(context.cwd, evidence.get(surface.current_evidence_id), surface.id, "current", surfaceContentDigest(current, surface.current_paths), errors, { ...context, baseline });
		if (baselineProbe && baselineProbe.reachable !== true) errors.push(`preservation_baseline_unreachable:${surface.id}`);
		if (baselineProbe && currentProbe && ["preserve", "extend"].includes(surface.disposition)) {
			if (currentProbe.reachable !== true) errors.push(`preservation_surface_unreachable:${surface.id}`);
			const currentCapabilities = new Set(currentProbe.capabilities);
			for (const capability of baselineProbe.capabilities) if (!currentCapabilities.has(capability)) errors.push(`preservation_capability_lost:${surface.id}:${capability}`);
		}
	}
	for (const rel of changed) if (!anyPathWithin(rel, allSurfaceRoots)) errors.push(`preservation_change_uncovered:${rel}`);
	if (context.config && context.config.preservation && context.config.preservation.protect_test_contracts) {
		const testRoots = inventory && inventory.test_roots || [];
		for (const rel of changed.filter((candidate) => anyPathWithin(candidate, testRoots) || TEST_PATH_PATTERN.test(candidate))) {
			const owners = declaration.projection.surfaces.filter((surface) => anyPathWithin(rel, [...surface.baseline_paths, ...surface.current_paths]));
			if (!owners.some((surface) => /test|spec|verification/i.test(surface.kind) && ["preserve", "extend"].includes(surface.disposition))) errors.push(`preservation_test_contract_unprotected:${rel}`);
		}
	}
	for (const vendor of declaration.projection.vendor_sources) {
		const prefix = normalizeRel(vendor.pristine_path);
		const baselineFiles = filesWithin(baseline, [prefix]);
		const currentFiles = filesWithin(current, [prefix]);
		const valid = vendor.disposition === "import"
			? !Object.keys(baselineFiles).length && Object.keys(currentFiles).length > 0 && vendorTreeDigest(current, prefix) === vendor.tree_digest
			: Object.keys(baselineFiles).length > 0 && vendorTreeDigest(baseline, prefix) === vendor.tree_digest && canonicalJson(currentFiles) === canonicalJson(baselineFiles);
		if (!valid) errors.push(`preservation_vendor_digest_mismatch:${vendor.id}`);
	}
	if (context.config && context.config.preservation && context.config.preservation.protect_vendor_sources) {
		const vendorRoots = inventory && inventory.vendor_roots || [];
		for (const rel of changed.filter((candidate) => anyPathWithin(candidate, vendorRoots) || VENDOR_PATH_PATTERN.test(candidate))) {
			if (!declaration.projection.vendor_sources.some((vendor) => pathWithin(rel, normalizeRel(vendor.pristine_path)))) errors.push(`preservation_vendor_change_unprotected:${rel}`);
		}
	}
	return { ok: errors.length === 0, errors: [...new Set(errors)], surface_digests: surfaceDigests };
}

module.exports = {
	INTENTS,
	DISPOSITIONS,
	DESTRUCTIVE,
	sha256,
	canonicalJson,
	surfaceDiffDigest,
	surfaceContentDigest,
	surfaceInventoryDigest,
	vendorTreeDigest,
	signedProbePayload,
	signedVendorPayload,
	signedInventoryPayload,
	validateSourceAuthority,
	validateDeclaration,
	validateWorkspace,
};
