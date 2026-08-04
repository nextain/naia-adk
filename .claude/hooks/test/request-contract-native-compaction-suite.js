"use strict";

/** Request-contract tests: native client parity and retention compaction. */

const {
	test,
	assert,
	cp,
	fs,
	os,
	path,
	core,
	adapter,
	CLIENT_VERSIONS,
	fixture,
	start,
	makeContract,
	bind,
	cleanReview,
	ingestReview,
	runNativeAdapter,
	nativeEnvelope,
} = require("./request-contract-test-helpers.js");

test("adapter parity is policy-equivalent for Claude Code and Codex", () => {
	const results = [];
	for (const client of ["claude", "codex"]) {
		const fx = fixture();
		const input = nativeEnvelope(client, fx, "UserPromptSubmit", "P", { prompt: "same" });
		const processed = adapter.processEnvelope(client, input);
		results.push({ result: core.canonicalParityProjection(processed.result), quarantine: core.canonicalParityProjection(core.readJsonl(path.join(core.listUnconsumedQuarantine(fx.cwd)[0].dir, "sources.jsonl"))) });
	}
	assert.deepEqual(results[0], results[1]);
});
test("client-native capability maps reject undeclared aliases and map native outputs explicitly", () => {
	assert.notStrictEqual(adapter.CLIENT_NATIVE_CAPABILITIES.claude, adapter.CLIENT_NATIVE_CAPABILITIES.codex);
	for (const client of ["claude", "codex"]) {
		const fx = fixture();
		const prompt = adapter.processEnvelope(client, nativeEnvelope(client, fx, "UserPromptSubmit", "NATIVE", { prompt: "native exact prompt" }), "UserPromptSubmit", { env: { REQUEST_CONTRACT: "on" } });
		assert.equal(prompt.event.prompt, "native exact prompt");
		assert.equal(prompt.event.origin, "native_user");
		assert.equal(prompt.output.decision, "block");
		const callerSpoof = adapter.normalizeInput(client, nativeEnvelope(client, fx, "PostToolUse", "NATIVE", { origin: "native_user", tool_name: "Read", tool_use_id: "spoof" }), "PostToolUse");
		assert.equal(callerSpoof.origin, "ambiguous");
		const context = adapter.formatOutput(client, "SessionStart", { kind: "context", code: "CTX", message: "mapped" });
		assert.deepEqual(context, { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "[request-contract:CTX] mapped" } });
		const block = adapter.formatOutput(client, "PreToolUse", { kind: "block", code: "DENY", message: "mapped" });
		assert.deepEqual(block, { decision: "block", reason: "[request-contract:DENY] mapped" });
		const aliasOnly = nativeEnvelope(client, fx, "UserPromptSubmit", "NATIVE");
		aliasOnly.user_prompt = "unsupported alias";
		const rejected = adapter.processEnvelope(client, aliasOnly, "UserPromptSubmit", { env: { REQUEST_CONTRACT: "on" } });
		assert.equal(rejected.result.code, "native_prompt_missing");
	}
	assert.deepEqual(
		adapter.formatOutput("codex", "PreCompact", { kind: "block", code: "DENY", message: "mapped" }),
		{ continue: false, stopReason: "[request-contract:DENY] mapped" },
	);
	assert.deepEqual(
		adapter.formatOutput("codex", "PostCompact", { kind: "context", code: "CTX", message: "mapped" }),
		{ systemMessage: "[request-contract:CTX] mapped" },
	);
	assert.deepEqual(
		adapter.formatOutput("codex", "SessionStart", { kind: "block", code: "DENY", message: "mapped" }),
		{ continue: false, stopReason: "[request-contract:DENY] mapped" },
	);
	assert.deepEqual(
		adapter.failureOutput("codex", "PreCompact", { code: "adapter_failure" }),
		{ continue: false, stopReason: "[request-contract:adapter_failure] Governed request-contract evaluation failed closed during PreCompact." },
	);
	assert.equal(adapter.formatOutput("codex", "Stop", { kind: "allow", code: "DONE", message: "complete" }), null);
});

