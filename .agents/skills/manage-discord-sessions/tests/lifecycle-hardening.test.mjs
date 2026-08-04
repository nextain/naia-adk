import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { buildAgentContextSnapshot } from "../helper/agent-context.mjs";
import { DiscordStatusProjection } from "../helper/discord-projection.mjs";
import { DiscordMessageRouter } from "../helper/discord-router.mjs";
import { RecoveryCodec } from "../helper/recovery-crypto.mjs";
import { SessionStore } from "../helper/store.mjs";

const roots = [];
const BOT = "111111111111111111";
const USER = "222222222222222222";
const GUILD = "333333333333333333";
const CHANNEL = "444444444444444444";
const RUNTIME_REVISION = "b".repeat(40);

afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "naia-lifecycle-hardening-"));
	roots.push(root);
	const state = join(root, "state");
	mkdirSync(state, { mode: 0o700 });
	return { root, store: new SessionStore(join(state, "runtime.sqlite3")) };
}

function binding() {
	return { kind: "guild_channel", guildId: GUILD, channelId: CHANNEL, allowedUserIds: [USER], respondWhen: "mentioned", canStartConversation: true, operatorActions: false, historyVisibility: "none" };
}

function basicRouter({ root, store, projectStatus }) {
	return new DiscordMessageRouter({
		config: { persona: { name: "Reviewer", instructions: "Review." }, role: { name: "reader", allowedActions: ["read", "reply"] }, backend: { selected: "codex" }, discord: { bindings: [binding()], operatorUserIds: [] }, runtime: { maxConcurrentJobs: 1 } },
		store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"),
		projectStatus, send: async () => ({ state: "confirmed" }), runner: async () => ({ backendOutcome: "failure", transientResult: null }),
	});
}

test("DSG-011 router shutdown aborts a hanging status PATCH without a fallback POST", async () => {
	const { root, store } = fixture();
	store.saveDiscordProjection({ scopeKey: "scope-1", channelId: CHANNEL, messageId: "555555555555555555" });
	const methods = [];
	const projection = new DiscordStatusProjection({
		store, token: "token-value-long-enough", botUserId: BOT, requestTimeoutMs: 1_000,
		fetchImpl: async (_url, init) => {
			methods.push(init.method);
			return new Promise(() => {});
		},
	});
	const router = basicRouter({ root, store, projectStatus: (input) => projection.publishScope(input) });
	const pending = router.projectScope({ scopeKey: "scope-1", channelId: CHANNEL });
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(methods, ["PATCH"]);
	await Promise.race([router.shutdown(), new Promise((_, reject) => setTimeout(() => reject(new Error("PATCH shutdown exceeded bound")), 300))]);
	assert.deepEqual(await pending, { state: "unknown", reasonCode: "request_aborted" });
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(methods, ["PATCH"]);
	store.close();
});

