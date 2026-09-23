import assert from "node:assert/strict";
import {
	composePrompt,
	validateAtoms,
	validateReviewOutput,
	COVERAGE_STATUSES,
	VERDICTS,
	OUTSIDE_SCOPE_VALUE,
	FINDING_REQUIRED_KEYS,
	FRAME_OBLIGATIONS,
	AGY_TOOL_POLICY,
} from "../scripts/invoke-reviewer.mjs";

const atom = { id: "ATOM-1", source_id: "SRC-1", text: "headless", directive_ids: ["DIR-1"], subject: "agent_workflow", effect: "constraint", render_policy: "deny", target_ids: ["TGT-1"], criterion_ids: ["AC-1"], evidence_ids: ["EV-1"] };
const atoms = validateAtoms([atom]);

// 1. agy tool policy appended, other tools prompt unchanged
const basePrompt = "STABLE BASE PROMPT\n";
const promptNoTool = composePrompt(basePrompt, atoms, "ROLE", "ask");
const promptClaude = composePrompt(basePrompt, atoms, "ROLE", "ask", "claude");
const promptCodex = composePrompt(basePrompt, atoms, "ROLE", "ask", "codex");
const promptOpencode = composePrompt(basePrompt, atoms, "ROLE", "ask", "opencode");
const promptGrok = composePrompt(basePrompt, atoms, "ROLE", "ask", "grok");
assert.equal(promptClaude, promptNoTool, "claude prompt must remain byte-identical");
assert.equal(promptCodex, promptNoTool, "codex prompt must remain byte-identical");
assert.equal(promptOpencode, promptNoTool, "opencode prompt must remain byte-identical");
assert.equal(promptGrok, promptNoTool, "grok prompt must remain byte-identical");

const promptAgy = composePrompt(basePrompt, atoms, "ROLE", "ask", "agy");
assert.notEqual(promptAgy, promptNoTool, "agy prompt must include tool policy");
assert.match(promptAgy, /--- TOOL USAGE POLICY ---/);
assert.match(promptAgy, /run_command/);
assert.match(promptAgy, /file viewing tools/);
assert.match(promptAgy, /review JSON/);
assert.ok(promptAgy.startsWith(promptNoTool.trimEnd()), "agy prompt must preserve base prefix");

// 2. the fixed prompt section matches the validator
for (const v of VERDICTS) {
	assert.ok(FRAME_OBLIGATIONS.includes(`"${v}"`), `FRAME_OBLIGATIONS must declare verdict ${v}`);
}
for (const cs of COVERAGE_STATUSES) {
	assert.ok(FRAME_OBLIGATIONS.includes(`"${cs}"`), `FRAME_OBLIGATIONS must declare coverage status ${cs}`);
}
assert.ok(FRAME_OBLIGATIONS.includes(`"${OUTSIDE_SCOPE_VALUE}"`), `FRAME_OBLIGATIONS must declare ${OUTSIDE_SCOPE_VALUE}`);
for (const key of FINDING_REQUIRED_KEYS) {
	assert.ok(FRAME_OBLIGATIONS.includes(`"${key}"`), `FRAME_OBLIGATIONS must declare finding key ${key}`);
}
for (const topKey of ["verdict", "coverage", "findings", "frame_assessment", "runtime_observed"]) {
	assert.ok(FRAME_OBLIGATIONS.includes(`"${topKey}"`), `FRAME_OBLIGATIONS must declare top-level key ${topKey}`);
}
for (const subKey of ["scope_is_sufficient", "missing_concerns"]) {
	assert.ok(FRAME_OBLIGATIONS.includes(`"${subKey}"`), `FRAME_OBLIGATIONS must declare frame_assessment key ${subKey}`);
}

// Sample JSON conforming to FRAME_OBLIGATIONS passes validateReviewOutput
const sampleCleanOutput = JSON.stringify({
	verdict: "CLEAN",
	coverage: [{ atom_id: "ATOM-1", status: "COVERED" }],
	findings: [],
	frame_assessment: { scope_is_sufficient: true, missing_concerns: [] },
	runtime_observed: false,
});
const parsedClean = validateReviewOutput(sampleCleanOutput, ["ATOM-1"]);
assert.equal(parsedClean.verdict, "CLEAN");

const sampleNotCleanOutput = JSON.stringify({
	verdict: "NOT_CLEAN",
	coverage: [{ atom_id: "ATOM-1", status: "COVERED" }],
	findings: [
		{
			atom_id: null,
			scope: "outside_declared_atoms",
			file_location: "src/sample.js:10",
			impact: "Unhandled rejection causes crash",
			minimal_fix: "Add try/catch block",
		},
	],
	frame_assessment: { scope_is_sufficient: false, missing_concerns: ["Crash handling omitted from ledger"] },
	runtime_observed: false,
});
const parsedNotClean = validateReviewOutput(sampleNotCleanOutput, ["ATOM-1"]);
assert.equal(parsedNotClean.verdict, "NOT_CLEAN");
assert.equal(parsedNotClean.findings.length, 1);
assert.equal(parsedNotClean.findings[0].scope, "outside_declared_atoms");

// 3. prompts for other tools also carry the format section
const toolsToTest = ["claude", "codex", "opencode", "grok", "agy", undefined];
for (const t of toolsToTest) {
	const promptForTool = composePrompt("BASE", atoms, "DELTA", "REQUEST", t);
	assert.ok(promptForTool.includes(FRAME_OBLIGATIONS), `Prompt for tool ${t || "default"} must include FRAME_OBLIGATIONS`);
	assert.ok(promptForTool.includes('"verdict"'), `Prompt for tool ${t || "default"} must include JSON schema`);
	assert.ok(promptForTool.includes('"coverage"'), `Prompt for tool ${t || "default"} must include coverage schema`);
	assert.ok(promptForTool.includes('"findings"'), `Prompt for tool ${t || "default"} must include findings schema`);
	assert.ok(promptForTool.includes('"frame_assessment"'), `Prompt for tool ${t || "default"} must include frame_assessment schema`);
	assert.ok(promptForTool.includes('"runtime_observed"'), `Prompt for tool ${t || "default"} must include runtime_observed schema`);
}

// 4. the agy policy forbids web access
assert.match(AGY_TOOL_POLICY, /web search|browser/i, "AGY policy must forbid web search and browser tools");
const promptForAgy = composePrompt("BASE", atoms, "DELTA", "REQUEST", "agy");
assert.match(promptForAgy, /web search|browser/i, "Composed prompt for AGY must forbid web search and browser tools");
for (const nonAgy of ["claude", "codex", "opencode", "grok"]) {
	const nonAgyPrompt = composePrompt("BASE", atoms, "DELTA", "REQUEST", nonAgy);
	assert.doesNotMatch(nonAgyPrompt, /--- TOOL USAGE POLICY ---/, `Tool ${nonAgy} prompt must not have AGY_TOOL_POLICY`);
}

console.log("review output contract tests: PASS");
