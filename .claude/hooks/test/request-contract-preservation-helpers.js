"use strict";

/** Preservation-specific fixtures shared by the preservation suite. */

const {
	assert,
	cp,
	crypto,
	fs,
	os,
	path,
	core,
	fixtureRoots,
	signedReceipt,
	makeContract,
} = require("./request-contract-test-helpers.js");

function preservationFile(content) {
	const bytes = Buffer.from(content);
	return { type: "file", mode: 0o100644, size: bytes.length, digest: core.sha256(bytes) };
}

function preservationManifest(head, files) {
	return {
		version: 1,
		config_digest: "c".repeat(64),
		head,
		index_digest: "d".repeat(64),
		submodules_digest: "e".repeat(64),
		files: Object.fromEntries(Object.entries(files).map(([rel, content]) => [rel, preservationFile(content)])),
	};
}

function writePreservationProbe(cwd, id, suffix, capabilities, subjectDigest, runner) {
	const relative = `evidence/${id.toLowerCase()}-${suffix}.json`;
	const result = { reachable: true, capabilities };
	const probe = {
		version: 1,
		surface_id: id,
		phase: suffix,
		subject_digest: subjectDigest,
		reachable: true,
		capabilities,
		execution: { credential_id: runner.credentialId, runner_digest: runner.digest, executed_at: 1780000000000, command_digest: core.sha256(`probe:${id}:${suffix}`), result_digest: core.sha256(core.canonicalJson(result)) },
	};
	probe.execution.signature = crypto.sign(null, Buffer.from(core.canonicalJson(core.signedProbePayload(probe))), runner.privateKey).toString("base64");
	const bytes = Buffer.from(JSON.stringify(probe));
	fs.mkdirSync(path.dirname(path.join(cwd, relative)), { recursive: true });
	fs.writeFileSync(path.join(cwd, relative), bytes);
	return { evidence: { id: `EVD-${suffix.toUpperCase()}-${id}`, locator: relative, digest: core.sha256(bytes) }, bytes };
}

function attestVendor(value, vendor) {
	const attestation = {
		version: 1,
		credential_id: value.runner.credentialId,
		runner_digest: value.runner.digest,
		executed_at: 1780000000000,
		resolved_tree_digest: vendor.tree_digest,
		imported_tree_digest: vendor.tree_digest,
	};
	vendor.attestation = attestation;
	attestation.signature = crypto.sign(null, Buffer.from(core.canonicalJson(core.signedVendorPayload(vendor))), value.runner.privateKey).toString("base64");
	return vendor;
}

function attestInventory(runner, baseline, current, surfaces, options = {}) {
	const inventory = {
		version: 1,
		origin: options.origin || "existing",
		adapter_id: options.adapterId || "ADAPTER-TEST",
		adapter_digest: runner.digest,
		baseline_ref: baseline.head,
		baseline_manifest_digest: core.sha256(core.canonicalJson(baseline)),
		current_manifest_digest: core.sha256(core.canonicalJson(current)),
		surface_ids: surfaces.map((surface) => surface.id),
		surface_inventory_digest: core.preservationSurfaceInventoryDigest(surfaces),
		test_roots: options.testRoots || [],
		vendor_roots: options.vendorRoots || [],
		release_operation_ids: options.releaseOperationIds || [],
		credential_id: runner.credentialId,
		runner_digest: runner.digest,
		executed_at: 1780000000000,
	};
	inventory.signature = crypto.sign(null, Buffer.from(core.canonicalJson(core.signedInventoryPayload(inventory))), runner.privateKey).toString("base64");
	return inventory;
}

