import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { buildAgentContextSnapshot } from "../helper/agent-context.mjs";
import { DiscordMessageRouter } from "../helper/discord-router.mjs";
import { BOT, CHANNEL, GUILD, RUNTIME_REVISION, USER, cleanupDiscordFixtureRoots, fixture } from "./fixtures/discord-fixture.mjs";

afterEach(cleanupDiscordFixtureRoots);

function context(root, name) {
	const workspace = join(root, name);
	mkdirSync(join(workspace, ".agents"), { recursive: true });
	writeFileSync(join(workspace, "AGENTS.md"), `# ${name}\n`, "utf8");
	writeFileSync(join(workspace, ".agents", "policy.yaml"), `workspace: ${name}\n`, "utf8");
	const snapshot = buildAgentContextSnapshot({ workspace, agentId: `${name}-agent`, entrypoint: "AGENTS.md", contextFiles: [".agents/policy.yaml"] });
	return { cwd: workspace, allowedPaths: [workspace], snapshot };
}

function routingConfig(profiles) {
	return {
		schemaVersion: 2,
		agentProfiles: {
			corp: { workspace: { agentId: "corp-agent", allowedPaths: [profiles.corp.cwd] }, persona: { name: "Corp agent", instructions: "Handle the configured company workspace." } },
			personal: { workspace: { agentId: "personal-agent", allowedPaths: [profiles.personal.cwd] }, persona: { name: "Personal agent", instructions: "Handle the configured personal workspace." } },
		},
		persona: { name: "fallback", instructions: "unused" },
		role: { name: "operator", allowedActions: ["read", "reply", "write", "execute"], requiresApproval: [] },
		backend: { selected: "codex", profiles: { codex: { enabled: true } } },
		discord: {
			bindings: [
				{ kind: "guild_channel", guildId: GUILD, channelId: CHANNEL, allowedUserIds: [USER], respondWhen: "mentioned", canStartConversation: true, operatorActions: true, historyVisibility: "none", agentProfileId: "corp" },
				{ kind: "dm", userId: USER, allowedUserIds: [USER], respondWhen: "always", canStartConversation: true, operatorActions: true, historyVisibility: "none", agentProfileId: "personal" },
			],
			operatorUserIds: [USER],
			participantProfiles: { [USER]: { label: "workspace-owner", relationship: "workspace owner", allowedActions: ["read", "reply", "write", "execute"] } },
		},
		runtime: { maxConcurrentJobs: 2, approvalPolicy: "never", permissionProfileEpoch: "routing-v1" },
		recovery: { autoRetry: false },
	};
}

test("multi-agent bindings select their own context and persona without copying another profile", async () => {
	const { root, store } = fixture();
	const profiles = { corp: context(root, "corp"), personal: context(root, "personal") };
	const calls = [];
	const router = new DiscordMessageRouter({
		config: routingConfig(profiles),
		store,
		token: "token-value-long-enough",
		botUserId: BOT,
		cwd: profiles.corp.cwd,
		allowedPaths: profiles.corp.allowedPaths,
		agentContextSnapshot: profiles.corp.snapshot,
		agentContexts: profiles,
		runtimeRoot: join(root, "runtime"),
		runtimeRevision: RUNTIME_REVISION,
		send: async () => ({ state: "confirmed" }),
		runner: async (input) => {
			calls.push(input);
			return { backendOutcome: "failure", transientResult: null };
		},
	});
	const guildResult = await router.onDispatch("MESSAGE_CREATE", { id: "666666666666666661", guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> company request` }, 1);
	const dmResult = await router.onDispatch("MESSAGE_CREATE", { id: "666666666666666662", channel_id: "777777777777777777", author: { id: USER }, mentions: [], content: "personal request" }, 2);
	await router.waitForIdle();
	assert.equal(guildResult.state, "accepted");
	assert.equal(dmResult.state, "accepted");
	assert.equal(calls.length, 2);
	const guild = calls.find((call) => call.prompt.includes("company request"));
	const personal = calls.find((call) => call.prompt.includes("personal request"));
	assert.equal(guild.cwd, profiles.corp.cwd);
	assert.deepEqual(guild.allowedPaths, profiles.corp.allowedPaths);
	assert.match(guild.prompt, /Persona: Corp agent/);
	assert.match(guild.prompt, new RegExp(`Context-SHA256: ${profiles.corp.snapshot.contextHash}`));
	assert.equal(personal.cwd, profiles.personal.cwd);
	assert.deepEqual(personal.allowedPaths, profiles.personal.allowedPaths);
	assert.match(personal.prompt, /Persona: Personal agent/);
	assert.match(personal.prompt, new RegExp(`Context-SHA256: ${profiles.personal.snapshot.contextHash}`));
	assert.notEqual(profiles.corp.snapshot.contextHash, profiles.personal.snapshot.contextHash);
	store.close();
});

test("closed-window notice stays before the User request block when history is loaded", async () => {
	const { root, store } = fixture();
	const workspace = context(root, "history");
	const config = routingConfig({ corp: workspace, personal: workspace });
	config.agentProfiles = { corp: config.agentProfiles.corp };
	config.discord.bindings = [{ ...config.discord.bindings[0], historyVisibility: "shared", agentProfileId: "corp" }];
	config.discord.participantProfiles[USER].mutationWindow = { timezone: "UTC", days: [1], start: "09:00", end: "18:00" };
	const calls = [];
	const router = new DiscordMessageRouter({
		config,
		store,
		token: "token-value-long-enough",
		botUserId: BOT,
		cwd: workspace.cwd,
		allowedPaths: workspace.allowedPaths,
		agentContextSnapshot: workspace.snapshot,
		agentContexts: { corp: workspace },
		runtimeRoot: join(root, "runtime"),
		runtimeRevision: RUNTIME_REVISION,
		now: () => Date.parse("2026-09-07T18:00:00Z"),
		send: async () => ({ state: "confirmed" }),
		loadHistory: async () => ({ state: "loaded", history: "participant[workspace-owner]: earlier context", messageCount: 1 }),
		runner: async (input) => {
			calls.push(input);
			return { backendOutcome: "failure", transientResult: null };
		},
	});
	const accepted = await router.onDispatch("MESSAGE_CREATE", { id: "666666666666666663", guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> closed request` }, 3);
	await router.waitForIdle();
	assert.equal(accepted.state, "accepted");
	assert.equal(calls.length, 1);
	const prompt = calls[0].prompt;
	const snapshotEnd = prompt.indexOf("Persona: Corp agent");
	const notice = prompt.indexOf("Mutation window:");
	const history = prompt.indexOf("Discord recent conversation");
	const request = prompt.lastIndexOf("User request:\nclosed request");
	assert.ok(snapshotEnd >= 0);
	assert.ok(notice > snapshotEnd);
	assert.ok(history > notice);
	assert.ok(request > history);
	assert.match(prompt, /Mutation window:[\s\S]*Discord recent conversation[\s\S]*earlier context[\s\S]*User request:\nclosed request$/);
	store.close();
});
