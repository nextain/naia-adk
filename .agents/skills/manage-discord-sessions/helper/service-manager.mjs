#!/usr/bin/env node
import { accessSync, chmodSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { renderDiscordSupervisorUnits, renderDiscordUserUnit } from "./systemd.mjs";
import { loadMessengerConfig } from "./discord-config.mjs";
import { assertOwnerOnly, protectOwnerOnly, trustedWindowsSystemExecutable } from "./platform-security.mjs";
import { messengerInstancePaths, normalizeMessengerInstance } from "./instance-paths.mjs";
import { observeOwnedProcess } from "./projector.mjs";
import { SessionStore } from "./store.mjs";

function runSystemctl(args) {
	const result = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
	if (result.status !== 0) throw new Error((result.stderr || result.stdout || "systemctl failed").trim());
	return result.stdout.trim();
}

export function installSupervisedPair({ installSupervisor, installService, quarantineService }) {
	if (![installSupervisor, installService, quarantineService].every((value) => typeof value === "function")) throw new Error("supervised installation callbacks are required");
	try {
		const supervisor = installSupervisor();
		return { supervisor, service: installService(supervisor) };
	} catch (error) {
		try { quarantineService(); }
		catch (quarantineError) { throw new Error(`${error.message}; service quarantine failed: ${quarantineError.message}`); }
		throw error;
	}
}

export function resolveBackendExecutable(name, pathValue = process.env.PATH ?? "") {
	if (!new Set(["codex", "claude"]).has(name)) throw new Error("unsupported backend executable");
	const extensions = process.platform === "win32"
		? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((value) => value.toLowerCase())]
		: [""];
	for (const directory of pathValue.split(delimiter).filter(Boolean)) {
		for (const extension of extensions) {
			const candidate = resolve(directory, `${name}${extension}`);
			try {
				accessSync(candidate, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
				const executable = realpathSync(candidate);
				if (!isAbsolute(executable) || !statSync(executable).isFile()) continue;
				return executable;
			} catch {}
		}
	}
	throw new Error(`${name} executable was not found in the installer PATH`);
}

export function resolveWindowsBackendCommand(name, pathValue = process.env.PATH ?? "") {
	if (process.platform !== "win32") return resolveBackendExecutable(name, pathValue);
	if (!new Set(["codex", "claude"]).has(name)) throw new Error("unsupported backend executable");
	for (const directory of pathValue.split(delimiter).filter(Boolean)) {
		for (const extension of [".exe", ".com"]) {
			const candidate = resolve(directory, `${name}${extension}`);
			try {
				const command = realpathSync(candidate);
				if (statSync(command).isFile()) return command;
			} catch {}
		}
		const shimPath = resolve(directory, `${name}.cmd`);
		try {
			const shim = readFileSync(shimPath, "utf8");
			const match = shim.match(/"%dp0%\\([^"\r\n]+\.js)"\s+%\*/i);
			if (!match || match[1].split(/[\\/]/).includes("..")) continue;
			const command = realpathSync(resolve(directory, "node.exe"));
			const script = realpathSync(resolve(directory, match[1]));
			const root = `${realpathSync(directory).replace(/[\\/]+$/, "")}\\`.toLowerCase();
			if (!statSync(command).isFile() || !statSync(script).isFile() || !script.toLowerCase().startsWith(root)) continue;
			return { command, prefixArgs: [script] };
		} catch {}
	}
	throw new Error(`${name} native executable or trusted npm shim was not found in the installer PATH`);
}

export function installServiceCommands(unitName) {
	if (typeof unitName !== "string" || !/^naia-discord-sessions-[a-f0-9]{12}\.service$/.test(unitName)) throw new Error("invalid Discord service unit name");
	return [["enable", unitName], ["restart", unitName]];
}

const OPERATOR_LAUNCHER_MARKER = "managed by naia-adk manage-discord-sessions";

