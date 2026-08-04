"use strict";

/** Request-contract tests: product-preservation contracts and lifecycle gates. */

const {
	test,
	assert,
	cp,
	fs,
	os,
	path,
	core,
	fixtureRoots,
	CLIENT_VERSIONS,
	fixture,
	start,
	bind,
	cleanReview,
	ingestReview,
	runNativeAdapter,
	nativePolicyOutput,
	nativeEnvelope,
	makeResumeReceipt,
	projectedUnitSnapshot,
	firstDifference,
} = require("./request-contract-test-helpers.js");

const {
	preservationFile,
	preservationManifest,
	attestVendor,
	attestInventory,
	preservationSurfaceCase,
	validatePreservationCase,
	assertPreservationError,
	lifecyclePreservationContract,
	pinLifecyclePreservationProbes,
} = require("./request-contract-preservation-helpers.js");

test("preservation additive extension keeps the baseline surface and permits a new surface", () => {
	const value = preservationSurfaceCase({
		disposition: "extend",
		baselineFiles: { "src/home.js": "home v1\n" },
		currentFiles: { "src/home.js": "home v2 compatible refactor\n", "src/pension.js": "pension case\n" },
		currentPaths: ["src/home.js", "src/pension.js"],
		currentCapabilities: ["route:/", "render:home", "enabled:home", "route:/pension"],
	});
	assert.equal(validatePreservationCase(value).ok, true);
});
test("preservation preserve surfaces reject missing successors and capability loss but permit compatible edits and renames", () => {
	let value = preservationSurfaceCase({ currentFiles: {}, currentPaths: ["src/home.js"] });
	assertPreservationError(validatePreservationCase(value), "preservation_current_path_missing");
	value = preservationSurfaceCase({ currentFiles: { "src/home.js": "refactored\n" }, currentCapabilities: ["route:/", "enabled:home"] });
	assertPreservationError(validatePreservationCase(value), "preservation_capability_lost");
	value = preservationSurfaceCase({ currentFiles: { "src/home.js": "refactored without behavior loss\n" } });
	assert.equal(validatePreservationCase(value).ok, true);
	value = preservationSurfaceCase({ currentFiles: { "src/home-renamed.js": "home v1\n" }, currentPaths: ["src/home-renamed.js"] });
	assert.equal(validatePreservationCase(value).ok, true);
});

test("preservation semantic probes reject redirects and disabled behavior", () => {
	let value = preservationSurfaceCase({ currentCapabilities: ["route:/pension", "render:home", "enabled:home"] });
	assertPreservationError(validatePreservationCase(value), "preservation_capability_lost");
	value = preservationSurfaceCase({ currentCapabilities: ["route:/", "render:home"] });
	assertPreservationError(validatePreservationCase(value), "preservation_capability_lost");
});

test("preservation baseline test probe rejects assertion inversion", () => {
	const value = preservationSurfaceCase({
		surfaceId: "SURF-BASELINE-TEST",
		kind: "test-contract",
		locator: "test/home.spec.js",
		baselineFiles: { "test/home.spec.js": "assert(home renders)\n" },
		currentFiles: { "test/home.spec.js": "assert(home does not render)\n" },
		baselinePaths: ["test/home.spec.js"],
		currentPaths: ["test/home.spec.js"],
		baselineCapabilities: ["assertion:home-renders", "polarity:positive"],
		currentCapabilities: ["assertion:home-not-render", "polarity:negative"],
	});
	assertPreservationError(validatePreservationCase(value), "preservation_capability_lost");
});

test("preservation vendor source requires its pristine tree digest", () => {
	const value = preservationSurfaceCase();
	value.contract.preservation.surfaces = [];
	value.baseline = preservationManifest(value.baseline.head, { "vendor/professor/app.js": "pristine vendor source\n" });
	value.current = preservationManifest(value.baseline.head, { "vendor/professor/app.js": "modified vendor source\n" });
	value.contract.preservation.inventory = attestInventory(value.runner, value.baseline, value.current, []);
	const pristine = value.baseline;
	value.contract.authorities.push({ id: "AUTH-VENDOR", operation: "authorize_contract", target_directive_ids: ["REQ-PRESERVE"] });
	value.contract.preservation.vendor_sources = [attestVendor(value, { id: "VENDOR-PROFESSOR", directive_id: "REQ-PRESERVE", authority_id: "AUTH-VENDOR", disposition: "preserve", pristine_path: "vendor/professor", source_ref: `https://github.com/professor/repo@${"a".repeat(40)}`, tree_digest: core.preservationVendorTreeDigest(pristine, "vendor/professor") })];
	assertPreservationError(validatePreservationCase(value), "preservation_vendor_digest_mismatch");
});

