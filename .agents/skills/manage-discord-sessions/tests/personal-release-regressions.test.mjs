import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, test } from "node:test";
import { buildAgentContextSnapshot } from "../helper/agent-context.mjs";
import { readOnlyBackendOptions } from "../helper/adapters.mjs";
import { verifyLinuxLegacyRegistration } from "../helper/cutover-managed-runtime.mjs";
import { resolveCutoverBackendExecutables, readCutoverSourceSnapshot } from "../helper/service-cutover-controller.mjs";
import { DiscordMessageRouter } from "../helper/discord-router.mjs";
import { configuredBackendCommand } from "../helper/service-runtime.mjs";
import { resolveBackendExecutable } from "../helper/service-manager-shared.mjs";
import { resolveWindowsBackendCommand } from "../helper/service-manager-windows.mjs";
import { renderLegacyRollbackUnits } from "../helper/cutover-rollback.mjs";
import { messengerInstancePaths } from "../helper/instance-paths.mjs";
import { discordUnitIdentity, renderDiscordUserUnit } from "../helper/systemd.mjs";
import { BOT, CHANNEL, GUILD, RUNTIME_REVISION, USER, binding, cleanupDiscordFixtureRoots, fixture } from "./fixtures/discord-fixture.mjs";

const OPEN = { timezone: "UTC", days: [1], start: "09:00", end: "18:00" };
const temporaryRoots = [];

afterEach(() => {
	cleanupDiscordFixtureRoots();
	while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop(), { recursive: true, force: true });
});

function operatorConfig(mutationWindow = OPEN) {
	return {
		schemaVersion: 2,
		workspace: { agentId: "personal-release-regression-agent" },
		persona: { name: "Operator", instructions: "Complete bounded operator work." },
		role: { name: "operator", allowedActions: ["read", "reply", "write", "execute"], requiresApproval: [] },
		backend: { selected: "codex", profiles: { codex: { enabled: true } } },
		discord: {
			bindings: [{ ...binding(), operatorActions: true, historyVisibility: "none" }],
			operatorUserIds: [USER],
			participantProfiles: {
				[USER]: { label: "workspace-owner", relationship: "workspace owner", allowedActions: ["read", "reply", "write", "execute"], ...(mutationWindow ? { mutationWindow } : {}) },
			},
		},
		runtime: { maxConcurrentJobs: 1, approvalPolicy: "never", permissionProfileEpoch: "personal-release-v1", networkAccess: false, credentialProfiles: [] },
		recovery: { autoRetry: false },
	};
}

function snapshotFor(root) {
	mkdirSync(join(root, ".agents", "context"), { recursive: true });
	writeFileSync(join(root, "AGENTS.md"), "# Personal release regression agent\n", "utf8");
	writeFileSync(join(root, ".agents", "context", "policy.yaml"), "authority: bounded\n", "utf8");
	return buildAgentContextSnapshot({ workspace: root, agentId: "personal-release-regression-agent", entrypoint: "AGENTS.md", contextFiles: [".agents/context/policy.yaml"] });
}