function shellQuote(value) {
	return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function windowsBatchPath(value, label) {
	if (typeof value !== "string" || !isAbsolute(value) || /[%!"\r\n]/.test(value)) throw new Error(`${label} is not safe for a Windows launcher`);
	return value;
}

export function renderOperatorLauncher(adkRoot, { platform = process.platform, nodePath = process.execPath } = {}) {
	if (platform === "win32") {
		const root = windowsBatchPath(realpathSync(adkRoot), "ADK root");
		const cli = windowsBatchPath(resolve(root, ".agents/skills/manage-discord-sessions/helper/cli.mjs"), "operator CLI");
		const node = windowsBatchPath(nodePath, "Node executable");
		const quote = (value) => `"${value}"`;
		return `@echo off\r\nREM managed by naia-adk manage-discord-sessions\r\n${quote(node)} ${quote(cli)} --adk-root ${quote(root)} %*\r\n`;
	}
	const script = resolve(realpathSync(adkRoot), ".agents/skills/manage-discord-sessions/scripts/manage-discord-sessions.sh");
	return `#!/usr/bin/env bash\n# ${OPERATOR_LAUNCHER_MARKER}\nset -euo pipefail\nexec ${shellQuote(script)} "$@"\n`;
}

function installOperatorLauncher(adkRoot) {
	const directory = process.platform === "win32"
		? resolve(process.env.LOCALAPPDATA ?? resolve(homedir(), "AppData/Local"), "Microsoft/WindowsApps")
		: resolve(homedir(), ".local/bin");
	const path = resolve(directory, process.platform === "win32" ? "naia.cmd" : "naia");
	const content = renderOperatorLauncher(adkRoot);
	mkdirSync(directory, { recursive: true, mode: 0o755 });
	if (existsSync(path)) {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("existing naia command is not a replaceable managed file");
		if (!readFileSync(path, "utf8").includes(OPERATOR_LAUNCHER_MARKER)) throw new Error("existing naia command is not managed by this installer");
	}
	writeFileSync(path, content, { mode: 0o755 });
	chmodSync(path, 0o755);
	protectOwnerOnly(path, "file", "operator launcher");
	return path;
}

function windowsTaskName(adkRoot, instance = "default") {
	const identity = `${realpathSync(adkRoot).toLowerCase()}\0${normalizeMessengerInstance(instance)}`;
	return `NaiaDiscordSessions-${createHash("sha256").update(identity).digest("hex").slice(0, 12)}`;
}

export function windowsSupervisorTaskName(adkRoot, instance = "default") {
	return `${windowsTaskName(adkRoot, instance)}-Supervisor`;
}

function trustedWindowsCommand(name) {
	const systemRoot = realpathSync("C:\\Windows");
	if (process.env.SystemRoot && realpathSync(process.env.SystemRoot).toLowerCase() !== systemRoot.toLowerCase()) throw new Error("Windows system directory identity mismatch");
	if (process.env.WINDIR && realpathSync(process.env.WINDIR).toLowerCase() !== systemRoot.toLowerCase()) throw new Error("Windows system directory identity mismatch");
	const path = join(systemRoot, "System32", name);
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`trusted Windows ${name} is unavailable`);
	return realpathSync(path);
}

function currentWindowsSid() {
	const result = spawnSync(trustedWindowsCommand("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
	const match = result.status === 0 ? result.stdout.match(/"(S-\d+(?:-\d+)+)"/i) : null;
	if (!match) throw new Error("current Windows user identity is unavailable");
	return match[1];
}

function runSchtasks(args, { allowMissing = false } = {}) {
	const result = spawnSync(trustedWindowsCommand("schtasks.exe"), args, { encoding: "utf8", windowsHide: true });
	if (result.status !== 0 && !allowMissing) throw new Error("Windows Discord service command failed");
	return { status: result.status, output: (result.stdout || "").trim(), error: (result.stderr || "").trim() };
}

export function renderWindowsStartupLauncher(serviceLauncher) {
	const launcher = windowsBatchPath(serviceLauncher, "service launcher").replaceAll('"', '""');
	return `Set shell = CreateObject("WScript.Shell")\r\nshell.Run Chr(34) & "${launcher}" & Chr(34), 0, False\r\n`;
}

function windowsStartupDirectory() {
	const powershell = trustedWindowsSystemExecutable("WindowsPowerShell", "v1.0", "powershell.exe");
	const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)"], { encoding: "utf8", windowsHide: true });
	const directory = result.status === 0 ? result.stdout.trim() : "";
	if (!directory || !isAbsolute(directory) || !statSync(directory).isDirectory()) throw new Error("Windows Startup directory is unavailable");
	return realpathSync(directory);
}

function windowsStartupPath(adkRoot, instance) {
	return resolve(windowsStartupDirectory(), `${windowsTaskName(adkRoot, instance)}.vbs`);
}

function startWindowsStartupLauncher(path) {
	const child = spawn(trustedWindowsSystemExecutable("wscript.exe"), [path], { detached: true, windowsHide: true, stdio: "ignore" });
	child.unref();
}

function installWindowsStartup(adkRoot, instance, serviceLauncher, autoStart) {
	const path = windowsStartupPath(adkRoot, instance);
	removeManagedStartup(`${path}.disabled`, serviceLauncher);
	writeFileSync(path, renderWindowsStartupLauncher(serviceLauncher), "utf8");
	protectOwnerOnly(path, "file", "Windows Startup launcher");
	if (autoStart) startWindowsStartupLauncher(path);
	return path;
}

function installWindowsSupervisor(adkRoot, instance, paths) {
	const stateDirectory = paths.stateDirectory;
	const root = windowsBatchPath(realpathSync(adkRoot), "ADK root");
	const node = windowsBatchPath(process.execPath, "Node executable");
	const supervisor = windowsBatchPath(resolve(adkRoot, ".agents/skills/manage-discord-sessions/helper/supervisor.mjs"), "supervisor entry");
	const onceLauncher = resolve(stateDirectory, "supervisor-once.cmd");
	writeFileSync(onceLauncher, `@echo off\r\n"${node}" "${supervisor}" --adk-root "${root}" --instance "${instance}"\r\n`, "utf8");
	protectOwnerOnly(onceLauncher, "file", "Windows Discord supervisor launcher");
	const taskName = windowsSupervisorTaskName(adkRoot, instance);
	const created = runSchtasks(["/Create", "/TN", taskName, "/TR", quoteWindowsTaskAction(onceLauncher), "/SC", "MINUTE", "/MO", "1", "/RL", "LIMITED", "/F"], { allowMissing: true });
	if (created.status === 0) {
		const registered = runSchtasks(["/Query", "/TN", taskName, "/XML"]);
		verifyWindowsTaskAction(registered.output, onceLauncher, currentWindowsSid(), { schedule: "minute" });
		runSchtasks(["/Run", "/TN", taskName]);
		return { registration: "task_scheduler", taskName };
	}
	const existing = runSchtasks(["/Query", "/TN", taskName, "/XML"], { allowMissing: true });
	if (existing.status === 0) {
		verifyWindowsTaskAction(existing.output, onceLauncher, currentWindowsSid(), { schedule: "minute" });
		runSchtasks(["/Run", "/TN", taskName]);
		return { registration: "task_scheduler", taskName };
	}
	throw new Error("Windows Discord supervisor requires a verified one-minute Task Scheduler registration");
}

function inspectWindowsSupervisorRegistration(adkRoot, instance, paths) {
	const taskName = windowsSupervisorTaskName(adkRoot, instance);
	const launcher = resolve(paths.stateDirectory, "supervisor-once.cmd");
	const task = runSchtasks(["/Query", "/TN", taskName, "/XML"], { allowMissing: true });
	if (task.status !== 0) throw new Error("Windows Discord supervisor is not installed");
	verifyWindowsTaskAction(task.output, launcher, currentWindowsSid(), { schedule: "minute" });
	return { registration: "task_scheduler", taskName, launcher };
}

function quarantineWindowsService(adkRoot, instance, paths) {
	const taskName = windowsTaskName(adkRoot, instance);
	const existingTask = runSchtasks(["/Query", "/TN", taskName, "/XML"], { allowMissing: true });
	if (existingTask.status === 0) {
		runSchtasks(["/End", "/TN", taskName], { allowMissing: true });
		const disabled = runSchtasks(["/Change", "/TN", taskName, "/DISABLE"], { allowMissing: true });
		if (disabled.status !== 0) throw new Error("Windows Discord task could not be disabled during quarantine");
		const verified = runSchtasks(["/Query", "/TN", taskName, "/XML"]);
		verifyWindowsTaskDisabled(verified.output);
	}
	const startup = windowsStartupPath(adkRoot, instance);
	if (existsSync(startup)) {
		const serviceLauncher = resolve(paths.stateDirectory, "service-launch.cmd");
		assertOwnerOnly(startup, "file", "Windows Startup launcher");
		if (readFileSync(startup, "utf8") !== renderWindowsStartupLauncher(serviceLauncher)) throw new Error("Windows Startup launcher integrity mismatch during quarantine");
		renameSync(startup, `${startup}.disabled`);
	}
	stopOwnedWindowsService(paths);
}

function removeManagedStartup(path, serviceLauncher) {
	if (!existsSync(path)) return;
	assertOwnerOnly(path, "file", "Windows Startup launcher");
	if (readFileSync(path, "utf8") !== renderWindowsStartupLauncher(serviceLauncher)) throw new Error("Windows Startup launcher is not managed by this installer");
	unlinkSync(path);
}

function inspectWindowsRegistration(adkRoot, instance, paths) {
	const taskName = windowsTaskName(adkRoot, instance);
	const serviceLauncher = resolve(paths.stateDirectory, "service-launch.cmd");
	const task = runSchtasks(["/Query", "/TN", taskName, "/XML"], { allowMissing: true });
	if (task.status === 0) {
		verifyWindowsTaskAction(task.output, serviceLauncher, currentWindowsSid());
		if (existsSync(windowsStartupPath(adkRoot, instance)) || existsSync(`${windowsStartupPath(adkRoot, instance)}.disabled`)) throw new Error("Windows service registrations coexist; run service install to reconcile them");
		return { kind: "task_scheduler", taskName, serviceLauncher };
	}
	const startupLauncher = windowsStartupPath(adkRoot, instance);
	if (existsSync(startupLauncher)) {
		assertOwnerOnly(startupLauncher, "file", "Windows Startup launcher");
		if (readFileSync(startupLauncher, "utf8") !== renderWindowsStartupLauncher(serviceLauncher)) throw new Error("Windows Startup launcher integrity mismatch");
		return { kind: "startup_folder", taskName, serviceLauncher, startupLauncher };
	}
	const disabledLauncher = `${startupLauncher}.disabled`;
	if (existsSync(disabledLauncher)) {
		assertOwnerOnly(disabledLauncher, "file", "disabled Windows Startup launcher");
		if (readFileSync(disabledLauncher, "utf8") !== renderWindowsStartupLauncher(serviceLauncher)) throw new Error("disabled Windows Startup launcher integrity mismatch");
		return { kind: "startup_folder_disabled", taskName, serviceLauncher, startupLauncher, disabledLauncher };
	}
	return null;
}

function stopOwnedWindowsService(paths) {
	if (!existsSync(paths.databasePath)) return false;
	const store = new SessionStore(paths.databasePath);
	try {
		const owner = store.getServiceOwner();
		if (!owner) return false;
		const observed = sampleWindowsStopObservation({ owner, getCurrentOwner: () => store.getServiceOwner() });
		if (observed === "stopped") return false;
		if (observed !== "owned") throw new Error("Windows Discord service ownership is not verifiable");
		writeFileSync(paths.stopRequestPath, JSON.stringify({ schemaVersion: 1, generation: owner.generation }), "utf8");
		protectOwnerOnly(paths.stopRequestPath, "file", "Discord stop request");
		for (let attempt = 0; attempt < 50; attempt += 1) {
			waitMilliseconds(100);
			const current = sampleWindowsStopObservation({ owner, getCurrentOwner: () => store.getServiceOwner() });
			if (current === "stopped") return true;
		}
		throw new Error("Windows Discord service did not stop within the bounded wait");
	} finally { store.close(); }
}

export function sampleWindowsStopObservation({ owner, getCurrentOwner, observe = observeOwnedProcess }) {
	const observation = observe(owner);
	const currentOwner = getCurrentOwner();
	const decision = classifyWindowsStopObservation({ owner, currentOwner, observation });
	return decision === "wait" ? observation.state : decision;
}

export function classifyWindowsStopObservation({ owner, currentOwner, observation }) {
	if (!currentOwner) return "stopped";
	if (currentOwner.generation !== owner.generation) throw new Error("Windows Discord service generation changed while stopping");
	if (observation.state === "missing") return "stopped";
	if (observation.state === "conflict") throw new Error("Windows Discord service ownership changed while stopping");
	if (observation.state === "owned" || observation.state === "unknown") return "wait";
	throw new Error("Windows Discord service returned an unsupported ownership state");
}

export function quoteWindowsTaskAction(path) {
	if (typeof path !== "string" || !isAbsolute(path) || path.includes("\"") || /[\r\n]/.test(path)) {
		throw new Error("Windows task action must be an absolute quote-safe path");
	}
	return path;
}

function decodeXmlText(value) {
	return value
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", "\"")
		.replaceAll("&apos;", "'")
		.replaceAll("&amp;", "&");
}

export function verifyWindowsTaskDisabled(xml) {
	if (typeof xml !== "string" || !/<Settings(?:\s[^>]*)?>[\s\S]*?<Enabled>\s*false\s*<\/Enabled>[\s\S]*?<\/Settings>/i.test(xml)) throw new Error("Windows task quarantine did not persist disabled state");
	return true;
}

export function verifyWindowsTaskAction(xml, expectedPath, expectedUserId = null, { schedule = "logon" } = {}) {
	if (typeof xml !== "string" || xml.length > 1024 * 1024) throw new Error("Windows task definition is invalid");
	const commands = [...xml.matchAll(/<Command>([\s\S]*?)<\/Command>/gi)].map((match) => decodeXmlText(match[1].trim()));
	if (commands.length !== 1) throw new Error("Windows task action is not uniquely defined");
	const actions = [...xml.matchAll(/<Actions(?:\s[^>]*)?>([\s\S]*?)<\/Actions>/gi)];
	const execs = [...xml.matchAll(/<Exec(?:\s[^>]*)?>([\s\S]*?)<\/Exec>/gi)];
	if (actions.length !== 1 || execs.length !== 1 || actions[0][1].replace(execs[0][0], "").trim() !== "") throw new Error("Windows task must contain one executable action");
	if (/<Arguments(?:\s|>)/i.test(execs[0][1]) || execs[0][1].replace(/<Command>[\s\S]*?<\/Command>/i, "").trim() !== "") throw new Error("Windows task action must contain only the launcher command");
	const principals = [...xml.matchAll(/<Principal(?:\s[^>]*)?>([\s\S]*?)<\/Principal>/gi)];
	if (principals.length !== 1
		|| (xml.match(/<UserId>/gi) ?? []).length !== 1
		|| (xml.match(/<LogonType>/gi) ?? []).length !== 1
		|| (xml.match(/<RunLevel>/gi) ?? []).length !== 1) throw new Error("Windows task principal is not uniquely defined");
	const principalRemainder = principals[0][1]
		.replace(/<UserId>[\s\S]*?<\/UserId>/i, "")
		.replace(/<LogonType>[\s\S]*?<\/LogonType>/i, "")
		.replace(/<RunLevel>[\s\S]*?<\/RunLevel>/i, "")
		.trim();
	if (principalRemainder !== "") throw new Error("Windows task principal contains unsupported privileges");
	const triggers = [...xml.matchAll(/<Triggers(?:\s[^>]*)?>([\s\S]*?)<\/Triggers>/gi)];
	if (triggers.length !== 1) throw new Error("Windows task must contain one trigger collection");
	if (schedule === "logon") {
		const logonTriggers = [...xml.matchAll(/<LogonTrigger(?:\s[^>]*)?\s*\/>|<LogonTrigger(?:\s[^>]*)?>([\s\S]*?)<\/LogonTrigger>/gi)];
		if (logonTriggers.length !== 1 || /<(BootTrigger|CalendarTrigger|TimeTrigger|EventTrigger|IdleTrigger|RegistrationTrigger|SessionStateChangeTrigger)(?:\s|\/?>)/i.test(xml)) throw new Error("Windows task must contain only one logon trigger");
		const logonBody = (logonTriggers[0][1] ?? "").replace(/<Enabled>\s*true\s*<\/Enabled>/i, "").trim();
		if (logonBody !== "" || triggers[0][1].replace(logonTriggers[0][0], "").trim() !== "") throw new Error("Windows logon trigger contains unsupported conditions");
	} else if (schedule === "minute") {
		const calendar = [...xml.matchAll(/<CalendarTrigger(?:\s[^>]*)?>([\s\S]*?)<\/CalendarTrigger>/gi)];
		if (calendar.length !== 1 || !/<Interval>\s*PT1M\s*<\/Interval>/i.test(calendar[0][1]) || triggers[0][1].replace(calendar[0][0], "").trim() !== "") throw new Error("Windows supervisor task must contain only one minute trigger");
		if (/<Enabled>\s*false\s*<\/Enabled>/i.test(xml) || !/<Settings(?:\s[^>]*)?>[\s\S]*?<Enabled>\s*true\s*<\/Enabled>[\s\S]*?<\/Settings>/i.test(xml)) throw new Error("Windows supervisor task must be enabled");
	} else throw new Error("unsupported Windows task schedule");
	if (!/<RunLevel>\s*LeastPrivilege\s*<\/RunLevel>/i.test(xml) || !/<LogonType>\s*InteractiveToken\s*<\/LogonType>/i.test(xml)) {
		throw new Error("Windows task must use a limited interactive principal");
	}
	const userIds = [...xml.matchAll(/<UserId>([\s\S]*?)<\/UserId>/gi)].map((match) => decodeXmlText(match[1].trim()));
	if (userIds.length !== 1 || (expectedUserId && userIds[0].toLowerCase() !== expectedUserId.toLowerCase())) throw new Error("Windows task principal identity mismatch");
	const actual = resolve(commands[0]).toLowerCase();
	const expected = resolve(expectedPath).toLowerCase();
	if (actual !== expected) throw new Error("Windows task action does not match the protected launcher");
	return true;
}

function waitMilliseconds(milliseconds) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function restartWindowsTask(taskName, {
	run = runSchtasks,
	maxAttempts = 10,
	retryDelayMs = 250,
	wait = waitMilliseconds,
} = {}) {
	if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) throw new Error("invalid Windows restart attempt limit");
	if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 10_000) throw new Error("invalid Windows restart retry delay");
	run(["/End", "/TN", taskName], { allowMissing: true });
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		const result = run(["/Run", "/TN", taskName], { allowMissing: true });
		if (result.status === 0) return attempt;
		if (attempt < maxAttempts) wait(retryDelayMs);
	}
	throw new Error("Windows Discord service did not restart within the bounded retry window");
}

