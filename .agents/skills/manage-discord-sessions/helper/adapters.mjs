import { createHash } from "node:crypto";

const CODEX_REASONING_BY_COST_PROFILE = Object.freeze({ control: "medium", balanced: "low", economy: "low" });

const ADAPTERS = new Map([
	["codex", {
		backendId: "codex",
		activityDetail: "structured",
		capabilities: { structuredProgress: true, textActivity: true, cancellation: true, checkpointResume: false },
		command({ executable = "codex", cwd, childHome = null, allowedPaths = [], sandbox = "workspace-write", approvalPolicy = "never", model = null, costProfile = "balanced", reasoningEffort = null, networkAccess = false }) {
			if (approvalPolicy !== "never") throw new Error("Codex child approval policy must be never");
			if (!Object.hasOwn(CODEX_REASONING_BY_COST_PROFILE, costProfile)) throw new Error("unsupported Codex cost profile");
			const selectedReasoningEffort = reasoningEffort ?? CODEX_REASONING_BY_COST_PROFILE[costProfile];
			if (!selectedReasoningEffort || !new Set(["low", "medium", "high", "max"]).has(selectedReasoningEffort)) throw new Error("unsupported Codex reasoning effort");
			const args = ["exec", "--json", "--ephemeral", "--strict-config", "--config", 'approval_policy="never"', "--config", `model_reasoning_effort="${selectedReasoningEffort}"`, "--config", "project_doc_max_bytes=0", "--sandbox", sandbox, "--cd", cwd, "--ignore-user-config", "--ignore-rules"];
			// Credential stores are isolated under the child HOME. Codex's
			// workspace-write sandbox otherwise denies gcloud/az/Vercel writes there.
			for (const path of [...allowedPaths, childHome].filter((path) => path && path !== cwd)) args.push("--add-dir", path);
			if (networkAccess) {
				if (sandbox !== "workspace-write") throw new Error("Codex network access requires workspace-write");
				args.push("--config", "sandbox_workspace_write.network_access=true");
			}
			if (model) args.push("--model", model);
			return { command: executable, args };
		},
		parse: parseCodex,
	}],
	["claude", {
		backendId: "claude",
		activityDetail: "structured",
		capabilities: { structuredProgress: true, textActivity: true, cancellation: true, checkpointResume: false },
		command({ executable = "claude", cwd, childHome = null, allowedPaths = [], permissionMode = "plan", approvalPolicy = "never", model = null }) {
			if (approvalPolicy !== "never") throw new Error("Claude child approval policy must be never");
			if (!new Set(["plan", "bypassPermissions"]).has(permissionMode)) throw new Error("unsupported Claude permission mode");
			const args = ["-p", "--safe-mode", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--no-session-persistence", "--permission-mode", permissionMode];
			if (permissionMode === "bypassPermissions") args.push("--dangerously-skip-permissions");
			for (const path of [...allowedPaths, childHome].filter((path) => path && path !== cwd)) args.push("--add-dir", path);
			if (model) args.push("--model", model);
			return {
				command: executable,
				args,
			};
		},
		parse: parseClaude,
	}],
	["opencode", {
		backendId: "opencode",
		activityDetail: "structured",
		capabilities: { structuredProgress: true, textActivity: true, cancellation: true, checkpointResume: false },
		command({ executable = "opencode", cwd, auto = false, model = null }) {
			const args = ["run", "--format", "json", "--dir", cwd, "--pure"];
			if (model) args.push("--model", model);
			if (auto) args.push("--auto");
			return { command: executable, args };
		},
		parse: parseOpencode,
	}],
]);

const MINIMUM_VERSIONS = new Map([["codex", [0, 146, 0]], ["claude", [2, 1, 220]], ["opencode", [1, 18, 0]]]);
const APPROVAL_REQUEST_PATTERN = /\b(?:approval|permission)[ _-]?(?:required|request)\b/i;

export function approvalRequestedText(value) {
	return APPROVAL_REQUEST_PATTERN.test(String(value));
}

function structuredApprovalRequested(message) {
	const eventType = String(message?.type ?? "");
	const itemType = String(message?.item?.type ?? "");
	return /(?:approval|permission)[_.-]?(?:required|request)/i.test(eventType)
		|| /(?:approval|permission)[_.-]?(?:required|request)/i.test(itemType);
}

export function getBackendAdapter(backendId) {
	const adapter = ADAPTERS.get(backendId);
	if (!adapter) throw new Error(`unsupported backend adapter: ${backendId}`);
	return adapter;
}

export function assertSupportedBackendVersion(backendId, versionOutput) {
	getBackendAdapter(backendId);
	const match = String(versionOutput).match(/\b(\d+)\.(\d+)\.(\d+)\b/);
	if (!match) throw new Error(`${backendId} version could not be determined`);
	const actual = match.slice(1).map(Number);
	const minimum = MINIMUM_VERSIONS.get(backendId);
	for (let index = 0; index < 3; index += 1) {
		if (actual[index] > minimum[index]) return actual.join(".");
		if (actual[index] < minimum[index]) throw new Error(`${backendId} version is not supported`);
	}
	return actual.join(".");
}

function activity(bytes) {
	return bytes > 0 ? [{ kind: "output_activity", safePayload: { bytes }, metrics: { bytes } }] : [];
}

function nonNegativeInteger(value) {
	return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function cacheReceipt(usage, backendId) {
	if (!usage || typeof usage !== "object" || Array.isArray(usage)) return [];
	const inputTokens = nonNegativeInteger(usage.input_tokens);
	const cacheReadInputTokens = nonNegativeInteger(backendId === "codex" ? usage.cached_input_tokens : usage.cache_read_input_tokens);
	const outputTokens = nonNegativeInteger(usage.output_tokens);
	if (inputTokens === null || cacheReadInputTokens === null || outputTokens === null) return [];
	const safePayload = { backend: backendId, inputTokens, cacheReadInputTokens, outputTokens };
	if (backendId === "claude") {
		const cacheCreationInputTokens = nonNegativeInteger(usage.cache_creation_input_tokens);
		if (cacheCreationInputTokens === null) return [];
		safePayload.cacheCreationInputTokens = cacheCreationInputTokens;
	}
	const metrics = { inputTokens, cacheReadInputTokens, outputTokens };
	if (safePayload.cacheCreationInputTokens !== undefined) metrics.cacheCreationInputTokens = safePayload.cacheCreationInputTokens;
	return [{ kind: "prompt_cache_observed", safePayload, metrics }];
}

const CODEX_TOOL_CATEGORIES = new Map([
	["command_execution", "command_execution"],
	["file_change", "file_change"],
	["web_search", "search"],
]);

const CLAUDE_TOOL_CATEGORIES = new Map([
	["Bash", "command_execution"],
	["Edit", "file_change"],
	["NotebookEdit", "file_change"],
	["Write", "file_change"],
	["Read", "read"],
	["Glob", "search"],
	["Grep", "search"],
	["WebSearch", "search"],
]);

function optionalToolPayload(category) {
	return category ? { toolCategory: category } : {};
}

function parseCodex(message, rawBytes) {
	const events = [];
	switch (message.type) {
		case "thread.started":
			events.push({ kind: "backend_ready", safePayload: { backend: "codex" } });
			break;
		case "turn.started":
			break;
		case "item.started":
			if (message.item?.type && !new Set(["reasoning", "agent_message"]).has(message.item.type)) {
				events.push({ kind: "tool_started", safePayload: optionalToolPayload(CODEX_TOOL_CATEGORIES.get(message.item.type)) });
			}
			break;
		case "item.completed":
			if (message.item?.type && !new Set(["reasoning", "agent_message"]).has(message.item.type)) {
				events.push({ kind: "tool_finished", safePayload: optionalToolPayload(CODEX_TOOL_CATEGORIES.get(message.item.type)) });
			}
			events.push(...activity(rawBytes));
			break;
		case "turn.completed":
			events.push(...cacheReceipt(message.usage, "codex"));
			break;
		default:
			if (message.type === "error" || message.type === "turn.failed") break;
			events.push(...activity(rawBytes));
	}
	return events;
}

function claudeBlocks(message) {
	return Array.isArray(message?.message?.content) ? message.message.content : Array.isArray(message?.content) ? message.content : [];
}

function parseClaude(message, rawBytes) {
	const events = [];
	if (message.type === "system" && message.subtype === "init") {
		events.push({ kind: "backend_ready", safePayload: { backend: "claude" } });
		return events;
	}
	if (message.type === "assistant") {
		for (const block of claudeBlocks(message)) {
			if (block.type === "tool_use") events.push({ kind: "tool_started", safePayload: optionalToolPayload(CLAUDE_TOOL_CATEGORIES.get(block.name)) });
		}
		events.push(...activity(rawBytes));
		return events;
	}
	if (message.type === "user") {
		return events;
	}
	if (message.type === "stream_event") return activity(rawBytes);
	if (message.type === "result") {
		events.push(...cacheReceipt(message.usage, "claude"));
		return events;
	}
	return events;
}

function parseOpencode(message, rawBytes) {
	const events = [];
	if (message.type === "step_start") events.push({ kind: "phase_changed", safePayload: { phase: "planning" } });
	if (message.type === "text") events.push(...activity(rawBytes));
	if (message.type === "tool_use") {
		const tool = message.part?.tool ?? "unknown";
		const status = message.part?.state?.status ?? "running";
		events.push({ kind: status === "completed" || status === "error" ? "tool_finished" : "tool_started", safePayload: { toolCategory: toolCategory(tool) } });
	}
	return events;
}

export function inspectBackendLine({ backendId, line, attemptId, lineNumber }) {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return { outcome: null, transientResult: null, assistantText: null, approvalRequested: approvalRequestedText(line), events: activity(Buffer.byteLength(line, "utf8")).map((event, eventIndex) => ({
			...event,
			dedupeKey: eventKey(backendId, attemptId, lineNumber, eventIndex, event.kind),
		})) };
	}
	const rawBytes = Buffer.byteLength(line, "utf8");
	const approvalRequested = structuredApprovalRequested(message);
	const codexCompletion = message.type === "turn.completed"
		&& (message.status === undefined || new Set(["completed", "success"]).has(message.status));
	const opencodeCompletion = backendId === "opencode" && new Set(["step_finish", "session_end", "result"]).has(message.type);
	const outcome = backendId === "codex"
		? codexCompletion ? "success" : new Set(["turn.failed", "error"]).has(message.type) ? "failure" : null
		: backendId === "opencode" ? opencodeCompletion && message.error ? "failure" : opencodeCompletion ? "success" : null
		: message.type === "result" ? (message.is_error === true || message.subtype === "error" ? "failure" : message.subtype === "success" && message.is_error !== true ? "success" : null) : null;
	let transientResult = null;
	let assistantText = null;
	if (backendId === "codex" && message.type === "item.completed" && message.item?.type === "agent_message" && typeof message.item.text === "string") transientResult = message.item.text;
	if (backendId === "codex" && message.type === "item.completed" && message.item?.type === "agent_message" && typeof message.item.text === "string") assistantText = message.item.text;
	if (backendId === "claude" && message.type === "assistant") {
		const text = claudeBlocks(message).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
		if (text) assistantText = text;
	}
	if (backendId === "claude" && message.type === "result" && outcome === "success" && typeof message.result === "string") transientResult = message.result;
	if (backendId === "opencode" && message.type === "text" && typeof message.part?.text === "string") {
		transientResult = message.part.text;
		assistantText = message.part.text;
	}
	return { outcome, transientResult, assistantText, approvalRequested, events: getBackendAdapter(backendId).parse(message, rawBytes).map((event, eventIndex) => ({
		...event,
		dedupeKey: eventKey(backendId, attemptId, lineNumber, eventIndex, event.kind),
	})) };
}

export function parseBackendLine(input) {
	return inspectBackendLine(input).events;
}

function eventKey(backendId, attemptId, lineNumber, eventIndex, kind) {
	const digest = createHash("sha256").update(`${backendId}\0${attemptId}\0${lineNumber}\0${eventIndex}\0${kind}`).digest("hex").slice(0, 32);
	return `${backendId}:${digest}`;
}