function message(id, content = "inspect this") {
	return { id, guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> ${content}` };
}

function unitQuote(value) {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

test("Grok stays pinned through resolver, cutover, Linux units, rollback, and runtime environment", () => {
	const candidateRoot = process.cwd();
	const root = mkdtempSync(join(tmpdir(), "naia-grok-regression-"));
	temporaryRoots.push(root);
	const bin = join(root, "bin");
	mkdirSync(bin, { mode: 0o700 });
	const grok = join(bin, "grok");
	writeFileSync(grok, "#!/bin/sh\n", { mode: 0o700 });
	chmodSync(grok, 0o700);
	const resolved = resolveBackendExecutable("grok", bin);
	assert.equal(resolved, resolve(grok));
	if (process.platform !== "win32") assert.equal(resolveWindowsBackendCommand("grok", bin), resolved);
	assert.deepEqual(resolveCutoverBackendExecutables("grok", () => resolved), { grok: resolved });

	const systemd = renderDiscordUserUnit({
		adkRoot: candidateRoot,
		tokenFingerprint: "a".repeat(64),
		runtimeRevision: "b".repeat(40),
		nodePath: resolve(process.execPath),
		backendExecutables: { grok: resolved },
	});
	assert.match(systemd.content, new RegExp(`NAIA_GROK_EXECUTABLE=${resolved.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")}`));
	assert.match(systemd.content, new RegExp(`PATH=.*${dirname(resolved).replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")}`));

	const paths = messengerInstancePaths(candidateRoot);
	const rollback = renderLegacyRollbackUnits({
		paths,
		runtimePath: join(candidateRoot, ".agents/skills/manage-discord-sessions"),
		names: { supervisorTimerName: "naia-discord-sessions-regression-supervisor.timer" },
		tokenFingerprint: "a".repeat(64),
		nodePath: resolve(process.execPath),
		backendExecutables: { grok: resolved },
	});
	assert.match(rollback.service, /NAIA_GROK_EXECUTABLE=/);
	assert.match(rollback.service, new RegExp(`PATH=.*${dirname(resolved).replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")}`));

	const previousExecutable = process.env.NAIA_GROK_EXECUTABLE;
	process.env.NAIA_GROK_EXECUTABLE = resolved;
	try {
		assert.equal(configuredBackendCommand("grok"), resolved);
	} finally {
		if (previousExecutable === undefined) delete process.env.NAIA_GROK_EXECUTABLE;
		else process.env.NAIA_GROK_EXECUTABLE = previousExecutable;
	}

	const sourceConfigDirectory = join(root, "config");
	mkdirSync(sourceConfigDirectory, { mode: 0o700 });
	const sourceConfigPath = join(sourceConfigDirectory, "config.json");
	writeFileSync(sourceConfigPath, JSON.stringify({ backend: { selected: "grok" }, discord: { botUserId: BOT, credentialRef: "discord" } }), { mode: 0o600 });
	const source = readCutoverSourceSnapshot(sourceConfigPath);
	assert.equal(source.config.backend.selected, "grok");

	// Verify the legacy registration reader accepts Grok and checks the same
	// canonical executable that the installer would have written.
	const unitDirectory = join(root, "units");
	mkdirSync(unitDirectory, { mode: 0o700 });
	const identity = discordUnitIdentity(candidateRoot);
	const servicePath = resolve(candidateRoot, ".agents/skills/manage-discord-sessions/helper/service.mjs");
	const nodePath = resolve(process.execPath);
	const lockPath = paths.lockPath;
	const exec = ["/usr/bin/flock", "--no-fork", "--nonblock", lockPath, nodePath, servicePath, "--adk-root", candidateRoot, "--instance", "default"].map(unitQuote).join(" ");
	const executablePath = [...new Set([dirname(nodePath), dirname(resolved), "/usr/local/bin", "/usr/bin", "/bin"])].join(delimiter);
	const service = `[Unit]\nDescription=Naia ADK Discord sessions (default)\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${exec}\nEnvironment=${unitQuote(`NAIA_GROK_EXECUTABLE=${resolved}`)}\nEnvironment=${unitQuote(`PATH=${executablePath}`)}\nRestart=always\nRestartSec=5\nKillMode=mixed\nTimeoutStopSec=20\nUMask=0077\nNoNewPrivileges=yes\nPrivateTmp=yes\n\n[Install]\nWantedBy=default.target\n`;
	const supervisorBase = identity.unitName.slice(0, -".service".length);
	const supervisorServiceName = `${supervisorBase}-supervisor.service`;
	const supervisorTimerName = `${supervisorBase}-supervisor.timer`;
	const supervisorExec = [nodePath, resolve(candidateRoot, ".agents/skills/manage-discord-sessions/helper/supervisor.mjs"), "--adk-root", candidateRoot, "--instance", "default"].map(unitQuote).join(" ");
	writeFileSync(join(unitDirectory, identity.unitName), service, { mode: 0o600 });
	writeFileSync(join(unitDirectory, supervisorServiceName), `[Unit]\nDescription=Naia ADK Discord independent health observer (default)\n\n[Service]\nType=oneshot\nExecStart=${supervisorExec}\nUMask=0077\nNoNewPrivileges=yes\nPrivateTmp=yes\n`, { mode: 0o600 });
	writeFileSync(join(unitDirectory, supervisorTimerName), `[Unit]\nDescription=Naia ADK Discord health observer timer (default)\n\n[Timer]\nOnBootSec=30s\nOnUnitActiveSec=60s\nAccuracySec=1s\nPersistent=true\nUnit=${supervisorServiceName}\n\n[Install]\nWantedBy=timers.target\n`, { mode: 0o600 });
	const registration = verifyLinuxLegacyRegistration({ adkRoot: candidateRoot, backend: "grok", unitDirectory, stateReader: (mode) => mode === "is-enabled" ? "enabled" : "active" });
	assert.equal(registration.sourceRegistration.kind, "legacy_mutable");
	assert.equal(registration.state.service.active, true);
});

test("Codex defaults remain writable when sandbox is omitted", () => {
	assert.equal(readOnlyBackendOptions("codex", {}), false);
	assert.equal(readOnlyBackendOptions("codex", { sandbox: "workspace-write" }), false);
	assert.equal(readOnlyBackendOptions("codex", { sandbox: "danger-full-access" }), false);
	assert.equal(readOnlyBackendOptions("codex", { sandbox: "read-only" }), true);
});

test("a busy mutation-window telemetry write does not orphan the accepted job", async () => {
	const { store, root } = fixture();
	try {
		const snapshot = snapshotFor(root);
		const calls = [];
		const originalRecordEvent = store.recordEvent.bind(store);
		store.recordEvent = (event) => {
			if (event.kind === "profile_replaced") throw Object.assign(new Error("database busy"), { code: "SQLITE_BUSY" });
			return originalRecordEvent(event);
		};
		const router = new DiscordMessageRouter({
			config: operatorConfig(),
			store,
			token: "token-value-long-enough",
			botUserId: BOT,
			cwd: root,
			runtimeRoot: join(root, "runtime"),
			agentContextSnapshot: snapshot,
			runtimeRevision: RUNTIME_REVISION,
			now: () => Date.parse("2026-09-07T18:00:00Z"),
			send: async () => ({ state: "confirmed" }),
			runner: async (input) => {
				calls.push(input);
				const attemptId = store.startAttempt(input.jobId, { attemptId: "telemetry-busy-attempt" });
				store.recordEvent({ jobId: input.jobId, attemptId, source: "helper", kind: "failed", safePayload: { reasonCode: "process_exit" } });
				return { backendOutcome: "failure", transientResult: null, attemptId };
			},
		});
		const accepted = await router.onDispatch("MESSAGE_CREATE", message("700000000000000101", "write while closed"), 101);
		await router.waitForIdle();
		assert.equal(accepted.state, "accepted");
		assert.equal(calls.length, 1);
		const job = store.getJob(accepted.jobId);
		assert.equal(job.lifecycle, "failed");
		assert.ok(job.events.some((event) => event.kind === "failed"));
	} finally {
		store.close();
	}
});

test("a pre-spawn mutation-window close explains that the write never started", async () => {
	const { store, root } = fixture();
	try {
		const snapshot = snapshotFor(root);
		let nowMs = Date.parse("2026-09-07T10:00:00Z");
		const sent = [];
		const router = new DiscordMessageRouter({
			config: operatorConfig(),
			store,
			token: "token-value-long-enough",
			botUserId: BOT,
			cwd: root,
			runtimeRoot: join(root, "runtime"),
			agentContextSnapshot: snapshot,
			runtimeRevision: RUNTIME_REVISION,
			now: () => nowMs,
			send: async (input) => { sent.push(input); return { state: "confirmed" }; },
			runner: async (input) => {
				nowMs = Date.parse("2026-09-07T18:00:00Z");
			input.preSpawnCheck();
			return { backendOutcome: "failure", transientResult: null };
			},
		});
		const accepted = await router.onDispatch("MESSAGE_CREATE", message("700000000000000102", "write after the window closes"), 102);
		await router.waitForIdle();
		assert.equal(accepted.state, "accepted");
		const failure = sent.find((item) => item.content.includes("쓰기 작업을 시작하지 않았습니다"));
		assert.ok(failure);
		assert.match(failure.content, /시간창이 열린 뒤 다시 요청하세요/);
		assert.doesNotMatch(failure.content, /서비스를 재시작/);
		assert.equal(sent.some((item) => item.content.includes("읽기 전용으로 실행할 수 없습니다")), false);
	} finally {
		store.close();
	}
});