test("scope authority rejects a source without native user-event provenance", () => {
	const fx = fixture();
	const unit = start(fx);
	const contract = makeContract(fx, unit);
	const records = core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records.map((record) => ({ ...record }));
	records[0].origin = "user";
	const result = core.validateContract(contract, records, core.readJson(unit.paths.state).occurrences, { publicKeyPem: fx.publicKeyPem, cwd: fx.cwd });
	assert(result.errors.includes("contract_authority_source_origin_invalid:AUTH-001"));
});

test("registered lifecycle event cannot be reclassified by the native envelope", () => {
	const fx = fixture();
	const input = { hook_event_name: "PostToolUse", session_id: "S1", cwd: fx.cwd, tool_name: "Read", prompt: "must be captured" };
	for (const client of ["claude", "codex"]) {
		const result = adapter.processEnvelope(client, input, "UserPromptSubmit");
		assert.equal(result.output.decision, "block");
		assert(result.output.reason.includes("native_event_mismatch"));
	}
	const captured = core.listUnconsumedQuarantine(fx.cwd).flatMap((item) => core.readJsonl(path.join(item.dir, "sources.jsonl"))).map((record) => record.prompt);
	assert.deepEqual(captured, ["must be captured", "must be captured"]);
});

test("native Claude Code and Codex processes discover the same nested project root", () => {
	const fx = fixture();
	const nested = path.join(fx.cwd, "src", "nested");
	fs.mkdirSync(nested, { recursive: true });
	for (const [client, sessionId] of [["claude", "NATIVE-C"], ["codex", "NATIVE-X"]]) {
		const output = runNativeAdapter(client, fx, { hook_event_name: "SessionStart", session_id: sessionId, cwd: nested }, "SessionStart");
		assert(output.hookSpecificOutput.additionalContext.includes("request_contract_genesis"));
	}
	const claudeUnit = core.findUnit(fx.cwd, "claude", "NATIVE-C");
	const codexUnit = core.findUnit(fx.cwd, "codex", "NATIVE-X");
	assert.notEqual(claudeUnit.id, codexUnit.id);
	for (const unit of [claudeUnit, codexUnit]) {
		assert.equal(unit.head.session_bindings.length, 1);
		for (const binding of unit.head.session_bindings) {
			assert(binding.host_process_ids.includes(process.pid));
			assert(binding.host_process_identities.includes(core.processIdentity(process.pid)));
		}
	}
	for (const [client, sessionId] of [["claude", "NATIVE-C"], ["codex", "NATIVE-X"]]) {
		const output = runNativeAdapter(client, fx, { hook_event_name: "Stop", session_id: sessionId, cwd: nested }, "Stop");
		assert.equal(output.decision, "block");
	}
});

test("malformed native stdin fails closed for both clients when governed", () => {
	for (const client of ["claude", "codex"]) {
		const fx = fixture();
		const output = runNativeAdapter(client, fx, "{not-json", "Stop");
		assert.equal(output.decision, "block");
		assert(output.reason.includes("native_envelope_parse_error"));
	}
});

test("native PreCompact blocks incomplete work before compaction for both clients", () => {
	for (const client of ["claude", "codex"]) {
		const fx = fixture();
		const sessionId = `PRECOMPACT-${client}`;
		runNativeAdapter(client, fx, nativeEnvelope(client, fx, "SessionStart", sessionId), "SessionStart");
		runNativeAdapter(client, fx, nativeEnvelope(client, fx, "UserPromptSubmit", sessionId, { prompt: "Implement the complete requested feature" }), "UserPromptSubmit");
		const pre = runNativeAdapter(client, fx, nativeEnvelope(client, fx, "PreCompact", sessionId), "PreCompact");
		if (client === "codex") {
			assert.equal(pre.continue, false);
			assert(pre.stopReason.includes("request_contract_blocked"));
		} else {
			assert.equal(pre.decision, "block");
			assert(pre.reason.includes("request_contract_blocked"));
		}
		const unit = core.findUnit(fx.cwd, client, sessionId);
		assert.equal(core.readJson(unit.paths.state).stop, undefined);
		assert.equal(core.readJson(unit.paths.state).terminal, undefined);
		const post = runNativeAdapter(client, fx, nativeEnvelope(client, fx, "PostCompact", sessionId), "PostCompact");
		if (client === "codex") {
			assert.equal(post.continue, false);
			assert(post.stopReason.includes("request_contract_postcompact_without_proof"));
		} else {
			assert.equal(post.decision, "block");
			assert(post.reason.includes("request_contract_postcompact_without_proof"));
		}
	}
});