test("preservation permits a pristine immutable vendor import without rewriting it", () => {
	const value = preservationSurfaceCase({
		disposition: "extend",
		baselineFiles: { "src/home.js": "home v1\n" },
		currentFiles: { "src/home.js": "home v1\n", "vendor/professor/app.js": "pristine professor source\n" },
		currentPaths: ["src/home.js", "vendor/professor"],
		currentCapabilities: ["route:/", "render:home", "enabled:home", "source:professor"],
	});
	value.contract.authorities.push({ id: "AUTH-VENDOR", operation: "amend_scope_add", target_directive_ids: ["REQ-PRESERVE"] });
	const originTreeDigest = core.preservationVendorTreeDigest(value.current, "vendor/professor");
	const relocated = preservationManifest(value.baseline.head, { "external/teacher/app.js": "pristine professor source\n" });
	assert.equal(core.preservationVendorTreeDigest(relocated, "external/teacher"), originTreeDigest, "origin tree digest must not depend on the destination prefix");
	value.contract.preservation.vendor_sources = [attestVendor(value, { id: "VENDOR-PROFESSOR", directive_id: "REQ-PRESERVE", authority_id: "AUTH-VENDOR", disposition: "import", pristine_path: "vendor/professor", source_ref: `https://github.com/professor/repo@${"b".repeat(40)}`, tree_digest: originTreeDigest })];
	assert.equal(validatePreservationCase(value).ok, true);
});

test("preservation approved migration accepts only the exact authorized diff", () => {
	const value = preservationSurfaceCase({
		disposition: "migrate",
		intent: "migrate",
		baselineFiles: { "src/home.js": "home v1\n" },
		currentFiles: { "src/home-v2.js": "home v2\n" },
		currentPaths: ["src/home-v2.js"],
		currentCapabilities: ["route:/", "render:home-v2", "enabled:home"],
		expectedDiffDigest: "exact",
	});
	assert.equal(validatePreservationCase(value).ok, true);
});

test("preservation rejects stale or wrong migration diff authority", () => {
	let value = preservationSurfaceCase({ disposition: "migrate", intent: "migrate", currentFiles: { "src/home.js": "home v2\n" }, expectedDiffDigest: "0".repeat(64) });
	assertPreservationError(validatePreservationCase(value), "preservation_authority_diff_mismatch");
	value = preservationSurfaceCase({ disposition: "migrate", intent: "migrate", currentFiles: { "src/home.js": "home v2\n" }, expectedDiffDigest: "exact" });
	value.current.files["src/home.js"] = preservationFile("home v3 after authority was issued\n");
	assertPreservationError(validatePreservationCase(value), "preservation_authority_diff_mismatch");
});

test("preservation bypass rejects net-new and empty-surface changes", () => {
	let value = preservationSurfaceCase({
		baselineFiles: { "src/home.js": "home v1\n" },
		currentFiles: { "src/home.js": "home v1\n", "src/unowned.js": "silent replacement\n" },
	});
	assertPreservationError(validatePreservationCase(value), "preservation_change_uncovered");
	value = preservationSurfaceCase({ baselineFiles: {}, currentFiles: { "src/new.js": "new-only app\n" } });
	value.contract.preservation.surfaces = [];
	const context = { baseline: value.baseline, current: value.current, cwd: value.cwd, config: { preservation: { required: true, protect_test_contracts: true, protect_vendor_sources: true } }, sourceRecords: [], readBaselineFile: () => value.baselineProbeBytes };
	assertPreservationError(core.validateWorkspacePreservation(value.contract, context), "preservation_change_uncovered");
});

test("preservation bypass rejects forged current and non-baseline probes", () => {
	let value = preservationSurfaceCase();
	const currentEvidence = value.contract.artifacts.evidence.find((item) => item.id === value.contract.preservation.surfaces[0].current_evidence_id);
	const forged = JSON.parse(fs.readFileSync(path.join(value.cwd, currentEvidence.locator), "utf8"));
	forged.subject_digest = "f".repeat(64);
	const bytes = Buffer.from(JSON.stringify(forged));
	fs.writeFileSync(path.join(value.cwd, currentEvidence.locator), bytes);
	currentEvidence.digest = core.sha256(bytes);
	assertPreservationError(validatePreservationCase(value), "preservation_current_probe_invalid");
	value = preservationSurfaceCase();
	value.baselineProbeBytes = Buffer.from(JSON.stringify({ version: 1, surface_id: "SURF-HOME", phase: "baseline", subject_digest: "0".repeat(64), reachable: true, capabilities: ["route:/"], execution: { runner: "fake", executed_at: 1, command_digest: "0".repeat(64), result_digest: "0".repeat(64) } }));
	assertPreservationError(validatePreservationCase(value), "preservation_baseline_probe_invalid");
});

