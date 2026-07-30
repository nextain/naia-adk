import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

function unitQuote(value) {
	if (typeof value !== "string" || /[\r\n\0]/.test(value)) throw new Error("systemd value is unsafe");
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function discordUnitIdentity(adkRoot) {
	const root = realpathSync(resolve(adkRoot));
	const suffix = createHash("sha256").update(root).digest("hex").slice(0, 12);
	return { root, unitName: `naia-discord-sessions-${suffix}.service` };
}

export function renderDiscordUserUnit({ adkRoot, nodePath = process.execPath, backendExecutables = {} }) {
	const { root, unitName } = discordUnitIdentity(adkRoot);
	const servicePath = resolve(root, ".agents/skills/manage-discord-sessions/helper/service.mjs");
	const lockPath = resolve(root, "naia-settings/.sessions/messenger-sessions/service.lock");
	const exec = ["/usr/bin/flock", "--no-fork", "--nonblock", lockPath, nodePath, servicePath, "--adk-root", root].map(unitQuote).join(" ");
	const environment = Object.entries(backendExecutables).map(([backend, executable]) => {
		if (!new Set(["codex", "claude"]).has(backend) || !resolve(executable).startsWith("/")) throw new Error("backend executable must be an absolute supported path");
		return `Environment=${unitQuote(`NAIA_${backend.toUpperCase()}_EXECUTABLE=${resolve(executable)}`)}`;
	}).join("\n");
	return { unitName, content: `[Unit]\nDescription=Naia ADK Discord sessions (${unitName.slice(-20, -8)})\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${exec}\n${environment ? `${environment}\n` : ""}Restart=on-failure\nRestartSec=5\nKillMode=mixed\nTimeoutStopSec=20\nUMask=0077\nNoNewPrivileges=yes\nPrivateTmp=yes\n\n[Install]\nWantedBy=default.target\n` };
}
