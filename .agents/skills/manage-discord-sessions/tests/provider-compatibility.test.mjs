import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { getBackendAdapter, readOnlyBackendOptions } from "../helper/adapters.mjs";
import { runBackendAttempt } from "../helper/backend-runner.mjs";
import { commandOptionsForProfile } from "../helper/execution-profile.mjs";
import { buildAgentContextSnapshot } from "../helper/agent-context.mjs";
import { DiscordMessageRouter } from "../helper/discord-router.mjs";
import { RecoveryCodec } from "../helper/recovery-crypto.mjs";
import { SessionStore } from "../helper/store.mjs";
import { randomBytes } from "node:crypto";
import { BOT, CHANNEL, GUILD, RUNTIME_REVISION, USER, binding, cleanupDiscordFixtureRoots, fixture } from "./fixtures/discord-fixture.mjs";

// Every backend the operator may select has to stay usable, not just the one
// the default configuration happens to name. These cases walk each provider
// through the same contract: argv construction, the options the router really
// hands the runner, a structured success, a structured failure, cancellation,
// and recovery — under both a read-only and an authorized write profile.
//
const PROVIDERS = ["codex", "claude", "opencode", "grok"];

const fakeBackendPath = fileURLToPath(new URL("./fixtures/fake-backend.mjs", import.meta.url));
const runnerRoots = [];

// Versions the installed CLIs reported on 2026-09-06. Passing them explicitly
// keeps the case away from the host's real executables.
const BACKEND_VERSION = { codex: "0.153.4", claude: "2.1.261 (Claude Code)", opencode: "1.18.26", grok: "grok 1.0.13" };

const ARGV_CONTRACT = {
	codex: {
		"read-only": { required: [["--sandbox", "read-only"]], forbidden: ["workspace-write", "danger-full-access"] },
		"workspace-write": { required: [["--sandbox", "workspace-write"]], forbidden: ["read-only"] },
	},
	claude: {
		"read-only": { required: [["--permission-mode", "plan"], ["--tools", "Read,Glob,Grep"], ["--strict-mcp-config"], ["--mcp-config", '{"mcpServers":{}}']], forbidden: ["--dangerously-skip-permissions", "bypassPermissions"] },
		"workspace-write": { required: [["--permission-mode", "bypassPermissions"], ["--dangerously-skip-permissions"]], forbidden: ["plan", "--tools"] },
	},
	opencode: {
		"read-only": { required: [["run", "--format", "json"], ["--pure"]], forbidden: ["--auto"] },
		"workspace-write": { required: [["--auto"]], forbidden: [] },
	},
	grok: {
		"read-only": { required: [["--output-format", "streaming-messages-json"], ["--permission-mode", "plan"], ["--sandbox", "read-only"], ["--verbatim"]], forbidden: ["bypassPermissions", "workspace"] },
		"workspace-write": { required: [["--permission-mode", "bypassPermissions"], ["--sandbox", "workspace"]], forbidden: ["plan", "read-only"] },
	},
};

function profileFor(backendId, access) {
	return { backendId, permissionProfileEpoch: "provider-matrix", authorizationMode: "never", access };
}

function invocationFor(backendId, access, { cwd = "/workspace", childHome = "/runtime/children/attempt" } = {}) {
	const adapter = getBackendAdapter(backendId);
	const options = commandOptionsForProfile(profileFor(backendId, access));
	const promptPath = adapter.promptDelivery === "file" ? join(childHome, "prompt.txt") : null;
	return adapter.command({ ...options, cwd, childHome, allowedPaths: [cwd], ...(promptPath ? { promptPath } : {}) });
}

function containsSequence(args, sequence) {
	for (let index = 0; index + sequence.length <= args.length; index += 1) {
		if (sequence.every((token, offset) => args[index + offset] === token)) return true;
	}
	return false;
}

function runnerFixture(backendId) {
	const root = mkdtempSync(join(tmpdir(), "naia-provider-matrix-"));
	runnerRoots.push(root);
	const store = new SessionStore(join(root, "state", "runtime.sqlite3"));
	const jobId = `${backendId}-matrix-job`;
	store.createJob({ jobId, backendId, revision: "rev-1", activityDetail: "structured", jobType: "issue_work" });
	return { root, store, jobId };
}

