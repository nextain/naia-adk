const MAX_PROFILE_LABEL_CODE_POINTS = 24;
const HUMAN_JOB_REFERENCE_PREFIX_CODE_POINTS = 8;
const HUMAN_JOB_REFERENCE_SUFFIX_CODE_POINTS = 4;

function prefix(value, limit) {
	return [...String(value)].slice(0, limit).join("");
}

export function operatorProfile({ instance, config = null }) {
	const configured = config?.persona?.shortName;
	return Object.freeze({
		instance,
		label: configured ?? prefix(instance, MAX_PROFILE_LABEL_CODE_POINTS),
		source: configured ? "configured" : "instance",
	});
}

function jobReference(jobId) {
	const codePoints = [...String(jobId)];
	if (codePoints.length <= HUMAN_JOB_REFERENCE_PREFIX_CODE_POINTS + HUMAN_JOB_REFERENCE_SUFFIX_CODE_POINTS + 1) return codePoints.join("");
	return `${codePoints.slice(0, HUMAN_JOB_REFERENCE_PREFIX_CODE_POINTS).join("")}~${codePoints.slice(-HUMAN_JOB_REFERENCE_SUFFIX_CODE_POINTS).join("")}`;
}

function elapsedLabel(event, state) {
	const current = Date.parse(event.occurredAt);
	if (!Number.isFinite(current)) return "elapsed=unknown";
	if (!state.has(event.jobId)) state.set(event.jobId, current);
	const elapsed = current - state.get(event.jobId);
	return elapsed >= 0 ? `+${elapsed}ms` : "elapsed=unknown";
}

function normalizedDetail(event) {
	if (event.kind === "output_activity") {
		const bytes = Number.isSafeInteger(event.metrics?.bytes) ? event.metrics.bytes : null;
		return `detail unavailable${bytes === null ? "" : ` bytes=${bytes}`}`;
	}
	const phase = event.kind === "phase_changed" ? event.safeSummary.match(/^Phase changed: ([a-z_]+)$/)?.[1] : null;
	if (phase) return `phase ${phase}`;
	const started = event.kind === "tool_started" ? event.safeSummary.match(/^Tool started: ([a-z_]+)$/)?.[1] : null;
	if (started) return `tool start ${started}`;
	const finished = event.kind === "tool_finished" ? event.safeSummary.match(/^Tool finished: ([a-z_]+)$/)?.[1] : null;
	if (finished) return `tool finish ${finished}`;
	const backend = event.kind === "backend_ready" ? event.safeSummary.match(/^Backend ready: ([a-z_]+)$/)?.[1] : null;
	if (backend) return `backend ready ${backend}`;
	if (event.kind === "attempt_succeeded") return "result ready";
	if (event.kind === "approval_required") return `blocker ${event.safeSummary}`;
	if (new Set(["delivery_unknown", "delivery_failed", "recovery_review_required", "watchdog_intervened", "failed"]).has(event.kind)) return `blocker ${event.safeSummary}`;
	return event.safeSummary;
}

export function formatVerboseEvent(event, profile, state = new Map()) {
	return `[${profile.label}] ${event.occurredAt} ${elapsedLabel(event, state)} job:${jobReference(event.jobId)} ${normalizedDetail(event)}`;
}
