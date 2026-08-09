/**
 * Thin host adapters for request-contract integrity.
 *
 * Claude Code and Codex envelopes are normalized here, while all policy and
 * persistence remain in request-contract.js. Keep client-specific behavior in
 * normalizeInput/formatOutput only.
 */

const core = require("./request-contract.js");
const contracts = require("./session-contract.js");
const cp = require("child_process");
const path = require("path");
const VALID_EVENTS = new Set(["PreToolUse", "SessionStart", "UserPromptSubmit", "PostToolUse", "PreCompact", "PostCompact", "Stop"]);
const CLIENT_NATIVE_CAPABILITIES = Object.freeze({
	claude: Object.freeze({
		eventField: "hook_event_name",
		sessionField: "session_id",
		cwdField: "cwd",
		promptField: "prompt",
		toolNameField: "tool_name",
		toolUseIdField: "tool_use_id",
		toolInputField: "tool_input",
		toolResponseField: "tool_response",
		contextEnvelope: "hookSpecificOutput",
		blockEnvelope: "decision",
	}),
	codex: Object.freeze({
		eventField: "hook_event_name",
		sessionField: "session_id",
		cwdField: "cwd",
		promptField: "prompt",
		toolNameField: "tool_name",
		toolUseIdField: "tool_use_id",
		toolInputField: "tool_input",
		toolResponseField: "tool_response",
		contextEnvelope: "hookSpecificOutput",
		blockEnvelope: "decision",
	}),
});

function projectRoot(cwd) {
	const candidate = path.resolve(cwd || process.cwd());
	try {
		const root = cp.execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: candidate, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		return root ? path.resolve(root) : candidate;
	} catch {
		return candidate;
	}
}

