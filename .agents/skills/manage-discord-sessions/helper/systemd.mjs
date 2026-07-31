import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import { messengerInstancePaths, normalizeMessengerInstance } from "./instance-paths.mjs";

function unitQuote(value) {
	if (typeof value !== "string" || /[\r\n\0]/.test(value)) throw new Error("systemd value is unsafe");
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function discordUnitIdentity(adkRoot, instanceValue = "default") {
	const root = realpathSync(resolve(adkRoot));
	const instance = normalizeMessengerInstance(instanceValue);
	const identity = instance === "default" ? root : `${root}\0${instance}`;
	const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 12);
	return { root, instance, unitName: `naia-discord-sessions-${suffix}.service` };
}

export function renderDiscordUserUnit({ adkRoot, instance = "default", nodePath = process.execPath, backendExecutables = {} }) {
	const identity = discordUnitIdentity(adkRoot, instance);
	const { root, unitName } = identity;
	const paths = messengerInstancePaths(root, identity.instance);
	const servicePath = resolve(root, ".agents/skills/manage-discord-sessions/helper/service.mjs");
	const exec = ["/usr/bin/flock", "--no-fork", "--nonblock", paths.lockPath, nodePath, servicePath, "--adk-root", root, "--instance", identity.instance].map(unitQuote).join(" ");
	const backendEnvironment = Object.entries(backendExecutables).map(([backend, executable]) => {
		if (!new Set(["codex", "claude"]).has(backend) || !resolve(executable).startsWith("/")) throw new Error("backend executable must be an absolute supported path");
		return `Environment=${unitQuote(`NAIA_${backend.toUpperCase()}_EXECUTABLE=${resolve(executable)}`)}`;
	});
	const executablePath = [...new Set([dirname(resolve(nodePath)), ...Object.values(backendExecutables).map((executable) => dirname(resolve(executable))), "/usr/local/bin", "/usr/bin", "/bin"])].join(delimiter);
	const environment = [...backendEnvironment, `Environment=${unitQuote(`PATH=${executablePath}`)}`].join("\n");
	return { unitName, instance: identity.instance, content: `[Unit]\nDescription=Naia ADK Discord sessions (${identity.instance})\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${exec}\n${environment ? `${environment}\n` : ""}Restart=on-failure\nRestartSec=5\nKillMode=mixed\nTimeoutStopSec=20\nUMask=0077\nNoNewPrivileges=yes\nPrivateTmp=yes\n\n[Install]\nWantedBy=default.target\n` };
}
