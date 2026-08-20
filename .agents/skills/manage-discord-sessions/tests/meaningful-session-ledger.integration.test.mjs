import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runBackendAttempt } from "../helper/backend-runner.mjs";
import { SessionStore } from "../helper/store.mjs";
import { cleanupRoots, fixture } from "./observability-fixture.mjs";

const cliPath = fileURLToPath(new URL("../helper/cli.mjs", import.meta.url));
const fakeBackendPath = fileURLToPath(new URL("./fixtures/fake-backend.mjs", import.meta.url));
const jobId = "meaningful-session-job";
const rawRequestSecret = "request-secret-013";
const assembledPromptSecret = "assembled-context-secret-013";

afterEach(cleanupRoots);

async function completedSession() {
	const { root, databasePath, store } = fixture();
	store.acceptIngressAndCreateJob({
		sourceMessageId: "666666666666666613",
		scopeKey: "scope-meaningful-session",
		jobId,
		backendId: "codex",
		backendCapabilities: { structuredProgress: true },
		activityDetail: "structured",
		requestExcerpt: `inspect token=${rawRequestSecret} /var/home/luke/request-private`,
	});
	const result = await runBackendAttempt({
		store,
		jobId,
		backendId: "codex",
		prompt: `__fake_meaningful_session__ token=${assembledPromptSecret} /var/home/luke/assembled-private`,
		cwd: root,
		runtimeRoot: join(root, "runtime"),
		executable: fakeBackendPath,
		backendVersion: "0.146.0",
		requireAuthentication: false,
		parentEnv: { PATH: process.env.PATH },
	});
	assert.equal(result.backendOutcome, "success");
	store.close();
	return { root, databasePath };
}

function cli(root, args) {
	const result = spawnSync(process.execPath, [cliPath, "--adk-root", root, ...args], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}

test("UCT_DSO_013_001 reopens a completed session and reads meaningful chronology through existing CLI", async () => {
	const { root, databasePath } = await completedSession();
	const reopened = new SessionStore(databasePath);
	const reopenedKinds = reopened.getJob(jobId).events.map((event) => event.kind);
	reopened.close();
	const requiredKinds = ["request_recorded", "tool_started", "tool_finished", "progress_reported", "result_reported"];
	for (const kind of requiredKinds) assert.ok(reopenedKinds.includes(kind), `${kind} is missing after reopen`);
	assert.ok(requiredKinds.every((kind, index) => index === 0 || reopenedKinds.indexOf(requiredKinds[index - 1]) < reopenedKinds.indexOf(kind)));

	const detail = JSON.parse(cli(root, ["job", jobId, "--json"]));
	assert.equal(detail.job.jobId, jobId);
	assert.deepEqual(detail.job.events.map((event) => event.kind), reopenedKinds);
	const watched = cli(root, ["watch", "--job", jobId, "--jsonl", "--once"]).trim().split("\n").map((line) => JSON.parse(line).event);
	assert.deepEqual(watched.map((event) => event.kind), reopenedKinds);
});

test("FET_DSO_013_001 preserves semantic events while excluding provider-private data", async () => {
	const { databasePath } = await completedSession();
	const reopened = new SessionStore(databasePath);
	const job = reopened.getJob(jobId);
	reopened.close();
	const event = (kind) => job.events.find((candidate) => candidate.kind === kind);
	assert.match(event("request_recorded").safeSummary, /\[REDACTED\].*\[LOCAL_PATH\]/);
	assert.match(event("progress_reported").safeSummary, /\[REDACTED\].*\[LOCAL_PATH\]/);
	assert.equal(event("tool_started").safeSummary, "Tool started: command_execution");
	assert.equal(event("tool_finished").safeSummary, "Tool finished: command_execution");
	assert.equal(event("result_reported").safeSummary, "Result: fake-model-content");
	assert.equal(job.currentActivity.includes("checking"), false);
	assert.equal(job.currentActivity.includes("fake-model-content"), false);

	const bytes = readFileSync(databasePath);
	for (const forbidden of [rawRequestSecret, assembledPromptSecret, "/var/home/luke/request-private", "/var/home/luke/assembled-private", "private-tool-command", "private-tool-output"]) {
		assert.equal(bytes.includes(Buffer.from(forbidden)), false, `persisted forbidden provider-private data: ${forbidden}`);
	}
});