function attemptInput({ root, store, jobId }, backendId, prompt, extra = {}) {
	return {
		store, jobId, backendId, prompt, cwd: root,
		runtimeRoot: join(root, "runtime"), executable: fakeBackendPath,
		commandOptions: commandOptionsForProfile(profileFor(backendId, "read-only")),
		backendVersion: BACKEND_VERSION[backendId], requireAuthentication: false,
		parentEnv: { PATH: process.env.PATH },
		...extra,
	};
}

afterEach(() => {
	while (runnerRoots.length) rmSync(runnerRoots.pop(), { recursive: true, force: true });
	cleanupDiscordFixtureRoots();
});

test("provider matrix builds each supported backend's read-only and writable argv", () => {
	for (const backendId of PROVIDERS) {
		for (const access of ["read-only", "workspace-write"]) {
			const contract = ARGV_CONTRACT[backendId][access];
			const { args } = invocationFor(backendId, access);
			for (const sequence of contract.required) assert.ok(containsSequence(args, sequence), `${backendId} ${access} is missing ${sequence.join(" ")}`);
			for (const token of contract.forbidden) assert.equal(args.includes(token), false, `${backendId} ${access} must not carry ${token}`);
			// A read-only option set has to be recognisable as read-only from the
			// options alone, because that is what clears network and credential
			// access for the child.
			assert.equal(readOnlyBackendOptions(backendId, commandOptionsForProfile(profileFor(backendId, access))), access === "read-only");
		}
	}
});

test("provider matrix keeps network access and credential profiles off read-only jobs and on writable ones", async () => {
	const observed = [];
	for (const backendId of PROVIDERS) {
		for (const closed of [true, false]) {
			const { root, store } = fixture();
			const snapshot = snapshotFor(root);
			const calls = [];
			const router = new DiscordMessageRouter({
				config: matrixConfig(backendId, { networkAccess: true, credentialProfiles: ["vercel"] }),
				store,
				token: "token-value-long-enough",
				botUserId: BOT,
				cwd: root,
				allowedPaths: [root],
				agentContextSnapshot: snapshot,
				runtimeRoot: join(root, "runtime"),
				runtimeRevision: RUNTIME_REVISION,
				// Monday 09:00 UTC is inside the configured window; Sunday is not.
				now: () => Date.parse(closed ? "2026-09-06T12:00:00Z" : "2026-09-07T09:00:00Z"),
				send: async () => ({ state: "confirmed" }),
				runner: async (input) => {
					calls.push(input);
					return { backendOutcome: "success", transientResult: "done" };
				},
				deliver: async () => ({ state: "confirmed" }),
			});
			const accepted = await router.onDispatch("MESSAGE_CREATE", message(backendId, closed), 1);
			await router.waitForIdle();
			assert.equal(accepted.state, "accepted", `${backendId} closed=${closed}`);
			assert.equal(calls.length, 1, `${backendId} closed=${closed} did not reach the runner`);
			const { commandOptions, executionProfile } = calls[0];
			if (closed) {
				assert.equal(executionProfile.access, "read-only");
				assert.equal(commandOptions.networkAccess, false, `${backendId} read-only kept network access`);
				assert.deepEqual(commandOptions.credentialProfiles, [], `${backendId} read-only kept credential profiles`);
				assert.notEqual(store.getJob(calls[0].jobId, { includeEvents: false }).lifecycle, "failed");
			} else {
				assert.notEqual(executionProfile.access, "read-only");
				assert.equal(commandOptions.networkAccess, true, `${backendId} writable lost network access`);
				assert.deepEqual(commandOptions.credentialProfiles, ["vercel"], `${backendId} writable lost credential profiles`);
			}
			observed.push(`${backendId}:${closed ? "closed" : "open"}`);
			store.close();
		}
	}
	assert.equal(observed.length, PROVIDERS.length * 2);
});

