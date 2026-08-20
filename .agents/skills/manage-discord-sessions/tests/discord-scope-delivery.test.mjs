import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { authorizeDiscordMessage, validateDiscordBindings } from "../helper/discord-scope.mjs";
import { deliverJobResult, postDiscordDirectMessage, postDiscordMessage, splitDiscordContent } from "../helper/discord-delivery.mjs";
import { transientPrompt } from "../helper/discord-router.mjs";
import { BOT, CHANNEL, GUILD, OTHER_USER, THREAD, USER, binding, cleanupDiscordFixtureRoots, fixture } from "./fixtures/discord-fixture.mjs";

afterEach(cleanupDiscordFixtureRoots);

test("DSG-001 authorizes DM, guild channel, and exact thread bindings with structured mentions only", () => {
	const bindings = validateDiscordBindings([binding("dm"), binding(), binding("thread")]);
	const common = { author: { id: USER }, mentions: [{ id: BOT }], content: "plain text", id: "666666666666666666" };
	assert.equal(authorizeDiscordMessage({ message: { ...common, channel_id: "777777777777777777" }, bindings, botUserId: BOT }).scope.kind, "dm");
	assert.equal(authorizeDiscordMessage({ message: { ...common, guild_id: GUILD, channel_id: CHANNEL }, bindings, botUserId: BOT }).scope.kind, "guild_channel");
	const threads = new Map([[THREAD, { parentChannelId: CHANNEL, guildId: GUILD }]]);
	assert.equal(authorizeDiscordMessage({ message: { ...common, guild_id: GUILD, channel_id: THREAD }, bindings, botUserId: BOT, threadParents: threads }).scope.kind, "thread");
	assert.equal(authorizeDiscordMessage({ message: { ...common, mentions: [], content: `<@${BOT}>`, guild_id: GUILD, channel_id: CHANNEL }, bindings, botUserId: BOT }).reasonCode, "mention_required");
	assert.equal(authorizeDiscordMessage({ message: { ...common, author: { id: "888888888888888888" }, guild_id: GUILD, channel_id: CHANNEL }, bindings, operatorUserIds: ["888888888888888888"], botUserId: BOT }).reasonCode, "user_not_allowed");
	assert.throws(() => validateDiscordBindings([{ ...binding(), respondWhen: "always" }]), /require messageContentIntent/);
	assert.doesNotThrow(() => validateDiscordBindings([{ ...binding(), respondWhen: "always" }], { messageContentIntent: true }));
});

test("DSG-021 binds configured participant profiles and ignores Discord guild roles", () => {
	const bindings = validateDiscordBindings([{ ...binding(), historyVisibility: "none", operatorActions: true }], { schemaVersion: 2 });
	const participantProfiles = { [USER]: { label: "workspace-owner", relationship: "workspace owner", allowedActions: ["read", "reply", "write"] } };
	const authorization = authorizeDiscordMessage({
		message: { guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, member: { roles: ["999999999999999999"] }, mentions: [{ id: BOT }] },
		bindings, operatorUserIds: [USER], participantProfiles, botUserId: BOT,
	});
	assert.equal(authorization.allowed, true);
	assert.equal(authorization.isOperator, true);
	assert.deepEqual(authorization.participantProfile, participantProfiles[USER]);
	const rejected = authorizeDiscordMessage({ message: { guild_id: GUILD, channel_id: CHANNEL, author: { id: OTHER_USER }, member: { roles: ["999999999999999999"] }, mentions: [{ id: BOT }] }, bindings, operatorUserIds: [OTHER_USER], participantProfiles, botUserId: BOT });
	assert.equal(rejected.reasonCode, "user_not_allowed");
});