function preservationSurfaceCase(options = {}) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "naia-preservation-contract-"));
	fixtureRoots.add(cwd);
	const head = "a".repeat(40);
	const { publicKey: runnerPublicKey, privateKey: runnerPrivateKey } = crypto.generateKeyPairSync("ed25519");
	const runner = {
		publicKey: runnerPublicKey.export({ type: "spki", format: "pem" }),
		privateKey: runnerPrivateKey,
		credentialId: "preservation-probe-runner",
		digest: core.sha256("preservation-probe-runner-v1"),
	};
	const surfaceId = options.surfaceId || "SURF-HOME";
	const baseline = preservationManifest(head, options.baselineFiles || { "src/home.js": "home v1\n" });
	const current = preservationManifest(head, options.currentFiles || { "src/home.js": "home v1\n" });
	const baselinePaths = options.baselinePaths || ["src/home.js"];
	const currentPaths = options.currentPaths || ["src/home.js"];
	const baselineProbe = writePreservationProbe(cwd, surfaceId, "baseline", options.baselineCapabilities || ["route:/", "render:home", "enabled:home"], core.surfaceContentDigest ? core.surfaceContentDigest(baseline, baselinePaths) : core.sha256(core.canonicalJson(Object.fromEntries(Object.entries(baseline.files).filter(([rel]) => baselinePaths.some((root) => rel === root || rel.startsWith(root + "/")))))), runner);
	const currentProbe = writePreservationProbe(cwd, surfaceId, "current", options.currentCapabilities || ["route:/", "render:home", "enabled:home"], core.surfaceContentDigest ? core.surfaceContentDigest(current, currentPaths) : core.sha256(core.canonicalJson(Object.fromEntries(Object.entries(current.files).filter(([rel]) => currentPaths.some((root) => rel === root || rel.startsWith(root + "/")))))), runner);
	const baselineEvidence = baselineProbe.evidence;
	const currentEvidence = currentProbe.evidence;
	const surface = {
		id: surfaceId,
		directive_id: "REQ-PRESERVE",
		kind: options.kind || "product-surface",
		locator: options.locator || "/",
		disposition: options.disposition || "preserve",
		baseline_paths: baselinePaths,
		current_paths: currentPaths,
		baseline_evidence_id: baselineEvidence.id,
		current_evidence_id: currentEvidence.id,
	};
	const authorities = [];
	if (["replace", "remove", "disable", "redirect", "migrate"].includes(surface.disposition)) {
		authorities.push({ id: "AUTH-MIGRATE", operation: "authorize_contract", target_directive_ids: [surface.directive_id] });
		surface.authority_id = "AUTH-MIGRATE";
		surface.expected_diff_digest = options.expectedDiffDigest === "exact"
			? core.sha256(core.canonicalJson([...new Set([...surface.baseline_paths, ...surface.current_paths])].sort().flatMap((rel) => {
				const before = baseline.files[rel] || null;
				const after = current.files[rel] || null;
				return core.canonicalJson(before) === core.canonicalJson(after) ? [] : [{ path: rel, before, after }];
			})))
			: options.expectedDiffDigest || "0".repeat(64);
	}
	return {
		cwd,
		baseline,
		current,
		runner,
		baselineProbeBytes: baselineProbe.bytes,
		contract: {
			kind: "request-contract",
			version: 1,
			sources: [],
			directives: [{ id: "REQ-PRESERVE" }],
			artifacts: { evidence: [baselineEvidence, currentEvidence] },
			authorities,
			preservation: { version: 1, baseline_ref: head, intent: options.intent || "integrate", surfaces: [surface], vendor_sources: [], inventory: attestInventory(runner, baseline, current, [surface], { origin: options.origin }) },
		},
	};
}

function validatePreservationCase(value) {
	assert.equal(typeof core.validatePreservationDeclaration, "function", "request-contract core must export validatePreservationDeclaration");
	assert.equal(typeof core.validateWorkspacePreservation, "function", "request-contract core must export validateWorkspacePreservation");
	const context = {
		baseline: value.baseline,
		current: value.current,
		cwd: value.cwd,
		config: { preservation: { required: true, protect_test_contracts: true, protect_vendor_sources: true, allowed_adapter_digests: [value.runner.digest] } },
		sourceRecords: [],
		readBaselineFile: () => value.baselineProbeBytes,
		probeRunner: { public_key: value.runner.publicKey, credential_id: value.runner.credentialId, allowed_digests: [value.runner.digest] },
	};
	const declaration = core.validatePreservationDeclaration(value.contract, context);
	assert.equal(declaration.ok, true, declaration.errors && declaration.errors.join(", "));
	return core.validateWorkspacePreservation(value.contract, context);
}

function assertPreservationError(result, prefix) {
	assert.equal(result.ok, false, `expected preservation rejection ${prefix}`);
	assert(result.errors.some((error) => error === prefix || error.startsWith(`${prefix}:`)), result.errors.join(", "));
}

function resignLifecycleContract(fx, unit, contract) {
	const scopeDigest = core.sha256(core.canonicalJson(core.scopeProjection(contract)));
	const presentation = core.authorityPresentation(contract.authorities[0], null, scopeDigest, 0, 1);
	const challenge = core.issueAuthorityChallenge(unit, fx.cwd, presentation);
	contract.authorities[0].receipt = signedReceipt(fx, {
		operation: "authorize_contract",
		// scopeProjection pins the receipt nonce; retain the nonce that was
		// present when the replacement scope digest above was calculated.
		nonce: "initial-nonce-01",
		resulting_scope_digest: scopeDigest,
		resulting_scope_epoch: 0,
		binding_epoch: 1,
		challenge: challenge.challenge,
		presentation_digest: challenge.presentation_digest,
		target_directive_ids: [contract.directives[0].id],
		replacement_ids: [contract.directives[0].id],
		sign_count: 1,
	});
}

