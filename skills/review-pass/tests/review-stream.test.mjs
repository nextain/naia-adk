import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stdinPayload, validateReviewOutput } from "../scripts/invoke-reviewer.mjs";

const frameOk = { runtime_observed: false, frame_assessment: { scope_is_sufficient: true, missing_concerns: [] } };
const validReview = JSON.stringify({ verdict: "CLEAN", coverage: [{ atom_id: "ATOM-1", status: "COVERED" }], findings: [], ...frameOk });

const agyPrompt = stdinPayload("agy", "AGY-PROMPT");
const agyPromptEvent = JSON.parse(agyPrompt);
assert.equal(agyPromptEvent.event, "user");
assert.equal(agyPromptEvent.message.role, "user");
assert.equal(agyPromptEvent.message.content, "AGY-PROMPT");
assert.match(agyPrompt, /\n$/);

// Sanitized fixture from the installed AGY stream shape: the terminal status
// is nested below the result event and the response carries the review.
const agyNestedSuccess = [
	JSON.stringify({ event: "init", session_id: "fixture" }),
	JSON.stringify({ event: "assistant", message: { role: "assistant", content: [{ type: "text", text: "fixture response" }] } }),
	JSON.stringify({ event: "result", result: { status: "SUCCESS", response: validReview } }),
].join("\n");
assert.equal(validateReviewOutput(agyNestedSuccess, ["ATOM-1"]).verdict, "CLEAN");
const agyFencedReviewText = `done\n\`\`\`json\n${validReview}\n\`\`\``;
assert.equal(
	validateReviewOutput(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: agyFencedReviewText } }), ["ATOM-1"]).verdict,
	"CLEAN",
	"AGY result.response may carry a fenced review",
);
assert.equal(
	validateReviewOutput(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: agyFencedReviewText }, null, 2), ["ATOM-1"]).verdict,
	"CLEAN",
	"pretty native envelopes must expose fenced result text to the schema parser",
);
assert.equal(
	validateReviewOutput(JSON.stringify({ event: "result", result: { status: "SUCCESS", error: "", response: validReview } }), ["ATOM-1"]).verdict,
	"CLEAN",
	"an empty provider error field is not a failure",
);
assert.throws(
	() => validateReviewOutput(`${agyNestedSuccess}\n${JSON.stringify({ event: "result", result: { status: "SUCCESS", error: "quota exceeded", response: validReview } })}`, ["ATOM-1"]),
	/incomplete or failed stream \(error\)/,
	"a non-empty nested AGY error string must fail closed even with SUCCESS status",
);
assert.throws(
	() => validateReviewOutput(`${agyNestedSuccess}\n${JSON.stringify({ error: "connection reset" })}`, ["ATOM-1"]),
	/incomplete or failed stream \(error\)/,
	"a later stream failure with a string error must fail closed after an earlier success",
);
assert.throws(
	() => validateReviewOutput(`${agyNestedSuccess}\n${JSON.stringify({ event: "result", result: { status: "SUCCESS", is_error: true, response: validReview } })}`, ["ATOM-1"]),
	/incomplete or failed stream \(error\)/,
	"a contradictory nested AGY error flag must fail closed even with SUCCESS status",
);
assert.throws(
	() => validateReviewOutput(`${agyNestedSuccess}\n{"event":"result","result":{"status":"ERROR"`, ["ATOM-1"]),
	/malformed structured stream JSON/,
	"a malformed later AGY terminal must fail closed after an earlier success",
);
assert.throws(
	() => validateReviewOutput(`${agyNestedSuccess.slice(0, agyNestedSuccess.lastIndexOf("\n"))}\n${JSON.stringify({ event: "result", result: { response: validReview } })}`, ["ATOM-1"]),
	/incomplete or failed stream \(missing terminal\)/,
	"AGY result without a status must fail closed",
);
assert.throws(
	() => validateReviewOutput(`${agyNestedSuccess}\n${JSON.stringify({ event: "result", result: { status: "ERROR", response: validReview } })}`, ["ATOM-1"]),
	/incomplete or failed stream \(error\)/,
	"a failed AGY result after success must fail closed",
);
assert.throws(
	() => validateReviewOutput(`${agyNestedSuccess}\n${JSON.stringify({ event: "result", result: { status: "SUCCESS", truncated: true } })}`, ["ATOM-1"]),
	/incomplete or failed stream \(truncated\)/,
	"a truncated AGY result after success must fail closed",
);