test("preservation bypass rejects mutable vendor refs and unbound authority", () => {
	const value = preservationSurfaceCase();
	value.contract.preservation.vendor_sources = [{ id: "VENDOR-PROFESSOR", directive_id: "REQ-PRESERVE", authority_id: "AUTH-MISSING", disposition: "preserve", pristine_path: "vendor/professor", source_ref: "https://github.com/professor/repo@main", tree_digest: "0".repeat(64) }];
	const result = core.validatePreservationDeclaration(value.contract, { config: { preservation: { required: true } }, sourceRecords: [] });
	assertPreservationError(result, "preservation_vendor_provenance_invalid");
	assertPreservationError(result, "preservation_vendor_authority_invalid");
});

test("preservation bypass rejects derived cycles and stale generic authority", () => {
	const value = preservationSurfaceCase({ disposition: "replace", expectedDiffDigest: "exact" });
	const parent = "SRC-11111111111111111111111111111111";
	const derived = "SRC-22222222222222222222222222222222";
	const approver = "SRC-33333333333333333333333333333333";
	value.contract.sources = [
		{ id: parent, source_kind: "human", directive_ids: ["REQ-PRESERVE"] },
		{ id: derived, source_kind: "derived", derived_from: parent, derivation_kind: "replace", directive_ids: ["REQ-PRESERVE"] },
		{ id: approver, source_kind: "human", directive_ids: ["REQ-PRESERVE"] },
	];
	value.contract.authorities[0] = { ...value.contract.authorities[0], source_id: approver, affected_source_ids: [derived], operation: "authorize_contract" };
	let result = core.validatePreservationDeclaration(value.contract, { config: { preservation: { required: true } }, sourceRecords: [
		{ source_id: parent, origin: "native_user", seq: 1 }, { source_id: derived, origin: "derived", seq: 2 }, { source_id: approver, origin: "native_user", seq: 3 },
	] });
	assertPreservationError(result, "preservation_derived_scope_escalation");
	value.contract.sources[0] = { ...value.contract.sources[0], source_kind: "derived", derived_from: derived, derivation_kind: "clarify" };
	result = core.validatePreservationDeclaration(value.contract, { config: { preservation: { required: true } }, sourceRecords: [
		{ source_id: parent, origin: "derived", seq: 1 }, { source_id: derived, origin: "derived", seq: 2 }, { source_id: approver, origin: "native_user", seq: 3 },
	] });
	assertPreservationError(result, "preservation_derived_source_cycle");
});

test("preservation inventory binds the complete surface descriptor and rejects unsupported greenfield claims", () => {
	let value = preservationSurfaceCase();
	value.contract.preservation.surfaces[0].locator = "/silently-rewritten";
	assertPreservationError(core.validatePreservationDeclaration(value.contract, {
		config: { preservation: { required: true, allowed_adapter_digests: [value.runner.digest] } },
		sourceRecords: [],
		probeRunner: { public_key: value.runner.publicKey, credential_id: value.runner.credentialId, allowed_digests: [value.runner.digest] },
	}), "preservation_inventory_descriptor_mismatch");
	value = preservationSurfaceCase({ origin: "greenfield" });
	assertPreservationError(core.validatePreservationDeclaration(value.contract, {
		config: { preservation: { required: true, allowed_adapter_digests: [value.runner.digest] } },
		sourceRecords: [],
		probeRunner: { public_key: value.runner.publicKey, credential_id: value.runner.credentialId, allowed_digests: [value.runner.digest] },
	}), "preservation_inventory_invalid");
	value = preservationSurfaceCase();
	value.contract.preservation.surfaces = [null];
	value.contract.preservation.vendor_sources = [null];
	const malformed = core.validatePreservationDeclaration(value.contract, {
		config: { preservation: { required: true, allowed_adapter_digests: [value.runner.digest] } },
		sourceRecords: [],
		probeRunner: { public_key: value.runner.publicKey, credential_id: value.runner.credentialId, allowed_digests: [value.runner.digest] },
	});
	assertPreservationError(malformed, "preservation_surface_shape_invalid");
	assertPreservationError(malformed, "preservation_vendor_shape_invalid");
	value = preservationSurfaceCase();
	value.contract.preservation.inventory = attestInventory(value.runner, value.baseline, value.current, value.contract.preservation.surfaces, { testRoots: ["../escape"] });
	assertPreservationError(core.validatePreservationDeclaration(value.contract, {
		config: { preservation: { required: true, allowed_adapter_digests: [value.runner.digest] } },
		sourceRecords: [],
		probeRunner: { public_key: value.runner.publicKey, credential_id: value.runner.credentialId, allowed_digests: [value.runner.digest] },
	}), "preservation_inventory_invalid");
});