test("DSG-021 removes raw Discord user, role, and channel snowflakes from the provider request", () => {
	const config = {
		schemaVersion: 2,
		persona: { name: "Reader", instructions: "Answer from the configured project context." },
		role: { name: "reader", allowedActions: ["read", "reply"], requiresApproval: [] },
	};
	const authorization = {
		participantProfile: { label: "workspace-owner", relationship: "workspace owner", allowedActions: ["read", "reply"] },
		isOperator: false,
		binding: { operatorActions: false },
	};
	const prompt = transientPrompt({ content: `<@${BOT}> compare <@${OTHER_USER}> with <@&999999999999999999> in <#${CHANNEL}>` }, BOT, config, authorization);
	for (const snowflake of [BOT, OTHER_USER, "999999999999999999", CHANNEL]) assert.equal(prompt.includes(snowflake), false);
	assert.match(prompt, /\[Discord user mention\]/);
	assert.match(prompt, /\[Discord role mention\]/);
	assert.match(prompt, /\[Discord channel mention\]/);
});

test("DSG-002 accepts ingress and job atomically and deduplicates Gateway replay", () => {
	const { store } = fixture();
	const input = { sourceMessageId: "666666666666666666", scopeKey: "scope-1", jobId: "job-1", dispatchSequence: 42, backendId: "codex", backendCapabilities: { structuredProgress: true }, activityDetail: "structured" };
	assert.equal(store.acceptIngressAndCreateJob(input).duplicate, false);
	assert.equal(store.acceptIngressAndCreateJob({ ...input, jobId: "job-2" }).jobId, "job-1");
	assert.equal(store.listJobs().length, 1);
	assert.equal(store.getJob("job-1").events[0].kind, "job_accepted");
	store.close();
});

test("DSO-001 stores one bounded local request excerpt without assembled context", () => {
	const { store } = fixture();
	const privateRequest = `inspect token=supersecretvalue /home/user/private ${"가".repeat(700)}`;
	const input = { sourceMessageId: "666666666666666667", scopeKey: "scope-request", jobId: "job-request", backendId: "codex", backendCapabilities: { structuredProgress: true }, activityDetail: "structured", requestExcerpt: privateRequest };
	assert.equal(store.acceptIngressAndCreateJob(input).duplicate, false);
	assert.equal(store.acceptIngressAndCreateJob({ ...input, jobId: "job-request-replay" }).jobId, "job-request");
	const job = store.getJob("job-request");
	assert.deepEqual(job.events.map((event) => event.kind), ["job_accepted", "request_recorded"]);
	const request = job.events[1];
	assert.equal(request.redactionLevel, "local_safe");
	assert.equal(request.metrics.truncated, true);
	assert.match(request.safeSummary, /\[REDACTED\]/);
	assert.match(request.safeSummary, /\[LOCAL_PATH\]/);
	assert.ok(request.safeSummary.length <= 512);
	assert.equal(job.currentActivity, null);
	store.close();
});

test("DSG-003 records delivery before bounded same-nonce retries and never starts a second delivery", async () => {
	const { store, databasePath } = fixture();
	store.createJob({ jobId: "job-1", backendId: "codex", activityDetail: "structured", jobType: "conversation" });
	const attemptId = store.startAttempt("job-1", { attemptId: "attempt-1" });
	store.recordEvent({ jobId: "job-1", attemptId, kind: "attempt_exited", source: "helper", safePayload: { terminationKind: "exited", exitCode: 0 } });
	store.recordEvent({ jobId: "job-1", attemptId, kind: "attempt_succeeded", source: "helper", safePayload: {} });
	let posts = 0;
	const fetchImpl = async (_url, init) => {
		posts += 1;
		const body = JSON.parse(init.body);
		assert.deepEqual(body.allowed_mentions, { parse: [] });
		assert.equal(body.enforce_nonce, true);
		assert.equal(body.content.includes("/home/user"), false);
		throw new Error("connection lost after send");
	};
	const first = await deliverJobResult({ store, jobId: "job-1", attemptId, token: "token-value-long-enough", channelId: CHANNEL, botUserId: BOT, content: "done /home/user/private @everyone", fetchImpl });
	assert.equal(first.state, "unknown");
	const second = await deliverJobResult({ store, jobId: "job-1", attemptId, token: "token-value-long-enough", channelId: CHANNEL, botUserId: BOT, content: "done", fetchImpl });
	assert.equal(second.state, "unknown");
	assert.equal(posts, 3);
	assert.equal(store.getJob("job-1").lifecycle, "completed");
	assert.equal(store.getJob("job-1").deliveryState, "unknown");
	assert.match(store.getJob("job-1").events.at(-1).safeSummary, /network_result_unknown/);
	store.close();
	const bytes = readFileSync(databasePath);
	assert.equal(bytes.includes(Buffer.from("done /home/user/private")), false);
});

