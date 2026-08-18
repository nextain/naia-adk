"use strict";
// Injected api carries no marker lookup; required directly so the repository-root
// no-harness marker also applies to sub-project working directories.
const harnessSwitch = require("./harness-switch.js");
module.exports = function createRequestContractModule(api) {
const {
	fs, path, CLASSIFICATIONS, REQUIRED_CLIENT_EVENTS, CONTROL_INPUT_NAMES, sha256, opaqueId, canonicalJson,
	readJson, requiredJson, optionalJson, readUnitState, writeUnitState, loadConfig, governed, controlInputPath,
	processIdentity, withUnitLock, withRepositoryLock, assertUnitMutable, findUnit, addSessionBinding, git, appendQuarantine,
	createGenesisUnlocked, adoptQuarantine, verifySourceChain, appendSource, contractDigest, verifyScopeHistory, planningSeal, captureWorkspaceOccurrences,
	evaluateCompletion, evaluatePreCompact, evaluatePostCompact,
} = api;
function safeShellWords(...args) { return api.safeShellWords(...args); }
function exactFlagMap(...args) { return api.exactFlagMap(...args); }
function trustedNodeWord(...args) { return api.trustedNodeWord(...args); }
function exactScriptWord(...args) { return api.exactScriptWord(...args); }
function governedControlCommand(...args) { return api.governedControlCommand(...args); }
function governedApplyPatchControlInput(...args) { return api.governedApplyPatchControlInput(...args); }
function governedControlInput(...args) { return api.governedControlInput(...args); }
function governedControlEvent(...args) { return api.governedControlEvent(...args); }
function configuredShellTools(...args) { return api.configuredShellTools(...args); }
function isShellTool(...args) { return api.isShellTool(...args); }
function mutationFromEvent(...args) { return api.mutationFromEvent(...args); }
function releaseCommandFromEvent(...args) { return api.releaseCommandFromEvent(...args); }
function mutationLeaseId(...args) { return api.mutationLeaseId(...args); }

function semanticVersion(value) {
	const match = String(value || "").match(/(\d+)\.(\d+)\.(\d+)/);
	return match ? match.slice(1).map(Number) : null;
}

function clientVersionSupported(actual, range) {
	const current = semanticVersion(actual);
	const minimum = semanticVersion(range);
	if (!current || !minimum) return false;
	for (let index = 0; index < 3; index++) {
		if (current[index] > minimum[index]) return true;
		if (current[index] < minimum[index]) return false;
	}
	return true;
}

const WINDOWS_ENCODED_PREFIX = "powershell -NoProfile -NonInteractive -EncodedCommand ";
const WINDOWS_QUIET_PREFIX = "$ProgressPreference='SilentlyContinue'; ";

function decodeWindowsHook(command) {
	if (typeof command !== "string" || !command.startsWith(WINDOWS_ENCODED_PREFIX)) return null;
	try { return Buffer.from(command.slice(WINDOWS_ENCODED_PREFIX.length), "base64").toString("utf16le"); }
	catch { return null; }
}

function clientRegistrySupports(cwd, client) {
	const config = loadConfig(cwd);
	const file = client === "claude" ? path.join(cwd, ".claude", "settings.json") : client === "codex" ? path.join(cwd, ".codex", "hooks.json") : null;
	if (!file) return false;
	const registry = readJson(file);
	if (!registry || !registry.hooks || typeof registry.hooks !== "object") return false;
	const adapterPath = client === "claude" ? ".claude/hooks/request-contract.js" : ".codex/hooks/request-contract.cjs";
	const shellMatchers = configuredShellTools(config);
	if (client === "codex") shellMatchers.push("exec_command", "(?:.*[.:/]exec_command)", "(?:.*[.:/]shell_command)");
	const preToolMatcher = [...new Set([...shellMatchers, "Edit", "Write", "NotebookEdit", "apply_patch"])].join("|");
	const seen = [];
	for (const [registeredEvent, entries] of Object.entries(registry.hooks)) {
		if (!Array.isArray(entries)) continue;
		for (const entry of entries) for (const hook of Array.isArray(entry.hooks) ? entry.hooks : []) {
			const registrationText = [hook.command, hook.commandWindows, decodeWindowsHook(hook.commandWindows), ...(Array.isArray(hook.args) ? hook.args : [])]
				.filter((value) => typeof value === "string");
			if (!registrationText.some((value) => value.includes(adapterPath))) continue;
			seen.push({ registeredEvent, entry, hook });
		}
	}
	if (seen.length !== REQUIRED_CLIENT_EVENTS.length) return false;
	return REQUIRED_CLIENT_EVENTS.every((eventName) => {
		const matches = seen.filter((candidate) => candidate.registeredEvent === eventName);
		if (matches.length !== 1) return false;
		const { entry, hook } = matches[0];
		if (hook.type !== "command") return false;
		if (client === "claude") {
			const expected = `node \"$CLAUDE_PROJECT_DIR/${adapterPath}\" ${eventName}`;
			if (hook.command !== expected || hook.commandWindows != null || hook.args != null) return false;
		} else {
			const rootResolution = 'root=${ADK_PROJECT_ROOT:-}; if [ -n "$root" ]; then case "$root" in /*) ;; *) exit 1;; esac; root=$(CDPATH= cd -- "$root" 2>/dev/null && pwd -P) || exit 1; else root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 1; fi; [ -f "$root/.codex/hooks.json" ] || exit 1;';
			const windowsRootResolution = '$root=$env:ADK_PROJECT_ROOT; if ($root) { if (-not [IO.Path]::IsPathRooted($root)) { exit 1 }; try { $root=(Resolve-Path -LiteralPath $root -ErrorAction Stop).Path } catch { exit 1 } } else { $root=git rev-parse --show-toplevel 2>$null; if ($LASTEXITCODE -ne 0 -or -not $root) { exit 1 }; $root=$root.Trim() }; if (-not (Test-Path -LiteralPath (Join-Path $root ".codex/hooks.json"))) { exit 1 };';
			const expected = `${rootResolution} registry=\"$root/.codex/hooks.json\"; [ ! -f \"$registry\" ] && exit 0; hook=\"$root/${adapterPath}\"; if [ ! -f \"$hook\" ]; then echo \"Configured Codex hook is missing: $hook\" >&2; exit 1; fi; node \"$hook\" ${eventName}`;
			const expectedWindows = `${WINDOWS_QUIET_PREFIX}${windowsRootResolution} $registry=Join-Path $root.Trim() \".codex/hooks.json\"; if (-not (Test-Path -LiteralPath $registry)) { exit 0 }; $hook=Join-Path $root.Trim() \"${adapterPath}\"; if (-not (Test-Path -LiteralPath $hook)) { Write-Error \"Configured Codex hook is missing: $hook\"; exit 1 }; node $hook ${eventName}`;
			const decodedWindows = decodeWindowsHook(hook.commandWindows);
			if (eventName === "Stop") {
				const resilientPosix = [
					"request-contract:stop_hook_unavailable",
					`hook="$root/${adapterPath}"`,
					'node "$hook" Stop || emit; exit 0',
				].every((required) => String(hook.command).includes(required));
				const resilientWindows = [
					"request-contract:stop_hook_unavailable",
					`Join-Path $root.Trim() "${adapterPath}"`,
					"node $hook Stop",
					"exit 0",
				].every((required) => String(decodedWindows).includes(required));
				if (!resilientPosix || !resilientWindows) return false;
			} else if (hook.command !== expected || decodedWindows !== expectedWindows) return false;
		}
		if (eventName === "PreToolUse") return entry.matcher === preToolMatcher;
		return entry.matcher == null || entry.matcher === "";
	});
}

function hostHarnessDisabled(cwd, client) {
	const hostConfigDir = client === "claude" ? ".claude" : client === "codex" ? ".codex" : null;
	return hostConfigDir !== null && harnessSwitch.findHarnessMarker({ cwd, configDirs: [hostConfigDir] }) !== null;
}

function assertSupportedClient(cwd, client, version) {
	const config = loadConfig(cwd);
	const range = config.supported_clients[client];
	if (!range || !clientVersionSupported(version, range)) throw Object.assign(new Error(`unsupported ${client} version`), { code: "request_contract_client_version_unsupported" });
	if (!clientRegistrySupports(cwd, client)) throw Object.assign(new Error(`${client} lacks required request-contract lifecycle events`), { code: "request_contract_client_capability_missing" });
	return true;
}

function handleEvent(event, opts = {}) {
	const cwd = event.cwd || process.cwd();
	const client = event.client || "unknown";
	const sessionId = event.sessionId;
	const now = opts.now || Date.now();
	if (hostHarnessDisabled(cwd, client)) return { kind: "allow", code: "request_contract_host_disabled" };
	const config = loadConfig(cwd);
	if (config.errors.length) return { kind: "block", code: "request_contract_config_invalid", message: "Request-contract configuration is missing or invalid.", errors: config.errors };
	if (!governed(cwd, opts.env || process.env)) return { kind: "allow", code: "request_contract_disabled" };
	if (!sessionId || sessionId === "no-session") {
		if (event.eventName === "UserPromptSubmit") {
			const quarantineId = `unbound-${opaqueId()}`;
			const q = appendQuarantine(cwd, client, quarantineId, event.prompt || "", now, event.origin);
			return { kind: "block", code: "host_session_identity_unavailable", message: `Prompt preserved in isolated quarantine (${q.quarantineId}); no shared no-session authority was created.` };
		}
		return { kind: "block", code: "host_session_identity_unavailable", message: "A native or host-local session identity is required." };
	}
	let unit = findUnit(cwd, client, sessionId);
	if (unit && unit.error) {
		if (event.eventName === "UserPromptSubmit") {
			const q = appendQuarantine(cwd, client, sessionId, event.prompt || "", now, event.origin);
			return { kind: "block", code: unit.error, message: `Prompt preserved in quarantine (${q.quarantineId}) because multiple runtime units claim this session.` };
		}
		return { kind: "block", code: unit.error, message: "Multiple runtime units claim this session." };
	}

	if (event.eventName === "SessionStart") {
		try {
			assertSupportedClient(cwd, client, event.clientVersion);
			if (unit) {
				const terminal = readUnitState(unit).terminal;
				if (terminal && terminal.status === "success") {
					const current = evaluateCompletion(unit, cwd, client, now, sessionId);
					if (current.kind !== "allow") return current;
					return { kind: "context", code: "request_contract_complete", message: "This request lineage is already complete; start a new session for a new request." };
				}
			}
			return withRepositoryLock(cwd, () => {
				unit = findUnit(cwd, client, sessionId);
				if (unit && unit.error) throw Object.assign(new Error("duplicate runtime binding"), { code: unit.error });
				if (!unit) {
					// A new session always starts a distinct lineage. Joining an existing
					// unit is an explicit operator action through addSessionBinding/CLI.
					unit = createGenesisUnlocked(cwd, client, sessionId, now, { adoptQuarantine: true, clientVersion: event.clientVersion, hostProcessId: event.hostProcessId || process.pid, hostProcessIdentity: event.hostProcessIdentity || processIdentity(event.hostProcessId || process.pid) });
				} else {
					unit = addSessionBinding(unit, client, sessionId, event.clientVersion, event.hostProcessId || process.pid, event.hostProcessIdentity || processIdentity(event.hostProcessId || process.pid));
					adoptQuarantine(unit, cwd, now);
				}
				return { kind: "context", code: "request_contract_genesis", message: `Governed request-contract session active (unit ${unit.id}). Every prompt and change must remain traceable.` };
			}, now);
		} catch (e) {
			return { kind: "block", code: e.code || "request_contract_genesis_failed", message: "Governed session cannot start until quarantined sources are resolved." };
		}
	}

	if (event.eventName === "UserPromptSubmit") {
		if (!unit) {
			const q = appendQuarantine(cwd, client, sessionId, event.prompt || "", now, event.origin);
			return { kind: "block", code: "request_contract_missing_genesis", message: `Prompt preserved in quarantine (${q.quarantineId}); start a governed session and import the complete chain.` };
		}
		try {
			const record = appendSource(unit, event.prompt || "", event.origin || "ambiguous", now);
			return { kind: "context", code: "request_contract_source_captured", message: `Captured ${record.source_id}. Bind and classify every source before completion.` };
		} catch (error) {
			const q = appendQuarantine(cwd, client, sessionId, event.prompt || "", now, event.origin);
			return { kind: "block", code: error.code || "request_contract_source_capture_failed", message: `Prompt preserved in quarantine (${q.quarantineId}) because the active lineage is not writable.` };
		}
	}

	if (!unit) {
		return { kind: "block", code: "request_contract_missing_genesis", message: "Governed session has no genesis/source chain; mutations and lifecycle continuation are denied." };
	}
	if (event.eventName === "PreToolUse") {
		if (releaseCommandFromEvent(event, config)) {
			return { kind: "block", code: "external_effect_gate_pending", message: "Publication is denied until the signed project external-effect adapter gate is implemented and provisioned." };
		}
		const pretoolContract = optionalJson(unit.paths.contract, null, "contract_state_corrupt");
		if ((config.preservation.required || pretoolContract && pretoolContract.preservation) && isShellTool(event, config)) {
			return { kind: "block", code: "external_effect_gate_pending", message: "Shell execution is denied for preservation work until the signed project external-effect adapter gate is implemented and provisioned." };
		}
		if (!mutationFromEvent(event, cwd, unit, config)) return { kind: "allow", code: governedControlEvent(event, cwd, unit) ? "request_contract_control_preflight" : "request_contract_pretool_read_only" };
		try {
			withUnitLock(unit, () => {
				assertUnitMutable(unit);
				const head = requiredJson(unit.paths.head, "unit_head_corrupt");
				const binding = optionalJson(unit.paths.binding, null, "binding_state_corrupt");
				const contract = optionalJson(unit.paths.contract, null, "contract_state_corrupt");
				if (!binding || binding.state !== "active" || !contract || binding.contract_id !== contract.id) throw Object.assign(new Error("mutation requires an active request-contract binding"), { code: "request_contract_unbound" });
				if (contractDigest(contract) !== head.contract_digest) throw Object.assign(new Error("bound contract digest differs from the active head"), { code: "request_contract_binding_stale" });
				const scopeHistory = verifyScopeHistory(unit);
				if (!scopeHistory.ok || !scopeHistory.records.length || scopeHistory.records.at(-1).contract_digest !== head.contract_digest) throw Object.assign(new Error("bound scope history is stale"), { code: "request_contract_binding_stale" });
				const sourceChain = verifySourceChain(unit.paths, head);
				if (!sourceChain.ok) throw Object.assign(new Error(sourceChain.errors.join(", ")), { code: "source_log_corrupt" });
				const classified = new Map((contract.sources || []).map((source) => [source.id, source]));
				if (classified.size !== sourceChain.records.length) throw Object.assign(new Error("classified source set differs from the source chain"), { code: "request_contract_source_unclassified" });
				for (const source of sourceChain.records) {
					const declaration = classified.get(source.source_id);
					if (!declaration || !CLASSIFICATIONS.has(declaration.classification)) throw Object.assign(new Error("every source must be classified before mutation"), { code: "request_contract_source_unclassified" });
				}
				if (config.preservation.required || contract.preservation) {
					const seal = planningSeal(unit, config, binding, head, contract);
					if (!seal.ok) throw Object.assign(new Error("implementation mutation requires a current planning×4 seal"), { code: "request_contract_planning_review_required", errors: seal.errors });
				}
				const state = readUnitState(unit, head);
				state.active_mutations = state.active_mutations || {};
				const leaseId = mutationLeaseId(event);
				const existingLease = state.active_mutations[leaseId];
				if (existingLease && (existingLease.client !== client || existingLease.session_id !== sessionId || existingLease.tool_name !== event.toolName)) throw Object.assign(new Error("mutation lease identifier conflicts with an in-flight tool"), { code: "request_contract_mutation_lease_conflict" });
				if (!existingLease) {
					state.active_mutations[leaseId] = { client, session_id: sessionId, tool_name: event.toolName, opened_at: now };
					head.work_revision += 1;
					writeUnitState(unit, state, head);
				}
			}, now);
			return { kind: "allow", code: "request_contract_mutation_preflight" };
		} catch (error) {
			return { kind: "block", code: error.code || "request_contract_mutation_denied", message: "Governed mutation denied before execution because the request lineage is not writable." };
		}
	}

	if (event.eventName === "PostToolUse") {
		if (!mutationFromEvent(event, cwd, unit, config)) return { kind: "allow", code: governedControlEvent(event, cwd, unit) ? "request_contract_control_complete" : "request_contract_posttool_read_only" };
		try {
			return withUnitLock(unit, () => {
				const state = readUnitState(unit);
				state.active_mutations = state.active_mutations || {};
				const leaseId = mutationLeaseId(event);
				const lease = state.active_mutations[leaseId];
				if (!lease || lease.client !== client || lease.session_id !== sessionId || lease.tool_name !== event.toolName) throw Object.assign(new Error("PostToolUse has no matching mutation lease"), { code: "request_contract_mutation_lease_missing" });
				if (state.terminal && state.terminal.status === "success") assertUnitMutable(unit);
				const before = state.occurrences.length;
				const captured = captureWorkspaceOccurrences(unit, cwd, { allowTerminalIncompleteLease: leaseId });
				const nextHead = requiredJson(unit.paths.head, "unit_head_corrupt");
				const nextState = readUnitState(unit, nextHead);
				delete nextState.active_mutations[leaseId];
				writeUnitState(unit, nextState, nextHead);
				const added = captured.occurrences.slice(before);
				return added.length ? { kind: "context", code: "request_contract_change_captured", message: `Captured ${added.length} workspace change occurrence(s); map each to directive, implementation, and evidence.` } : { kind: "allow", code: "request_contract_change_known" };
			}, now);
		} catch (error) {
			return { kind: "block", code: error.code || "request_contract_mutation_lease_failed", message: "Governed mutation completion could not be matched to an active pre-execution lease." };
		}
	}

	if (event.eventName === "PreCompact") return evaluatePreCompact(unit, cwd, client, now, sessionId);
	if (event.eventName === "PostCompact") return evaluatePostCompact(unit, cwd, client, now, sessionId);
	if (event.eventName === "SessionStart") return { kind: "context", code: "request_contract_resume", message: "Reload the bound request contract, complete source history, and current evidence before continuing." };
	if (event.eventName === "Stop") return evaluateCompletion(unit, cwd, client, now, sessionId);
	return { kind: "allow", code: "request_contract_event_ignored" };
}

function canonicalParityProjection(value) {
	function project(v, key = "") {
		if (Array.isArray(v)) return v.map((x) => project(x, key));
		if (v && typeof v === "object") {
			const out = {};
			const cryptographicFields = [];
			for (const k of Object.keys(v).sort()) {
				if (k === "client_versions") out[k] = { "<client>": "<version>" };
				else if (["client", "session_id", "sessionId", "event_id", "ts", "at"].includes(k) || /(_at|_time)$/.test(k)) out[k] = `<${k}>`;
				else if (/(^|_)(hash|digest|head|signature|fingerprint)$/.test(k)) cryptographicFields.push(k);
				else out[k] = project(v[k], k);
			}
			for (const cryptoField of cryptographicFields) {
				if (cryptoField.endsWith("signature")) out[cryptoField] = "<verified-signature>";
				else if (cryptoField.endsWith("fingerprint")) out[cryptoField] = "<verified-fingerprint>";
				else out[cryptoField] = `recomputed:${sha256(canonicalJson({ field: cryptoField, dependencies: out }))}`;
			}
			return out;
		}
		if (["unit_id", "run_id", "receipt_id", "execution_id"].includes(key) || /_session_ids?$/.test(key) || /(^|_)process_(id|ids|identity|identities)$/.test(key) || /^host_process_(ids|identities)$/.test(key)) return `<${key}>`;
		if (key === "private_bundle_path") return "<private-bundle-path>";
		if (typeof v === "string") {
			if (["scopeVersionMappings", "covered_scope_version_mappings"].includes(key)) {
				try {
					return canonicalJson(project(JSON.parse(v)));
				} catch {
					return "<invalid-scope-version-mapping>";
				}
			}
			return v
				.replace(/\b(SRC|CHG|EP|TERM|RCPT|OBL)-[a-f0-9]{32}\b/gi, (_m, prefix) => `<opaque-${prefix.toLowerCase()}>`)
				.replace(/\b[a-f0-9]{64}\b/g, "<opaque-digest>")
				.replace(/\b[a-f0-9]{32}\b/g, "<opaque-id>");
		}
		return v;
	}
	return project(value);
}

	return {
		semanticVersion,
		clientVersionSupported,
		clientRegistrySupports,
		assertSupportedClient,
		handleEvent,
		canonicalParityProjection,
	};
};
