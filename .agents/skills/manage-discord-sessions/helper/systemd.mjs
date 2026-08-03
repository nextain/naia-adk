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
	return { unitName, instance: identity.instance, content: `[Unit]\nDescription=Naia ADK Discord sessions (${identity.instance})\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${exec}\n${environment ? `${environment}\n` : ""}Restart=always\nRestartSec=5\nKillMode=mixed\nTimeoutStopSec=20\nUMask=0077\nNoNewPrivileges=yes\nPrivateTmp=yes\n\n[Install]\nWantedBy=default.target\n` };
}

export function renderDiscordSupervisorUnits({ adkRoot, instance = "default", nodePath = process.execPath }) {
	const identity = discordUnitIdentity(adkRoot, instance);
	const supervisorPath = resolve(identity.root, ".agents/skills/manage-discord-sessions/helper/supervisor.mjs");
	const base = identity.unitName.slice(0, -".service".length);
	const serviceName = `${base}-supervisor.service`;
	const timerName = `${base}-supervisor.timer`;
	const exec = [nodePath, supervisorPath, "--adk-root", identity.root, "--instance", identity.instance].map(unitQuote).join(" ");
	return {
		serviceName,
		timerName,
		serviceContent: `[Unit]\nDescription=Naia ADK Discord independent health observer (${identity.instance})\n\n[Service]\nType=oneshot\nExecStart=${exec}\nUMask=0077\nNoNewPrivileges=yes\nPrivateTmp=yes\n`,
		timerContent: `[Unit]\nDescription=Naia ADK Discord health observer timer (${identity.instance})\n\n[Timer]\nOnBootSec=30s\nOnUnitActiveSec=60s\nAccuracySec=1s\nPersistent=true\nUnit=${serviceName}\n\n[Install]\nWantedBy=timers.target\n`,
	};
}