test("DSG-003 retries an uncertain Discord POST with the same deduplicating nonce", async () => {
	const nonces = [];
	const receipt = await postDiscordMessage({
		token: "token-value-long-enough", channelId: CHANNEL, content: "receipt", nonce: "stable-retry-nonce", botUserId: BOT, retryDelayMs: 0,
		fetchImpl: async (_url, init) => {
			const body = JSON.parse(init.body);
			nonces.push(body.nonce);
			if (nonces.length === 1) throw new Error("transient connection failure");
			return { ok: true, status: 200, json: async () => ({ id: "666666666666666666", channel_id: CHANNEL, author: { id: BOT }, nonce: body.nonce }) };
		},
	});
	assert.equal(receipt.state, "confirmed");
	assert.deepEqual(nonces, ["stable-retry-nonce", "stable-retry-nonce"]);
});

test("DSG-003 retries transient Discord server failures before recording a confirmed receipt", async () => {
	const nonces = [];
	const receipt = await postDiscordMessage({
		token: "token-value-long-enough", channelId: CHANNEL, content: "receipt", nonce: "stable-server-retry", botUserId: BOT, retryDelayMs: 0,
		fetchImpl: async (_url, init) => {
			const body = JSON.parse(init.body);
			nonces.push(body.nonce);
			if (nonces.length < 3) return { ok: false, status: 503 };
			return { ok: true, status: 200, json: async () => ({ id: "666666666666666666", channel_id: CHANNEL, author: { id: BOT }, nonce: body.nonce }) };
		},
	});
	assert.equal(receipt.state, "confirmed");
	assert.deepEqual(nonces, ["stable-server-retry", "stable-server-retry", "stable-server-retry"]);
});

test("FET_DSO_014_006 retries transient Discord failures and persists a bounded unknown-delivery reason", async () => {
	const { store } = fixture();
	store.createJob({ jobId: "delivery-unknown-job", backendId: "codex", activityDetail: "structured", jobType: "conversation" });
	const attemptId = store.startAttempt("delivery-unknown-job", { attemptId: "delivery-unknown-attempt" });
	store.recordEvent({ jobId: "delivery-unknown-job", attemptId, kind: "attempt_exited", source: "helper", safePayload: { terminationKind: "exited", exitCode: 0 } });
	store.recordEvent({ jobId: "delivery-unknown-job", attemptId, kind: "attempt_succeeded", source: "helper", safePayload: {} });
	let posts = 0;
	const result = await deliverJobResult({
		store, jobId: "delivery-unknown-job", attemptId, token: "token-value-long-enough", channelId: CHANNEL, botUserId: BOT, content: "done",
		fetchImpl: async () => { posts += 1; return { ok: false, status: 503 }; },
	});
	assert.equal(result.state, "unknown");
	assert.equal(posts, 3);
	const deliveryEvent = store.getJob("delivery-unknown-job").events.find((event) => event.kind === "delivery_unknown");
	assert.equal(deliveryEvent.safeSummary, "Delivery result requires review: server_response_unknown");
	store.close();
});

test("DSG-003 confirms a matching Discord receipt when the API omits the echoed nonce", async () => {
	const receipt = await postDiscordMessage({
		token: "token-value-long-enough", channelId: CHANNEL, content: "receipt", nonce: "accepted-request-nonce", botUserId: BOT,
		fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ id: "666666666666666666", channel_id: CHANNEL, author: { id: BOT } }) }),
	});
	assert.equal(receipt.state, "confirmed");
	assert.equal(receipt.messageId, "666666666666666666");
});