function lifecyclePreservationContract(fx, unit) {
	const contract = makeContract(fx, unit);
	for (const source of contract.sources) source.source_kind = "human";
	const surfaceId = "SURF-PRODUCT";
	const baseline = core.readJson(unit.paths.state).baseline;
	const current = core.workspaceManifest(fx.cwd, core.loadConfig(fx.cwd)).manifest;
	const probeRunner = { privateKey: fx.runnerPrivateKey, credentialId: "test-isolation-runner", digest: fx.runnerAttestorDigest };
	const baselineEvidence = writePreservationProbe(fx.cwd, surfaceId, "baseline", ["render:product", "enabled:product"], core.sha256(core.canonicalJson({ "src/product.txt": baseline.files["src/product.txt"] })), probeRunner).evidence;
	const currentEvidence = writePreservationProbe(fx.cwd, surfaceId, "current", ["render:product", "enabled:product"], core.sha256(core.canonicalJson({ "src/product.txt": current.files["src/product.txt"] })), probeRunner).evidence;
	const implementationId = contract.directives[0].trace.implementations[0];
	const obligationAtomIds = contract.artifacts.evidence[0].obligation_atom_ids;
	for (const [index, evidence] of [baselineEvidence, currentEvidence].entries()) {
		contract.artifacts.evidence.push({ ...evidence, statement: `${index ? "Current" : "Baseline"} product capability probe`, kind: "preservation-probe", subject_id: implementationId, obligation_atom_ids: [...obligationAtomIds] });
		contract.directives[0].trace.evidence.push(evidence.id);
		contract.edges.push({ id: `EDGE-PRESERVATION-${index + 1}`, kind: "implementations_to_evidence", from: implementationId, to: evidence.id });
	}
	const surface = {
		id: surfaceId,
		directive_id: contract.directives[0].id,
		kind: "product-surface",
		locator: "src/product.txt",
		disposition: "preserve",
		baseline_paths: ["src/product.txt"],
		current_paths: ["src/product.txt"],
		baseline_evidence_id: baselineEvidence.id,
		current_evidence_id: currentEvidence.id,
	};
	contract.preservation = {
		version: 1,
		baseline_ref: core.readJson(unit.paths.state).baseline.head,
		intent: "integrate",
		surfaces: [surface],
		vendor_sources: [],
		inventory: attestInventory(probeRunner, baseline, current, [surface]),
	};
	resignLifecycleContract(fx, unit, contract);
	return contract;
}

function pinLifecyclePreservationProbes(fx, options = {}) {
	const configPath = path.join(fx.cwd, ".agents", "context", "request-contract.json");
	const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
	config.preservation = { ...(config.preservation || {}), required: options.required !== false, protect_test_contracts: true, protect_vendor_sources: true, allowed_adapter_digests: [fx.runnerAttestorDigest] };
	if (options.requiredRoles) config.reviewer = { ...(config.reviewer || {}), required_roles: options.requiredRoles };
	fs.writeFileSync(configPath, JSON.stringify(config));
	const manifest = core.workspaceManifest(fx.cwd, core.loadConfig(fx.cwd)).manifest;
	const subjectDigest = core.sha256(core.canonicalJson({ "src/product.txt": manifest.files["src/product.txt"] }));
	const probeRunner = { privateKey: fx.runnerPrivateKey, credentialId: "test-isolation-runner", digest: fx.runnerAttestorDigest };
	writePreservationProbe(fx.cwd, "SURF-PRODUCT", "baseline", ["render:product", "enabled:product"], subjectDigest, probeRunner);
	writePreservationProbe(fx.cwd, "SURF-PRODUCT", "current", ["render:product", "enabled:product"], subjectDigest, probeRunner);
	cp.execFileSync("git", ["add", ".agents/context/request-contract.json", "evidence/surf-product-baseline.json", "evidence/surf-product-current.json"], { cwd: fx.cwd });
	cp.execFileSync("git", ["commit", "-q", "-m", "pin preservation probes"], { cwd: fx.cwd });
}

module.exports = {
	preservationFile,
	preservationManifest,
	writePreservationProbe,
	attestVendor,
	attestInventory,
	preservationSurfaceCase,
	validatePreservationCase,
	assertPreservationError,
	resignLifecycleContract,
	lifecyclePreservationContract,
	pinLifecyclePreservationProbes,
};