test("PreCompact failures never consume Stop attempts", () => {
	const fx = fixture();
	const unit = start(fx);
	for (let attempt = 0; attempt < 3; attempt++) {
		const result = core.handleEvent({ client: "claude", eventName: "PreCompact", sessionId: "S1", cwd: fx.cwd });
		assert.equal(result.kind, "block");
	}
	let state = core.readJson(unit.paths.state);
	assert.equal(state.stop, undefined);
	assert.equal(state.terminal, undefined);
	assert.equal(core.handleEvent({ client: "claude", eventName: "Stop", sessionId: "S1", cwd: fx.cwd }).kind, "block");
	state = core.readJson(unit.paths.state);
	assert.equal(state.stop.attempt, 1);
	assert.equal(state.terminal, undefined);
});

test("PostCompact requires and consumes one matching PreCompact authorization", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	for (const id of ["COMPACT-R1", "COMPACT-R2"]) ingestReview(fx, unit, cleanReview(fx, unit, id));
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude", Date.now(), "S1").kind, "allow");
	let result = core.handleEvent({ client: "claude", eventName: "PostCompact", sessionId: "S1", cwd: fx.cwd });
	assert.equal(result.code, "request_contract_postcompact_without_proof");
	result = core.handleEvent({ client: "claude", eventName: "PreCompact", sessionId: "S1", cwd: fx.cwd });
	assert.equal(result.code, "request_contract_compaction_ready");
	const authorization = core.readJson(unit.paths.state).compaction_authorization;
	assert.equal(authorization.client, "claude");
	assert.equal(authorization.session_id, "S1");
	assert.equal(authorization.consumed_at, null);
	result = core.handleEvent({ client: "claude", eventName: "PostCompact", sessionId: "S1", cwd: fx.cwd });
	assert.equal(result.code, "request_contract_resume");
	assert(Number.isInteger(core.readJson(unit.paths.state).compaction_authorization.consumed_at));
	result = core.handleEvent({ client: "claude", eventName: "PostCompact", sessionId: "S1", cwd: fx.cwd });
	assert.equal(result.code, "request_contract_postcompact_without_proof");
});

test("successful native Codex Stop intentionally emits empty stdout", () => {
	const fx = fixture();
	const sessionId = "CODEX-EMPTY-SUCCESS";
	const unit = start(fx, "codex", sessionId);
	bind(fx, unit);
	for (const id of ["CODEX-R1", "CODEX-R2"]) ingestReview(fx, unit, cleanReview(fx, unit, id));
	assert.equal(runNativeAdapter("codex", fx, nativeEnvelope("codex", fx, "Stop", sessionId), "Stop"), null);
});

test("native PreCompact creates or revalidates a current completion proof", () => {
	const fx = fixture();
	const sessionId = "PRECOMPACT-COMPLETE";
	const unit = start(fx, "claude", sessionId);
	bind(fx, unit);
	for (const id of ["PRECOMPACT-R1", "PRECOMPACT-R2"]) ingestReview(fx, unit, cleanReview(fx, unit, id));
	let result = adapter.processEnvelope("claude", nativeEnvelope("claude", fx, "PreCompact", sessionId), "PreCompact");
	assert.equal(result.output, null);
	assert.equal(core.readJson(unit.paths.state).terminal.status, "success");
	result = adapter.processEnvelope("claude", nativeEnvelope("claude", fx, "PostCompact", sessionId), "PostCompact");
	assert(result.output.hookSpecificOutput.additionalContext.includes("request_contract_resume"));
	result = adapter.processEnvelope("claude", nativeEnvelope("claude", fx, "PostCompact", sessionId), "PostCompact");
	assert.equal(result.output.decision, "block");
	assert(result.output.reason.includes("request_contract_postcompact_without_proof"));
	fs.writeFileSync(path.join(fx.cwd, "src", "product.txt"), "out-of-band mutation after success\n");
	result = adapter.processEnvelope("claude", nativeEnvelope("claude", fx, "Stop", sessionId), "Stop");
	assert.equal(result.output.decision, "block");
	assert(result.output.reason.includes("request_contract_completion_proof_invalid"));
	result = adapter.processEnvelope("claude", nativeEnvelope("claude", fx, "SessionStart", sessionId), "SessionStart");
	assert.equal(result.output.decision, "block");
	assert(result.output.reason.includes("request_contract_completion_proof_invalid"));
	result = adapter.processEnvelope("claude", nativeEnvelope("claude", fx, "PreCompact", sessionId), "PreCompact");
	assert.equal(result.output.decision, "block");
	assert(result.output.reason.includes("request_contract_completion_proof_invalid"));
});