test("derived source authority cannot bypass validation when preservation is absent", () => {
	const contract = {
		sources: [{ id: "SRC-DERIVED", source_kind: "derived", derived_from: "SRC-MISSING", derivation_kind: "narrow", directive_ids: ["REQ-DERIVED"] }],
		directives: [{ id: "REQ-DERIVED" }],
		authorities: [],
	};
	const result = core.validatePreservationDeclaration(contract, { config: { preservation: { required: false } }, sourceRecords: [] });
	assertPreservationError(result, "preservation_derived_source_parent_invalid");
});

test("release bypass detection covers wrappers, newlines, both shells, merge and deploy", () => {
	const config = { release: { shell_tools: ["Bash", "shell_command"], command_patterns: [] } };
	for (const [toolName, command] of [
		["Bash", "git -C . push origin main"],
		["Bash", "echo preparing\ngit push"],
		["shell_command", "gh pr merge 42 --squash"],
		["Bash", "npm publish"],
		["shell_command", "az webapp deploy --name aipol"],
		["shell_command", "powershell -Command \"git push origin main\""],
		["shell_command", "cmd /c git push origin main"],
		["Bash", "bash -lc \"git push origin main\""],
		["Bash", "/usr/bin/git push origin main"],
		["shell_command", "gh release create v1"],
		["shell_command", "gh issue close 17"],
		["shell_command", "az webapp up --name aipol"],
		["shell_command", "kubectl apply -f deploy.yaml"],
		["shell_command", "helm upgrade aipol ./chart"],
		["shell_command", "terraform apply -auto-approve"],
		["shell_command", "gcloud run deploy aipol"],
		["shell_command", "vercel --prod"],
	]) assert.equal(core.releaseCommandFromEvent({ toolName, toolInput: { command } }, config), true, command);
	assert.equal(core.releaseCommandFromEvent({ toolName: "Bash", toolInput: { command: 'echo "git push"' } }, config), false);
});

test("config bypass fails closed for missing and corrupt fresh repository config", () => {
	for (const corrupt of [false, true]) {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "naia-config-fail-closed-"));
		fixtureRoots.add(cwd);
		if (corrupt) {
			fs.mkdirSync(path.join(cwd, ".agents", "context"), { recursive: true });
			fs.writeFileSync(path.join(cwd, ".agents", "context", "request-contract.json"), "{");
		}
		const result = core.handleEvent({ client: "claude", clientVersion: CLIENT_VERSIONS.claude, eventName: "SessionStart", sessionId: "FRESH", cwd }, { env: {} });
		assert.equal(result.kind, "block");
		assert.equal(result.code, "request_contract_config_invalid");
	}
});

test("preservation shell and release remain blocked while the external-effect gate is pending", () => {
	for (const [client, toolName, command] of [["claude", "Bash", "git -C . push origin main"], ["codex", "shell_command", "az webapp deploy --name aipol"]]) {
		const fx = fixture();
		pinLifecyclePreservationProbes(fx);
		const sessionId = `RELEASE-${client.toUpperCase()}`;
		const unit = start(fx, client, sessionId);
		bind(fx, unit, lifecyclePreservationContract(fx, unit));
		const publication = core.handleEvent({ client, eventName: "PreToolUse", sessionId, cwd: fx.cwd, toolName, toolUseId: `release-${client}`, toolInput: { command } });
		assert.equal(publication.kind, "block");
		assert.equal(publication.code, "external_effect_gate_pending");
		const result = core.handleEvent({ client, eventName: "Stop", sessionId, cwd: fx.cwd });
		assert.equal(result.kind, "block");
		assert.notEqual(core.readJson(unit.paths.state).terminal && core.readJson(unit.paths.state).terminal.status, "success");
	}
});

