import assert from "node:assert/strict";
import { test } from "node:test";
import { failureNotice, reportDiscordJobFailure } from "../helper/discord-failure.mjs";

test("DSG-019 formats only terminal failure and recovery-review notices", () => {
	assert.equal(failureNotice(null), null);
	assert.equal(failureNotice({ jobId: "queued", lifecycle: "queued" }), null);
	assert.match(failureNotice({ jobId: "failed-job", lifecycle: "failed", latestSafeError: "Job failed: provider_quota_exhausted" }), /사용량 한도 또는 잔액이 소진되어/);
	assert.match(failureNotice({ jobId: "review-job", lifecycle: "recovery_review", latestSafeError: "Job failed: internal_error" }), /검토 대상으로 보존했습니다/);
	assert.match(failureNotice({ jobId: "unknown-job", lifecycle: "failed", latestSafeError: "unsafe detail" }), /내부 오류가 발생했습니다/);
});

test("DSG-019 reports a failure through the supplied scoped sender and absorbs sender errors", async () => {
	const calls = [];
	const store = { getJob: () => ({ jobId: "failed-job", lifecycle: "failed", latestSafeError: "Job failed: timeout" }) };
	const sendControl = (input) => {
		calls.push(input);
		return { promise: Promise.resolve({ state: "confirmed" }) };
	};
	await reportDiscordJobFailure({ item: { jobId: "failed-job", channelId: "channel-id" }, store, token: "token", botUserId: "bot-id", sendControl });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].channelId, "channel-id");
	assert.match(calls[0].content, /작업 제한 시간을 초과해/);
	assert.match(calls[0].content, /failed-job/);
	assert.match(calls[0].nonce, /^[a-f0-9]{24}$/);
	await reportDiscordJobFailure({ item: { jobId: "failed-job", channelId: "channel-id" }, store, token: "token", botUserId: "bot-id", sendControl: () => ({ promise: Promise.reject(new Error("Discord unavailable")) }) });
});
