import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizeHistoryRequest, authorizeReplyRequest, downloadDiscordAttachment, fetchDiscordHistory, sendDiscordReply } from "../helper/discord-history.mjs";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { protectOwnerOnly } from "../helper/platform-security.mjs";

const BOT = "111111111111111111";
const USER = "222222222222222222";
const OTHER = "333333333333333333";
const GUILD = "444444444444444444";
const CHANNEL = "555555555555555555";
const TOKEN = "fake-discord-token-value-long-enough";

function config(overrides = {}) {
	return {
		role: { allowedActions: ["read", "reply"] },
		discord: {
			botUserId: BOT,
			operatorUserIds: [USER],
			bindings: [{
				kind: "guild_channel",
				guildId: GUILD,
				channelId: CHANNEL,
				allowedUserIds: [USER],
				respondWhen: "mentioned",
				canStartConversation: false,
				operatorActions: true,
			}],
		},
		...overrides,
	};
}

function response(messages, { status = 200 } = {}) {
	return new Response(JSON.stringify(messages), { status, headers: { "content-type": "application/json" } });
}

function attachmentResponse(bytes, headers = {}) {
	const result = new Response(bytes, { status: 200, headers });
	Object.defineProperty(result, "url", { value: "https://cdn.discordapp.com/attachments/1/2/qa.xlsx" });
	return result;
}

test("DSO-003 history reads one exact operator binding without persistence", async () => {
	const requests = [];
	const result = await fetchDiscordHistory({
		config: config(),
		token: TOKEN,
		channelId: CHANNEL,
		fetchImpl: async (url, init) => {
			requests.push({ url, init });
			return response([
				{ id: "666666666666666666", channel_id: CHANNEL, timestamp: "2026-07-31T00:00:00.000Z", author: { id: USER, username: "Reviewer" }, content: "received sk-fake123456789 C:\\Users\\Public\\private" },
				{ id: "777777777777777777", channel_id: CHANNEL, timestamp: "2026-07-30T00:00:00.000Z", author: { id: OTHER, username: "Other" }, content: "must stay hidden" },
				{ id: "888888888888888888", channel_id: OTHER, timestamp: "2026-07-29T00:00:00.000Z", author: { id: USER, username: "Reviewer" }, content: "wrong channel" },
			]);
		},
	});
	assert.equal(requests.length, 1);
	assert.equal(requests[0].init.method, "GET");
	assert.equal(requests[0].init.headers.authorization, `Bot ${TOKEN}`);
	assert.equal(result.length, 1);
	assert.equal(result[0].authorId, USER);
	assert.equal(result[0].content.includes("secretvalue"), false);
	assert.equal(result[0].content.includes("C:\\Users"), false);
	assert.equal(JSON.stringify(result).includes(TOKEN), false);
	assert.equal(JSON.stringify(result).includes("must stay hidden"), false);
});

test("DSO-003 latest selects the newest authorized author response", async () => {
	const messages = await fetchDiscordHistory({
		config: config(),
		token: TOKEN,
		channelId: CHANNEL,
		authorId: USER,
		mode: "latest",
		fetchImpl: async () => response([
			{ id: "666666666666666666", channel_id: CHANNEL, timestamp: "2026-07-30T00:00:00.000Z", author: { id: USER, username: "Reviewer" }, content: "older" },
			{ id: "777777777777777777", channel_id: CHANNEL, timestamp: "2026-07-31T00:00:00.000Z", author: { id: USER, username: "Reviewer" }, content: "newer" },
		]),
	});
	assert.equal(messages.length, 1);
	assert.equal(messages[0].content, "newer");
});

test("DSO-005 history fails closed for role, binding, author, duplicate, and rate limit", async () => {
	assert.throws(() => authorizeHistoryRequest({ config: config({ role: { allowedActions: ["reply"] } }), channelId: CHANNEL }), /read role/);
	assert.throws(() => authorizeHistoryRequest({ config: config(), channelId: OTHER }), /uniquely authorized/);
	assert.throws(() => authorizeHistoryRequest({ config: config(), channelId: CHANNEL, authorId: OTHER }), /author is not authorized/);
	const duplicate = config();
	duplicate.discord.bindings.push({ ...duplicate.discord.bindings[0] });
	assert.throws(() => authorizeHistoryRequest({ config: duplicate, channelId: CHANNEL }), /uniquely authorized/);
	await assert.rejects(fetchDiscordHistory({ config: config(), token: TOKEN, channelId: CHANNEL, fetchImpl: async () => response([], { status: 429 }) }), /rate limited/);
	const participantOnly = config();
	participantOnly.discord.operatorUserIds = [OTHER];
	assert.throws(() => authorizeHistoryRequest({ config: participantOnly, channelId: CHANNEL }), /no authorized operator/);
});

test("DSO-005 history rejects malformed and oversized responses", async () => {
	await assert.rejects(fetchDiscordHistory({
		config: config(), token: TOKEN, channelId: CHANNEL,
		fetchImpl: async () => new Response("not-json", { status: 200 }),
	}), /invalid/);
	await assert.rejects(fetchDiscordHistory({
		config: config(), token: TOKEN, channelId: CHANNEL,
		fetchImpl: async () => new Response(`"${"x".repeat(1024 * 1024)}"`, { status: 200 }),
	}), /safe limit/);
});