test("preservation collects planning and integration evidence views but remains review only while controls are pending", () => {
	const fx = fixture();
	const configPath = path.join(fx.cwd, ".agents", "context", "request-contract.json");
	const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
	config.preservation = { required: true, protect_test_contracts: true, protect_vendor_sources: true, allowed_adapter_digests: [fx.runnerAttestorDigest] };
	fs.writeFileSync(configPath, JSON.stringify(config));
	cp.execFileSync("git", ["add", ".agents/context/request-contract.json"], { cwd: fx.cwd });
	pinLifecyclePreservationProbes(fx);
	const unit = start(fx);
	bind(fx, unit, lifecyclePreservationContract(fx, unit));
	const expectedSections = {
		source_fidelity: ["binding", "contract", "scope_history", "sources"],
		baseline_preservation: ["baseline_manifest", "baseline_materials", "preservation"],
		implementation_test: ["contract", "occurrences"],
		authority_release: ["binding", "contract", "scope_history"],
	};
	for (const role of Object.keys(expectedSections)) {
		const planningView = core.buildReviewBundle(unit, fx.cwd, { stage: "planning", role }).bundle;
		assert.deepEqual(planningView.included_sections, expectedSections[role], `${role} planning included sections`);
		assert.deepEqual(Object.keys(planningView.evidence).filter((key) => planningView.evidence[key] !== undefined).sort(), expectedSections[role], `${role} planning evidence bytes`);
		assert.equal(new Set([...planningView.included_sections, ...planningView.withheld_sections]).size, 10, `${role} declares the complete section partition`);
		const integrationView = core.buildReviewBundle(unit, fx.cwd, { stage: "integration", role }).bundle;
		if (["baseline_preservation", "implementation_test", "authority_release"].includes(role)) assert(integrationView.included_sections.includes("workspace_manifest"), `${role} integration receives current workspace`);
		if (["baseline_preservation", "implementation_test"].includes(role)) assert(integrationView.included_sections.includes("materials"), `${role} integration receives current materials`);
	}
	const reviews = [];
	for (let index = 0; index < 15; index++) {
		const review = cleanReview(fx, unit, `SLOT-${index + 1}`);
		reviews.push(review);
		ingestReview(fx, unit, review);
	}
	let result = core.handleEvent({ client: "claude", eventName: "Stop", sessionId: "S1", cwd: fx.cwd });
	assert.equal(result.kind, "block");
	assert(result.message.includes("review_required_slots_incomplete"), result.message);
	const finalReview = cleanReview(fx, unit, "SLOT-16");
	reviews.push(finalReview);
	ingestReview(fx, unit, finalReview);
	assert.equal(reviews.length, 16);
	assert.equal(new Set(reviews.map((review) => review.evidence_view_digest)).size, 8);
	result = core.handleEvent({ client: "claude", eventName: "Stop", sessionId: "S1", cwd: fx.cwd });
	assert.equal(result.kind, "block");
	assert(result.errors.includes("external_effect_gate_pending"), result.errors.join(","));
	assert(result.errors.includes("preservation_incident_history_pending"), result.errors.join(","));
	const chain = core.verifyReviewChain(unit.paths);
	assert.deepEqual(new Set(chain.records.map((review) => review.role)), new Set(["source_fidelity", "baseline_preservation", "implementation_test", "authority_release"]));
	assert.deepEqual(new Set(chain.records.map((review) => review.review_stage)), new Set(["planning", "integration"]));
	assert.notEqual(core.readJson(unit.paths.state).terminal && core.readJson(unit.paths.state).terminal.status, "success");
	const publication = core.handleEvent({ client: "claude", eventName: "PreToolUse", sessionId: "S1", cwd: fx.cwd, toolName: "Bash", toolUseId: "release-after-clean", toolInput: { command: "git push origin main" } });
	assert.equal(publication.kind, "block");
	assert.equal(publication.code, "external_effect_gate_pending");
});

