import assert from "node:assert/strict";
import { accessSync, chmodSync, constants as fsConstants, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { discordUnitIdentity, renderDiscordUserUnit } from "../helper/systemd.mjs";
import { classifyWindowsStopObservation, cutoverRegistrationRestoreCommands, inspectCutoverRuntimeTree, installOperatorLauncher, installServiceCommands, normalizeCutoverRegistrationState, quoteWindowsTaskAction, readCutoverSourceConfig, readCutoverSourceSnapshot, renderOperatorLauncher, renderWindowsStartupLauncher, resolveBackendExecutable, resolveCutoverBackendExecutables, resolveWindowsBackendCommand, restartWindowsTask, sampleWindowsStopObservation, verifyCutoverSourceIdentity, verifyCutoverSourceSnapshot, verifyWindowsTaskAction } from "../helper/service-manager.mjs";
import { messengerInstancePaths, normalizeMessengerInstance } from "../helper/instance-paths.mjs";
import { classifyDiscordServiceFailure, writeDiscordServiceFailure } from "../helper/service.mjs";
import { observeOnce } from "../helper/supervisor.mjs";
import { protectOwnerOnly, trustedWindowsSystemExecutable } from "../helper/platform-security.mjs";
import { spawnSync } from "node:child_process";
import { validateCutoverBootstrap } from "../helper/cutover-bundle.mjs";
import { discordTokenFingerprint } from "../helper/token-owner-lock.mjs";
import { fileURLToPath } from "node:url";
import { BOT, RUNTIME_REVISION, TOKEN_FINGERPRINT, cleanupDiscordFixtureRoots, fixture, roots } from "./fixtures/discord-fixture.mjs";

afterEach(cleanupDiscordFixtureRoots);

test("DSG-008 renders a stable isolated user service with restart and single-owner controls", () => {
	const { root, store } = fixture();
	const first = renderDiscordUserUnit({ adkRoot: root, tokenFingerprint: TOKEN_FINGERPRINT, runtimeRevision: RUNTIME_REVISION, nodePath: "/usr/bin/node" });
	const second = renderDiscordUserUnit({ adkRoot: root, tokenFingerprint: TOKEN_FINGERPRINT, runtimeRevision: RUNTIME_REVISION, nodePath: "/usr/bin/node" });
	assert.equal(first.unitName, second.unitName);
	assert.equal(first.content, second.content);
	for (const required of ["flock", "--nonblock", "Restart=always", "RestartPreventExitStatus=78", "KillMode=mixed", "UMask=0077", "WantedBy=default.target"]) assert.equal(first.content.includes(required), true);
	assert.equal(first.content.includes(`%t/naia-discord-token-${TOKEN_FINGERPRINT}.lock`), true);
	assert.equal(first.content.includes("RuntimeDirectory="), false);
	assert.equal(first.content.includes(`NAIA_DISCORD_KERNEL_TOKEN_FINGERPRINT=${TOKEN_FINGERPRINT}`), true);
	assert.equal(first.content.includes(`NAIA_DISCORD_RUNTIME_REVISION=${RUNTIME_REVISION}`), true);
	assert.equal(/credential-value|prompt|result/i.test(first.content), false);
	store.close();
});

test("DSG-008 exposes safe startup failure reason codes in journal and supervisor state", async () => {
	const { root, store } = fixture();
	store.close();
	const paths = messengerInstancePaths(root);
	mkdirSync(join(root, "naia-settings/messenger-sessions"), { recursive: true, mode: 0o700 });
	writeFileSync(paths.configPath, "{}\n", { mode: 0o600 });
	protectOwnerOnly(paths.configPath, "file", "test config");
	assert.equal(classifyDiscordServiceFailure({ code: "DISCORD_TOKEN_ALREADY_OWNED" }), "discord_token_already_owned");
	assert.equal(classifyDiscordServiceFailure({ serviceReasonCode: "configuration_invalid" }), "configuration_invalid");
	await writeDiscordServiceFailure(paths, "configuration_invalid");
	const snapshot = observeOnce({ adkRoot: root, nowMs: Date.now() });
	assert.equal(snapshot.startupFailureReasonCode, "configuration_invalid");
	assert.equal(snapshot.unhealthy.some((item) => item.reasonCode === "configuration_invalid"), true);
	for (const unsafe of [
		JSON.stringify({ schemaVersion: 1, reasonCode: "token=SHOULD_NOT_PROJECT", observedAt: new Date().toISOString() }),
		"{corrupt-json",
		JSON.stringify({ schemaVersion: 1, reasonCode: "configuration_invalid", observedAt: "not-a-timestamp" }),
	]) {
		writeFileSync(paths.serviceFailurePath, `${unsafe}\n`, { mode: 0o600 });
		const invalid = observeOnce({ adkRoot: root, nowMs: Date.now() });
		assert.equal(invalid.startupFailureReasonCode, "failure_status_invalid");
		assert.equal(JSON.stringify(invalid).includes("SHOULD_NOT_PROJECT"), false);
	}
});

test("DSG-021 requires separate clean candidate and target runtime revisions", () => {
	const makeRepository = (label) => {
		const root = mkdtempSync(join(tmpdir(), `naia-cutover-${label}-`));
		roots.push(root);
		const runtime = join(root, ".agents/skills/manage-discord-sessions");
		mkdirSync(runtime, { recursive: true });
		writeFileSync(join(runtime, "runtime.txt"), `${label}\n`, "utf8");
		for (const args of [
			["init", "-q"],
			["add", ".agents/skills/manage-discord-sessions"],
			["-c", "user.name=Naia Test", "-c", "user.email=naia@example.invalid", "commit", "-qm", label],
		]) {
			const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
		}
		const revision = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
		return { root, runtime, revision };
	};
	const candidate = makeRepository("candidate");
	const target = makeRepository("target");
	const bootstrap = validateCutoverBootstrap({ candidateRoot: candidate.root, targetRoot: target.root, candidateRevision: candidate.revision, targetRevision: target.revision });
	assert.equal(bootstrap.targetRevision, target.revision);
	assert.match(inspectCutoverRuntimeTree(candidate.root, candidate.revision), /^[a-f0-9]{40}$/);
	assert.match(inspectCutoverRuntimeTree(target.root, target.revision), /^[a-f0-9]{40}$/);
	writeFileSync(join(target.runtime, "runtime.txt"), "dirty\n", "utf8");
	assert.throws(() => inspectCutoverRuntimeTree(target.root, target.revision), /clean candidate and target/);
	assert.throws(() => validateCutoverBootstrap({ candidateRoot: candidate.root, targetRoot: candidate.root, candidateRevision: candidate.revision, targetRevision: candidate.revision }), /separate candidate revision/);
});

test("DSG-021 snapshots old policy and inactive registration without candidate-policy validation", { skip: process.platform === "win32" ? "POSIX permission semantics" : false }, () => {
	const root = mkdtempSync(join(tmpdir(), "naia-cutover-old-policy-"));
	roots.push(root);
	const configPath = join(root, "config.json");
	writeFileSync(configPath, `${JSON.stringify({ schemaVersion: 0, backend: { selected: "codex" }, discord: { botUserId: BOT, credentialRef: "discord-token" }, runtime: { approvalPolicy: "managed" }, obsolete: true })}\n`, { mode: 0o600 });
	assert.deepEqual(readCutoverSourceConfig(configPath), { backend: { selected: "codex" }, discord: { botUserId: BOT, credentialRef: "discord-token" } });
	assert.deepEqual(resolveCutoverBackendExecutables("codex", () => { throw new Error("missing"); }), {});
	const registrationState = normalizeCutoverRegistrationState({ serviceEnabled: "disabled", serviceActive: "failed", supervisorTimerEnabled: "enabled", supervisorTimerActive: "inactive" });
	assert.deepEqual(registrationState, { service: { enabled: false, active: false }, supervisorTimer: { enabled: true, active: false } });
	const names = { serviceName: "discord.service", supervisorTimerName: "discord-supervisor.timer" };
	assert.deepEqual(cutoverRegistrationRestoreCommands(names, registrationState), [
		["stop", names.serviceName],
		["stop", names.supervisorTimerName],
		["enable", names.supervisorTimerName],
		["disable", names.serviceName],
	]);
	chmodSync(configPath, 0o644);
	assert.throws(() => readCutoverSourceConfig(configPath), /owner-only|permissions/);
});

test("DSG-021 rejects config or credential drift before publishing a rollback snapshot", () => {
	const root = mkdtempSync(join(tmpdir(), "naia-cutover-snapshot-race-"));
	roots.push(root);
	const configPath = join(root, "config.json");
	const credentialsDirectory = join(root, "credentials");
	const credentialPath = join(credentialsDirectory, "discord-token");
	mkdirSync(credentialsDirectory, { mode: 0o700 });
	const configText = `${JSON.stringify({ backend: { selected: "codex" }, discord: { botUserId: BOT, credentialRef: "discord-token" } })}\n`;
	const token = "source-token-123456789";
	writeFileSync(configPath, configText, { mode: 0o600 });
	writeFileSync(credentialPath, `${token}\n`, { mode: 0o600 });
	const snapshot = readCutoverSourceSnapshot(configPath);
	const expectation = { configPath, credentialsDirectory, expectedConfigText: snapshot.text, expectedTokenFingerprint: discordTokenFingerprint(token) };
	assert.equal(verifyCutoverSourceSnapshot(expectation), true);
	writeFileSync(configPath, configText.replace("codex", "claude"), { mode: 0o600 });
	assert.throws(() => verifyCutoverSourceSnapshot(expectation), /config changed during prepare/);
	writeFileSync(configPath, configText, { mode: 0o600 });
	writeFileSync(credentialPath, "replacement-token-987654321\n", { mode: 0o600 });
	assert.throws(() => verifyCutoverSourceSnapshot(expectation), /credential changed during prepare/);
});

test("DSG-021 refuses a source snapshot when installed or running runtime identity diverges from target HEAD", () => {
	const sourceRevision = "a".repeat(40);
	const registrationState = { service: { enabled: true, active: true }, supervisorTimer: { enabled: true, active: false } };
	const input = {
		sourceRevision,
		registrationState,
		serviceOwner: { generation: `${sourceRevision}.12345678`, pid: process.pid, bootId: null, processStartIdentity: null },
		serviceUnit: "service-unit",
		expectedServiceUnit: "service-unit",
		supervisorServiceUnit: "supervisor-unit",
		expectedSupervisorServiceUnit: "supervisor-unit",
		supervisorTimerUnit: "timer-unit",
		expectedSupervisorTimerUnit: "timer-unit",
	};
	assert.throws(() => verifyCutoverSourceIdentity({ ...input, serviceOwner: { ...input.serviceOwner, generation: `${"b".repeat(40)}.12345678` } }), /running Discord service runtime/);
	assert.throws(() => verifyCutoverSourceIdentity(input), /running Discord service runtime/);
	assert.throws(() => verifyCutoverSourceIdentity({ ...input, registrationState: { ...registrationState, service: { enabled: true, active: false } }, serviceUnit: "old-rollback-unit" }), /does not match target HEAD/);
	assert.throws(() => verifyCutoverSourceIdentity({ ...input, registrationState: { ...registrationState, service: { enabled: true, active: false } }, serviceUnit: null }), /unit is unavailable/);
});

test("DSG-008 isolates named bot instances while preserving the default instance contract", () => {
	const { root, store } = fixture();
	const defaultPaths = messengerInstancePaths(root);
	const alphaPaths = messengerInstancePaths(root, "alpha");
	assert.equal(defaultPaths.configPath, join(root, "naia-settings/messenger-sessions/config.json"));
	assert.equal(defaultPaths.databasePath, join(root, "naia-settings/.sessions/messenger-sessions/runtime.sqlite3"));
	assert.equal(alphaPaths.configPath, join(root, "naia-settings/messenger-sessions/instances/alpha/config.json"));
	assert.equal(alphaPaths.databasePath, join(root, "naia-settings/.sessions/messenger-sessions/instances/alpha/runtime.sqlite3"));
	assert.notEqual(alphaPaths.lockPath, defaultPaths.lockPath);
	assert.notEqual(alphaPaths.stopRequestPath, defaultPaths.stopRequestPath);
	assert.notEqual(alphaPaths.recoveryKeyPath, defaultPaths.recoveryKeyPath);
	const defaultUnit = discordUnitIdentity(root);
	const alphaUnit = discordUnitIdentity(root, "alpha");
	assert.notEqual(alphaUnit.unitName, defaultUnit.unitName);
	const defaultRendered = renderDiscordUserUnit({ adkRoot: root, tokenFingerprint: TOKEN_FINGERPRINT, runtimeRevision: RUNTIME_REVISION, nodePath: "/usr/bin/node" });
	const alpha = renderDiscordUserUnit({ adkRoot: root, instance: "alpha", tokenFingerprint: TOKEN_FINGERPRINT, runtimeRevision: RUNTIME_REVISION, nodePath: "/usr/bin/node" });
	assert.equal(alpha.instance, "alpha");
	assert.equal(defaultRendered.content.includes(`%t/naia-discord-token-${TOKEN_FINGERPRINT}.lock`), true);
	assert.equal(alpha.content.includes(`%t/naia-discord-token-${TOKEN_FINGERPRINT}.lock`), true);
	assert.equal(alpha.content.includes("RuntimeDirectory="), false);
	assert.match(alpha.content, /--instance" "alpha"/);
	assert.match(alpha.content, /Description=Naia ADK Discord sessions \(alpha\)/);
	assert.throws(() => normalizeMessengerInstance("../alpha"), /lowercase identifier/);
	assert.throws(() => normalizeMessengerInstance("Alpha"), /lowercase identifier/);
	assert.throws(() => normalizeMessengerInstance("service"), /command name/);
	store.close();
});

test("DSG-008 pins the selected backend executable independently of the systemd PATH", () => {
	const root = mkdtempSync(join(tmpdir(), "naia-discord-systemd-backend-"));
	roots.push(root);
	const bin = join(root, "bin");
	mkdirSync(bin, { mode: 0o700 });
	const codex = join(bin, "codex");
	writeFileSync(codex, "#!/bin/sh\n", { mode: 0o700 });
	const resolved = resolveBackendExecutable("codex", bin);
	if (process.platform === "win32") {
		const launcher = renderOperatorLauncher(root);
		assert.match(launcher, /@echo off/);
		assert.match(launcher, /managed by naia-adk manage-discord-sessions/);
		assert.match(launcher, /cli\.mjs/);
		const cli = join(import.meta.dirname, "../helper/cli.mjs");
		const service = spawnSync(process.execPath, [cli, "--adk-root", root, "service", "unit"], { encoding: "utf8", windowsHide: true });
		assert.equal(service.status, 0, service.stderr);
		assert.match(service.stdout, /Windows Task Scheduler: NaiaDiscordSessions-/);
		return;
	}
	const unit = renderDiscordUserUnit({ adkRoot: root, tokenFingerprint: TOKEN_FINGERPRINT, runtimeRevision: RUNTIME_REVISION, nodePath: "/opt/node/bin/node", backendExecutables: { codex: resolved } });
	assert.match(unit.content, new RegExp(`Environment=\\"NAIA_CODEX_EXECUTABLE=${resolved.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\"`));
	assert.match(unit.content, /Environment="PATH=\/opt\/node\/bin:/);
	assert.match(unit.content, new RegExp(`PATH=[^\\n]*${bin.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}`));
	assert.throws(() => resolveBackendExecutable("claude", bin), /not found/);
	assert.deepEqual(installServiceCommands(unit.unitName), [["enable", unit.unitName], ["restart", unit.unitName]]);
	assert.deepEqual(installServiceCommands(unit.unitName, false), [["disable", "--now", unit.unitName]]);
	assert.throws(() => installServiceCommands(unit.unitName, "false"), /auto-start policy/);
	assert.throws(() => installServiceCommands("other.service"), /invalid/);
	const launcher = renderOperatorLauncher(root);
	assert.match(launcher, /managed by naia-adk manage-discord-sessions/);
	assert.match(launcher, /manage-discord-sessions\.sh' "\$@"/);
});

test("DSG-008 Bash entrypoint preserves every top-level CLI command", () => {
	const script = readFileSync(join(import.meta.dirname, "../scripts/manage-discord-sessions.sh"), "utf8");
	for (const command of ["status", "health-check", "jobs", "job", "watch", "logs", "monitor", "cancel", "restart", "amend", "history", "latest", "attachment", "reply", "service", "cutover", "artifacts"]) {
		assert.match(script, new RegExp(`\\b${command}\\b`));
	}
});

test("DSG-021 routes artifact retention operations as explicit operator commands", () => {
	const { root, store } = fixture();
	store.close();
	const cli = fileURLToPath(new URL("../helper/cli.mjs", import.meta.url));
	const result = spawnSync(process.execPath, [cli, "--adk-root", root, "artifacts", "delete"], { encoding: "utf8" });
	assert.equal(result.status, 2);
	assert.match(result.stderr, /artifacts requires list or prune/);
	assert.equal(result.stderr.includes("lowercase identifier"), false);
});

test("DSG-021 routes cutover canary as an operator command instead of an instance", () => {
	const { root, store } = fixture();
	store.close();
	const cli = fileURLToPath(new URL("../helper/cli.mjs", import.meta.url));
	const result = spawnSync(process.execPath, [cli, "--adk-root", root, "cutover", "canary"], { encoding: "utf8" });
	assert.equal(result.status, 2);
	assert.match(result.stderr, /cutover canary requires --job/);
	assert.equal(result.stderr.includes("lowercase identifier"), false);
});

test("DSG-008 POSIX operator launcher remains owner-executable after hardening", { skip: process.platform === "win32" }, () => {
	const root = mkdtempSync(join(tmpdir(), "naia-discord-launcher-root-"));
	const bin = mkdtempSync(join(tmpdir(), "naia-discord-launcher-bin-"));
	roots.push(root, bin);
	const scripts = join(root, ".agents/skills/manage-discord-sessions/scripts");
	mkdirSync(scripts, { recursive: true });
	writeFileSync(join(scripts, "manage-discord-sessions.sh"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });
	const existing = join(bin, "naia");
	writeFileSync(existing, "#!/usr/bin/env bash\n# managed by naia-adk manage-discord-sessions\nexit 1\n", { mode: 0o600 });
	const launcher = installOperatorLauncher(root, { directory: bin });
	assert.equal(statSync(launcher).mode & 0o777, 0o700);
	assert.doesNotThrow(() => accessSync(launcher, fsConstants.X_OK));
	assert.equal(spawnSync(launcher, ["service", "unit"]).status, 0);
});

test("DSG-008 Windows operator launcher passes its native execution probe", { skip: process.platform !== "win32" }, () => {
	const root = mkdtempSync(join(tmpdir(), "naia-discord-win-launcher-root-"));
	const bin = mkdtempSync(join(tmpdir(), "naia-discord-win-launcher-bin-"));
	roots.push(root, bin);
	const helper = join(root, ".agents/skills/manage-discord-sessions/helper");
	mkdirSync(helper, { recursive: true });
	writeFileSync(join(helper, "cli.mjs"), "process.exit(process.argv.slice(-2).join(' ') === 'service unit' ? 0 : 1);\n", { mode: 0o600 });
	const launcher = installOperatorLauncher(root, { directory: bin });
	assert.equal(spawnSync(launcher, ["service", "unit"], { shell: true, windowsHide: true }).status, 0);
});

test("DSG-008 quotes and verifies the exact Windows Task Scheduler action", () => {
	const action = "C:\\Program Files\\Naia Workspace\\service-launch.cmd";
	assert.equal(quoteWindowsTaskAction(action), action);
	assert.equal(verifyWindowsTaskAction(
		`<?xml version="1.0"?><Task><Principals><Principal><UserId>S-1-5-21-1</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Triggers><LogonTrigger /></Triggers><Actions><Exec><Command>C:\\Program Files\\Naia Workspace\\service-launch.cmd</Command></Exec></Actions></Task>`,
		action, "S-1-5-21-1",
	), true);
	assert.equal(verifyWindowsTaskAction(
		`<?xml version="1.0"?><Task><Principals><Principal><UserId>S-1-5-21-1</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Actions><Exec><Command>C:\\Program Files\\Naia Workspace\\service-launch.cmd</Command></Exec></Actions></Task>`,
		action, "S-1-5-21-1",
	), true);
	assert.throws(
		() => verifyWindowsTaskAction("<Task><Principals><Principal><UserId>S-1-5-21-1</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Triggers><LogonTrigger /></Triggers><Actions><Exec><Command>C:\\Other\\launch.cmd</Command></Exec></Actions></Task>", action, "S-1-5-21-1"),
		/does not match/,
	);
	assert.throws(() => verifyWindowsTaskAction(
		"<Task><Principals><Principal><UserId>S-1-5-21-1</UserId><LogonType>Password</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals><Triggers><BootTrigger /><LogonTrigger /></Triggers><Actions><Exec><Command>C:\\Program Files\\Naia Workspace\\service-launch.cmd</Command></Exec><ComHandler /></Actions></Task>",
		action, "S-1-5-21-1",
	), /one executable action|only one logon trigger|limited interactive principal/);
	assert.throws(() => verifyWindowsTaskAction(
		"<Task><Principals><Principal><UserId>S-1-5-21-1</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal><Principal><UserId>S-1-5-21-1</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Triggers><LogonTrigger /></Triggers><Actions><Exec><Command>C:\\Program Files\\Naia Workspace\\service-launch.cmd</Command><Arguments>unsafe</Arguments></Exec><SendEmail /></Actions></Task>",
		action, "S-1-5-21-1",
	), /one executable action|only the launcher command|principal is not uniquely defined/);
	assert.throws(() => verifyWindowsTaskAction(
		"<Task><Principals><Principal><UserId>S-1-5-21-1</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel><ProcessTokenSidType>Unrestricted</ProcessTokenSidType><RequiredPrivileges><Privilege>SeDebugPrivilege</Privilege></RequiredPrivileges></Principal></Principals><Triggers><LogonTrigger /></Triggers><Actions><Exec><Command>C:\\Program Files\\Naia Workspace\\service-launch.cmd</Command></Exec></Actions></Task>",
		action, "S-1-5-21-1",
	), /unsupported privileges/);
	assert.throws(() => quoteWindowsTaskAction("relative\\launch.cmd"), /absolute/);
});

test("DSG-008 renders a hidden per-user Startup fallback without embedding credentials", () => {
	const content = renderWindowsStartupLauncher("C:\\Naia Workspace\\service-launch.cmd");
	assert.match(content, /WScript\.Shell/);
	assert.match(content, /service-launch\.cmd/);
	assert.match(content, /, 0, False/);
	assert.equal(/token|credential|secret/i.test(content), false);
});

test("DSG-008 resolves the installed Windows npm shim to pinned node and script paths", { skip: process.platform !== "win32" }, () => {
	const command = resolveWindowsBackendCommand("codex");
	assert.equal(typeof command, "object");
	assert.match(command.command, /node\.exe$/i);
	assert.equal(command.prefixArgs.length, 1);
	assert.match(command.prefixArgs[0], /[\\/]codex\.js$/i);
});

test("DSG-008 rejects caller-controlled Windows system roots", { skip: process.platform !== "win32" }, () => {
	const originalRoot = process.env.SystemRoot;
	const originalWinDir = process.env.WINDIR;
	const fakeRoot = mkdtempSync(join(tmpdir(), "naia-fake-system-root-"));
	roots.push(fakeRoot);
	try {
		process.env.SystemRoot = fakeRoot;
		process.env.WINDIR = fakeRoot;
		assert.throws(() => trustedWindowsSystemExecutable("taskkill.exe"), /identity mismatch/);
	} finally {
		process.env.SystemRoot = originalRoot;
		process.env.WINDIR = originalWinDir;
	}
});

test("DSG-008 retries Windows Task Scheduler restart within a fixed bound", () => {
	const calls = [];
	const waits = [];
	let starts = 0;
	const attempts = restartWindowsTask("NaiaDiscordSessions-123456789abc", {
		maxAttempts: 4,
		retryDelayMs: 10,
		wait: (milliseconds) => waits.push(milliseconds),
		run: (args, options = {}) => {
			calls.push({ args, options });
			if (args[0] === "/End") return { status: 0, output: "" };
			starts += 1;
			return { status: starts < 3 ? 1 : 0, output: "" };
		},
	});
	assert.equal(attempts, 3);
	assert.deepEqual(calls.map((call) => call.args[0]), ["/End", "/Run", "/Run", "/Run"]);
	assert.deepEqual(waits, [10, 10]);
	assert.throws(() => restartWindowsTask("NaiaDiscordSessions-123456789abc", {
		maxAttempts: 2,
		retryDelayMs: 0,
		wait: () => {},
		stopOwned: () => true,
		run: () => ({ status: 1, output: "" }),
	}), /bounded retry window/);
});

test("DSG-008 tolerates transient Windows ownership gaps while stopping", () => {
	const owner = { generation: "generation-a" };
	assert.equal(classifyWindowsStopObservation({ owner, currentOwner: owner, observation: { state: "unknown" } }), "wait");
	assert.equal(classifyWindowsStopObservation({ owner, currentOwner: owner, observation: { state: "owned" } }), "wait");
	assert.equal(classifyWindowsStopObservation({ owner, currentOwner: owner, observation: { state: "missing" } }), "stopped");
	assert.equal(classifyWindowsStopObservation({ owner, currentOwner: null, observation: { state: "unknown" } }), "stopped");
	assert.throws(() => classifyWindowsStopObservation({ owner, currentOwner: { generation: "generation-b" }, observation: { state: "owned" } }), /generation changed/);
	assert.throws(() => classifyWindowsStopObservation({ owner, currentOwner: { generation: "generation-b" }, observation: { state: "missing" } }), /generation changed/);
	assert.throws(() => classifyWindowsStopObservation({ owner, currentOwner: owner, observation: { state: "conflict" } }), /ownership changed/);
	const calls = [];
	let currentOwner = owner;
	assert.throws(() => sampleWindowsStopObservation({
		owner,
		observe: () => { calls.push("observe"); currentOwner = { generation: "generation-b" }; return { state: "missing" }; },
		getCurrentOwner: () => { calls.push("owner"); return currentOwner; },
	}), /generation changed/);
	assert.deepEqual(calls, ["observe", "owner"]);
});