function installWindowsService(adkRoot, instance, paths, config, backendExecutables, supervisor) {
	const stateDirectory = paths.stateDirectory;
	mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
	protectOwnerOnly(stateDirectory, "directory", "Discord service state");
	const serviceLauncher = resolve(stateDirectory, "service-launch.cmd");
	const servicePath = resolve(adkRoot, ".agents/skills/manage-discord-sessions/helper/service.mjs");
	const selected = config.backend.selected;
	const spec = backendExecutables[selected];
	const command = windowsBatchPath(typeof spec === "string" ? spec : spec.command, "backend executable");
	const prefixArgs = (typeof spec === "string" ? [] : spec.prefixArgs).map((item) => windowsBatchPath(item, "backend prefix"));
	const envPrefix = `NAIA_${selected.toUpperCase()}`;
	const envLine = `set "${envPrefix}_EXECUTABLE=${command}"\r\n`
		+ (prefixArgs.length > 0 ? `set "${envPrefix}_PREFIX_ARGS=${Buffer.from(JSON.stringify(prefixArgs)).toString("base64url")}"\r\n` : "");
	const node = windowsBatchPath(process.execPath, "Node executable");
	const root = windowsBatchPath(realpathSync(adkRoot), "ADK root");
	writeFileSync(serviceLauncher, `@echo off\r\n${envLine}"${node}" "${windowsBatchPath(servicePath, "service entry")}" --adk-root "${root}" --instance "${instance}"\r\n`, "utf8");
	protectOwnerOnly(serviceLauncher, "file", "Discord service launcher");
	const taskName = windowsTaskName(adkRoot, instance);
	const created = runSchtasks(["/Create", "/TN", taskName, "/TR", quoteWindowsTaskAction(serviceLauncher), "/SC", "ONLOGON", "/RL", "LIMITED", "/F"], { allowMissing: true });
	if (created.status === 0) {
		const registered = runSchtasks(["/Query", "/TN", taskName, "/XML"]);
		verifyWindowsTaskAction(registered.output, serviceLauncher, currentWindowsSid());
		removeManagedStartup(windowsStartupPath(adkRoot, instance), serviceLauncher);
		removeManagedStartup(`${windowsStartupPath(adkRoot, instance)}.disabled`, serviceLauncher);
		if (config.service?.autoStart !== false) runSchtasks(["/Run", "/TN", taskName]);
		return { taskName, serviceLauncher, registration: "task_scheduler", supervisor };
	}
	const existingTask = runSchtasks(["/Query", "/TN", taskName, "/XML"], { allowMissing: true });
	if (existingTask.status === 0) {
		verifyWindowsTaskAction(existingTask.output, serviceLauncher, currentWindowsSid());
		removeManagedStartup(windowsStartupPath(adkRoot, instance), serviceLauncher);
		removeManagedStartup(`${windowsStartupPath(adkRoot, instance)}.disabled`, serviceLauncher);
		if (config.service?.autoStart !== false) runSchtasks(["/Run", "/TN", taskName]);
		return { taskName, serviceLauncher, registration: "task_scheduler", supervisor };
	}
	const startupLauncher = installWindowsStartup(adkRoot, instance, serviceLauncher, config.service?.autoStart !== false);
	return { taskName, serviceLauncher, startupLauncher, registration: "startup_folder", supervisor };
}