test("preservation blocks shell indirection and release-regex false positives until classification exists", () => {
	const fx = fixture();
	const configPath = path.join(fx.cwd, ".agents", "context", "request-contract.json");
	const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
	config.release = config.release || { shell_tools: ["Bash", "shell_command"], command_patterns: [] };
	config.release.shell_tools.push("PowerShell");
	fs.writeFileSync(configPath, JSON.stringify(config));
	const settingsPath = path.join(fx.cwd, ".claude", "settings.json");
	const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	settings.hooks.PreToolUse[0].matcher = "Bash|shell_command|PowerShell|Edit|Write|NotebookEdit|apply_patch";
	fs.writeFileSync(settingsPath, JSON.stringify(settings));
	cp.execFileSync("git", ["add", ".agents/context/request-contract.json", ".claude/settings.json"], { cwd: fx.cwd });
	pinLifecyclePreservationProbes(fx);
	const unit = start(fx);
	bind(fx, unit, lifecyclePreservationContract(fx, unit));
	for (const command of [
		"git p$(printf ush) origin main",
		"verb=push; git $verb origin main",
		"$verb = 'push'; git $verb origin main",
		"Write-Output 'git push'",
		"node --test",
	]) {
		const result = core.handleEvent({ client: "claude", eventName: "PreToolUse", sessionId: "S1", cwd: fx.cwd, toolName: "Bash", toolUseId: `shell-${core.sha256(command).slice(0, 12)}`, toolInput: { command } });
		assert.equal(result.kind, "block", command);
		assert.equal(result.code, "external_effect_gate_pending", command);
	}
	const configuredShell = core.handleEvent({ client: "claude", eventName: "PreToolUse", sessionId: "S1", cwd: fx.cwd, toolName: "PowerShell", toolUseId: "configured-shell", toolInput: { command: "Get-ChildItem" } });
	assert.equal(configuredShell.kind, "block");
	assert.equal(configuredShell.code, "external_effect_gate_pending");
	assert.equal(core.isShellTool({ toolName: "PowerShell" }, core.loadConfig(fx.cwd)), true);
	assert.equal(core.isShellTool({ toolName: "Bash" }, { release: { shell_tools: [] } }), true);
	assert.equal(core.isShellTool({ toolName: "shell_command" }, { release: { shell_tools: [] } }), true);
});

test("preservation blocks implementation until planning is sealed and closes stale planning windows", () => {
	let fx = fixture();
	let configPath = path.join(fx.cwd, ".agents", "context", "request-contract.json");
	let config = JSON.parse(fs.readFileSync(configPath, "utf8"));
	config.preservation = { required: true, protect_test_contracts: true, protect_vendor_sources: true, allowed_adapter_digests: [fx.runnerAttestorDigest] };
	fs.writeFileSync(configPath, JSON.stringify(config));
	cp.execFileSync("git", ["add", ".agents/context/request-contract.json"], { cwd: fx.cwd });
	pinLifecyclePreservationProbes(fx);
	let unit = start(fx);
	bind(fx, unit, lifecyclePreservationContract(fx, unit));
	let mutation = core.handleEvent({ client: "claude", eventName: "PreToolUse", sessionId: "S1", cwd: fx.cwd, toolName: "Edit", toolUseId: "before-plan", toolInput: { file_path: "src/product.txt" } });
	assert.equal(mutation.kind, "block");
	assert.equal(mutation.code, "request_contract_planning_review_required");
	for (let index = 0; index < 8; index++) ingestReview(fx, unit, cleanReview(fx, unit, `PLAN-${index + 1}`));
	mutation = core.handleEvent({ client: "claude", eventName: "PreToolUse", sessionId: "S1", cwd: fx.cwd, toolName: "Edit", toolUseId: "after-plan", toolInput: { file_path: "src/product.txt" } });
	assert.equal(mutation.kind, "allow");

	fx = fixture();
	configPath = path.join(fx.cwd, ".agents", "context", "request-contract.json");
	config = JSON.parse(fs.readFileSync(configPath, "utf8"));
	config.preservation = { required: true, protect_test_contracts: true, protect_vendor_sources: true, allowed_adapter_digests: [fx.runnerAttestorDigest] };
	fs.writeFileSync(configPath, JSON.stringify(config));
	cp.execFileSync("git", ["add", ".agents/context/request-contract.json"], { cwd: fx.cwd });
	pinLifecyclePreservationProbes(fx);
	unit = start(fx);
	bind(fx, unit, lifecyclePreservationContract(fx, unit));
	fs.writeFileSync(path.join(fx.cwd, "src", "product.txt"), "unreviewed external drift\n");
	assert.throws(() => core.issueReviewInvocation(unit, fx.cwd, "S1"), (error) => error.code === "review_planning_window_closed");
});

