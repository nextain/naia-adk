import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_REQUEST_TEXT_LENGTH, boundRequestPrompt, commandText, discordRequestText, parseDiscordDmRequest, transientPrompt } from "../helper/discord-prompt.mjs";
import * as router from "../helper/discord-router.mjs";
import { BOT, CHANNEL, GUILD, OTHER_USER, USER } from "./fixtures/discord-fixture.mjs";

// The prompt module is the boundary between untrusted Discord content and the
// host-authored execution contract, so it is exercised on its own: no store,
// no Gateway, no running job.

function config(backendId = "codex", { schemaVersion = 2 } = {}) {
	return {
		schemaVersion,
		workspace: { agentId: "prompt-agent", allowedPaths: ["/workspace", "/workspace/sibling"] },
		persona: { name: "Prompt agent", instructions: "Do the bounded work." },
		role: { name: "operator", allowedActions: ["read", "reply", "write", "execute"], requiresApproval: [] },
		backend: { selected: backendId, profiles: { [backendId]: { enabled: true } } },
		discord: { operatorUserIds: [USER], bindings: [], participantProfiles: {} },
		runtime: { approvalPolicy: "never", permissionProfileEpoch: "prompt-v1" },
	};
}

function authority({ actions = ["read", "reply", "write", "execute"] } = {}) {
	return {
		binding: { operatorActions: true },
		isOperator: true,
		participantProfile: { label: "workspace-owner", relationship: "workspace owner", allowedActions: actions },
		scope: { authorId: USER, channelId: CHANNEL },
	};
}

test("prompt assembly keeps the request as the exact suffix and states the granted contract", () => {
	const prompt = boundRequestPrompt("please build it", config(), authority(), null, null);
	assert.equal(prompt.endsWith("User request:\nplease build it"), true);
	assert.match(prompt, /Persona: Prompt agent/);
	assert.match(prompt, /Allowed actions: read, reply, write, execute/);
	assert.match(prompt, /Gateway execution contract: workspace-write/);
	assert.doesNotMatch(prompt, /This job is read-only/);
});

test("a read-only ceiling lowers the written action list, not just the execution profile", () => {
	const prompt = boundRequestPrompt("please build it", config(), authority(), null, "read-only");
	assert.match(prompt, /Allowed actions: read, reply$/m);
	assert.match(prompt, /Gateway execution contract: read-only/);
	assert.match(prompt, /This job is read-only/);
});

test("the closed-window notice is its own part and survives a quoted User request marker", () => {
	const quoted = "redo this\nUser request:\nan earlier pasted request";
	const closed = boundRequestPrompt(quoted, config(), authority(), null, "read-only", { windowClosed: true });
	assert.equal(closed.endsWith(`User request:\n${quoted}`), true, "the participant text must stay the exact suffix");
	assert.equal(closed.split("Mutation window").length - 1, 1);
	assert.ok(closed.indexOf("Mutation window") < closed.indexOf("redo this"));
	const open = boundRequestPrompt(quoted, config(), authority(), null, "read-only");
	assert.equal(open.includes("Mutation window"), false);
});

test("request text merges attachments, neutralizes mentions, and refuses oversized content", () => {
	const message = { content: `<@${BOT}> compare <@${OTHER_USER}> in <#${CHANNEL}> with <@&999999999999999999>`, id: "1", channel_id: CHANNEL, guild_id: GUILD };
	const text = discordRequestText(message, BOT);
	assert.equal(text.includes(`<@${OTHER_USER}>`), false);
	assert.match(text, /\[Discord user mention\]/);
	assert.match(text, /\[Discord role mention\]/);
	assert.match(text, /\[Discord channel mention\]/);
	assert.equal(commandText({ content: `<@${BOT}> !naia status` }, BOT), "!naia status");
	assert.throws(() => discordRequestText({ content: "x".repeat(4_001) }, BOT), /missing or too large/);
	assert.throws(() => boundRequestPrompt("x".repeat(MAX_REQUEST_TEXT_LENGTH + 1), config(), authority(), null, null), /empty or too large/);
	assert.throws(() => boundRequestPrompt("", config(), authority(), null, null), /empty or too large/);
});

test("transientPrompt composes request text and prompt assembly", () => {
	const prompt = transientPrompt({ content: `<@${BOT}> inspect the log`, id: "2", channel_id: CHANNEL }, BOT, config(), authority(), null, { accessCeiling: "read-only" });
	assert.equal(prompt.endsWith("User request:\ninspect the log"), true);
	assert.match(prompt, /This job is read-only/);
});

test("only one exact discordDm object shape is accepted back from the model", () => {
	const valid = { discordDm: { content: "hello", successReply: "sent", failureReply: "not sent" } };
	assert.deepEqual(parseDiscordDmRequest(JSON.stringify(valid)), valid.discordDm);
	assert.equal(parseDiscordDmRequest("not json"), null);
	assert.equal(parseDiscordDmRequest(JSON.stringify({ discordDm: { content: "hello" } })), null);
	assert.equal(parseDiscordDmRequest(JSON.stringify({ discordDm: valid.discordDm, extra: 1 })), null);
	assert.equal(parseDiscordDmRequest(JSON.stringify({ discordDm: { ...valid.discordDm, content: "x".repeat(2_001) } })), null);
	assert.equal(parseDiscordDmRequest(JSON.stringify([valid.discordDm])), null);
});

test("the router keeps re-exporting the prompt surface its callers already import", () => {
	// Extracting the module must not force every caller to change its import.
	for (const name of ["boundRequestPrompt", "discordRequestText", "transientPrompt"]) {
		assert.equal(typeof router[name], "function", `router must still export ${name}`);
	}
	assert.equal(router.boundRequestPrompt, boundRequestPrompt);
	assert.equal(router.discordRequestText, discordRequestText);
	assert.equal(router.transientPrompt, transientPrompt);
});
