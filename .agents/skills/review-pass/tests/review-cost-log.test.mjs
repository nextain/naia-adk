import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	createCostLogEntry,
	extractUsage,
	invoke,
	recordReviewCost,
	resolveCostLogPath,
} from "../scripts/invoke-reviewer.mjs";

const frameOk = { runtime_observed: false, frame_assessment: { scope_is_sufficient: true, missing_concerns: [] } };
const validReview = JSON.stringify({ verdict: "CLEAN", coverage: [{ atom_id: "ATOM-1", status: "COVERED" }], findings: [], ...frameOk });

// 1. fixture-based agy usage extraction
const agySuccessFixture = await readFile(new URL("./fixtures/agy-success-review.ndjson", import.meta.url), "utf8");
const agyUsage1 = extractUsage("agy", agySuccessFixture);
assert.equal(agyUsage1.usageSource, "result.usage");
assert.equal(agyUsage1.usage.input_tokens, 185320);
assert.equal(agyUsage1.usage.output_tokens, 19159);
assert.equal(agyUsage1.usage.thinking_tokens, 16790);
assert.equal(agyUsage1.usage.cache_read_tokens, 1402118);
assert.equal(agyUsage1.usage.cache_write_tokens, null);
assert.equal(agyUsage1.usage.total_tokens, 204479);
assert.equal(agyUsage1.usage.cost_usd, null);

const agySimpleFixture = await readFile(new URL("./fixtures/agy-simple-success.ndjson", import.meta.url), "utf8");
const agyUsage2 = extractUsage("agy", agySimpleFixture);
assert.equal(agyUsage2.usageSource, "result.usage");
assert.equal(agyUsage2.usage.input_tokens, 13352);
assert.equal(agyUsage2.usage.output_tokens, 1669);
assert.equal(agyUsage2.usage.thinking_tokens, 1664);
assert.equal(agyUsage2.usage.cache_read_tokens, 0);
assert.equal(agyUsage2.usage.total_tokens, 15021);

const deniedEmptyFixture = await readFile(new URL("./fixtures/agy-denied-empty.ndjson", import.meta.url), "utf8");
const agyDeniedUsage = extractUsage("agy", deniedEmptyFixture);
assert.equal(agyDeniedUsage.usageSource, "result.usage");
assert.equal(agyDeniedUsage.usage.input_tokens, 13715);
assert.equal(agyDeniedUsage.usage.output_tokens, 1962);
assert.equal(agyDeniedUsage.usage.thinking_tokens, 1904);
assert.equal(agyDeniedUsage.usage.total_tokens, 15677);

// 2. claude json usage and cost extraction
const claudeRaw = JSON.stringify({
	type: "result",
	result: validReview,
	total_cost_usd: 0.0425,
	usage: {
		input_tokens: 1200,
		output_tokens: 350,
		thinking_tokens: 150,
		cache_read_input_tokens: 500,
		cache_creation_input_tokens: 80,
	},
});
const claudeUsage = extractUsage("claude", claudeRaw);
assert.equal(claudeUsage.usageSource, "claude_json");
assert.equal(claudeUsage.usage.input_tokens, 1200);
assert.equal(claudeUsage.usage.output_tokens, 350);
assert.equal(claudeUsage.usage.thinking_tokens, 150);
assert.equal(claudeUsage.usage.cache_read_tokens, 500);
assert.equal(claudeUsage.usage.cache_write_tokens, 80);
assert.equal(claudeUsage.usage.total_tokens, null); // never estimate or compute
assert.equal(claudeUsage.usage.cost_usd, 0.0425);

// 3. logging failure does not alter invocation result or exit code
const impossibleLogPath = "/dev/null/forbidden/cost.jsonl";
const logFailDir = await mkdtemp(path.join(os.tmpdir(), "review-cost-fail-"));
const fakeSuccess = path.join(logFailDir, "fake-success.mjs");
await writeFile(fakeSuccess, `#!/usr/bin/env node\nlet input=""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => { console.log(${JSON.stringify(validReview)}); });\n`, { mode: 0o700 });
const invResult = await invoke({
	tool: "codex",
	repo: logFailDir,
	prompt: "TEST",
	atomIds: ["ATOM-1"],
	startupMs: 1000,
	idleMs: 1000,
	totalMs: 2000,
	executable: fakeSuccess,
	costLog: impossibleLogPath,
});
assert.equal(invResult.review.verdict, "CLEAN");

