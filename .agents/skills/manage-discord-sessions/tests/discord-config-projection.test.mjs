import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { authorizeDiscordMessage } from "../helper/discord-scope.mjs";
import { DiscordMessageRouter } from "../helper/discord-router.mjs";
import { DiscordStatusProjection } from "../helper/discord-projection.mjs";
import { FileCredentialResolver, loadMessengerConfig } from "../helper/discord-config.mjs";
import { protectOwnerOnly } from "../helper/platform-security.mjs";
import { BOT, CHANNEL, GUILD, OTHER_USER, USER, binding, cleanupDiscordFixtureRoots, fixture, widenTestAcl } from "./fixtures/discord-fixture.mjs";

afterEach(cleanupDiscordFixtureRoots);

test("DSG-009 participant status projection is limited to the current Discord scope", async () => {
	const { store, root } = fixture();
	const config = { persona: { name: "Reviewer", instructions: "Review." }, role: { name: "reader", allowedActions: ["read", "reply"] }, backend: { selected: "codex" }, discord: { bindings: [binding()], operatorUserIds: [] }, runtime: { maxConcurrentJobs: 1 } };
	const scope = authorizeDiscordMessage({ message: { guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }] }, bindings: config.discord.bindings, botUserId: BOT }).scopeKey;
	store.createJob({ jobId: "visible-job", backendId: "codex", activityDetail: "structured", jobType: "conversation", scopeKey: scope });
	store.createJob({ jobId: "hidden-job", backendId: "codex", activityDetail: "structured", jobType: "conversation", scopeKey: "different-scope" });
	const sent = [];
	const router = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), send: async (input) => { sent.push(input); return { state: "confirmed" }; } });
	const result = await router.onDispatch("MESSAGE_CREATE", { id: "999999999999999999", guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> !naia jobs` }, 9);
	assert.equal(result.state, "command_handled");
	assert.equal(sent[0].content.includes("visible-job"), true);
	assert.equal(sent[0].content.includes("hidden-job"), false);
	store.close();
});

test("DSG-010 approval-required actions are removed from unattended access and prompts", async () => {
	const { store, root } = fixture();
	const calls = [];
	const config = { persona: { name: "Builder", instructions: "Work safely." }, role: { name: "guarded", allowedActions: ["read", "reply", "write", "execute"], requiresApproval: ["write", "execute"] }, backend: { selected: "claude" }, discord: { bindings: [binding()], operatorUserIds: [] }, runtime: { maxConcurrentJobs: 1, approvalPolicy: "never" } };
	const router = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), send: async () => ({ state: "confirmed" }), runner: async (input) => { calls.push(input); return { backendOutcome: "failure", transientResult: null }; } });
	await router.onDispatch("MESSAGE_CREATE", { id: "121212121212121212", guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> change a file` }, 10);
	await router.waitForIdle();
	assert.deepEqual(calls[0].commandOptions, { permissionMode: "plan", approvalPolicy: "never" });
	assert.match(calls[0].prompt, /Allowed actions: read, reply/);
	assert.equal(calls[0].prompt.includes("Allowed actions: read, reply, write"), false);
	store.close();
});

test("DSG-011 creates, pins, and updates one scoped Discord status projection", async () => {
	const { store } = fixture();
	store.createJob({ jobId: "visible-job", backendId: "codex", activityDetail: "structured", jobType: "conversation", scopeKey: "scope-1" });
	store.createJob({ jobId: "hidden-job", backendId: "codex", activityDetail: "structured", jobType: "conversation", scopeKey: "scope-2" });
	const requests = [];
	const fetchImpl = async (url, init) => {
		requests.push({ url, init });
		if (init.method === "POST") return { ok: true, status: 200, json: async () => ({ id: "141414141414141414", channel_id: CHANNEL, author: { id: BOT }, nonce: JSON.parse(init.body).nonce }) };
		return { ok: true, status: 204, json: async () => ({}) };
	};
	const projection = new DiscordStatusProjection({ store, token: "token-value-long-enough", botUserId: BOT, fetchImpl });
	assert.equal((await projection.publishScope({ scopeKey: "scope-1", channelId: CHANNEL })).state, "created");
	assert.equal(requests.some((item) => item.url.includes("/pins/")), true);
	assert.equal(requests[0].init.body.includes("visible-job"), true);
	assert.equal(requests[0].init.body.includes("hidden-job"), false);
	assert.equal((await projection.publishScope({ scopeKey: "scope-1", channelId: CHANNEL })).state, "updated");
	assert.equal(requests.at(-1).init.method, "PATCH");
	store.close();
});