test("DSO-003 reply sends one sanitized message to one exact operator binding", async () => {
	const root = mkdtempSync(join(tmpdir(), "naia-discord-reply-"));
	const contentPath = join(root, "report.txt");
	try {
		protectOwnerOnly(root, "directory");
		writeFileSync(contentPath, "handoff C:\\Users\\Public\\private", { mode: 0o600 });
		protectOwnerOnly(contentPath, "file");
		let body;
		const result = await sendDiscordReply({
			config: config(),
			token: TOKEN,
			channelId: CHANNEL,
			contentPath,
			fetchImpl: async (_url, init) => {
				body = JSON.parse(init.body);
				return new Response(JSON.stringify({
					id: "666666666666666666",
					channel_id: CHANNEL,
					author: { id: BOT, bot: true },
					nonce: body.nonce,
				}), { status: 200, headers: { "content-type": "application/json" } });
			},
		});
		assert.equal(result.state, "confirmed");
		assert.deepEqual(body.allowed_mentions, { parse: ["users"] });
		assert.equal(body.allowed_mentions.parse.includes("everyone"), false);
		assert.equal(body.content.includes("C:\\Users"), false);
		assert.equal(JSON.stringify(body).includes(TOKEN), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("DSO-005 reply is default-deny for role and ambiguous binding", () => {
	assert.throws(() => authorizeReplyRequest({ config: config({ role: { allowedActions: ["read"] } }), channelId: CHANNEL }), /reply role/);
	const duplicate = config();
	duplicate.discord.bindings.push({ ...duplicate.discord.bindings[0] });
	assert.throws(() => authorizeReplyRequest({ config: duplicate, channelId: CHANNEL }), /uniquely authorized/);
});

test("DSO-005 reply treats a success response with a mismatched nonce as unknown", async () => {
	const root = mkdtempSync(join(tmpdir(), "naia-discord-reply-nonce-"));
	const contentPath = join(root, "report.txt");
	try {
		protectOwnerOnly(root, "directory");
		writeFileSync(contentPath, "handoff", { mode: 0o600 });
		protectOwnerOnly(contentPath, "file");
		const result = await sendDiscordReply({
			config: config(), token: TOKEN, channelId: CHANNEL, contentPath,
			fetchImpl: async () => new Response(JSON.stringify({
				id: "666666666666666666", channel_id: CHANNEL, author: { id: BOT, bot: true }, nonce: "different-request-nonce",
			}), { status: 200, headers: { "content-type": "application/json" } }),
		});
		assert.equal(result.state, "unknown");
		assert.equal(result.reasonCode, "receipt_identity_mismatch");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("DSO-003 attachment recovery verifies exact authorized message and SHA-256", async () => {
	const root = mkdtempSync(join(tmpdir(), "naia-discord-attachment-"));
	const outputPath = join(root, "qa.xlsx");
	const bytes = Buffer.from("deterministic-xlsx-fixture");
	const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
	let request = 0;
	try {
		protectOwnerOnly(root, "directory");
		const result = await downloadDiscordAttachment({
			config: config(),
			token: TOKEN,
			channelId: CHANNEL,
			messageId: "666666666666666666",
			attachmentId: "777777777777777777",
			outputPath,
			expectedSha256,
			fetchImpl: async (_url, init) => {
				request += 1;
				if (request === 1) return response({
						id: "666666666666666666",
						channel_id: CHANNEL,
						author: { id: BOT, bot: true },
						attachments: [{ id: "777777777777777777", size: bytes.length, url: "https://cdn.discordapp.com/attachments/1/2/qa.xlsx" }],
					});
				assert.equal(init.headers.authorization, undefined);
				return attachmentResponse(bytes, { "content-length": String(bytes.length) });
			},
		});
		assert.equal(result.state, "downloaded");
		assert.equal(result.sha256, expectedSha256);
		assert.deepEqual(readFileSync(outputPath), bytes);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("DSO-005 attachment recovery stops an oversized streamed body before buffering it", async () => {
	const root = mkdtempSync(join(tmpdir(), "naia-discord-attachment-limit-"));
	const expected = Buffer.from("1234");
	let request = 0;
	try {
		protectOwnerOnly(root, "directory");
		await assert.rejects(downloadDiscordAttachment({
			config: config(),
			token: TOKEN,
			channelId: CHANNEL,
			messageId: "666666666666666666",
			attachmentId: "777777777777777777",
			outputPath: join(root, "qa.xlsx"),
			fetchImpl: async () => {
				request += 1;
				if (request === 1) return response({
						id: "666666666666666666",
						channel_id: CHANNEL,
						author: { id: BOT, bot: true },
						attachments: [{ id: "777777777777777777", size: expected.length, url: "https://cdn.discordapp.com/attachments/1/2/qa.xlsx" }],
					});
				return attachmentResponse(Buffer.from("12345"));
			},
		}), /safe size limit/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
