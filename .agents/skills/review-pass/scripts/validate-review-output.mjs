/**
 * Parse and validate reviewer output independently from process invocation.
 *
 * Keeping stream completion and review-schema checks together means the CLI
 * wrapper only owns process lifecycle, while this module remains usable by
 * focused validation tests and other callers.
 */
const COVERAGE_STATUSES = new Set(["COVERED", "NOT_COVERED"]);

function invalidOutput(message) {
	const error = new Error(message);
	error.kind = "invalid_output";
	return error;
}

function findReview(value, depth = 0) {
	if (depth > 32) return undefined;
	if (typeof value === "string") {
		try { return findReview(JSON.parse(value), depth + 1); } catch { return undefined; }
	}
	if (!value || typeof value !== "object") return undefined;
	if (Array.isArray(value.coverage)) return value;
	for (const nested of Object.values(value)) {
		const found = findReview(nested, depth + 1);
		if (found) return found;
	}
}

function collectTextFields(value, out, depth = 0, key = "") {
	if (depth > 32 || value === null || value === undefined) return;
	// Some streaming CLIs place the completed assistant message below an
	// arbitrary envelope (for example `part.text`) while others JSON-encode a
	// nested event as a string. Collect message/result strings as independent candidates;
	// the strict review-schema validation below still decides what may pass.
	if (typeof value === "string") {
		if (key === "text" || key === "result" || key === "response") out.push(value);
		try { collectTextFields(JSON.parse(value), out, depth + 1); } catch {}
		return;
	}
	if (typeof value !== "object") return;
	for (const [nestedKey, nested] of Object.entries(value)) collectTextFields(nested, out, depth + 1, nestedKey);
}

export const STREAM_EVENT_TYPES = new Set([
	"step_start", "step_finish", "step-start", "step-finish",
	"text", "tool_use", "tool-use", "tool_result", "tool-result",
	"assistant", "result",
]);
export const STREAM_TERMINAL_TYPES = new Set(["step_finish", "step-finish", "result"]);
export const STREAM_SUCCESS_REASONS = new Set(["stop", "completed", "complete", "success", "end_turn"]);
export const STREAM_CONTINUATION_REASONS = new Set(["tool_calls", "tool-calls"]);
export const STREAM_FAILURE_TYPES = new Set(["error", "failure", "failed", "truncated"]);
export const STREAM_FAILURE_STATES = new Set(["error", "failure", "failed", "incomplete", "aborted", "cancelled", "canceled", "truncated", "truncation"]);
export const STREAM_LENGTH_REASONS = new Set(["length", "max_tokens", "max_output_tokens"]);

export function streamMetadata(event) {
	if (!event || typeof event !== "object" || Array.isArray(event)) return [];
	const values = [event];
	// OpenCode's JSON stream puts step state below `part`; inspect this known
	// envelope only. Do not recursively parse message text, where examples can
	// contain words such as `error` or `max_tokens` without describing the run.
	if (event.part && typeof event.part === "object" && !Array.isArray(event.part)) values.push(event.part);
	// AGY places terminal metadata in the result member of its result event.
	// Inspect this known envelope only; recursively walking arbitrary provider
	// payloads would mistake review-content examples for stream state.
	const eventType = typeof event.type === "string"
		? event.type.toLowerCase()
		: typeof event.event === "string" ? event.event.toLowerCase() : "";
	if (eventType === "result" && event.result && typeof event.result === "object" && !Array.isArray(event.result)) values.push(event.result);
	return values;
}

export function streamMetadataPriority(event) {
	const metadata = streamMetadata(event);
	return metadata.length > 1 ? [...metadata].reverse() : metadata;
}

export function streamValue(value) {
	return typeof value === "string" ? value.toLowerCase() : "";
}

export function streamFailureReason(event) {
	for (const metadata of streamMetadataPriority(event)) {
		const type = streamValue(typeof metadata.type === "string" ? metadata.type : metadata.event);
		const status = streamValue(metadata.status);
		const reason = streamValue(metadata.reason);
		const finishReason = streamValue(typeof metadata.finish_reason === "string" ? metadata.finish_reason : metadata.finishReason);
		const subtype = streamValue(metadata.subtype);
		if (metadata.truncated === true || metadata.is_truncated === true || metadata.isTruncated === true) return "truncated";
		if (metadata.is_error === true || metadata.isError === true) return "error";
		if (STREAM_FAILURE_TYPES.has(type)) return type;
		if (STREAM_FAILURE_STATES.has(status)) return status;
		if (STREAM_FAILURE_STATES.has(reason) || STREAM_LENGTH_REASONS.has(reason)) return reason;
		if (STREAM_FAILURE_STATES.has(finishReason) || STREAM_LENGTH_REASONS.has(finishReason)) return finishReason;
		if (STREAM_FAILURE_STATES.has(subtype) || STREAM_LENGTH_REASONS.has(subtype)) return subtype;
		if (metadata.error && (typeof metadata.error === "object" || (typeof metadata.error === "string" && metadata.error.trim().length > 0))) return "error";
	}
	return "";
}

