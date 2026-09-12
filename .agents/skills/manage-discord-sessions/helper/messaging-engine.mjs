import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { protectOwnerOnly } from "./platform-security.mjs";
import { installEngineSnapshot, validateEngineLock, verifyEngineSnapshot } from "./messaging-snapshot.mjs";

export function validateMessagingEngineLock(lock) {
	return Object.freeze({ ...validateEngineLock(lock) });
}

export function messagingRuntimeTreeId(lock) {
	const valid = validateMessagingEngineLock(lock);
	return createHash("sha1").update(`naia-messaging:${valid.snapshotSha256}`).digest("hex");
}

export function readMessagingEngineLockFile(path) {
	if (typeof path !== "string" || !isAbsolute(path)) throw new Error("engine lock path is invalid");
	return validateMessagingEngineLock(JSON.parse(readFileSync(path, "utf8")));
}

export function resolveMessagingEngineSource(adkRoot, env = process.env) {
	const root = realpathSync(resolve(adkRoot));
	const named = env.NAIA_MESSAGING_ROOT;
	const candidates = [
		...(typeof named === "string" && named.length > 0 ? [named] : []),
		join(root, "naia-messaging"),
		join(dirname(root), "naia-messaging"),
	];
	for (const candidate of candidates) {
		if (existsSync(join(candidate, "runtime/engine-snapshot.mjs")) && existsSync(join(candidate, "engine/discord/service.mjs"))) {
			return realpathSync(resolve(candidate));
		}
	}
	return null;
}

export function installPinnedMessagingEngine({ sourceRoot, destination, lock }) {
	const valid = validateMessagingEngineLock(lock);
	if (typeof sourceRoot !== "string" || !isAbsolute(sourceRoot)) throw new Error("naia-messaging source root is invalid");
	if (typeof destination !== "string" || !isAbsolute(destination)) throw new Error("naia-messaging snapshot destination is invalid");
	verifyEngineSnapshot(sourceRoot, valid);
	return installEngineSnapshot({ sourceRoot, destination, lock: valid });
}

function copyEngineDiscord(snapshotRoot, helperPath) {
	const engineDiscord = join(snapshotRoot, "engine/discord");
	if (!existsSync(join(engineDiscord, "service.mjs")) || !existsSync(join(engineDiscord, "supervisor-entry.mjs"))) {
		throw new Error("naia-messaging snapshot is missing the Discord engine entrypoints");
	}
	mkdirSync(helperPath, { recursive: true, mode: 0o700 });
	protectOwnerOnly(helperPath, "directory", "Discord messaging engine helper");
	for (const name of readdirSync(engineDiscord).sort()) {
		const from = join(engineDiscord, name);
		const to = join(helperPath, name);
		if (statSync(from).isDirectory()) cpSync(from, to, { recursive: true });
		else cpSync(from, to);
	}
}

export function materializeMessagingRuntime({ sourceRoot, snapshotDestination, lock, runtimePath }) {
	const snapshotRoot = installPinnedMessagingEngine({ sourceRoot, destination: snapshotDestination, lock });
	mkdirSync(runtimePath, { recursive: true, mode: 0o700 });
	protectOwnerOnly(runtimePath, "directory", "Discord messaging runtime");
	copyEngineDiscord(snapshotRoot, join(runtimePath, "helper"));
	if (!existsSync(join(runtimePath, "helper/service.mjs")) || !existsSync(join(runtimePath, "helper/supervisor-entry.mjs"))) {
		throw new Error("messaging runtime is missing service or supervisor entry");
	}
	return snapshotRoot;
}
