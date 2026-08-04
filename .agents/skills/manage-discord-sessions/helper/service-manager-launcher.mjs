import { accessSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, win32 } from "node:path";
import { spawnSync } from "node:child_process";
import { protectOwnerExecutable, trustedWindowsSystemExecutable } from "./platform-security.mjs";

const OPERATOR_LAUNCHER_MARKER = "managed by naia-adk manage-discord-sessions";

function shellQuote(value) {
	return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

export function windowsBatchPath(value, label) {
	if (typeof value !== "string" || !win32.isAbsolute(value) || /[%!"\r\n]/.test(value)) throw new Error(`${label} is not safe for a Windows launcher`);
	return value;
}

export function windowsOperatorProbeArguments(path) {
	const launcher = windowsBatchPath(path, "operator launcher");
	return ["/d", "/s", "/c", `""${launcher}" service unit"`];
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

export function installOperatorLauncher(adkRoot, { directory: targetDirectory } = {}) {
	const directory = targetDirectory ?? (process.platform === "win32"
		? resolve(process.env.LOCALAPPDATA ?? resolve(homedir(), "AppData/Local"), "Microsoft/WindowsApps")
		: resolve(homedir(), ".local/bin"));
	const path = resolve(directory, process.platform === "win32" ? "naia.cmd" : "naia");
	const content = renderOperatorLauncher(adkRoot);
	mkdirSync(directory, { recursive: true, mode: 0o755 });
	if (existsSync(path)) {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("existing naia command is not a replaceable managed file");
		if (!readFileSync(path, "utf8").includes(OPERATOR_LAUNCHER_MARKER)) throw new Error("existing naia command is not managed by this installer");
	}
	writeFileSync(path, content, { mode: 0o600 });
	protectOwnerExecutable(path, "operator launcher");
	if (process.platform !== "win32") {
		accessSync(path, fsConstants.X_OK);
		const probe = spawnSync(path, ["service", "unit"], { encoding: "utf8", timeout: 5_000 });
		if (probe.error || probe.status !== 0) throw new Error("operator launcher execution probe failed");
	} else {
		const command = trustedWindowsSystemExecutable("cmd.exe");
		const probe = spawnSync(command, windowsOperatorProbeArguments(path), { encoding: "utf8", windowsHide: true, timeout: 5_000 });
		if (probe.error || probe.status !== 0) throw new Error("operator launcher execution probe failed");
	}
	return path;
}