export function streamType(event) {
	const metadata = streamMetadata(event);
	if (!metadata.length) return { structured: false, terminal: false };
	const [outer, part] = metadata;
	const type = streamValue(typeof outer.type === "string" ? outer.type : outer.event);
	const partType = streamValue(part?.type);
	const nestedResult = outer.result && typeof outer.result === "object" && !Array.isArray(outer.result) ? outer.result : null;
	// A provider result envelope is a stream event only when it carries native
	// terminal metadata.  Plain Claude-style {type:"result", result:"..."}
	// envelopes remain supported as direct JSON output below.
	const nativeResult = type === "result" && (
		typeof outer.event === "string" ||
		typeof outer.subtype === "string" ||
		typeof outer.is_error === "boolean" ||
		typeof outer.status === "string" ||
		typeof nestedResult?.subtype === "string" ||
		typeof nestedResult?.is_error === "boolean" ||
		typeof nestedResult?.status === "string"
	);
	return {
		structured: (STREAM_EVENT_TYPES.has(type) && (type !== "result" || nativeResult)) || STREAM_EVENT_TYPES.has(partType),
		terminal: (STREAM_TERMINAL_TYPES.has(type) && (type !== "result" || nativeResult)) || STREAM_TERMINAL_TYPES.has(partType),
		start: type === "step_start" || type === "step-start" || partType === "step_start" || partType === "step-start",
	};
}

export function streamTerminalReason(event) {
	for (const metadata of streamMetadataPriority(event)) {
		for (const key of ["reason", "finish_reason", "finishReason", "status", "subtype"]) {
			const value = streamValue(metadata[key]);
			if (value) return value;
		}
	}
	return "";
}

export function parseStreamEvents(raw) {
	// A provider may emit one complete, pretty-printed JSON envelope.  It is a
	// document, not NDJSON, so its interior newlines must not be reported as
	// malformed stream records.  Only fall back to line parsing when the whole
	// payload is not valid JSON; once in that mode every non-empty line remains
	// subject to the strict NDJSON check below.
	try { return { events: [JSON.parse(raw)], malformedLines: [] }; } catch {}
	const events = [];
	const malformedLines = [];
	for (const [index, line] of raw.split(/\r?\n/).entries()) {
		if (!line.trim()) continue;
		try { events.push(JSON.parse(line)); } catch { malformedLines.push(index + 1); }
	}
	return { events, malformedLines };
}

export function rejectFailedStreamEvents(raw) {
	const { events, malformedLines } = parseStreamEvents(raw);
	for (const event of events) {
		for (const metadata of streamMetadata(event)) {
			if (Array.isArray(metadata.denied_actions) && metadata.denied_actions.length > 0) {
				const response = typeof metadata.response === "string" ? metadata.response.trim() : "";
				if (!response) throw invalidOutput("agy denied tool action and returned no review");
			}
		}
	}
	const reason = events.map(streamFailureReason).find(Boolean);
	if (reason) throw invalidOutput(`review output contains an incomplete or failed stream (${reason})`);
	const structuredEvents = events.filter((event) => streamType(event).structured);
	if (!structuredEvents.length) return;
	if (malformedLines.length) throw invalidOutput("review output contains malformed structured stream JSON");
	let completed = false;
	for (const event of structuredEvents) {
		const type = streamType(event);
		if (type.start) {
			completed = false;
			continue;
		}
		if (!type.terminal) continue;
		const terminalReason = streamTerminalReason(event);
		if (STREAM_SUCCESS_REASONS.has(terminalReason)) {
			completed = true;
			continue;
		}
		if (STREAM_CONTINUATION_REASONS.has(terminalReason)) {
			completed = false;
			continue;
		}
		const eventName = streamValue(typeof event.type === "string" ? event.type : event.event);
		const missingReason = !terminalReason && eventName === "result" ? "missing terminal" : "unknown terminal";
		throw invalidOutput(`review output contains an incomplete or failed stream (${terminalReason || missingReason})`);
	}
	if (!completed) throw invalidOutput("review output contains an incomplete or failed stream (missing terminal)");
}