test("argv fallback cannot replace a missing native event field for either client", () => {
	for (const client of ["claude", "codex"]) {
		const fx = fixture();
		const output = runNativeAdapter(client, fx, { session_id: `MISSING-${client}`, cwd: fx.cwd }, "Stop");
		assert.equal(output.decision, "block");
		assert(output.reason.includes("native_event_missing"));
	}
});

test("both client registries cover all governed lifecycle events", () => {
	const root = path.resolve(__dirname, "..", "..", "..");
	const claude = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"));
	const codex = JSON.parse(fs.readFileSync(path.join(root, ".codex", "hooks.json"), "utf8"));
	for (const event of ["PreToolUse", "SessionStart", "UserPromptSubmit", "PostToolUse", "PreCompact", "PostCompact", "Stop"]) {
		for (const [client, registry] of [["claude", claude], ["codex", codex]]) {
			assert(registry.hooks[event]);
			const hooks = registry.hooks[event].flatMap((entry) => entry.hooks).filter((hook) => hook.command.includes("request-contract") || (hook.args || []).some((arg) => arg.includes("request-contract")));
			assert.equal(hooks.length, 1);
			const registeredEvent = Array.isArray(hooks[0].args) ? hooks[0].args.at(-1) : hooks[0].command.split(/\s+/).at(-1);
			assert.equal(registeredEvent, event);
			if (client === "claude") assert(hooks[0].command.includes("$CLAUDE_PROJECT_DIR/"));
			else assert(hooks[0].command.includes("git rev-parse --show-toplevel"));
		}
	}
});

test("Claude command hooks quote project roots that contain spaces", () => {
	const root = path.resolve(__dirname, "..", "..", "..");
	const settings = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"));
	const commandHooks = Object.values(settings.hooks).flatMap((entries) => entries.flatMap((entry) => entry.hooks)).filter((hook) => typeof hook.command === "string" && hook.command.includes("$CLAUDE_PROJECT_DIR/"));
	assert(commandHooks.length > 0);
	for (const hook of commandHooks) assert.match(hook.command, /^node "\$CLAUDE_PROJECT_DIR\/.+"(?:\s+.*)?$/);

	const spacedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "request contract spaced root "));
	try {
		const hooksDir = path.join(spacedRoot, ".claude", "hooks");
		fs.mkdirSync(hooksDir, { recursive: true });
		fs.writeFileSync(path.join(hooksDir, "space-probe.js"), "process.stdout.write('space-path-ok')\n");
		const template = commandHooks.find((hook) => hook.command.includes("pr-guard.js")).command.replace("/.claude/hooks/pr-guard.js", "/.claude/hooks/space-probe.js");
		const command = template.replace("$CLAUDE_PROJECT_DIR", spacedRoot.replace(/\\/g, "/"));
		const result = cp.spawnSync(command, { shell: true, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, "space-path-ok");
	} finally {
		fs.rmSync(spacedRoot, { recursive: true, force: true });
	}
});

test("governed adapter fails closed when source state is corrupted", () => {
	const fx = fixture();
	const unit = start(fx);
	fs.writeFileSync(unit.paths.head, "not json");
	const result = adapter.processEnvelope("claude", { hook_event_name: "UserPromptSubmit", session_id: "S1", cwd: fx.cwd, prompt: "still capture" });
	assert.equal(result.output.decision, "block");
});

test("a corrupt unresolved head blocks every new session lineage", () => {
	const fx = fixture();
	const unit = start(fx, "claude", "OLD", "original scope");
	fs.writeFileSync(unit.paths.head, "not json");
	const result = core.handleEvent({ client: "codex", clientVersion: CLIENT_VERSIONS.codex, eventName: "SessionStart", sessionId: "NEW", cwd: fx.cwd });
	assert.equal(result.code, "corrupt_unresolved_unit");
	assert.equal(core.listUnits(fx.cwd).length, 1);
});