test("provider matrix read-only options survive the real runner's own validation", async () => {
	for (const backendId of PROVIDERS) {
		const context = runnerFixture(backendId);
		// The options the router produces for a closed window on a
		// network-enabled instance, passed to the runner unchanged.
		const commandOptions = { ...commandOptionsForProfile(profileFor(backendId, "read-only")), networkAccess: false, credentialProfiles: [] };
		const result = await runBackendAttempt(attemptInput(context, backendId, "read-only contract", { commandOptions }));
		assert.equal(result.exitCode, 0, `${backendId} read-only attempt did not complete`);
		assert.equal(context.store.getJob(context.jobId).lifecycle, "result_ready");
		context.store.close();
	}
});

test("provider matrix rejects a read-only job that still carries network access", async () => {
	// Codex is the backend whose own adapter refuses the combination. The
	// assertion pins the reason the router must never produce it.
	const context = runnerFixture("codex");
	await assert.rejects(runBackendAttempt(attemptInput(context, "codex", "invalid", {
		commandOptions: { sandbox: "read-only", approvalPolicy: "never", networkAccess: true, credentialProfiles: [] },
	})), (error) => error.code === "backend_invocation_invalid");
	context.store.close();
});

test("provider matrix reports structured success and structured failure for every backend", async () => {
	for (const backendId of PROVIDERS) {
		const success = runnerFixture(backendId);
		const successResult = await runBackendAttempt(attemptInput(success, backendId, "provider ok"));
		assert.equal(successResult.backendOutcome, "success", `${backendId} success outcome`);
		// A success with no deliverable result would leave the requester with
		// silence, so the matrix demands actual final text from every backend.
		assert.equal(typeof successResult.transientResult, "string", `${backendId} produced no deliverable result`);
		assert.match(successResult.transientResult, /fake-model-content/);
		assert.equal(success.store.getJob(success.jobId).lifecycle, "result_ready");
		success.store.close();

		const failure = runnerFixture(backendId);
		const failureResult = await runBackendAttempt(attemptInput(failure, backendId, "__fake_structured_failure__"));
		assert.equal(failureResult.backendOutcome, "failure", `${backendId} failure outcome`);
		assert.equal(failure.store.getJob(failure.jobId).lifecycle, "failed");
		failure.store.close();
	}
});

test("provider matrix cancels a running attempt for every backend", async () => {
	for (const backendId of PROVIDERS) {
		const context = runnerFixture(backendId);
		const controller = new AbortController();
		const pending = runBackendAttempt(attemptInput(context, backendId, "__fake_hang__", { signal: controller.signal, killGraceMs: 100 }));
		setTimeout(() => controller.abort("operator_cancel"), 50).unref?.();
		const result = await pending;
		assert.equal(result.terminationReason, "cancelled", `${backendId} cancellation`);
		assert.equal(context.store.getJob(context.jobId).lifecycle, "cancelled");
		context.store.close();
	}
});

