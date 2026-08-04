import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { acquireDiscordArtifactOperationLock, createManagedRuntimeArtifact, listManagedDiscordArtifacts, pruneManagedDiscordArtifacts, validateConfigWithRuntime, verifyLinuxLegacyRegistration, verifyLinuxLegacyRegistrationBinding, verifyLinuxManagedRegistration } from "../helper/cutover-bundle.mjs";
import { verifyManagedServiceRuntimeEnvironment } from "../helper/service.mjs";
import { SessionStore } from "../helper/store.mjs";
import { authorizeManagedServiceInstall, classifyWindowsTaskQuery, removeUnreferencedManagedRuntimeArtifact, verifyLinuxInstallOutcome } from "../helper/service-manager.mjs";
import { messengerInstancePaths } from "../helper/instance-paths.mjs";
import { discordUnitIdentity } from "../helper/systemd.mjs";

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_FINGERPRINT = "f".repeat(64);
const temporaryRoots = [];
const temporaryDirectory = (prefix) => {
	const root = mkdtempSync(join(tmpdir(), prefix));
	temporaryRoots.push(root);
	return root;
};
test.after(() => temporaryRoots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function git(root, ...args) {
	const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr || result.stdout);
	return result.stdout.trim();
}

function committedRuntimeFixture() {
	const root = temporaryDirectory("discord-managed-runtime-");
	const destination = join(root, ".agents/skills/manage-discord-sessions");
	mkdirSync(dirname(destination), { recursive: true });
	cpSync(SKILL_ROOT, destination, { recursive: true });
	git(root, "init", "-q");
	git(root, "config", "user.email", "test@example.invalid");
	git(root, "config", "user.name", "test");
	git(root, "add", ".agents/skills/manage-discord-sessions");
	git(root, "commit", "-qm", "runtime fixture");
	const revision = git(root, "rev-parse", "HEAD");
	const runtimeTreeId = git(root, "rev-parse", `${revision}:.agents/skills/manage-discord-sessions`);
	return { root, revision, runtimeTreeId };
}

function runtimeEnvironment(artifact) {
	return {
		NAIA_DISCORD_LAUNCH_MODE: "managed-systemd",
		NAIA_DISCORD_RUNTIME_ARTIFACT: artifact.artifactDirectory,
		NAIA_DISCORD_RUNTIME_REVISION: artifact.manifest.sourceRevision,
		NAIA_DISCORD_RUNTIME_TREE_ID: artifact.manifest.sourceRuntimeTreeId,
		NAIA_DISCORD_RUNTIME_SHA256: artifact.manifest.runtimeSha256,
	};
}

