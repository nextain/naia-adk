import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { buildAgentContextSnapshot } from "../helper/agent-context.mjs";
import { loadMessengerConfig } from "../helper/discord-config.mjs";
import { DiscordMessageRouter } from "../helper/discord-router.mjs";
import { configuredAgentContexts } from "../helper/service-runtime.mjs";
import { BOT, CHANNEL, GUILD, RUNTIME_REVISION, USER, cleanupDiscordFixtureRoots, fixture } from "./fixtures/discord-fixture.mjs";

after(cleanupDiscordFixtureRoots);

function context(root, name) {
	const workspace = join(root, name);
	mkdirSync(join(workspace, ".agents"), { recursive: true });
	writeFileSync(join(workspace, "AGENTS.md"), `# ${name}\n`, "utf8");
	writeFileSync(join(workspace, ".agents/policy.yaml"), `workspace: ${name}\n`, "utf8");
	const snapshot = buildAgentContextSnapshot({ workspace, agentId: `${name}-agent`, entrypoint: "AGENTS.md", contextFiles: [".agents/policy.yaml"] });
	return { cwd: workspace, allowedPaths: [workspace], snapshot };
}

test("FET_DSO_016_001 routes exact Discord bindings to isolated workspace and persona profiles", async () => {
	const { root, store } = fixture();
	const onmam = context(root, "onmam");
	const luke = context(root, "luke");
	const channelBinding = { kind: "guild_channel", guildId: GUILD, channelId: CHANNEL, allowedUserIds: [USER], respondWhen: "mentioned", canStartConversation: true, operatorActions: true, historyVisibility: "none", agentProfileId: "onmam" };
	const dmBinding = { kind: "dm", userId: USER, allowedUserIds: [USER], respondWhen: "always", canStartConversation: true, operatorActions: true, historyVisibility: "none", agentProfileId: "luke" };
	const config = {
		schemaVersion: 2,
		agentProfiles: {
			onmam: { workspace: { agentId: "onmam-agent", allowedPaths: [onmam.cwd] }, persona: { name: "온맘봇", instructions: "온맘 채널 업무를 처리한다." } },
			luke: { workspace: { agentId: "luke-agent", allowedPaths: [luke.cwd] }, persona: { name: "Luke봇", instructions: "Luke DM 업무를 처리한다." } },
		},
		persona: { name: "fallback", instructions: "unused" }, role: { name: "developer", allowedActions: ["read", "reply", "write", "execute"], requiresApproval: [] },
		backend: { selected: "codex", profiles: { codex: { enabled: true } } },
		discord: { bindings: [channelBinding, dmBinding], operatorUserIds: [USER], participantProfiles: { [USER]: { label: "owner", relationship: "workspace owner", allowedActions: ["read", "reply", "write", "execute"] } } },
		runtime: { maxConcurrentJobs: 2, approvalPolicy: "never", permissionProfileEpoch: "routing-v1" }, recovery: { autoRetry: false },
	};
	const calls = [];
	const router = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: onmam.cwd, allowedPaths: onmam.allowedPaths, agentContextSnapshot: onmam.snapshot, agentContexts: { onmam, luke }, runtimeRoot: join(root, "runtime"), runtimeRevision: RUNTIME_REVISION, send: async () => ({ state: "confirmed" }), runner: async (input) => { calls.push(input); return { backendOutcome: "failure", transientResult: null }; } });
	await router.onDispatch("MESSAGE_CREATE", { id: "666666666666666661", guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> channel work` }, 1);
	await router.onDispatch("MESSAGE_CREATE", { id: "666666666666666662", channel_id: "777777777777777777", author: { id: USER }, mentions: [], content: "dm work" }, 2);
	await router.waitForIdle();
	assert.equal(calls.length, 2);
	const channel = calls.find((call) => call.prompt.includes("channel work"));
	const dm = calls.find((call) => call.prompt.includes("dm work"));
	assert.equal(channel.cwd, onmam.cwd);
	assert.deepEqual(channel.allowedPaths, [onmam.cwd]);
	assert.match(channel.prompt, /Persona: 온맘봇/);
	assert.equal(dm.cwd, luke.cwd);
	assert.deepEqual(dm.allowedPaths, [luke.cwd]);
	assert.match(dm.prompt, /Persona: Luke봇/);
	store.close();
});

test("FET_DSO_016_002 validates external agent profiles and rejects an unknown binding profile", () => {
	const { root, store } = fixture();
	store.close();
	const onmam = context(root, "external-onmam");
	const config = {
		schemaVersion: 2, enabled: true, workspaceId: "routing-test",
		agentProfiles: { onmam: { workspace: { path: onmam.cwd, allowedPaths: [onmam.cwd], agentId: "external-onmam-agent", entrypoint: "AGENTS.md", contextFiles: [".agents/policy.yaml"] }, persona: { name: "온맘봇", instructions: "Handle the configured channel." } } },
		persona: { name: "fallback", instructions: "unused" }, role: { name: "operator", allowedActions: ["read", "reply"], requiresApproval: [] },
		backend: { selected: "codex", profiles: { codex: { enabled: true } } },
		discord: { credentialRef: "test-token", botUserId: BOT, operatorUserIds: [USER], participantProfiles: { [USER]: { label: "owner", relationship: "owner", allowedActions: ["read", "reply"] } }, bindings: [{ kind: "guild_channel", guildId: GUILD, channelId: CHANNEL, allowedUserIds: [USER], respondWhen: "mentioned", canStartConversation: true, operatorActions: false, historyVisibility: "none", agentProfileId: "onmam" }] },
		runtime: { approvalPolicy: "never" }, service: {}, recovery: {}, observability: {},
	};
	const path = join(root, "config.json");
	writeFileSync(path, JSON.stringify(config), { encoding: "utf8", mode: 0o600 });
	const loaded = loadMessengerConfig(path);
	assert.equal(configuredAgentContexts(root, loaded).onmam.cwd, onmam.cwd);
	config.discord.bindings[0].agentProfileId = "missing";
	writeFileSync(path, JSON.stringify(config), { encoding: "utf8", mode: 0o600 });
	assert.throws(() => loadMessengerConfig(path), /unknown agent profile/);
});
