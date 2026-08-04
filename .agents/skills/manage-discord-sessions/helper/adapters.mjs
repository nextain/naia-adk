import { createHash } from "node:crypto";

const ADAPTERS = new Map([
	["codex", {
		backendId: "codex",
		activityDetail: "structured",
		capabilities: { structuredProgress: true, textActivity: true, cancellation: true, checkpointResume: false },
		command({ executable = "codex", cwd, sandbox = "workspace-write", approvalPolicy = "never", model = null }) {
			if (approvalPolicy !== "never") throw new Error("Codex child approval policy must be never");
			const args = ["exec", "--json", "--ephemeral", "--strict-config", "--config", 'approval_policy="never"', "--config", 'model_reasoning_effort="low"', "--config", "project_doc_max_bytes=0", "--sandbox", sandbox, "--cd", cwd, "--ignore-user-config", "--ignore-rules"];
			if (model) args.push("--model", model);
			return { command: executable, args };
		},
		parse: parseCodex,
	}],
	["claude", {
		backendId: "claude",
		activityDetail: "structured",
		capabilities: { structuredProgress: true, textActivity: true, cancellation: true, checkpointResume: false },
		command({ executable = "claude", permissionMode = "plan", approvalPolicy = "never" }) {
			if (approvalPolicy !== "never") throw new Error("Claude child approval policy must be never");
			return {
				command: executable,
				args: ["-p", "--safe-mode", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--no-session-persistence", "--permission-mode", permissionMode],
			};
		},
		parse: parseClaude,
	}],
]);

const MINIMUM_VERSIONS = new Map([["codex", [0, 146, 0]], ["claude", [2, 1, 220]]]);
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

function toolCategory(value = "") {
	const name = String(value).toLowerCase();
	if (/test/.test(name)) return "test";
	if (/build|compile/.test(name)) return "build";
	if (/web|http|fetch|browser/.test(name)) return "network";
	if (/read|search|list|glob|grep/.test(name)) return "file_read";
	if (/edit|write|patch|create/.test(name)) return "file_edit";
	if (/command|exec|shell|bash|terminal/.test(name)) return "command";
	return "other";
}

function codexItemCategory(item = {}) {
	const categoryByItemType = new Map([
		["command_execution", "command"],
		["file_change", "file_edit"],
		["file_read", "file_read"],
		["mcp_tool_call", "other"],
		["web_search", "network"],
	]);
	return categoryByItemType.get(item.type) ?? toolCategory(item.name ?? item.type ?? "");
}

function phaseForToolCategory(category) {
	if (category === "file_read" || category === "network") return "reading";
	if (category === "file_edit") return "editing";
	if (category === "test" || category === "build") return "testing";
	if (category === "command") return "executing";
	return null;
}

function toolStarted(category) {
	const events = [];
	const phase = phaseForToolCategory(category);
	if (phase) events.push({ kind: "phase_changed", safePayload: { phase } });
	events.push({ kind: "tool_started", safePayload: { toolCategory: category } });
	return events;
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
			if (message.item?.type === "reasoning") events.push({ kind: "phase_changed", safePayload: { phase: "planning" } });
			else if (message.item?.type && message.item.type !== "agent_message") events.push(...toolStarted(codexItemCategory(message.item)));
			break;
		case "item.completed":
			if (message.item?.type && !new Set(["reasoning", "agent_message"]).has(message.item.type)) {
				events.push({ kind: "tool_finished", safePayload: { toolCategory: codexItemCategory(message.item) } });
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

function claudeToolState(adapterState) {
	if (!(adapterState.toolCategories instanceof Map)) adapterState.toolCategories = new Map();
	return adapterState.toolCategories;
}

function parseClaude(message, rawBytes, adapterState = {}) {
	const events = [];
	if (message.type === "system" && message.subtype === "init") {
		events.push({ kind: "backend_ready", safePayload: { backend: "claude" } });
		return events;
	}
	if (message.type === "assistant") {
		const blocks = claudeBlocks(message);
		if (blocks.some((block) => block.type === "thinking")) events.push({ kind: "phase_changed", safePayload: { phase: "planning" } });
		for (const block of blocks) {
			if (block.type !== "tool_use") continue;
			const category = toolCategory(block.name);
			events.push(...toolStarted(category));
			if (typeof block.id === "string") claudeToolState(adapterState).set(block.id, category);
		}
		events.push(...activity(rawBytes));
		return events;
	}
	if (message.type === "user") {
		for (const block of claudeBlocks(message)) {
			if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
			const tools = claudeToolState(adapterState);
			const category = tools.get(block.tool_use_id) ?? "other";
			tools.delete(block.tool_use_id);
			events.push({ kind: "tool_finished", safePayload: { toolCategory: category } });
		}
		return events;
	}
	if (message.type === "stream_event") {
		if (message.event?.type === "content_block_start" && message.event?.content_block?.type === "thinking") events.push({ kind: "phase_changed", safePayload: { phase: "planning" } });
		events.push(...activity(rawBytes));
		return events;
	}
	if (message.type === "result") {
		events.push(...cacheReceipt(message.usage, "claude"));
		return events;
	}
	return events;
}

export function inspectBackendLine({ backendId, line, attemptId, lineNumber, adapterState = {} }) {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return { outcome: null, transientResult: null, approvalRequested: approvalRequestedText(line), events: activity(Buffer.byteLength(line, "utf8")).map((event, eventIndex) => ({
			...event,
			dedupeKey: eventKey(backendId, attemptId, lineNumber, eventIndex, event.kind),
		})) };
	}
	const rawBytes = Buffer.byteLength(line, "utf8");
	const approvalRequested = structuredApprovalRequested(message);
	const codexCompletion = message.type === "turn.completed"
		&& (message.status === undefined || new Set(["completed", "success"]).has(message.status));
	const outcome = backendId === "codex"
		? codexCompletion ? "success" : new Set(["turn.failed", "error"]).has(message.type) ? "failure" : null
		: message.type === "result" ? (message.is_error === true || message.subtype === "error" ? "failure" : message.subtype === "success" && message.is_error !== true ? "success" : null) : null;
	let transientResult = null;
	if (backendId === "codex" && message.type === "item.completed" && message.item?.type === "agent_message" && typeof message.item.text === "string") transientResult = message.item.text;
	if (backendId === "claude" && message.type === "result" && outcome === "success" && typeof message.result === "string") transientResult = message.result;
	return { outcome, transientResult, approvalRequested, events: getBackendAdapter(backendId).parse(message, rawBytes, adapterState).map((event, eventIndex) => ({
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
