import { MAX_SAFE_SUMMARY_LENGTH, SAFE_METRIC_KEYS } from "./constants.mjs";

const SECRET_PATTERNS = [
	/\b(?:sk|sk-or-v1|xox[baprs])-[-A-Za-z0-9_]{8,}\b/gi,
	/\b(?:bot|bearer)\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
	/\b(?:token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi,
	/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g,
];

const LOCAL_PATH_PATTERN = /(?:[A-Za-z]:\\|\/(?:home|Users|var\/home)\/)[^\s"']+/g;

export function sanitizeSummary(value) {
	if (typeof value !== "string") throw new TypeError("safeSummary must be a string");
	let sanitized = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
	for (const pattern of SECRET_PATTERNS) sanitized = sanitized.replace(pattern, "[REDACTED]");
	sanitized = sanitized.replace(LOCAL_PATH_PATTERN, "[LOCAL_PATH]");
	if (sanitized.length > MAX_SAFE_SUMMARY_LENGTH) throw new Error(`safeSummary exceeds ${MAX_SAFE_SUMMARY_LENGTH} characters`);
	return sanitized;
}

export function validateSafeMetrics(metrics = {}) {
	if (metrics === null || typeof metrics !== "object" || Array.isArray(metrics)) {
		throw new TypeError("metrics must be an object");
	}
	const safe = {};
	for (const [key, value] of Object.entries(metrics)) {
		if (!SAFE_METRIC_KEYS.has(key)) throw new Error(`unsafe metric key: ${key}`);
		if (typeof value !== "boolean" && (!Number.isSafeInteger(value) || value < 0)) {
			throw new TypeError(`metric ${key} must be boolean or a non-negative safe integer`);
		}
		safe[key] = value;
	}
	return safe;
}

export function assertOnlyKeys(value, allowed, label) {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`${label} contains unsupported field: ${key}`);
	}
}

const CAPABILITY_KEYS = new Set(["structuredProgress", "textActivity", "cancellation", "checkpointResume"]);

export function validateBackendCapabilities(value = {}) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("backendCapabilities must be an object");
	assertOnlyKeys(value, CAPABILITY_KEYS, "backendCapabilities");
	const safe = {};
	for (const [key, enabled] of Object.entries(value)) {
		if (typeof enabled !== "boolean") throw new TypeError(`backend capability ${key} must be boolean`);
		safe[key] = enabled;
	}
	return safe;
}

const ENUMS = {
	backend: new Set(["codex", "claude", "fake"]),
	jobType: new Set(["conversation", "issue_work", "review", "maintenance", "unknown"]),
	phase: new Set(["setup", "planning", "reading", "editing", "testing", "reviewing", "delivering", "recovering"]),
	toolCategory: new Set(["file_read", "file_edit", "command", "test", "build", "network", "other"]),
	approvalType: new Set(["read", "write", "execute", "cancel", "retry"]),
	checkpointType: new Set(["job_state"]),
	recoveryAction: new Set(["resume", "safe_retry", "manual_review"]),
	reasonCode: new Set(["timeout", "process_exit", "authorization", "delivery_unknown", "internal_error"]),
	terminationKind: new Set(["exited", "signaled"]),
	signal: new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"]),
};

function enumValue(value, label) {
	if (!ENUMS[label]?.has(value)) throw new Error(`${label} is not an allowed value`);
	return value;
}

function count(value, label) {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
	return value;
}