test("DSG-012 loads only private closed settings and resolves an owner-only credential reference", () => {
	const { root, store } = fixture();
	store.close();
	const configPath = join(root, "config.json");
	const config = { schemaVersion: 1, enabled: true, workspaceId: "test", persona: { name: "Reviewer", instructions: "Review." }, role: { name: "reader", allowedActions: ["read", "reply"], requiresApproval: ["write"] }, backend: { selected: "codex", profiles: { codex: { enabled: true }, claude: { enabled: false } } }, discord: { credentialRef: "discord-token", botUserId: BOT, operatorUserIds: [], bindings: [binding()] }, runtime: { heartbeatSeconds: 10, softSilenceSeconds: 120, noProgressInterventionSeconds: 120, operatorResponseSeconds: 30, approvalPolicy: "never", permissionProfileEpoch: "profile-1", maxConcurrentJobs: 1 }, observability: { discordStatusProjection: true }, service: { autoStart: true, startAt: "login" }, recovery: { autoRetry: true } };
	writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
	protectOwnerOnly(configPath, "file", "test config");
	assert.equal(loadMessengerConfig(configPath).backend.selected, "codex");
	writeFileSync(configPath, JSON.stringify({ ...config, runtime: { ...config.runtime, approvalPolicy: "managed" } }), { mode: 0o600 });
	assert.throws(() => loadMessengerConfig(configPath), /explicitly set to never/);
	writeFileSync(configPath, JSON.stringify({ ...config, runtime: { ...config.runtime, approvalPolicy: undefined } }), { mode: 0o600 });
	assert.throws(() => loadMessengerConfig(configPath), /explicitly set to never/);
	writeFileSync(configPath, JSON.stringify({ ...config, runtime: { ...config.runtime, conversationCoordinator: true } }), { mode: 0o600 });
	assert.throws(() => loadMessengerConfig(configPath), /unsupported field/);
	writeFileSync(configPath, JSON.stringify({ ...config, unexpected: true }), { mode: 0o600 });
	assert.throws(() => loadMessengerConfig(configPath), /unsupported field/);
	writeFileSync(configPath, JSON.stringify(config), { mode: 0o644 });
	widenTestAcl(configPath);
	assert.throws(() => loadMessengerConfig(configPath), /owner-only/);
	const keyDirectory = join(root, "keys");
	mkdirSync(keyDirectory, { mode: 0o700 });
	const keyPath = join(keyDirectory, "discord-token");
	writeFileSync(keyPath, "credential-value-long-enough", { mode: 0o600 });
	protectOwnerOnly(keyDirectory, "directory", "test credential directory");
	protectOwnerOnly(keyPath, "file", "test credential");
	assert.equal(new FileCredentialResolver(keyDirectory).resolve("discord-token"), "credential-value-long-enough");
	widenTestAcl(keyPath);
	assert.throws(() => new FileCredentialResolver(keyDirectory).resolve("discord-token"), /owner-only/);
});

