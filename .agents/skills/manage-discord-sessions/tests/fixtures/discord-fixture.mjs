import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { SessionStore } from "../../helper/store.mjs";

export const roots = [];
export const BOT = "111111111111111111";
export const TOKEN_FINGERPRINT = "a".repeat(64);
export const RUNTIME_REVISION = "b".repeat(40);
export const USER = "222222222222222222";
export const OTHER_USER = "888888888888888888";
export const GUILD = "333333333333333333";
export const CHANNEL = "444444444444444444";
export const THREAD = "555555555555555555";

export function cleanupDiscordFixtureRoots() {
	while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
}

export function fixture() {
	const root = mkdtempSync(join(tmpdir(), "naia-discord-gateway-"));
	roots.push(root);
	const directory = join(root, "state");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	return { root, databasePath: join(directory, "runtime.sqlite3"), store: new SessionStore(join(directory, "runtime.sqlite3")) };
}

export function widenTestAcl(path) {
	if (process.platform !== "win32") { chmodSync(path, 0o644); return; }
	const executable = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
	const result = spawnSync(executable, [path, "/grant", "*S-1-1-0:(R)"], { windowsHide: true });
	assert.equal(result.status, 0);
}

export function binding(kind = "guild_channel") {
	if (kind === "dm") return { kind, userId: USER, allowedUserIds: [USER], respondWhen: "always", canStartConversation: true };
	if (kind === "thread") return { kind, guildId: GUILD, channelId: CHANNEL, threadId: THREAD, allowedUserIds: [USER], respondWhen: "mentioned", canStartConversation: true };
	return { kind, guildId: GUILD, channelId: CHANNEL, allowedUserIds: [USER], respondWhen: "mentioned", canStartConversation: true };
}