test("DSG-003 splits a long multibyte final response into bounded confirmed deliveries", async () => {
	const content = "분석결과 ".repeat(260);
	const chunks = splitDiscordContent(content);
	assert.equal(chunks.length > 1, true);
	assert.equal(chunks.every((chunk) => chunk.length <= 920 && Buffer.byteLength(chunk, "utf8") <= 1_520), true);
	const { store } = fixture();
	store.createJob({ jobId: "chunked-delivery-job", backendId: "codex", activityDetail: "structured", jobType: "conversation" });
	const attemptId = store.startAttempt("chunked-delivery-job", { attemptId: "chunked-delivery-attempt" });
	store.recordEvent({ jobId: "chunked-delivery-job", attemptId, kind: "attempt_exited", source: "helper", safePayload: { terminationKind: "exited", exitCode: 0 } });
	store.recordEvent({ jobId: "chunked-delivery-job", attemptId, kind: "attempt_succeeded", source: "helper", safePayload: {} });
	const posts = [];
	const result = await deliverJobResult({ store, jobId: "chunked-delivery-job", attemptId, token: "token-value-long-enough", channelId: CHANNEL, botUserId: BOT, content, fetchImpl: async (_url, init) => {
		const body = JSON.parse(init.body);
		posts.push(body);
		return { ok: true, status: 200, json: async () => ({ id: String(666666666666666666n + BigInt(posts.length)), channel_id: CHANNEL, author: { id: BOT }, nonce: body.nonce }) };
	} });
	assert.equal(result.state, "confirmed");
	assert.equal(posts.length, chunks.length);
	assert.equal(new Set(posts.map((post) => post.nonce)).size, posts.length);
	assert.equal(store.getJob("chunked-delivery-job").deliveryState, "delivered");
	store.close();
});

test("DSG-003 opens an operator DM and confirms the sent message identity", async () => {
	const calls = [];
	const receipt = await postDiscordDirectMessage({ token: "token-value-long-enough", userId: USER, content: "operator handoff", nonce: "dm-nonce", botUserId: BOT, fetchImpl: async (url, init) => {
		calls.push({ url, body: JSON.parse(init.body) });
		if (calls.length === 1) return { ok: true, status: 200, json: async () => ({ id: CHANNEL }) };
		return { ok: true, status: 200, json: async () => ({ id: "666666666666666666", channel_id: CHANNEL, author: { id: BOT }, nonce: "dm-nonce" }) };
	} });
	assert.equal(receipt.state, "confirmed");
	assert.deepEqual(calls[0].body, { recipient_id: USER });
	assert.equal(calls[1].url.endsWith(`/channels/${CHANNEL}/messages`), true);
});

test("DSG-003 delivery rejection is separate from completed worker execution", async () => {
	const { store } = fixture();
	store.createJob({ jobId: "delivery-failed-job", backendId: "codex", activityDetail: "structured", jobType: "conversation" });
	const attemptId = store.startAttempt("delivery-failed-job", { attemptId: "delivery-failed-attempt" });
	store.recordEvent({ jobId: "delivery-failed-job", attemptId, kind: "attempt_exited", source: "helper", safePayload: { terminationKind: "exited", exitCode: 0 } });
	store.recordEvent({ jobId: "delivery-failed-job", attemptId, kind: "attempt_succeeded", source: "helper", safePayload: {} });
	const result = await deliverJobResult({ store, jobId: "delivery-failed-job", attemptId, token: "token-value-long-enough", channelId: CHANNEL, botUserId: BOT, content: "done", fetchImpl: async () => ({ ok: false, status: 403 }) });
	assert.equal(result.state, "failed");
	assert.equal(store.getJob("delivery-failed-job").lifecycle, "completed");
	assert.equal(store.getJob("delivery-failed-job").deliveryState, "failed");
	store.close();
});
