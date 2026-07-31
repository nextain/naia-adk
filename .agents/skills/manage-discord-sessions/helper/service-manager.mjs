#!/usr/bin/env node
import { accessSync, chmodSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { renderDiscordUserUnit } from "./systemd.mjs";
import { loadMessengerConfig } from "./discord-config.mjs";
import { messengerInstancePaths, normalizeMessengerInstance } from "./instance-paths.mjs";

function runSystemctl(args) {
	const result = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
	if (result.status !== 0) throw new Error((result.stderr || result.stdout || "systemctl failed").trim());
	return result.stdout.trim();
}

export function resolveBackendExecutable(name, pathValue = process.env.PATH ?? "") {
	if (!new Set(["codex", "claude"]).has(name)) throw new Error("unsupported backend executable");
	for (const directory of pathValue.split(delimiter).filter(Boolean)) {
		const candidate = resolve(directory, name);
		try {
			accessSync(candidate, fsConstants.X_OK);
			const executable = realpathSync(candidate);
			if (!isAbsolute(executable) || !statSync(executable).isFile()) continue;
			return executable;
		} catch {}
	}
	throw new Error(`${name} executable was not found in the installer PATH`);
}

export function installServiceCommands(unitName) {
	if (typeof unitName !== "string" || !/^naia-discord-sessions-[a-f0-9]{12}\.service$/.test(unitName)) throw new Error("invalid Discord service unit name");
	return [["enable", unitName], ["restart", unitName]];
}

const OPERATOR_LAUNCHER_MARKER = "# managed by naia-adk manage-discord-sessions";

function shellQuote(value) {
	return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

export function renderOperatorLauncher(adkRoot) {
	const script = resolve(realpathSync(adkRoot), ".agents/skills/manage-discord-sessions/scripts/manage-discord-sessions.sh");
	return `#!/usr/bin/env bash\n${OPERATOR_LAUNCHER_MARKER}\nset -euo pipefail\nexec ${shellQuote(script)} "$@"\n`;
}

function installOperatorLauncher(adkRoot) {
	const directory = resolve(homedir(), ".local/bin");
	const path = resolve(directory, "naia");
	const content = renderOperatorLauncher(adkRoot);
	mkdirSync(directory, { recursive: true, mode: 0o755 });
	if (existsSync(path)) {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("existing naia command is not a replaceable managed file");
		if (!readFileSync(path, "utf8").includes(OPERATOR_LAUNCHER_MARKER)) throw new Error("existing naia command is not managed by this installer");
	}
	writeFileSync(path, content, { mode: 0o755 });
	chmodSync(path, 0o755);
	return path;
}

export function manageService({ adkRoot, command, instance = "default" }) {
	const normalizedInstance = normalizeMessengerInstance(instance);
	const paths = messengerInstancePaths(adkRoot, normalizedInstance);
	const config = command === "unit" ? null : loadMessengerConfig(paths.configPath);
	const backendExecutables = command === "install" ? { [config.backend.selected]: resolveBackendExecutable(config.backend.selected) } : {};
	const rendered = renderDiscordUserUnit({ adkRoot, instance: normalizedInstance, backendExecutables });
	const unitDirectory = resolve(homedir(), ".config/systemd/user");
	const unitPath = resolve(unitDirectory, rendered.unitName);
	if (command === "install") {
		mkdirSync(paths.stateDirectory, { recursive: true, mode: 0o700 });
		chmodSync(paths.stateDirectory, 0o700);
		mkdirSync(unitDirectory, { recursive: true, mode: 0o700 });
		writeFileSync(unitPath, rendered.content, { mode: 0o600 });
		const launcherPath = installOperatorLauncher(adkRoot);
		runSystemctl(["daemon-reload"]);
		if (config.service?.startAt === "boot") {
			const linger = spawnSync("loginctl", ["enable-linger", userInfo().username], { encoding: "utf8" });
			if (linger.status !== 0) throw new Error((linger.stderr || linger.stdout || "could not enable user lingering").trim());
		}
		if (config.service?.autoStart !== false) for (const args of installServiceCommands(rendered.unitName)) runSystemctl(args);
		return `installed ${rendered.unitName} and ${launcherPath}`;
	}
	if (command === "status") return runSystemctl(["status", "--no-pager", rendered.unitName]);
	if (new Set(["start", "stop", "restart", "enable", "disable"]).has(command)) {
		runSystemctl([command, rendered.unitName]);
		return `${command} ${rendered.unitName}`;
	}
	if (command === "unit") return rendered.content;
	throw new Error(`unsupported service command: ${command}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
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