test("corrupt unit state fails closed without losing the submitted prompt", () => {
	const fx = fixture();
	const unit = start(fx);
	const originalState = fs.readFileSync(unit.paths.state, "utf8");
	fs.writeFileSync(unit.paths.state, "not json");
	const result = adapter.processEnvelope("claude", { hook_event_name: "UserPromptSubmit", session_id: "S1", cwd: fx.cwd, prompt: "preserve during corruption" });
	assert.equal(result.output.decision, "block");
	const quarantine = core.listUnconsumedQuarantine(fx.cwd);
	assert.equal(core.readJsonl(path.join(quarantine[0].dir, "sources.jsonl"))[0].prompt, "preserve during corruption");
	fs.writeFileSync(unit.paths.state, originalState);
	assert.equal(core.handleEvent({ client: "claude", clientVersion: CLIENT_VERSIONS.claude, eventName: "SessionStart", sessionId: "S1", cwd: fx.cwd }).kind, "context");
	const prompts = core.verifySourceChain(unit.paths, core.readJson(unit.paths.head)).records.map((record) => record.prompt);
	assert(prompts.includes("preserve during corruption"));
});

test("single-file lifecycle rewrites cannot erase occurrences or reset Stop attempts", () => {
	const fx = fixture();
	const unit = start(fx);
	fs.writeFileSync(path.join(fx.cwd, "src", "product.txt"), "captured before tamper\n");
	core.captureWorkspaceOccurrences(unit, fx.cwd);
	bind(fx, unit);
	core.evaluateCompletion(unit, fx.cwd, "claude");
	const state = core.readJson(unit.paths.state);
	assert(state.occurrences.length > 0);
	state.occurrences = [];
	state.stop.attempt = 0;
	core.secureJson(unit.paths.state, state);
	assert.throws(() => core.evaluateCompletion(unit, fx.cwd, "claude"), (error) => error.code === "unit_state_digest_mismatch");
});

test("baseline manifest is independently self-digested inside protected lifecycle state", () => {
	const fx = fixture();
	const unit = start(fx);
	const state = core.readJson(unit.paths.state);
	const head = core.readJson(unit.paths.head);
	state.baseline.head = "forged-baseline";
	head.state_digest = core.sha256(core.canonicalJson(state));
	core.secureJson(unit.paths.state, state);
	core.secureJson(unit.paths.head, head);
	assert.throws(() => core.readUnitState(unit), (error) => error.code === "unit_baseline_digest_mismatch");
});

test("successful units compact to non-sensitive receipts after retention", () => {
	const fx = fixture();
	core.handleEvent({ client: "claude", eventName: "UserPromptSubmit", sessionId: "S1", cwd: fx.cwd, prompt: "quarantined private source", origin: "native_user" });
	core.handleEvent({ client: "claude", clientVersion: CLIENT_VERSIONS.claude, eventName: "SessionStart", sessionId: "S1", cwd: fx.cwd });
	const unit = core.findUnit(fx.cwd, "claude", "S1");
	const consumedQuarantineDir = path.join(core.harnessRoot(fx.cwd), "quarantine");
	bind(fx, unit);
	ingestReview(fx, unit, cleanReview(fx, unit, "COMPACT-R1"));
	ingestReview(fx, unit, cleanReview(fx, unit, "COMPACT-R2"));
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "allow");
	const terminalId = core.readJson(unit.paths.state).terminal.id;
	const compacted = core.compactExpiredUnits(fx.cwd, Date.now() + 200 * 60 * 60 * 1000);
	assert.equal(compacted.length, 1);
	assert(!fs.existsSync(unit.paths.unit));
	assert.equal(fs.existsSync(consumedQuarantineDir) ? fs.readdirSync(consumedQuarantineDir).length : 0, 0);
	assert.deepEqual(Object.keys(compacted[0]), ["receipt_id"]);
	const receiptPath = path.join(core.harnessRoot(fx.cwd), "receipts-v2", `${compacted[0].receipt_id}.json`);
	const receipt = core.readJson(receiptPath);
	assert.equal(receipt.status, "success");
	assert.match(receipt.receipt_id, /^RCPT-[a-f0-9]{32}$/);
	assert.notEqual(receipt.receipt_id, `RCPT-${core.sha256(`${unit.id}:${terminalId}`).slice(0, 32)}`);
	assert.deepEqual(Object.keys(receipt).sort(), ["change_count", "compacted_at", "receipt_id", "review_count", "source_count", "started_at", "status", "terminal_at", "version"]);
});