// Preserve the existing native result envelope accepted by other adapters.
assert.equal(validateReviewOutput(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: validReview }), ["ATOM-1"]).verdict, "CLEAN");
assert.equal(validateReviewOutput(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: validReview }, null, 2), ["ATOM-1"]).verdict, "CLEAN", "a pretty-printed native envelope is one JSON document, not malformed NDJSON");
assert.equal(validateReviewOutput(`result\n\`\`\`json\n${validReview}\n\`\`\``, ["ATOM-1"]).verdict, "CLEAN");
assert.equal(validateReviewOutput(`reviewer prose\n${validReview}\ntrailing prose`, ["ATOM-1"]).verdict, "CLEAN", "plain stdout prose remains supported when no structured stream event is present");
const openCodeTerminal = JSON.stringify({ type: "step_finish", part: { type: "step-finish", reason: "stop", tokens: { input: 1, output: 1 } } });
const fragmented = `${JSON.stringify({ type: "text", part: { type: "text", text: validReview.slice(0, 30) } })}\n${JSON.stringify({ type: "text", part: { type: "text", text: validReview.slice(30) } })}\n${openCodeTerminal}`;
assert.equal(validateReviewOutput(fragmented, ["ATOM-1"]).verdict, "CLEAN");
const fencedFileText = 'before ```js\nconsole.log("not review")\n```';
const fencedReviewText = `done\n\`\`\`json\n${validReview}\n\`\`\``;
const interleavedEvents = [fencedFileText, fencedReviewText]
	.map((text) => JSON.stringify({ type: "text", part: { text } }))
	.concat(openCodeTerminal)
	.join("\n");
assert.equal(validateReviewOutput(interleavedEvents, ["ATOM-1"]).verdict, "CLEAN");
const claudeEnvelope = JSON.stringify({ type: "result", result: fencedReviewText });
assert.equal(validateReviewOutput(claudeEnvelope, ["ATOM-1"]).verdict, "CLEAN");
const nestedStringEnvelope = JSON.stringify({ type: "result", payload: JSON.stringify({ part: { text: fencedReviewText } }) });
assert.equal(validateReviewOutput(nestedStringEnvelope, ["ATOM-1"]).verdict, "CLEAN");
const illustrativeStatusText = JSON.stringify({ type: "text", part: { text: 'example: {"status_code":402} and code:payment_required' } });
assert.equal(validateReviewOutput(`${illustrativeStatusText}\n${openCodeTerminal}\n${validReview}`, ["ATOM-1"]).verdict, "CLEAN", "quota-like examples in successful text must remain text");
assert.throws(() => validateReviewOutput(`${JSON.stringify({ type: "text", part: { text: validReview } })}\n${validReview}`, ["ATOM-1"]), /incomplete or failed stream \(missing terminal\)/);
assert.throws(() => validateReviewOutput(`${openCodeTerminal}\n${JSON.stringify({ type: "step_start", part: { type: "step-start" } })}\n${JSON.stringify({ type: "text", part: { type: "text", text: validReview } })}`, ["ATOM-1"]), /incomplete or failed stream \(missing terminal\)/, "a new step after stop needs its own terminal");
assert.throws(() => validateReviewOutput(`${JSON.stringify({ type: "step_finish", part: { type: "step-finish", reason: "mystery" } })}\n${validReview}`, ["ATOM-1"]), /incomplete or failed stream \(mystery\)/);
for (const reason of ["length", "max_tokens"]) {
	assert.throws(() => validateReviewOutput(`${JSON.stringify({ type: "step_finish", part: { type: "step-finish", reason, tokens: { input: 1, output: 1 } } })}\n${validReview}`, ["ATOM-1"]), new RegExp(`incomplete or failed stream \\(${reason}\\)`));
}
assert.throws(() => validateReviewOutput(`${JSON.stringify({ type: "step_finish", part: { type: "step-finish", reason: "error", error: { message: "provider failed" } } })}\n${validReview}`, ["ATOM-1"]), /incomplete or failed stream \(error\)/);
assert.throws(() => validateReviewOutput(`${JSON.stringify({ type: "step_finish", reason: "length" })}\n${validReview}`, ["ATOM-1"]), /incomplete or failed stream \(length\)/);
assert.throws(() => validateReviewOutput(`${JSON.stringify({ type: "error", error: { message: "provider failed" } })}\n${validReview}`, ["ATOM-1"]), /incomplete or failed stream \(error\)/);
assert.throws(() => validateReviewOutput(`${JSON.stringify({ type: "step_finish", status: "incomplete" })}\n${validReview}`, ["ATOM-1"]), /incomplete or failed stream \(incomplete\)/);
assert.throws(() => validateReviewOutput(`${JSON.stringify({ type: "step_finish", status: "truncated" })}\n${validReview}`, ["ATOM-1"]), /incomplete or failed stream \(truncated\)/);
assert.throws(() => validateReviewOutput(`${JSON.stringify({ type: "step_finish", truncated: true })}\n${validReview}`, ["ATOM-1"]), /incomplete or failed stream \(truncated\)/);
const echoedDraftThenFinal = [
	JSON.stringify({ type: "text", part: { text: JSON.stringify({ coverage: [] }) } }),
	JSON.stringify({ type: "text", part: { text: fencedReviewText } }),
	openCodeTerminal,
].join("\n");
assert.equal(validateReviewOutput(echoedDraftThenFinal, ["ATOM-1"]).verdict, "CLEAN");

const deniedEmptyFixture = await readFile(new URL("./fixtures/agy-denied-empty.ndjson", import.meta.url), "utf8");
assert.throws(
	() => validateReviewOutput(deniedEmptyFixture, ["ATOM-1"]),
	/agy denied tool action and returned no review/,
	"empty response with denied_actions must fail closed with distinct reason",
);

console.log("review stream tests: PASS");