function detectClientVersion(client, data, env = process.env) {
	const declared = data.client_version || data.clientVersion || env[client === "claude" ? "CLAUDE_CODE_VERSION" : "CODEX_VERSION"];
	if (declared) return String(declared);
	try {
		return cp.execFileSync(client === "claude" ? "claude" : "codex", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
	} catch {
		return "";
	}
}

function normalizeInput(client, input, fallbackEvent, opts = {}) {
	const data = input && typeof input === "object" ? input : {};
	const capability = CLIENT_NATIVE_CAPABILITIES[client];
	if (!capability) return { client, eventName: "Unknown", declaredEvent: "", sessionId: "no-session", cwd: projectRoot(process.cwd()), prompt: "", origin: "ambiguous", toolName: "", toolUseId: "", toolInput: {}, toolResponse: null };
	const declaredEvent = data[capability.eventField] || "";
	const eventName = fallbackEvent || declaredEvent || "Unknown";
	const inputCwd = data[capability.cwdField] || process.cwd();
	const cwd = client === "codex"
		? contracts.resolveHookProjectRoot(inputCwd, opts.env || process.env) || projectRoot(inputCwd)
		: projectRoot(inputCwd);
	// Provenance is derived from the registered/native lifecycle event. Never
	// trust an origin label supplied inside the hook payload.
	const origin = declaredEvent === "UserPromptSubmit" && eventName === "UserPromptSubmit" ? "native_user" : "ambiguous";
	return {
		client,
		clientVersion: detectClientVersion(client, data, opts.env || process.env),
		eventName,
		declaredEvent,
		sessionId: data[capability.sessionField] || "no-session",
		cwd,
		prompt: data[capability.promptField] || "",
		origin,
		toolName: data[capability.toolNameField] || "",
		toolUseId: data[capability.toolUseIdField] || "",
		toolInput: data[capability.toolInputField] || {},
		toolResponse: data[capability.toolResponseField] || null,
		hostProcessId: process.ppid,
		hostProcessIdentity: eventName === "SessionStart" ? core.processIdentity(process.ppid) : null,
	};
}

function validateEnvelope(client, input, event) {
	const errors = [];
	const capability = CLIENT_NATIVE_CAPABILITIES[client];
	if (!capability) errors.push("native_client_unsupported");
	if (!input || input.__parse_error === true) errors.push("native_envelope_parse_error");
	if (!VALID_EVENTS.has(event.eventName)) errors.push("native_event_invalid");
	if (!event.declaredEvent) errors.push("native_event_missing");
	else if (event.declaredEvent !== event.eventName) errors.push("native_event_mismatch");
	if (!event.sessionId || event.sessionId === "no-session") errors.push("native_session_id_missing");
	if (!event.cwd) errors.push("native_cwd_missing");
	if (event.eventName === "UserPromptSubmit" && (!capability || !input || typeof input[capability.promptField] !== "string")) errors.push("native_prompt_missing");
	if (["PreToolUse", "PostToolUse"].includes(event.eventName) && !event.toolName) errors.push("native_tool_name_missing");
	if (["PreToolUse", "PostToolUse"].includes(event.eventName) && !event.toolUseId) errors.push("native_tool_use_id_missing");
	return errors;
}

function formatClaudeOutput(eventName, result) {
	if (!result || result.kind === "allow") return null;
	if (result.kind === "context") {
		return {
			hookSpecificOutput: {
				hookEventName: eventName,
				additionalContext: `[request-contract:${result.code}] ${result.message}`,
			},
		};
	}
	if (result.kind === "incomplete") return { decision: "block", reason: `[request-contract:${result.code}] ${result.message}` };
	if (result.kind === "block") {
		return {
			decision: "block",
			reason: `[request-contract:${result.code}] ${result.message}`,
		};
	}
	return null;
}

function formatCodexOutput(eventName, result) {
	if (!result || result.kind === "allow") return null;
	const message = `[request-contract:${result.code}] ${result.message}`;
	if (result.kind === "context") {
		// Codex compact hooks accept only universal output fields. Their schema
		// deliberately rejects Claude's hookSpecificOutput envelope.
		if (["PreCompact", "PostCompact"].includes(eventName)) return { systemMessage: message };
		return { hookSpecificOutput: { hookEventName: eventName, additionalContext: message } };
	}
	if (result.kind === "incomplete" || result.kind === "block") {
		// Codex SessionStart/PreCompact/PostCompact stop through the universal
		// lifecycle contract. In particular, decision:block is invalid for
		// PreCompact and would otherwise fail open in the native dispatcher.
		if (["SessionStart", "PreCompact", "PostCompact"].includes(eventName)) return { continue: false, stopReason: message };
		return { decision: "block", reason: message };
	}
	return null;
}

function formatOutput(client, eventName, result) {
	return client === "claude" ? formatClaudeOutput(eventName, result) : client === "codex" ? formatCodexOutput(eventName, result) : null;
}

function failureOutput(client, eventName, error) {
	const code = (error && error.code) || "request_contract_internal_error";
	const result = { kind: "block", code, message: `Governed request-contract evaluation failed closed during ${eventName}.` };
	return client === "codex" ? formatCodexOutput(eventName, result) : formatClaudeOutput(eventName, result);
}

function preserveRejectedPrompt(client, input, event, opts = {}) {
	const data = input && typeof input === "object" ? input : {};
	const capability = CLIENT_NATIVE_CAPABILITIES[client];
	const prompt = capability && data[capability.promptField];
	const claimsPromptEvent = event.eventName === "UserPromptSubmit" || event.declaredEvent === "UserPromptSubmit";
	if (!claimsPromptEvent || typeof prompt !== "string") return null;
	return core.appendQuarantine(event.cwd, client, event.sessionId || "no-session", prompt, opts.now || Date.now(), event.origin);
}

function processEnvelope(client, input, fallbackEvent, opts = {}) {
	const event = normalizeInput(client, input, fallbackEvent, opts);
	try {
		const envelopeErrors = validateEnvelope(client, input, event);
		if (envelopeErrors.length) {
			if (!core.governed(event.cwd, opts.env || process.env)) return { event, result: { kind: "allow", code: "request_contract_disabled" }, output: null };
			preserveRejectedPrompt(client, input, event, opts);
			const error = Object.assign(new Error(envelopeErrors.join(", ")), { code: envelopeErrors[0], errors: envelopeErrors });
			return { event, error, result: { kind: "block", code: error.code }, output: failureOutput(client, event.eventName, error) };
		}
		const result = core.handleEvent(event, opts);
		return { event, result, output: formatOutput(client, event.eventName, result) };
	} catch (error) {
		// An unreadable governance store is itself a fail-closed condition.  Do not
		// let the exception handler repeat that read and escape without a native
		// block response; only a successful, explicit disabled result may allow.
		let governed = true;
		try { governed = core.governed(event.cwd, opts.env || process.env); } catch {}
		if (!governed) return { event, result: { kind: "allow", code: "request_contract_disabled" }, output: null };
		try { preserveRejectedPrompt(client, input, event, opts); }
		catch (preservationError) { error.preservation_error = preservationError.code || "prompt_preservation_failed"; }
		return { event, error, result: { kind: "block", code: error.code || "request_contract_internal_error" }, output: failureOutput(client, event.eventName, error) };
	}
}

module.exports = { VALID_EVENTS, CLIENT_NATIVE_CAPABILITIES, projectRoot, detectClientVersion, normalizeInput, validateEnvelope, formatClaudeOutput, formatCodexOutput, formatOutput, failureOutput, preserveRejectedPrompt, processEnvelope };