test("a DIRTY planning verdict resets both complete rounds before implementation", () => {
	const fx = fixture();
	const configPath = path.join(fx.cwd, ".agents", "context", "request-contract.json");
	const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
	const dirtyReviewer = process.platform === "win32" ? "dirty-reviewer.cjs" : "dirty-reviewer.sh";
	config.review_runner.allowed_reviewer_digests.push(core.sha256(fs.readFileSync(path.join(__dirname, "fixtures", dirtyReviewer))));
	fs.writeFileSync(configPath, JSON.stringify(config));
	cp.execFileSync("git", ["add", ".agents/context/request-contract.json"], { cwd: fx.cwd });
	pinLifecyclePreservationProbes(fx);
	const unit = start(fx);
	bind(fx, unit, lifecyclePreservationContract(fx, unit));
	for (let index = 0; index < 4; index++) ingestReview(fx, unit, cleanReview(fx, unit, `PRE-DIRTY-${index + 1}`));
	const dirty = cleanReview(fx, unit, "DIRTY", { reviewerFixture: "dirty-reviewer" });
	ingestReview(fx, unit, dirty);
	let mutation = core.handleEvent({ client: "claude", eventName: "PreToolUse", sessionId: "S1", cwd: fx.cwd, toolName: "Edit", toolUseId: "dirty-plan", toolInput: { file_path: "src/product.txt" } });
	assert.equal(mutation.kind, "block");
	assert.equal(mutation.code, "request_contract_planning_review_required");
	for (let index = 0; index < 8; index++) ingestReview(fx, unit, cleanReview(fx, unit, `POST-DIRTY-${index + 1}`));
	mutation = core.handleEvent({ client: "claude", eventName: "PreToolUse", sessionId: "S1", cwd: fx.cwd, toolName: "Edit", toolUseId: "clean-after-dirty", toolInput: { file_path: "src/product.txt" } });
	assert.equal(mutation.kind, "allow");
});

test("an integration DIRTY resets integration only and converges after two new rounds", () => {
	const fx = fixture();
	const configPath = path.join(fx.cwd, ".agents", "context", "request-contract.json");
	const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
	const dirtyReviewer = process.platform === "win32" ? "dirty-reviewer.cjs" : "dirty-reviewer.sh";
	config.review_runner.allowed_reviewer_digests.push(core.sha256(fs.readFileSync(path.join(__dirname, "fixtures", dirtyReviewer))));
	fs.writeFileSync(configPath, JSON.stringify(config));
	cp.execFileSync("git", ["add", ".agents/context/request-contract.json"], { cwd: fx.cwd });
	pinLifecyclePreservationProbes(fx);
	const unit = start(fx);
	bind(fx, unit, lifecyclePreservationContract(fx, unit));
	for (let index = 0; index < 8; index++) ingestReview(fx, unit, cleanReview(fx, unit, `PLAN-BEFORE-INTEGRATION-${index + 1}`));
	for (let index = 0; index < 4; index++) ingestReview(fx, unit, cleanReview(fx, unit, `INTEGRATION-PRE-DIRTY-${index + 1}`));
	ingestReview(fx, unit, cleanReview(fx, unit, "INTEGRATION-DIRTY", { reviewerFixture: "dirty-reviewer" }));
	for (let index = 0; index < 8; index++) ingestReview(fx, unit, cleanReview(fx, unit, `INTEGRATION-POST-DIRTY-${index + 1}`));
	assert.throws(() => core.issueReviewInvocation(unit, fx.cwd, "S1"), (error) => error.code === "review_slots_complete");
	const completion = core.evaluateCompletion(unit, fx.cwd, "claude");
	assert.equal(completion.kind, "block");
	assert(!completion.errors.includes("review_required_slots_incomplete"), completion.errors.join(","));
	assert(!completion.errors.includes("preservation_review_convergence_pending"), completion.errors.join(","));
});

test("a declared preservation contract cannot shrink the fixed review roles through optional configuration", () => {
	const fx = fixture();
	pinLifecyclePreservationProbes(fx, { required: false, requiredRoles: ["general"] });
	const unit = start(fx);
	bind(fx, unit, lifecyclePreservationContract(fx, unit));
	const issuedRoles = [];
	for (let index = 0; index < 5; index++) {
		const review = cleanReview(fx, unit, `OPTIONAL-PRESERVATION-${index + 1}`);
		issuedRoles.push(review.role);
		ingestReview(fx, unit, review);
	}
	assert.deepEqual(issuedRoles, ["source_fidelity", "baseline_preservation", "implementation_test", "authority_release", "general"]);
	const mutation = core.handleEvent({ client: "claude", eventName: "PreToolUse", sessionId: "S1", cwd: fx.cwd, toolName: "Edit", toolUseId: "optional-role-bypass", toolInput: { file_path: "src/product.txt" } });
	assert.equal(mutation.kind, "block");
	assert.equal(mutation.code, "request_contract_planning_review_required");
});