test("a fabricated success terminal without completion reviews cannot compact", () => {
	const fx = fixture();
	const unit = start(fx);
	const state = core.readJson(unit.paths.state);
	state.terminal = { id: "TERM-FORGED", status: "success", at: Date.now() - 200 * 60 * 60 * 1000 };
	core.writeUnitState(unit, state);
	assert.throws(() => core.compactExpiredUnits(fx.cwd, Date.now()), (error) => error.code === "completion_proof_invalid");
	assert(fs.existsSync(unit.paths.unit));
});

test("retention compaction rejects a stale successful workspace or config", () => {
	for (const mutate of [
		(fx) => fs.writeFileSync(path.join(fx.cwd, "src", "product.txt"), "changed after successful completion\n"),
		(fx) => {
			const file = path.join(fx.cwd, ".agents", "context", "request-contract.json");
			const config = JSON.parse(fs.readFileSync(file, "utf8"));
			config.retention.success_hours += 1;
			fs.writeFileSync(file, JSON.stringify(config));
		},
	]) {
		const fx = fixture();
		const unit = start(fx);
		bind(fx, unit);
		for (const id of ["STALE-COMPACT-R1", "STALE-COMPACT-R2"]) ingestReview(fx, unit, cleanReview(fx, unit, id));
		assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "allow");
		const terminalAt = core.readJson(unit.paths.state).terminal.at;
		mutate(fx);
		assert.throws(() => core.compactExpiredUnits(fx.cwd, terminalAt + 200 * 60 * 60 * 1000), (error) => error.code === "completion_proof_invalid");
		assert(fs.existsSync(unit.paths.unit));
	}
});

test("retention compaction revalidates immediately before removing a successful unit", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	for (const id of ["COMPACT-RACE-R1", "COMPACT-RACE-R2"]) ingestReview(fx, unit, cleanReview(fx, unit, id));
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "allow");
	const terminalAt = core.readJson(unit.paths.state).terminal.at;
	assert.throws(
		() => core.compactExpiredUnits(fx.cwd, terminalAt + 200 * 60 * 60 * 1000, {
			afterReceiptWritten: () => fs.writeFileSync(path.join(fx.cwd, "src", "product.txt"), "drift during compaction\n"),
		}),
		(error) => error.code === "completion_proof_invalid",
	);
	assert(fs.existsSync(unit.paths.unit));
});

test("failed final compaction validation preserves consumed quarantine evidence", () => {
	const fx = fixture();
	core.handleEvent({ client: "claude", eventName: "UserPromptSubmit", sessionId: "S1", cwd: fx.cwd, prompt: "quarantined source evidence", origin: "native_user" });
	core.handleEvent({ client: "claude", clientVersion: CLIENT_VERSIONS.claude, eventName: "SessionStart", sessionId: "S1", cwd: fx.cwd });
	core.handleEvent({ client: "claude", eventName: "UserPromptSubmit", sessionId: "S1", cwd: fx.cwd, prompt: "complete the adopted request", origin: "native_user" });
	const unit = core.findUnit(fx.cwd, "claude", "S1");
	bind(fx, unit);
	for (const id of ["QUARANTINE-COMPACT-R1", "QUARANTINE-COMPACT-R2"]) ingestReview(fx, unit, cleanReview(fx, unit, id));
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "allow");
	const quarantineDirs = fs.readdirSync(path.join(core.harnessRoot(fx.cwd), "quarantine"));
	assert.equal(quarantineDirs.length, 1);
	const terminalAt = core.readJson(unit.paths.state).terminal.at;
	assert.throws(
		() => core.compactExpiredUnits(fx.cwd, terminalAt + 200 * 60 * 60 * 1000, { afterReceiptWritten: () => fs.writeFileSync(path.join(fx.cwd, "src", "product.txt"), "late drift\n") }),
		(error) => error.code === "completion_proof_invalid",
	);
	assert(fs.existsSync(unit.paths.unit));
	assert(fs.existsSync(path.join(core.harnessRoot(fx.cwd), "quarantine", quarantineDirs[0])));
});

