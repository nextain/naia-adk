#!/usr/bin/env node
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { renderDiscordUserUnit } from "./systemd.mjs";
import { loadMessengerConfig } from "./discord-config.mjs";

function runSystemctl(args) {
	const result = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
	if (result.status !== 0) throw new Error((result.stderr || result.stdout || "systemctl failed").trim());
	return result.stdout.trim();
}

export function manageService({ adkRoot, command }) {
	const rendered = renderDiscordUserUnit({ adkRoot });
	const config = command === "unit" ? null : loadMessengerConfig(resolve(adkRoot, "naia-settings/messenger-sessions/config.json"));
	const unitDirectory = resolve(homedir(), ".config/systemd/user");
	const unitPath = resolve(unitDirectory, rendered.unitName);
	if (command === "install") {
		mkdirSync(resolve(adkRoot, "naia-settings/.sessions/messenger-sessions"), { recursive: true, mode: 0o700 });
		chmodSync(resolve(adkRoot, "naia-settings/.sessions/messenger-sessions"), 0o700);
		mkdirSync(unitDirectory, { recursive: true, mode: 0o700 });
		writeFileSync(unitPath, rendered.content, { mode: 0o600 });
		runSystemctl(["daemon-reload"]);
		if (config.service?.startAt === "boot") {
			const linger = spawnSync("loginctl", ["enable-linger", userInfo().username], { encoding: "utf8" });
			if (linger.status !== 0) throw new Error((linger.stderr || linger.stdout || "could not enable user lingering").trim());
		}
		if (config.service?.autoStart !== false) runSystemctl(["enable", "--now", rendered.unitName]);
		return `installed ${rendered.unitName}`;
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
	try {
		if (rootIndex < 0 || !args[rootIndex + 1]) throw new Error("--adk-root is required");
		const command = args.find((value, index) => index !== rootIndex && index !== rootIndex + 1 && !value.startsWith("--"));
		console.log(manageService({ adkRoot: resolve(args[rootIndex + 1]), command }));
	} catch (error) { console.error(error.message); process.exitCode = 1; }
}