export function validateReviewOutput(raw, atomIds) {
	rejectFailedStreamEvents(raw);
	const candidates = [];
	const eventTexts = [];
	const addJsonCandidates = (text) => {
		try { candidates.push(JSON.parse(text)); } catch {}
		for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
			try { candidates.push(JSON.parse(match[1])); } catch {}
		}
	};
	addJsonCandidates(raw);
	const { events } = parseStreamEvents(raw);
	for (const event of events) {
		candidates.push(event);
		const lineTexts = [];
		collectTextFields(event, lineTexts);
		for (const text of lineTexts) addJsonCandidates(text);
		eventTexts.push(...lineTexts);
	}
	const reconstructed = eventTexts.join("");
	addJsonCandidates(reconstructed);
	// Streaming reviewers may echo the ledger or an earlier draft before their
	// final answer. Prefer the latest structured review so those intermediate
	// coverage-shaped objects cannot shadow the completed verdict.
	const review = [...candidates].reverse().map(findReview).find(Boolean);
	if (!review) throw invalidOutput("review output has no structured coverage array");
	if (!["CLEAN", "NOT_CLEAN"].includes(review.verdict) || !Array.isArray(review.findings)) throw invalidOutput("review output has an invalid verdict or findings array");
	const expected = new Set(atomIds);
	const seen = new Set();
	for (const row of review.coverage) {
		if (!row || typeof row.atom_id !== "string" || !COVERAGE_STATUSES.has(row.status)) throw invalidOutput("review output has an invalid coverage row");
		if (!expected.has(row.atom_id)) throw invalidOutput(`review output has unknown atom: ${row.atom_id}`);
		if (seen.has(row.atom_id)) throw invalidOutput(`review output duplicates atom: ${row.atom_id}`);
		seen.add(row.atom_id);
	}
	const missing = [...expected].filter((id) => !seen.has(id));
	if (missing.length) throw invalidOutput(`review output misses atoms: ${missing.join(", ")}`);
	for (const [index, finding] of review.findings.entries()) {
		// A finding outside the author's ledger is the one the ledger could never
		// have asked for. Rejecting it as "unknown atom" is how a review gets
		// locked inside the frame it was supposed to test.
		if (finding?.atom_id === null || finding?.atom_id === undefined) {
			if (finding?.scope !== "outside_declared_atoms") {
				throw invalidOutput(`review finding ${index} has no atom_id and does not declare scope "outside_declared_atoms"`);
			}
		} else if (!expected.has(finding.atom_id)) {
			throw invalidOutput(`review finding ${index} has an unknown atom_id`);
		}
		for (const key of ["file_location", "impact", "minimal_fix"]) {
			if (typeof finding[key] !== "string" || !finding[key].trim()) throw invalidOutput(`review finding ${index} has an invalid ${key}`);
		}
	}

	// Whether the scope was right is a separate question from whether the work
	// inside it was right, and a review that answers only the second one reads
	// as complete while leaving the first unasked.
	const frame = review.frame_assessment;
	if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
		throw invalidOutput("review output has no frame_assessment");
	}
	if (typeof frame.scope_is_sufficient !== "boolean") {
		throw invalidOutput("frame_assessment.scope_is_sufficient must be a boolean");
	}
	if (!Array.isArray(frame.missing_concerns) || frame.missing_concerns.some((item) => typeof item !== "string" || !item.trim())) {
		throw invalidOutput("frame_assessment.missing_concerns must be an array of non-empty strings");
	}
	if (frame.scope_is_sufficient === false && frame.missing_concerns.length === 0) {
		throw invalidOutput("an insufficient scope must name what is missing");
	}

	// Reading files is not observing behaviour. Saying which one happened keeps
	// a text review from being quoted later as a runtime result.
	if (typeof review.runtime_observed !== "boolean") {
		throw invalidOutput("review output must state runtime_observed as a boolean");
	}

	if (review.verdict === "CLEAN") {
		if (review.findings.length || review.coverage.some(({ status }) => status !== "COVERED")) {
			throw invalidOutput("CLEAN review contains findings or uncovered atoms");
		}
		if (frame.scope_is_sufficient === false) {
			throw invalidOutput("CLEAN is unavailable while the reviewed scope is insufficient");
		}
	}
	if (review.verdict === "NOT_CLEAN" && !review.findings.length && review.coverage.every(({ status }) => status === "COVERED") && frame.scope_is_sufficient !== false) {
		throw invalidOutput("NOT_CLEAN review has no finding, uncovered atom, or scope objection");
	}
	return review;
}