test("receipt-journaled unit staging finishes private cleanup after a crash", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	for (const id of ["STAGED-COMPACT-R1", "STAGED-COMPACT-R2"]) ingestReview(fx, unit, cleanReview(fx, unit, id));
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "allow");
	const terminalAt = core.readJson(unit.paths.state).terminal.at;
	let staged;
	assert.throws(
		() => core.compactExpiredUnits(fx.cwd, terminalAt + 200 * 60 * 60 * 1000, { afterUnitStaged: (value) => { staged = value; throw new Error("simulated staged cleanup crash"); } }),
		/simulated staged cleanup crash/,
	);
	assert(staged && fs.existsSync(staged.stagedUnit));
	assert.equal(core.hasStickyGovernanceState(fx.cwd), true);
	assert.deepEqual(core.compactExpiredUnits(fx.cwd, terminalAt + 200 * 60 * 60 * 1000 + 1), []);
	assert(!fs.existsSync(staged.stagedUnit));
	assert(fs.existsSync(staged.receipt));
});

test("staged compaction recovery revalidates the complete private proof", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	for (const id of ["STAGED-PROOF-R1", "STAGED-PROOF-R2"]) ingestReview(fx, unit, cleanReview(fx, unit, id));
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "allow");
	const terminalAt = core.readJson(unit.paths.state).terminal.at;
	let staged;
	assert.throws(
		() => core.compactExpiredUnits(fx.cwd, terminalAt + 200 * 60 * 60 * 1000, { afterUnitStaged: (value) => { staged = value; throw new Error("simulated proof recovery crash"); } }),
		/simulated proof recovery crash/,
	);
	fs.appendFileSync(path.join(staged.stagedUnit, "sources.jsonl"), "{}\n");
	assert.throws(
		() => core.compactExpiredUnits(fx.cwd, terminalAt + 200 * 60 * 60 * 1000 + 1),
		(error) => error.code === "completion_proof_invalid",
	);
	assert(fs.existsSync(staged.stagedUnit));
	assert(fs.existsSync(staged.receipt));
});

test("incomplete units never compact and remain governed until signed resume", () => {
	const fx = fixture();
	const unit = start(fx);
	const old = Date.now() - 10_000 * 60 * 60 * 1000;
	const state = core.readJson(unit.paths.state);
	state.terminal = { id: "TERM-INCOMPLETE-PRESERVED", status: "incomplete", at: old, error_codes: ["test"] };
	core.writeUnitState(unit, state);
	assert.deepEqual(core.compactExpiredUnits(fx.cwd, Date.now()), []);
	assert(fs.existsSync(unit.paths.unit));
	assert.equal(core.governed(fx.cwd, { REQUEST_CONTRACT: "off" }), true);
	assert.equal(fs.existsSync(path.join(core.harnessRoot(fx.cwd), "receipts-v2")), false);
});

test("random compaction receipt identity survives a crash and retry", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	ingestReview(fx, unit, cleanReview(fx, unit, "RETRY-R1"));
	ingestReview(fx, unit, cleanReview(fx, unit, "RETRY-R2"));
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "allow");
	const retentionTime = Date.now() + 200 * 60 * 60 * 1000;
	let prepared;
	assert.throws(() => core.compactExpiredUnits(fx.cwd, retentionTime, { afterReceiptWritten: (value) => { prepared = value; throw new Error("simulated compaction crash"); } }), /simulated compaction crash/);
	assert(fs.existsSync(unit.paths.unit));
	assert(fs.existsSync(prepared.receipt));
	const first = core.readJson(prepared.receipt);
	const compacted = core.compactExpiredUnits(fx.cwd, retentionTime + 1_000);
	assert.equal(compacted.length, 1);
	assert.deepEqual(compacted[0], { receipt_id: prepared.receiptId });
	assert.deepEqual(core.readJson(prepared.receipt), first);
});
