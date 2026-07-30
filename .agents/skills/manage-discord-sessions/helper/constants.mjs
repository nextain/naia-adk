export const DB_SCHEMA_VERSION = 2;
export const OUTPUT_SCHEMA_VERSION = 1;

export const EVENT_KINDS = new Set([
	"job_accepted",
	"attempt_reserved",
	"attempt_started",
	"backend_ready",
	"phase_changed",
	"output_activity",
	"tool_started",
	"tool_finished",
	"approval_required",
	"checkpoint_saved",
	"verification_recorded",
	"attempt_exited",
	"attempt_succeeded",
	"retry_scheduled",
	"delivery_started",
	"delivery_confirmed",
	"delivery_unknown",
	"recovered",
	"cancel_requested",
	"cancelled",
	"completed",
	"failed",
]);

export const TERMINAL_LIFECYCLES = new Set([
	"completed",
	"failed",
	"cancelled",
	"recovery_review",
]);

export const LIFECYCLES = new Set([
	"queued",
	"running",
	"waiting_approval",
	"retry_wait",
	"result_ready",
	"delivering",
	...TERMINAL_LIFECYCLES,
]);

export const ACTIVITY_DETAILS = new Set(["structured", "text_activity", "unsupported"]);

export const SAFE_METRIC_KEYS = new Set([
	"bytes",
	"count",
	"durationMs",
	"exitCode",
	"passed",
	"failed",
	"missing",
	"total",
	"queuePosition",
]);

export const DEFAULT_SOFT_SILENCE_MS = 120_000;
export const DEFAULT_SERVICE_STALE_MS = 30_000;
export const MAX_SAFE_SUMMARY_LENGTH = 512;

export const ALLOWED_TRANSITIONS = new Map([
	["queued", new Set(["queued", "running", "cancelled", "failed", "recovery_review"])],
	["running", new Set(["running", "waiting_approval", "retry_wait", "result_ready", "delivering", "failed", "cancelled", "recovery_review"])],
	["waiting_approval", new Set(["waiting_approval", "running", "cancelled", "failed", "recovery_review"])],
	["retry_wait", new Set(["retry_wait", "queued", "running", "cancelled", "failed", "recovery_review"])],
	["result_ready", new Set(["result_ready", "delivering", "cancelled", "failed", "recovery_review"])],
	["delivering", new Set(["delivering", "completed", "retry_wait", "recovery_review", "failed"])],
	["recovery_review", new Set(["recovery_review", "queued", "completed", "failed", "cancelled"])],
	["completed", new Set(["completed"])],
	["failed", new Set(["failed"])],
	["cancelled", new Set(["cancelled"])],
]);