test("provider matrix resumes read-only recovered work and parks the rest for every backend", async () => {
	for (const backendId of PROVIDERS) {
		for (const autoRetry of [true, false]) {
			const { root, store } = fixture();
			const snapshot = snapshotFor(root);
			const codec = new RecoveryCodec(randomBytes(32));
			const config = matrixConfig(backendId, { networkAccess: true, credentialProfiles: ["vercel"], recovery: { autoRetry } });
			const routerOptions = {
				config,
				store,
				token: "token-value-long-enough",
				botUserId: BOT,
				cwd: root,
				allowedPaths: [root],
				agentContextSnapshot: snapshot,
				runtimeRevision: RUNTIME_REVISION,
				recoveryCodec: codec,
				now: () => Date.parse("2026-09-07T09:00:00Z"),
				deliver: async () => ({ state: "confirmed" }),
			};
			// Produce a real sealed envelope rather than a hand-written one, so
			// the recovery path validates the same digests production would.
			const seedCalls = [];
			const seed = new DiscordMessageRouter({ ...routerOptions, runtimeRoot: join(root, "runtime-seed"), send: async () => ({ state: "confirmed" }), runner: async (input) => { seedCalls.push(input); return { backendOutcome: "failure", transientResult: null }; } });
			const submitted = await seed.submitOperatorRequest({ channelId: CHANNEL, authorId: USER, content: `${backendId} recovery seed`, access: "read-only" });
			await seed.waitForIdle();
			assert.equal(submitted.state, "accepted", `${backendId} recovery seed`);
			assert.equal(seedCalls[0].executionProfile.access, "read-only");

			const recoveredJobId = `${backendId}-recovered`;
			store.createJob({ jobId: recoveredJobId, backendId, activityDetail: "structured", jobType: "conversation", recoveryEnvelope: store.loadJobRecovery(submitted.jobId) });
			store.startAttempt(recoveredJobId, { attemptId: `${backendId}-recovery-attempt` });
			const recovered = store.recoverInterruptedWork().find((item) => item.jobId === recoveredJobId);
			assert.ok(recovered, `${backendId} recovery envelope`);

			const calls = [];
			const controls = [];
			const router = new DiscordMessageRouter({ ...routerOptions, runtimeRoot: join(root, "runtime-recovery"), send: async (input) => { controls.push(input); return { state: "confirmed" }; }, runner: async (input) => { calls.push(input); return { backendOutcome: "success", transientResult: "recovered" }; } });
			router.resumeRecovered([recovered], { autoRetry });
			await router.waitForIdle();
			await router.shutdown();
			if (autoRetry) {
				assert.equal(calls.length, 1, `${backendId} auto recovery did not run`);
				assert.equal(calls[0].executionProfile.access, "read-only");
				assert.equal(calls[0].commandOptions.networkAccess, false);
				assert.deepEqual(calls[0].commandOptions.credentialProfiles, []);
			} else {
				assert.equal(calls.length, 0, `${backendId} parked work must not run`);
				assert.equal(store.getJob(recoveredJobId).events.filter((event) => event.kind === "recovery_review_required").length, 1);
				const notices = controls.filter((control) => control.content.includes(recoveredJobId));
				assert.equal(notices.length, 1, `${backendId} parked work must notify exactly once`);
			}
			store.close();
		}
	}
});

function message(backendId, closed) {
	return {
		id: `6666666666666666${closed ? "1" : "2"}${PROVIDERS.indexOf(backendId)}`,
		guild_id: GUILD,
		channel_id: CHANNEL,
		author: { id: USER },
		mentions: [{ id: BOT }],
		content: `<@${BOT}> ${backendId} matrix request`,
	};
}

function snapshotFor(root) {
	mkdirSync(join(root, ".agents", "context"), { recursive: true });
	writeFileSync(join(root, "AGENTS.md"), "# Provider matrix agent\n", "utf8");
	writeFileSync(join(root, ".agents", "context", "policy.yaml"), "authority: bounded\n", "utf8");
	return buildAgentContextSnapshot({ workspace: root, agentId: "provider-matrix-agent", entrypoint: "AGENTS.md", contextFiles: [".agents/context/policy.yaml"] });
}

function matrixConfig(backendId, { networkAccess = false, credentialProfiles = [], recovery = { autoRetry: false } } = {}) {
	return {
		schemaVersion: 2,
		workspace: { agentId: "provider-matrix-agent" },
		persona: { name: "Matrix", instructions: "Complete bounded provider work." },
		role: { name: "operator", allowedActions: ["read", "reply", "write", "execute"], requiresApproval: [] },
		backend: { selected: backendId, profiles: { [backendId]: { enabled: true } } },
		discord: {
			bindings: [{ ...binding(), operatorActions: true, historyVisibility: "none" }],
			operatorUserIds: [USER],
			participantProfiles: {
				[USER]: { label: "workspace-owner", relationship: "workspace owner", allowedActions: ["read", "reply", "write", "execute"], mutationWindow: { timezone: "UTC", days: [1], start: "09:00", end: "18:00" } },
			},
		},
		runtime: { maxConcurrentJobs: 1, approvalPolicy: "never", permissionProfileEpoch: "provider-matrix-v1", networkAccess, credentialProfiles },
		recovery,
	};
}