test("preservation lifecycle policy is equivalent across Claude Code and Codex", () => {
	const outputs = [];
	for (const client of ["claude", "codex"]) {
		const fx = fixture();
		pinLifecyclePreservationProbes(fx);
		const sessionId = `PRESERVATION-${client.toUpperCase()}`;
		const unit = start(fx, client, sessionId);
		bind(fx, unit, lifecyclePreservationContract(fx, unit));
		const output = nativePolicyOutput(runNativeAdapter(client, fx, nativeEnvelope(client, fx, "Stop", sessionId), "Stop"));
		assert.equal(output.kind, "block");
		assert(output.message.includes("review_required_slots_incomplete"), output.message);
		outputs.push(core.canonicalParityProjection(output));
	}
	assert.equal(firstDifference(outputs[0], outputs[1]), null);
});

test("full persisted lifecycle is policy-equivalent across Claude Code and Codex", () => {
	if (!process.env.TEST_FILTER) {
		return;
	}
	const snapshots = [];
	for (const client of ["claude", "codex"]) {
		const fx = fixture();
		const sessionId = `${client}-SESSION`;
		const nativeOutputs = [];
		nativeOutputs.push(runNativeAdapter(client, fx, nativeEnvelope(client, fx, "SessionStart", sessionId), "SessionStart"));
		nativeOutputs.push(runNativeAdapter(client, fx, nativeEnvelope(client, fx, "UserPromptSubmit", sessionId, { prompt: "Implement the complete requested feature" }), "UserPromptSubmit"));
		const unit = core.findUnit(fx.cwd, client, sessionId);
		assert(unit && !unit.error);
		bind(fx, unit);
		nativeOutputs.push(runNativeAdapter(client, fx, nativeEnvelope(client, fx, "PreToolUse", sessionId, { tool_name: "apply_patch", tool_input: { patch: "mutate" }, tool_use_id: "native-tool-1" }), "PreToolUse"));
		fs.writeFileSync(path.join(fx.cwd, "src", "product.txt"), "native lifecycle mutation\n");
		nativeOutputs.push(runNativeAdapter(client, fx, nativeEnvelope(client, fx, "PostToolUse", sessionId, { tool_name: "apply_patch", tool_input: { patch: "mutate" }, tool_response: { ok: true }, tool_use_id: "native-tool-1" }), "PostToolUse"));
		bind(fx, unit, core.readJson(unit.paths.contract));
		for (let index = 0; index < 3; index++) nativeOutputs.push(runNativeAdapter(client, fx, nativeEnvelope(client, fx, "Stop", sessionId), "Stop"));
		core.resumeIncomplete(unit, makeResumeReceipt(fx, unit), fx.cwd);
		ingestReview(fx, unit, cleanReview(fx, unit, "PARITY-ONE"));
		ingestReview(fx, unit, cleanReview(fx, unit, "PARITY-TWO"));
		nativeOutputs.push(runNativeAdapter(client, fx, nativeEnvelope(client, fx, "Stop", sessionId), "Stop"));
		assert(core.readJson(unit.paths.state).terminal);
		nativeOutputs.push(runNativeAdapter(client, fx, nativeEnvelope(client, fx, "PreCompact", sessionId), "PreCompact"));
		nativeOutputs.push(runNativeAdapter(client, fx, nativeEnvelope(client, fx, "PostCompact", sessionId), "PostCompact"));
		const before = projectedUnitSnapshot(unit, fx);
		const terminalAt = core.readJson(unit.paths.state).terminal.at;
		core.compactExpiredUnits(fx.cwd, terminalAt + 25 * 60 * 60 * 1000);
		const receiptsDir = path.join(core.harnessRoot(fx.cwd), "receipts-v2");
		const receipts = fs.readdirSync(receiptsDir).map((name) => ({ mode: fs.statSync(path.join(receiptsDir, name)).mode & 0o777, value: core.readJson(path.join(receiptsDir, name)) }));
		const claimsRoot = path.join(core.harnessRoot(fx.cwd), "claims");
		const claims = fs.readdirSync(claimsRoot).sort().map((kind) => ({ kind, values: fs.readdirSync(path.join(claimsRoot, kind)).sort().map((name) => core.readJson(path.join(claimsRoot, kind, name))) }));
		snapshots.push(core.canonicalParityProjection({ nativeOutputs: nativeOutputs.map(nativePolicyOutput), before, receipts, claims }));
	}
	const difference = firstDifference(snapshots[0], snapshots[1]);
	assert.equal(difference, null, difference && JSON.stringify(difference));
});