test("DSG-011 router shutdown aborts a hanging status pin without late requests", async () => {
	const { root, store } = fixture();
	const methods = [];
	const projection = new DiscordStatusProjection({
		store, token: "token-value-long-enough", botUserId: BOT, requestTimeoutMs: 1_000,
		fetchImpl: async (_url, init) => {
			methods.push(init.method);
			if (init.method === "POST") {
				return { ok: true, status: 200, json: async () => ({ id: "666666666666666666", channel_id: CHANNEL, author: { id: BOT }, nonce: JSON.parse(init.body).nonce }) };
			}
			return new Promise(() => {});
		},
	});
	const router = basicRouter({ root, store, projectStatus: (input) => projection.publishScope(input) });
	const pending = router.projectScope({ scopeKey: "scope-1", channelId: CHANNEL });
	for (let attempt = 0; attempt < 20 && methods.length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.deepEqual(methods, ["POST", "PUT"]);
	await Promise.race([router.shutdown(), new Promise((_, reject) => setTimeout(() => reject(new Error("pin shutdown exceeded bound")), 300))]);
	assert.deepEqual(await pending, { state: "created", messageId: "666666666666666666" });
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(methods, ["POST", "PUT"]);
	store.close();
});

test("DSG-015 exact-v2 recovery sends an operator acknowledgement only before a durable result", async () => {
	const { root, store } = fixture();
	mkdirSync(join(root, ".agents/context"), { recursive: true });
	writeFileSync(join(root, "AGENTS.md"), "# Recovery agent\n", "utf8");
	writeFileSync(join(root, ".agents/context/policy.yaml"), "authority: bounded\n", "utf8");
	const snapshot = buildAgentContextSnapshot({ workspace: root, agentId: "recovery-agent", entrypoint: "AGENTS.md", contextFiles: [".agents/context/policy.yaml"] });
	const config = {
		schemaVersion: 2,
		workspace: { agentId: "recovery-agent" },
		persona: { name: "Recovery agent", instructions: "Stay read-only." },
		role: { name: "reader", allowedActions: ["read", "reply"], requiresApproval: [] },
		backend: { selected: "codex", profiles: { codex: { enabled: true } } },
		discord: { bindings: [binding()], operatorUserIds: [USER], participantProfiles: { [USER]: { label: "owner", relationship: "workspace owner", allowedActions: ["read", "reply"] } } },
		runtime: { maxConcurrentJobs: 1, approvalPolicy: "never", permissionProfileEpoch: "recovery-v1", operatorResponseSeconds: 30 },
		recovery: { autoRetry: true },
	};
	const codec = new RecoveryCodec(randomBytes(32));
	let releaseInterrupted;
	const interrupted = new Promise((resolve) => { releaseInterrupted = resolve; });
	const firstRouter = new DiscordMessageRouter({
		config, store, token: "token-value-long-enough", botUserId: BOT, cwd: snapshot.workspaceRoot, runtimeRoot: join(root, "runtime-first"),
		agentContextSnapshot: snapshot, runtimeRevision: RUNTIME_REVISION, recoveryCodec: codec,
		send: async () => ({ state: "confirmed" }),
		runner: async ({ jobId }) => {
			store.startAttempt(jobId, { attemptId: "interrupted-attempt" });
			await interrupted;
			return { backendOutcome: "failure", transientResult: null };
		},
	});
	const accepted = await firstRouter.onDispatch("MESSAGE_CREATE", { id: "777777777777777777", guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> recover exactly once` }, 1);
	for (let attempt = 0; attempt < 50; attempt += 1) {
		const job = store.getJob(accepted.jobId);
		if (job.attemptId && job.events.some((event) => event.kind === "operator_response_sent")) break;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.equal(store.getJob(accepted.jobId).events.filter((event) => event.kind === "operator_response_sent").length, 1);
	const recovered = store.recoverInterruptedWork();
	assert.equal(recovered.length, 1);
	releaseInterrupted();
	await firstRouter.waitForIdle();
	let recoveryAcknowledgements = 0;
	let recoveryRuns = 0;
	const recoveredRouter = new DiscordMessageRouter({
		config, store, token: "token-value-long-enough", botUserId: BOT, cwd: snapshot.workspaceRoot, runtimeRoot: join(root, "runtime-recovered"),
		agentContextSnapshot: snapshot, runtimeRevision: RUNTIME_REVISION, recoveryCodec: codec,
		send: async () => { recoveryAcknowledgements += 1; return { state: "confirmed" }; },
		runner: async () => { recoveryRuns += 1; return { backendOutcome: "failure", transientResult: null }; },
	});
	recoveredRouter.resumeRecovered(recovered, { autoRetry: true });
	await recoveredRouter.waitForIdle();
	assert.equal(recoveryRuns, 1);
	assert.equal(recoveryAcknowledgements, 0);
	const resultEvents = store.getJob(accepted.jobId).events.filter((event) => event.kind === "operator_response_sent" || event.kind === "operator_response_missed");
	assert.equal(resultEvents.length, 1);
	assert.equal(resultEvents[0].kind, "operator_response_sent");
	store.recordEvent({ jobId: accepted.jobId, source: "helper", kind: "failed", safePayload: { reasonCode: "internal_error" } });

	const recoverClone = (jobId, acknowledgementKind = null) => {
		store.createJob({ jobId, backendId: "codex", activityDetail: "structured", jobType: "conversation", recoveryEnvelope: recovered[0].envelope });
		if (acknowledgementKind) store.recordEvent({ jobId, source: "helper", kind: acknowledgementKind, safePayload: {} });
		store.startAttempt(jobId, { attemptId: `${jobId}-attempt` });
		return store.recoverInterruptedWork().find((item) => item.jobId === jobId);
	};
	const missed = recoverClone("durable-missed-job", "operator_response_missed");
	recoveredRouter.resumeRecovered([missed], { autoRetry: true });
	await recoveredRouter.waitForIdle();
	assert.equal(recoveryRuns, 2);
	assert.equal(recoveryAcknowledgements, 0);
	assert.equal(store.getJob("durable-missed-job").events.filter((event) => event.kind === "operator_response_sent" || event.kind === "operator_response_missed").length, 1);
	store.recordEvent({ jobId: "durable-missed-job", source: "helper", kind: "failed", safePayload: { reasonCode: "internal_error" } });

	const beforeAcknowledgement = recoverClone("before-ack-job");
	recoveredRouter.resumeRecovered([beforeAcknowledgement], { autoRetry: true });
	await recoveredRouter.waitForIdle();
	assert.equal(recoveryRuns, 3);
	assert.equal(recoveryAcknowledgements, 1);
	const beforeAcknowledgementEvents = store.getJob("before-ack-job").events.filter((event) => event.kind === "operator_response_sent" || event.kind === "operator_response_missed");
	assert.equal(beforeAcknowledgementEvents.length, 1);
	assert.equal(beforeAcknowledgementEvents[0].kind, "operator_response_sent");
	store.close();
});