const PAYLOAD_BUILDERS = {
	job_accepted: (payload) => `Accepted job: ${enumValue(payload.jobType, "jobType")}`,
	attempt_started: (payload) => `Backend attempt started: ${enumValue(payload.backend, "backend")}`,
	backend_ready: (payload) => `Backend ready: ${enumValue(payload.backend, "backend")}`,
	phase_changed: (payload) => `Phase changed: ${enumValue(payload.phase, "phase")}`,
	output_activity: (payload) => `Output activity: ${count(payload.bytes, "bytes")} bytes`,
	tool_started: (payload) => `Tool started: ${enumValue(payload.toolCategory, "toolCategory")}`,
	tool_finished: (payload) => `Tool finished: ${enumValue(payload.toolCategory, "toolCategory")}`,
	approval_required: (payload) => `Approval required: ${enumValue(payload.approvalType, "approvalType")}`,
	checkpoint_saved: (payload) => `Checkpoint saved: ${enumValue(payload.checkpointType, "checkpointType")}`,
	verification_recorded: (payload) => `Verification recorded: ${safeIdentifier(payload.checkId, "checkId")}`,
	attempt_exited: (payload) => {
		const terminationKind = enumValue(payload.terminationKind, "terminationKind");
		if (terminationKind === "exited") {
			if (payload.signal !== undefined) throw new Error("exited termination cannot carry signal");
			return `Backend attempt exited: ${count(payload.exitCode, "exitCode")}`;
		}
		if (payload.exitCode !== undefined) throw new Error("signaled termination cannot carry exitCode");
		return `Backend attempt signaled: ${enumValue(payload.signal, "signal")}`;
	},
	retry_scheduled: (payload) => `Retry scheduled: ${count(payload.delayMs, "delayMs")} ms`,
	delivery_started: () => "Delivery started",
	delivery_confirmed: () => "Delivery confirmed",
	delivery_unknown: () => "Delivery result requires review",
	recovered: (payload) => `Recovered job: ${enumValue(payload.recoveryAction, "recoveryAction")}`,
	cancel_requested: () => "Cancellation requested",
	cancelled: () => "Job cancelled",
	completed: () => "Job completed",
	failed: (payload) => `Job failed: ${enumValue(payload.reasonCode, "reasonCode")}`,
};

const PAYLOAD_KEYS = new Map([
	["job_accepted", new Set(["jobType"])],
	["attempt_started", new Set(["backend"])],
	["backend_ready", new Set(["backend"])],
	["phase_changed", new Set(["phase"])],
	["output_activity", new Set(["bytes"])],
	["tool_started", new Set(["toolCategory"])],
	["tool_finished", new Set(["toolCategory"])],
	["approval_required", new Set(["approvalType"])],
	["checkpoint_saved", new Set(["checkpointType"])],
	["verification_recorded", new Set(["checkId"])],
	["attempt_exited", new Set(["terminationKind", "exitCode", "signal"])],
	["retry_scheduled", new Set(["delayMs"])],
	["delivery_started", new Set()],
	["delivery_confirmed", new Set()],
	["delivery_unknown", new Set()],
	["recovered", new Set(["recoveryAction"])],
	["cancel_requested", new Set()],
	["cancelled", new Set()],
	["completed", new Set()],
	["failed", new Set(["reasonCode"])],
]);

export function safeIdentifier(value, label = "identifier") {
	if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(value)) throw new Error(`${label} must be a safe identifier`);
	if (sanitizeSummary(value) !== value) throw new Error(`${label} resembles sensitive data`);
	return value;
}

export function canonicalTimestamp(value, label = "timestamp") {
	if (typeof value !== "string") throw new TypeError(`${label} must be a canonical ISO timestamp`);
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) throw new Error(`${label} must be a canonical ISO timestamp`);
	return value;
}

export function buildSafeEventSummary(kind, payload = {}) {
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("safePayload must be an object");
	if (Buffer.byteLength(JSON.stringify(payload), "utf8") > 2_048) throw new Error("safePayload exceeds 2048 bytes");
	const allowedKeys = PAYLOAD_KEYS.get(kind);
	if (!allowedKeys) throw new Error(`event kind does not accept adapter payload: ${kind}`);
	assertOnlyKeys(payload, allowedKeys, `${kind} payload`);
	const builder = PAYLOAD_BUILDERS[kind];
	if (!builder) throw new Error(`event kind does not accept adapter payload: ${kind}`);
	return sanitizeSummary(builder(payload));
}