// 4. single cost log entry contains exact field set
const expectedFields = [
	"ts",
	"review_id",
	"stage",
	"round",
	"reviewer_index",
	"tool",
	"model",
	"repo",
	"prompt_chars",
	"duration_ms",
	"outcome",
	"failure_reason",
	"verdict",
	"findings_count",
	"usage",
	"usage_source",
];
const testLogPath = path.join(logFailDir, "cost.jsonl");
await invoke({
	tool: "codex",
	repo: logFailDir,
	model: "test-model",
	prompt: "TEST PROMPT",
	atomIds: ["ATOM-1"],
	startupMs: 1000,
	idleMs: 1000,
	totalMs: 2000,
	executable: fakeSuccess,
	costLog: testLogPath,
	reviewId: "rev-123",
	stage: "development",
	round: 2,
	reviewerIndex: 0,
});
const logContent = await readFile(testLogPath, "utf8");
const logLines = logContent.trim().split("\n");
assert.equal(logLines.length, 1, "exactly one cost log line must be written");
const parsedEntry = JSON.parse(logLines[0]);
assert.deepEqual(Object.keys(parsedEntry), expectedFields);
assert.equal(parsedEntry.review_id, "rev-123");
assert.equal(parsedEntry.stage, "development");
assert.equal(parsedEntry.round, 2);
assert.equal(parsedEntry.reviewer_index, 0);
assert.equal(parsedEntry.tool, "codex");
assert.equal(parsedEntry.model, "test-model");
assert.equal(parsedEntry.repo, logFailDir);
assert.equal(parsedEntry.outcome, "reviewed");
assert.equal(parsedEntry.failure_reason, null);
assert.equal(parsedEntry.verdict, "CLEAN");
assert.equal(parsedEntry.findings_count, 0);
assert.equal(typeof parsedEntry.duration_ms, "number");
assert.equal(parsedEntry.prompt_chars, 11);

// Verify usage object field set
const expectedUsageFields = [
	"input_tokens",
	"output_tokens",
	"thinking_tokens",
	"cache_read_tokens",
	"cache_write_tokens",
	"total_tokens",
	"cost_usd",
];
const entryWithUsage = createCostLogEntry({
	tool: "agy",
	repo: "/tmp",
	durationMs: 100,
	outcome: "reviewed",
	usage: agyUsage1.usage,
	usageSource: agyUsage1.usageSource,
});

// 5. every invoke() path writes exactly one log line
const testLogDir = await mkdtemp(path.join(os.tmpdir(), "review-cost-direct-"));
const singleLineSuccessLog = path.join(testLogDir, "direct-success-cost.jsonl");
await invoke({
	tool: "codex",
	repo: testLogDir,
	prompt: "TEST SUCCESS",
	atomIds: ["ATOM-1"],
	startupMs: 1000,
	idleMs: 1000,
	totalMs: 2000,
	executable: fakeSuccess,
	costLog: singleLineSuccessLog,
});
const successLogLines = (await readFile(singleLineSuccessLog, "utf8")).trim().split("\n");
assert.equal(successLogLines.length, 1, "direct invoke() success must write exactly 1 line to cost log");
assert.equal(JSON.parse(successLogLines[0]).outcome, "reviewed");

const fail = path.join(testLogDir, "fail.mjs");
await writeFile(fail, '#!/usr/bin/env node\nconsole.error("token=sk-secretvalue123"); console.log(JSON.stringify({type:"error",error:{data:{message:"provider login required"}}})); process.exit(7);\n', { mode: 0o700 });

const singleLineFailLog = path.join(testLogDir, "direct-fail-cost.jsonl");
await assert.rejects(
	invoke({
		tool: "codex",
		repo: testLogDir,
		prompt: "TEST FAIL",
		atomIds: ["ATOM-1"],
		startupMs: 1000,
		idleMs: 1000,
		totalMs: 2000,
		executable: fail,
		costLog: singleLineFailLog,
	}),
);
const failLogLines = (await readFile(singleLineFailLog, "utf8")).trim().split("\n");
assert.equal(failLogLines.length, 1, "direct invoke() failure must write exactly 1 line to cost log");
assert.equal(JSON.parse(failLogLines[0]).outcome, "failed");

console.log("review cost log tests: PASS");