export function manageService({ adkRoot, command, instance = "default" }) {
	const normalizedInstance = normalizeMessengerInstance(instance);
	const paths = messengerInstancePaths(adkRoot, normalizedInstance);
	const config = command === "unit" ? null : loadMessengerConfig(paths.configPath);
	const backendExecutables = command === "install"
		? { [config.backend.selected]: process.platform === "win32" ? resolveWindowsBackendCommand(config.backend.selected) : resolveBackendExecutable(config.backend.selected) }
		: {};
	if (process.platform === "win32") {
		const taskName = windowsTaskName(adkRoot, normalizedInstance);
		if (command === "install") {
			const pair = installSupervisedPair({
				installSupervisor: () => installWindowsSupervisor(adkRoot, normalizedInstance, paths),
				installService: (supervisor) => installWindowsService(adkRoot, normalizedInstance, paths, config, backendExecutables, supervisor),
				quarantineService: () => quarantineWindowsService(adkRoot, normalizedInstance, paths),
			});
			const installed = pair.service;
			const launcherPath = installOperatorLauncher(adkRoot);
			return `installed ${installed.registration} ${installed.startupLauncher ?? installed.taskName}, supervisor ${installed.supervisor.registration}, and ${launcherPath}`;
		}
		if (command === "status") {
			const registration = inspectWindowsRegistration(adkRoot, normalizedInstance, paths);
			const supervisor = inspectWindowsSupervisorRegistration(adkRoot, normalizedInstance, paths);
			if (registration) return `installed ${registration.kind} ${registration.startupLauncher ?? registration.taskName}; supervisor ${supervisor.taskName}`;
			throw new Error("Windows Discord service is not installed");
		}
		if (new Set(["start", "stop", "restart", "enable", "disable"]).has(command)) {
			const registration = inspectWindowsRegistration(adkRoot, normalizedInstance, paths);
			if (!registration) throw new Error("Windows Discord service is not installed");
			if (new Set(["start", "restart", "enable"]).has(command)) inspectWindowsSupervisorRegistration(adkRoot, normalizedInstance, paths);
			if (registration.kind === "task_scheduler") {
				if (command === "start") { runSchtasks(["/Run", "/TN", taskName]); return `started ${taskName}`; }
				if (command === "stop") { runSchtasks(["/End", "/TN", taskName]); return `stopped ${taskName}`; }
				if (command === "restart") { restartWindowsTask(taskName); return `restarted ${taskName}`; }
				runSchtasks(["/Change", "/TN", taskName, command === "enable" ? "/ENABLE" : "/DISABLE"]);
				return `${command}d ${taskName}`;
			}
			if (registration.kind === "startup_folder_disabled" && new Set(["start", "restart"]).has(command)) throw new Error("Windows Discord service is disabled");
			if (command === "stop") { stopOwnedWindowsService(paths); return `stopped ${registration.startupLauncher}`; }
			if (command === "restart") { stopOwnedWindowsService(paths); startWindowsStartupLauncher(registration.startupLauncher); return `restarted ${registration.startupLauncher}`; }
			if (command === "start") { startWindowsStartupLauncher(registration.startupLauncher); return `started ${registration.startupLauncher}`; }
			if (command === "disable" && registration.kind === "startup_folder") { renameSync(registration.startupLauncher, `${registration.startupLauncher}.disabled`); return `disabled ${registration.startupLauncher}`; }
			if (command === "enable" && registration.kind === "startup_folder_disabled") { renameSync(registration.disabledLauncher, registration.startupLauncher); return `enabled ${registration.startupLauncher}`; }
			return `${command}d ${registration.startupLauncher}`;
		}
		if (command === "unit") return `Windows Task Scheduler: ${taskName}`;
		throw new Error(`unsupported service command: ${command}`);
	}
	const rendered = renderDiscordUserUnit({ adkRoot, instance: normalizedInstance, backendExecutables });
	const supervisor = renderDiscordSupervisorUnits({ adkRoot, instance: normalizedInstance });
	const unitDirectory = resolve(homedir(), ".config/systemd/user");
	const unitPath = resolve(unitDirectory, rendered.unitName);
	if (command === "install") {
		mkdirSync(paths.stateDirectory, { recursive: true, mode: 0o700 });
		chmodSync(paths.stateDirectory, 0o700);
		mkdirSync(unitDirectory, { recursive: true, mode: 0o700 });
		writeFileSync(unitPath, rendered.content, { mode: 0o600 });
		writeFileSync(resolve(unitDirectory, supervisor.serviceName), supervisor.serviceContent, { mode: 0o600 });
		writeFileSync(resolve(unitDirectory, supervisor.timerName), supervisor.timerContent, { mode: 0o600 });
		const launcherPath = installOperatorLauncher(adkRoot);
		runSystemctl(["daemon-reload"]);
		if (config.service?.startAt === "boot") {
			const linger = spawnSync("loginctl", ["enable-linger", userInfo().username], { encoding: "utf8" });
			if (linger.status !== 0) throw new Error((linger.stderr || linger.stdout || "could not enable user lingering").trim());
		}
		installSupervisedPair({
			installSupervisor: () => { runSystemctl(["enable", "--now", supervisor.timerName]); return supervisor.timerName; },
			installService: () => {
				if (config.service?.autoStart !== false) for (const args of installServiceCommands(rendered.unitName)) runSystemctl(args);
				return rendered.unitName;
			},
			quarantineService: () => { runSystemctl(["disable", "--now", rendered.unitName]); },
		});
		return `installed ${rendered.unitName}, ${supervisor.timerName}, and ${launcherPath}`;
	}
	if (command === "status") return `${runSystemctl(["status", "--no-pager", rendered.unitName])}\n${runSystemctl(["status", "--no-pager", supervisor.timerName])}`;
	if (new Set(["start", "stop", "restart", "enable", "disable"]).has(command)) {
		if (new Set(["start", "restart", "enable"]).has(command)) runSystemctl(["status", "--no-pager", supervisor.timerName]);
		runSystemctl([command, rendered.unitName]);
		return `${command} ${rendered.unitName}`;
	}
	if (command === "unit") return rendered.content;
	throw new Error(`unsupported service command: ${command}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	const args = process.argv.slice(2);
	const rootIndex = args.indexOf("--adk-root");
	const instanceIndex = args.indexOf("--instance");
	try {
		if (rootIndex < 0 || !args[rootIndex + 1]) throw new Error("--adk-root is required");
		if (instanceIndex < 0 || !args[instanceIndex + 1]) throw new Error("--instance is required");
		const excluded = new Set([rootIndex, rootIndex + 1, instanceIndex, instanceIndex + 1]);
		const command = args.find((value, index) => !excluded.has(index) && !value.startsWith("--"));
		console.log(manageService({ adkRoot: resolve(args[rootIndex + 1]), instance: args[instanceIndex + 1], command }));
	} catch (error) { console.error(error.message); process.exitCode = 1; }
}