function quoteUnit(value) {
	return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function writeLegacyRegistration(root, unitDirectory, { instance = "default", backend = "codex", executable = process.execPath } = {}) {
	const identity = discordUnitIdentity(root, instance);
	const paths = messengerInstancePaths(root, instance);
	const nodePath = realpathSync(process.execPath);
	const backendExecutable = realpathSync(executable);
	const servicePath = resolve(root, ".agents/skills/manage-discord-sessions/helper/service.mjs");
	const supervisorPath = resolve(root, ".agents/skills/manage-discord-sessions/helper/supervisor.mjs");
	const base = identity.unitName.slice(0, -".service".length);
	const supervisorService = `${base}-supervisor.service`;
	const supervisorTimer = `${base}-supervisor.timer`;
	const serviceExec = ["/usr/bin/flock", "--no-fork", "--nonblock", paths.lockPath, nodePath, servicePath, "--adk-root", identity.root, "--instance", identity.instance].map(quoteUnit).join(" ");
	const executablePath = [...new Set([dirname(nodePath), dirname(backendExecutable), "/usr/local/bin", "/usr/bin", "/bin"])].join(delimiter);
	const service = `[Unit]\nDescription=Naia ADK Discord sessions (${identity.instance})\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${serviceExec}\nEnvironment=${quoteUnit(`NAIA_${backend.toUpperCase()}_EXECUTABLE=${backendExecutable}`)}\nEnvironment=${quoteUnit(`PATH=${executablePath}`)}\nRestart=always\nRestartSec=5\nKillMode=mixed\nTimeoutStopSec=20\nUMask=0077\nNoNewPrivileges=yes\nPrivateTmp=yes\n\n[Install]\nWantedBy=default.target\n`;
	const supervisorExec = [nodePath, supervisorPath, "--adk-root", identity.root, "--instance", identity.instance].map(quoteUnit).join(" ");
	const supervisorServiceContent = `[Unit]\nDescription=Naia ADK Discord independent health observer (${identity.instance})\n\n[Service]\nType=oneshot\nExecStart=${supervisorExec}\nUMask=0077\nNoNewPrivileges=yes\nPrivateTmp=yes\n`;
	const supervisorTimerContent = `[Unit]\nDescription=Naia ADK Discord health observer timer (${identity.instance})\n\n[Timer]\nOnBootSec=30s\nOnUnitActiveSec=60s\nAccuracySec=1s\nPersistent=true\nUnit=${supervisorService}\n\n[Install]\nWantedBy=timers.target\n`;
	mkdirSync(unitDirectory, { recursive: true });
	for (const [name, content] of [[identity.unitName, service], [supervisorService, supervisorServiceContent], [supervisorTimer, supervisorTimerContent]]) writeFileSync(join(unitDirectory, name), content, { mode: 0o600 });
	return { identity, servicePath: join(unitDirectory, identity.unitName) };
}

test("managed install runtime stays immutable and mutable checkout B cannot impersonate artifact A", () => {
	const fixture = committedRuntimeFixture();
	const artifact = createManagedRuntimeArtifact({ adkRoot: fixture.root, instance: "alpha", sourceRevision: fixture.revision, sourceRuntimeTreeId: fixture.runtimeTreeId, tokenFingerprint: TOKEN_FINGERPRINT, nodePath: "/usr/bin/node" });
	const environment = runtimeEnvironment(artifact);
	assert.match(artifact.service.content, new RegExp(`${artifact.artifactDirectory.replaceAll("/", "\\/")}\/runtime\/manage-discord-sessions\/helper\/service\\.mjs`));
	assert.match(artifact.service.content, new RegExp(`NAIA_DISCORD_RUNTIME_TREE_ID=${fixture.runtimeTreeId}`));
	assert.match(artifact.service.content, new RegExp(`NAIA_DISCORD_RUNTIME_SHA256=${artifact.manifest.runtimeSha256}`));
	assert.equal(artifact.service.content.indexOf("ExecStartPre=" ) < artifact.service.content.indexOf("ExecStart=\"/usr/bin/flock\""), true);
	assert.equal(statSync(artifact.artifactDirectory).mode & 0o777, 0o700);
	assert.equal(statSync(artifact.manifestPath).mode & 0o777, 0o600);
	assert.equal(verifyManagedServiceRuntimeEnvironment({ environment, runtimePath: artifact.runtimePath }), fixture.revision);
	assert.throws(() => verifyManagedServiceRuntimeEnvironment({ environment: {}, runtimePath: artifact.runtimePath }), /startup_or_runtime_failure/);
	assert.equal(verifyManagedServiceRuntimeEnvironment({ environment: { NAIA_DISCORD_LAUNCH_MODE: "direct" }, runtimePath: artifact.runtimePath, allowDirect: true }), null);

	writeFileSync(join(fixture.root, ".agents/skills/manage-discord-sessions/helper/service.mjs"), "\n// mutable checkout B\n", { flag: "a" });
	assert.throws(() => verifyManagedServiceRuntimeEnvironment({ environment, runtimePath: join(fixture.root, ".agents/skills/manage-discord-sessions") }), /startup_or_runtime_failure/);
	assert.equal(verifyManagedServiceRuntimeEnvironment({ environment, runtimePath: artifact.runtimePath }), fixture.revision);

	writeFileSync(join(artifact.runtimePath, "helper/service.mjs"), "\n// artifact tamper\n", { flag: "a" });
	assert.throws(() => verifyManagedServiceRuntimeEnvironment({ environment, runtimePath: artifact.runtimePath }), /startup_or_runtime_failure/);
});

test("managed preflight rejects a tampered imported helper before its top-level code can execute", () => {
	const fixture = committedRuntimeFixture();
	const artifact = createManagedRuntimeArtifact({ adkRoot: fixture.root, sourceRevision: fixture.revision, sourceRuntimeTreeId: fixture.runtimeTreeId, tokenFingerprint: TOKEN_FINGERPRINT, nodePath: process.execPath });
	const sideEffectPath = join(temporaryDirectory("discord-preflight-side-effect-"), "executed");
	writeFileSync(join(artifact.runtimePath, "helper/adapters.mjs"), `\nawait import("node:fs").then(({ writeFileSync }) => writeFileSync(${JSON.stringify(sideEffectPath)}, "executed"));\n`, { flag: "a" });
	const launched = spawnSync(process.execPath, [join(artifact.runtimePath, "helper/service.mjs"), "--managed-preflight"], {
		encoding: "utf8",
		env: { ...process.env, ...runtimeEnvironment(artifact) },
	});
	assert.equal(launched.status, 1);
	assert.match(launched.stderr, /startup_or_runtime_failure/);
	assert.equal(existsSync(sideEffectPath), false);
});

test("managed supervisor verifies the runtime before importing observer helpers", () => {
	const fixture = committedRuntimeFixture();
	const artifact = createManagedRuntimeArtifact({ adkRoot: fixture.root, sourceRevision: fixture.revision, sourceRuntimeTreeId: fixture.runtimeTreeId, tokenFingerprint: TOKEN_FINGERPRINT, nodePath: process.execPath });
	const sideEffectPath = join(temporaryDirectory("discord-supervisor-side-effect-"), "executed");
	writeFileSync(join(artifact.runtimePath, "helper/unattended-health.mjs"), `\nawait import("node:fs").then(({ writeFileSync }) => writeFileSync(${JSON.stringify(sideEffectPath)}, "executed"));\n`, { flag: "a" });
	const launched = spawnSync(process.execPath, [join(artifact.runtimePath, "helper/supervisor-entry.mjs"), "--adk-root", fixture.root], {
		encoding: "utf8",
		env: { ...process.env, ...runtimeEnvironment(artifact) },
	});
	assert.equal(launched.status, 1);
	assert.match(launched.stderr, /startup_or_runtime_failure/);
	assert.equal(existsSync(sideEffectPath), false);
});

test("Linux registration verification binds exact unit bytes and an enabled active independent timer", () => {
	const fixture = committedRuntimeFixture();
	const artifact = createManagedRuntimeArtifact({ adkRoot: fixture.root, sourceRevision: fixture.revision, sourceRuntimeTreeId: fixture.runtimeTreeId, tokenFingerprint: TOKEN_FINGERPRINT, nodePath: "/usr/bin/node" });
	const unitDirectory = temporaryDirectory("discord-systemd-units-");
	for (const [name, content] of [
		[artifact.service.unitName, artifact.service.content],
		[artifact.supervisor.serviceName, artifact.supervisor.serviceContent],
		[artifact.supervisor.timerName, artifact.supervisor.timerContent],
	]) writeFileSync(join(unitDirectory, name), content, { mode: 0o600 });
	const activeState = (mode) => mode === "is-enabled" ? "enabled" : "active";
	assert.equal(verifyLinuxManagedRegistration({ adkRoot: fixture.root, expectedRevision: fixture.revision, expectedRuntimeTreeId: fixture.runtimeTreeId, unitDirectory, stateReader: (mode) => mode === "is-enabled" ? "enabled" : "active", requireEnabledActive: true }).artifact.manifest.runtimeSha256, artifact.manifest.runtimeSha256);
	const owner = { generation: `${fixture.revision}.deadbeef`, pid: 123, bootId: "boot", processStartIdentity: "start" };
	assert.equal(verifyLinuxInstallOutcome({ adkRoot: fixture.root, runtimeArtifact: artifact, autoStart: true, unitDirectory, stateReader: activeState, ownerReader: () => owner, processObserver: () => ({ state: "owned" }) }).artifact.manifest.runtimeSha256, artifact.manifest.runtimeSha256);
	assert.throws(() => verifyLinuxInstallOutcome({ adkRoot: fixture.root, runtimeArtifact: artifact, autoStart: true, unitDirectory, stateReader: activeState, ownerReader: () => owner, processObserver: () => ({ state: "missing" }) }), /expected owned running process/);
	const disabledState = (mode, unit) => unit === artifact.service.unitName ? (mode === "is-enabled" ? "disabled" : "inactive") : (mode === "is-enabled" ? "enabled" : "active");
	assert.equal(verifyLinuxInstallOutcome({ adkRoot: fixture.root, runtimeArtifact: artifact, autoStart: false, unitDirectory, stateReader: disabledState }).state.service.active, false);
	assert.throws(() => verifyLinuxInstallOutcome({ adkRoot: fixture.root, runtimeArtifact: artifact, autoStart: false, unitDirectory, stateReader: activeState }), /unexpectedly remained enabled or active/);
	assert.throws(() => verifyLinuxManagedRegistration({ adkRoot: fixture.root, expectedRevision: fixture.revision, expectedRuntimeTreeId: fixture.runtimeTreeId, unitDirectory, stateReader: (mode, unit) => unit === artifact.supervisor.timerName && mode === "is-enabled" ? "disabled" : mode === "is-enabled" ? "enabled" : "active", requireEnabledActive: true }), /enabled and active/);
	writeFileSync(join(unitDirectory, artifact.supervisor.timerName), `${artifact.supervisor.timerContent}\n# stale\n`, { mode: 0o600 });
	assert.throws(() => verifyLinuxManagedRegistration({ adkRoot: fixture.root, expectedRevision: fixture.revision, expectedRuntimeTreeId: fixture.runtimeTreeId, unitDirectory, stateReader: activeState, requireEnabledActive: true }), /identity or bytes/);
	writeFileSync(join(unitDirectory, artifact.service.unitName), artifact.service.content.replace(/^Environment="NAIA_DISCORD_RUNTIME_ARTIFACT=.*\n/m, ""), { mode: 0o600 });
	assert.throws(() => verifyLinuxManagedRegistration({ adkRoot: fixture.root, expectedRevision: fixture.revision, expectedRuntimeTreeId: fixture.runtimeTreeId, unitDirectory, stateReader: activeState }), /no unambiguous managed runtime artifact/);
});

test("managed supervisor entry fails before importing observer runtime without valid markers", () => {
	const stateRoot = temporaryDirectory("discord-legacy-supervisor-");
	const supervisorPath = join(SKILL_ROOT, "helper/supervisor-entry.mjs");
	const result = spawnSync(process.execPath, [supervisorPath, "--adk-root", stateRoot], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /startup_or_runtime_failure/);
	assert.equal(existsSync(join(stateRoot, "naia-settings/messenger-sessions/state")), false);
});

test("existing service installation requires a verified cutover while first install remains available", () => {
	assert.equal(authorizeManagedServiceInstall({ hasExistingRegistration: false }), "first_install");
	assert.throws(() => authorizeManagedServiceInstall({ hasExistingRegistration: true }), /verified cutover upgrade/);
	assert.throws(() => authorizeManagedServiceInstall({ hasExistingRegistration: true, verifyCutoverUpgrade: () => { throw new Error("stale registration"); } }), /verified cutover upgrade/);
	let verified = 0;
	assert.equal(authorizeManagedServiceInstall({ hasExistingRegistration: true, verifyCutoverUpgrade: () => { verified += 1; } }), "verified_cutover_upgrade");
	assert.equal(verified, 1);
});

test("one-time legacy adoption binds exact mutable registration bytes before managed install", () => {
	const fixture = committedRuntimeFixture();
	const unitDirectory = temporaryDirectory("discord-legacy-units-");
	const legacy = writeLegacyRegistration(fixture.root, unitDirectory);
	const installed = verifyLinuxLegacyRegistration({ adkRoot: fixture.root, backend: "codex", unitDirectory, stateReader: (mode) => mode === "is-enabled" ? "enabled" : "inactive" });
	assert.equal(installed.sourceRegistration.kind, "legacy_mutable");
	assert.deepEqual(verifyLinuxLegacyRegistrationBinding({ adkRoot: fixture.root, expectedUnitSha256: installed.sourceRegistration.unitSha256, unitDirectory }).sourceRegistration, installed.sourceRegistration);
	writeFileSync(legacy.servicePath, `${readFileSync(legacy.servicePath, "utf8")}# drift\n`, { mode: 0o600 });
	assert.throws(() => verifyLinuxLegacyRegistrationBinding({ adkRoot: fixture.root, expectedUnitSha256: installed.sourceRegistration.unitSha256, unitDirectory }), /changed after cutover prepare/);
});

test("failed install cleanup removes only an unreferenced verified runtime artifact", () => {
	const fixture = committedRuntimeFixture();
	const first = createManagedRuntimeArtifact({ adkRoot: fixture.root, sourceRevision: fixture.revision, sourceRuntimeTreeId: fixture.runtimeTreeId, tokenFingerprint: TOKEN_FINGERPRINT, nodePath: "/usr/bin/node" });
	const absentUnit = join(fixture.root, "absent.service");
	assert.equal(removeUnreferencedManagedRuntimeArtifact(first, absentUnit), true);
	assert.equal(existsSync(first.artifactDirectory), false);
	const retained = createManagedRuntimeArtifact({ adkRoot: fixture.root, sourceRevision: fixture.revision, sourceRuntimeTreeId: fixture.runtimeTreeId, tokenFingerprint: TOKEN_FINGERPRINT, nodePath: "/usr/bin/node" });
	const installedUnit = join(fixture.root, "installed.service");
	writeFileSync(installedUnit, retained.service.content, { mode: 0o600 });
	assert.equal(removeUnreferencedManagedRuntimeArtifact(retained, installedUnit), false);
	assert.equal(existsSync(retained.artifactDirectory), true);
});

test("Linux unit publication and manager setup remain inside the pair quarantine boundary", () => {
	const source = readFileSync(fileURLToPath(new URL("../helper/service-manager-linux.mjs", import.meta.url)), "utf8");
	const installStart = source.indexOf("let launcherPath = null;");
	const pairStart = source.indexOf("installSupervisedPair({", installStart);
	const installEnd = source.indexOf('if (command === "status")', pairStart);
	const transaction = source.slice(pairStart, installEnd);
	const serviceCallback = transaction.slice(transaction.indexOf("installService:"), transaction.indexOf("quarantinePair:"));
	assert.ok(installStart >= 0 && pairStart > installStart && installEnd > pairStart);
	for (const operation of ["writeFileSync(unitPath", 'runSystemctl(["daemon-reload"])', 'spawnSync("loginctl"', "quarantineLinuxSupervisedPair"]) assert.match(transaction, new RegExp(operation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(serviceCallback, /installServiceCommands[\s\S]*verifyLinuxInstallOutcome[\s\S]*return rendered\.unitName/);
});

test("Windows autoStart false first install creates only a disabled Startup fallback", () => {
	const source = readFileSync(fileURLToPath(new URL("../helper/service-manager-windows.mjs", import.meta.url)), "utf8");
	const startupStart = source.indexOf("function installWindowsStartup");
	const startupEnd = source.indexOf("function installWindowsSupervisor", startupStart);
	const startup = source.slice(startupStart, startupEnd);
	assert.match(startup, /const installedPath = autoStart \? path : disabledPath/);
	assert.match(startup, /if \(autoStart\) startWindowsStartupLauncher\(installedPath\)/);
	const serviceStart = source.indexOf("function installWindowsService");
	const serviceEnd = source.indexOf("export function manageWindowsService", serviceStart);
	const service = source.slice(serviceStart, serviceEnd);
	assert.equal((service.match(/startWindowsTask/g) ?? []).length, 1);
	const disabledBranch = service.indexOf("if (!autoStart)");
	const taskCreate = service.indexOf('runSchtasks(["/Create"', disabledBranch);
	assert.ok(disabledBranch >= 0 && taskCreate > disabledBranch);
	assert.match(service.slice(disabledBranch, taskCreate), /installWindowsStartup\(adkRoot, instance, serviceLauncher, false\)/);
	assert.match(service.slice(disabledBranch, taskCreate), /registration: "startup_folder_disabled"/);
	const manage = source.slice(source.indexOf("export function manageWindowsService"));
	const installBranch = manage.slice(manage.indexOf('if (command === "install")'), manage.indexOf('if (command === "status")'));
	const mainInspection = installBranch.indexOf("inspectWindowsRegistration");
	const supervisorInspection = installBranch.indexOf("windowsSupervisorRegistrationExists");
	const launcherInstall = installBranch.indexOf("installOperatorLauncher");
	assert.ok(mainInspection >= 0 && supervisorInspection > mainInspection && launcherInstall > supervisorInspection);
	assert.match(installBranch, /existing Windows Discord service or supervisor registration requires a versioned cutover/);
	assert.doesNotMatch(source, /"\/F"/);
	assert.match(manage, /containWindowsTask\(\{ taskName, disable: true/);
});

test("Windows task queries distinguish confirmed absence from every other failure", () => {
	assert.deepEqual(classifyWindowsTaskQuery({ status: 3 }), { state: "absent", output: "" });
	assert.deepEqual(classifyWindowsTaskQuery({ status: 0, output: "<Task />" }), { state: "present", output: "<Task />" });
	for (const status of [null, 1, 2, 4, 5]) assert.throws(() => classifyWindowsTaskQuery({ status, output: "access denied" }), /query failed/);
	assert.throws(() => classifyWindowsTaskQuery({ status: 0, output: "" }), /query failed/);
	const source = readFileSync(fileURLToPath(new URL("../helper/service-manager-windows.mjs", import.meta.url)), "utf8");
	assert.match(source, /HResult -eq -2147024894/);
	assert.match(source, /queryWindowsTask\(taskName\)/);
});

test("explicit artifact pruning retains the installed runtime and removes only verified orphans", () => {
	const fixture = committedRuntimeFixture();
	const installed = createManagedRuntimeArtifact({ adkRoot: fixture.root, sourceRevision: fixture.revision, sourceRuntimeTreeId: fixture.runtimeTreeId, tokenFingerprint: TOKEN_FINGERPRINT, nodePath: "/usr/bin/node" });
	const orphan = createManagedRuntimeArtifact({ adkRoot: fixture.root, sourceRevision: fixture.revision, sourceRuntimeTreeId: fixture.runtimeTreeId, tokenFingerprint: TOKEN_FINGERPRINT, nodePath: "/usr/bin/node" });
	const unitDirectory = temporaryDirectory("discord-prune-units-");
	for (const [name, content] of [[installed.service.unitName, installed.service.content], [installed.supervisor.serviceName, installed.supervisor.serviceContent], [installed.supervisor.timerName, installed.supervisor.timerContent]]) writeFileSync(join(unitDirectory, name), content, { mode: 0o600 });
	const options = { adkRoot: fixture.root, unitDirectory, stateReader: (mode) => mode === "is-enabled" ? "enabled" : "active" };
	const inventory = listManagedDiscordArtifacts(options);
	assert.equal(inventory.items.find((item) => item.path === installed.artifactDirectory)?.state, "installed_retained");
	assert.equal(inventory.items.find((item) => item.path === orphan.artifactDirectory)?.state, "orphaned_verified");
	const pruned = pruneManagedDiscordArtifacts(options);
	assert.deepEqual(pruned.removed, [{ kind: "managed_runtime", id: orphan.artifactDirectory.split("/").at(-1) }]);
	assert.equal(existsSync(installed.artifactDirectory), true);
	assert.equal(existsSync(orphan.artifactDirectory), false);
});

test("artifact pruning fails closed while the same instance is preparing or installing artifacts", () => {
	const fixture = committedRuntimeFixture();
	const orphan = createManagedRuntimeArtifact({ adkRoot: fixture.root, sourceRevision: fixture.revision, sourceRuntimeTreeId: fixture.runtimeTreeId, tokenFingerprint: TOKEN_FINGERPRINT, nodePath: "/usr/bin/node" });
	const operation = acquireDiscordArtifactOperationLock({ adkRoot: fixture.root });
	try {
		assert.throws(() => pruneManagedDiscordArtifacts({ adkRoot: fixture.root, unitDirectory: temporaryDirectory("discord-locked-prune-units-"), stateReader: () => "not-found" }), /artifact operation is already active/);
		assert.equal(existsSync(orphan.artifactDirectory), true);
	} finally { operation.release(); }
	const pruned = pruneManagedDiscordArtifacts({ adkRoot: fixture.root, unitDirectory: temporaryDirectory("discord-unlocked-prune-units-"), stateReader: () => "not-found" });
	assert.deepEqual(pruned.removed, [{ kind: "managed_runtime", id: orphan.artifactDirectory.split("/").at(-1) }]);
});

test("artifact operation kernel lock releases after its owner process dies", { skip: process.platform === "win32" ? "Linux kernel flock" : false }, async () => {
	const fixture = committedRuntimeFixture();
	const moduleUrl = pathToFileURL(fileURLToPath(new URL("../helper/cutover-bundle.mjs", import.meta.url))).href;
	const child = spawn(process.execPath, ["--input-type=module", "-e", `import { acquireDiscordArtifactOperationLock } from ${JSON.stringify(moduleUrl)}; acquireDiscordArtifactOperationLock({ adkRoot: ${JSON.stringify(fixture.root)} }); process.stdout.write("locked\\n"); setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "pipe"] });
	await new Promise((resolveReady, rejectReady) => {
		let output = "";
		const timer = setTimeout(() => rejectReady(new Error("competing lock owner did not start")), 2_000);
		child.stdout.on("data", (chunk) => {
			output += chunk;
			if (!output.includes("locked\n")) return;
			clearTimeout(timer);
			resolveReady();
		});
		child.once("exit", (code) => { if (!output.includes("locked\n")) { clearTimeout(timer); rejectReady(new Error(`competing lock owner exited ${code}`)); } });
	});
	assert.throws(() => acquireDiscordArtifactOperationLock({ adkRoot: fixture.root }), /artifact operation is already active/);
	child.kill("SIGKILL");
	await new Promise((resolveExit) => child.once("exit", resolveExit));
	let recovered = null;
	const deadline = Date.now() + 2_000;
	while (!recovered && Date.now() < deadline) {
		try { recovered = acquireDiscordArtifactOperationLock({ adkRoot: fixture.root }); }
		catch (error) {
			if (!/artifact operation is already active/.test(error.message)) throw error;
			await new Promise((resolveWait) => setTimeout(resolveWait, 20));
		}
	}
	assert.ok(recovered, "kernel lock did not release after owner death");
	recovered.release();
	const stateDirectory = messengerInstancePaths(fixture.root).stateDirectory;
	assert.deepEqual(readdirSync(stateDirectory).filter((name) => name.startsWith(".artifact-operation-ready-")), []);
});

test("install, prepare, restore, and prune share one instance artifact-operation lock", () => {
	const linux = readFileSync(fileURLToPath(new URL("../helper/service-manager-linux.mjs", import.meta.url)), "utf8");
	const windows = readFileSync(fileURLToPath(new URL("../helper/service-manager-windows.mjs", import.meta.url)), "utf8");
	const controller = readFileSync(fileURLToPath(new URL("../helper/service-cutover-controller.mjs", import.meta.url)), "utf8");
	const artifacts = readFileSync(fileURLToPath(new URL("../helper/cutover-artifacts.mjs", import.meta.url)), "utf8");
	assert.match(linux, /command === "install" \? acquireDiscordArtifactOperationLock/);
	assert.match(windows, /command === "install" \? acquireDiscordArtifactOperationLock/);
	assert.equal((controller.match(/acquireDiscordArtifactOperationLock/g) ?? []).length >= 3, true);
	assert.match(artifacts, /acquireOperation = acquireDiscordArtifactOperationLock/);
});

test("rollback config receipt is produced and rechecked by the materialized source loader", () => {
	const fixture = committedRuntimeFixture();
	const artifact = createManagedRuntimeArtifact({ adkRoot: fixture.root, sourceRevision: fixture.revision, sourceRuntimeTreeId: fixture.runtimeTreeId, tokenFingerprint: TOKEN_FINGERPRINT, nodePath: process.execPath });
	const configPath = join(fixture.root, "rollback-config.json");
	const config = {
		schemaVersion: 1, enabled: true, workspaceId: "rollback-probe",
		persona: { name: "Rollback reader", instructions: "Stay read-only." },
		role: { name: "reader", allowedActions: ["read", "reply"], requiresApproval: [] },
		backend: { selected: "codex", profiles: { codex: { enabled: true } } },
		discord: { credentialRef: "discord-token", botUserId: "111111111111111111", operatorUserIds: [], bindings: [{ kind: "dm", userId: "222222222222222222", allowedUserIds: ["222222222222222222"], respondWhen: "always", canStartConversation: true }] },
		runtime: { approvalPolicy: "never", permissionProfileEpoch: "rollback-probe", maxConcurrentJobs: 1 },
		service: { autoStart: true, startAt: "login" }, recovery: { autoRetry: false },
	};
	writeFileSync(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
	const receipt = validateConfigWithRuntime({ runtimePath: artifact.runtimePath, configPath });
	assert.equal(receipt.result, "accepted");
	assert.deepEqual(validateConfigWithRuntime({ runtimePath: artifact.runtimePath, configPath, expectedReceipt: receipt }), receipt);
	assert.throws(() => validateConfigWithRuntime({ runtimePath: artifact.runtimePath, configPath, expectedReceipt: { ...receipt, configSha256: "0".repeat(64) } }), /receipt mismatch/);
	writeFileSync(configPath, `${JSON.stringify({ schemaVersion: 1 })}\n`, { mode: 0o600 });
	assert.throws(() => validateConfigWithRuntime({ runtimePath: artifact.runtimePath, configPath }), /source runtime rejected/);
});

test("service generations are durable across acceptance and execution while schema 6 remains rollback-compatible", async () => {
	const stateRoot = temporaryDirectory("discord-generation-store-");
	const databasePath = join(stateRoot, "runtime.sqlite3");
	const generationA = `${"a".repeat(40)}.aaaaaaaa`;
	const store = new SessionStore(databasePath);
	store.heartbeatService({ generation: generationA, pid: process.pid });
	store.createJob({ jobId: "generation-job", backendId: "codex", revision: "v2r", activityDetail: "structured", jobType: "conversation" });
	store.startAttempt("generation-job", { attemptId: "generation-attempt", childPid: process.pid });
	const job = store.getJob("generation-job", { includeEvents: false });
	assert.equal(job.acceptingServiceGeneration, generationA);
	assert.equal(job.executingServiceGeneration, generationA);
	store.close();

	const database = new DatabaseSync(databasePath);
	assert.equal(database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, "6");
	const columns = new Set(database.prepare("PRAGMA table_info(jobs)").all().map((column) => column.name));
	assert.equal(columns.has("accepting_service_generation"), true);
	assert.equal(columns.has("executing_service_generation"), true);
	assert.equal(columns.has("execution_binding_json"), true);
	database.close();

	const oldCheckout = temporaryDirectory("discord-old-runtime-");
	const repositoryRoot = resolve(SKILL_ROOT, "../../..");
	const clone = spawnSync("git", ["clone", "-q", "--no-hardlinks", repositoryRoot, oldCheckout], { encoding: "utf8" });
	assert.equal(clone.status, 0, clone.stderr);
	const oldStoreUrl = `${pathToFileURL(join(oldCheckout, ".agents/skills/manage-discord-sessions/helper/store.mjs")).href}?compat=${Date.now()}`;
	const { SessionStore: OldSessionStore } = await import(oldStoreUrl);
	const oldStore = OldSessionStore.openReadOnly(databasePath);
	assert.equal(oldStore.getJob("generation-job", { includeEvents: false }).jobId, "generation-job");
	oldStore.close();
});