test("DSG-021 validates schema v2 workspace, exact participant coverage, and safe labels", () => {
	const { root, store } = fixture();
	store.close();
	const configPath = join(root, "participant-config.json");
	const base = {
		schemaVersion: 2, enabled: true, workspaceId: "test",
		workspace: { path: ".", agentId: "aipol", entrypoint: "AGENTS.md", contextFiles: [".agents/context/agents-rules.json"] },
		persona: { name: "Reviewer", instructions: "Review." },
		role: { name: "builder", allowedActions: ["read", "reply", "write", "execute"], requiresApproval: [] },
		backend: { selected: "codex", profiles: { codex: { enabled: true }, claude: { enabled: false } } },
		discord: { credentialRef: "discord-token", botUserId: BOT, operatorUserIds: [USER], participantProfiles: { [USER]: { label: "workspace-owner", relationship: "workspace owner", allowedActions: ["read", "reply", "write", "execute"] } }, bindings: [{ ...binding(), operatorActions: true, historyVisibility: "requester_only" }] },
		runtime: { heartbeatSeconds: 10, softSilenceSeconds: 120, noProgressInterventionSeconds: 120, operatorResponseSeconds: 30, approvalPolicy: "never", permissionProfileEpoch: "profile-2", maxConcurrentJobs: 1 },
		observability: { discordStatusProjection: true }, service: { autoStart: true, startAt: "login" }, recovery: { autoRetry: true },
	};
	const load = (config) => { writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 }); protectOwnerOnly(configPath, "file", "test config"); return loadMessengerConfig(configPath); };
	const loaded = load(base);
	assert.deepEqual(loaded.discord.participantProfiles[USER].allowedActions, ["read", "reply", "write", "execute"]);
	assert.equal(loaded.discord.bindings[0].historyVisibility, "requester_only");
	assert.equal(loaded.backend.profiles.codex.costProfile, "balanced");
	assert.equal(load({ ...base, backend: { ...base.backend, profiles: { ...base.backend.profiles, codex: { enabled: true, costProfile: "control" } } } }).backend.profiles.codex.costProfile, "control");
	assert.throws(() => load({ ...base, backend: { ...base.backend, profiles: { ...base.backend.profiles, codex: { enabled: true, costProfile: "unknown" } } } }), /costProfile is invalid/);
	assert.throws(() => load({ ...base, discord: { ...base.discord, participantProfiles: {} } }), /exactly cover/);
	assert.throws(() => load({ ...base, discord: { ...base.discord, participantProfiles: { [USER]: { ...base.discord.participantProfiles[USER], label: "system" } } } }), /reserved/);
	assert.throws(() => load({ ...base, discord: { ...base.discord, participantProfiles: { [USER]: { ...base.discord.participantProfiles[USER], relationship: "owner\ninjected" } } } }), /single line/);
	assert.throws(() => load({ ...base, discord: { ...base.discord, bindings: [{ ...base.discord.bindings[0], allowedUserIds: [USER, OTHER_USER] }], participantProfiles: { ...base.discord.participantProfiles, [OTHER_USER]: { label: "guest", relationship: "external participant", allowedActions: ["read", "reply"] } } } }), /trusted host operators/);
	assert.throws(() => load({ ...base, role: { ...base.role, allowedActions: ["read", "reply", "write"] } }), /write and execute together/);
	assert.throws(() => load({ ...base, backend: { selected: "claude", profiles: { codex: { enabled: false }, claude: { enabled: true } } } }), /read\/reply only/);
	assert.throws(() => load({ ...base, discord: { ...base.discord, bindings: [{ ...binding(), operatorActions: true }] } }), /historyVisibility must be explicit/);
});

test("DSG-021 keeps schema v1 compatible while closing multi-user mutation and history", () => {
	const { root, store } = fixture();
	store.close();
	const configPath = join(root, "legacy-config.json");
	const base = {
		schemaVersion: 1, enabled: true, workspaceId: "test", persona: { name: "Reviewer", instructions: "Review." },
		role: { name: "reader", allowedActions: ["read", "reply"], requiresApproval: [] }, backend: { selected: "codex", profiles: { codex: { enabled: true } } },
		discord: { credentialRef: "discord-token", botUserId: BOT, operatorUserIds: [], bindings: [{ ...binding(), allowedUserIds: [USER, OTHER_USER] }] },
		runtime: { approvalPolicy: "never", permissionProfileEpoch: "legacy", maxConcurrentJobs: 1 }, service: { autoStart: true, startAt: "login" }, recovery: { autoRetry: false },
	};
	const load = (config) => { writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 }); protectOwnerOnly(configPath, "file", "test config"); return loadMessengerConfig(configPath); };
	assert.equal(load(base).discord.bindings[0].historyVisibility, "none");
	const mutation = { ...base, role: { name: "builder", allowedActions: ["read", "reply", "write"], requiresApproval: [] }, discord: { ...base.discord, operatorUserIds: [USER, OTHER_USER], bindings: [{ ...base.discord.bindings[0], operatorActions: true }] } };
	assert.throws(() => load(mutation), /cannot grant mutation in a multi-user binding/);
});
