import assert from "node:assert/strict";
import test from "node:test";
import { formatVerboseEvent, operatorProfile } from "../helper/operator-trace.mjs";

test("DSO-013 named instances fall back to concise profile-safe labels", () => {
	assert.deepEqual(operatorProfile({ instance: "onmam", config: null }), {
		instance: "onmam", label: "onmam", source: "instance",
	});
	assert.deepEqual(operatorProfile({ instance: "onmam", config: { persona: { shortName: "온맘" } } }), {
		instance: "onmam", label: "온맘", source: "configured",
	});
	assert.equal(operatorProfile({ instance: "an-instance-name-that-is-longer-than-twenty-four-characters", config: null }).label.length, 24);
});

test("DSO-013 verbose events expose bounded state and unavailable detail", () => {
	const profile = operatorProfile({ instance: "onmam", config: { persona: { shortName: "온맘" } } });
	const state = new Map();
	const base = { ordinal: 1, eventId: "event-1", dedupeKey: "dedupe-1", jobId: "123e4567-e89b-12d3-a456-426614174000", attemptId: null, sequence: 1, occurredAt: "2026-08-04T00:00:00.000Z", source: "codex", metrics: {}, redactionLevel: "metadata_only" };
	const accepted = formatVerboseEvent({ ...base, kind: "job_accepted", safeSummary: "Accepted job: issue_work" }, profile, state);
	assert.equal(accepted, "[온맘] 2026-08-04T00:00:00.000Z +0ms job:123e4567~4000 Accepted job: issue_work");
	const unavailable = formatVerboseEvent({ ...base, ordinal: 2, sequence: 2, occurredAt: "2026-08-04T00:00:01.250Z", kind: "output_activity", safeSummary: "Output activity: 433 bytes", metrics: { bytes: 433 } }, profile, state);
	assert.equal(unavailable, "[온맘] 2026-08-04T00:00:01.250Z +1250ms job:123e4567~4000 detail unavailable bytes=433");
	assert.equal(unavailable.includes("reasoning"), false);
});
