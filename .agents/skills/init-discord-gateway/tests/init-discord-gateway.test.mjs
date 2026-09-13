import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { initDiscordGateway } from "../scripts/init-discord-gateway.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const skillRoot = join(here, "..");
const naiaAdk = join(skillRoot, "..", "..", "..");
const exampleSrc = join(naiaAdk, "naia-settings/messenger-sessions/config.example.json");

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "init-discord-"));
	mkdirSync(join(root, "naia-settings/messenger-sessions"), { recursive: true });
	writeFileSync(join(root, "naia-settings/messenger-sessions/config.example.json"), readFileSync(exampleSrc));
	return {
		root,
		cleanup() { rmSync(root, { recursive: true, force: true }); },
	};
}

test("writes owner-only config under naia-settings, not data-private", () => {
	const { root, cleanup } = fixture();
	try {
		const result = initDiscordGateway({
			adkRoot: root,
			instance: "alpha",
			botUserId: "111111111111111111",
			operatorUserId: "222222222222222222",
			guildId: "333333333333333333",
			channelId: "444444444444444444",
			backend: "opencode",
			repo: "example-org/example-repo",
		});
		assert.equal(result.configPath, join(root, "naia-settings/messenger-sessions/instances/alpha/config.json"));
		assert.equal(result.tokenPath.startsWith(join(root, "naia-settings/.keys/messenger-sessions")), true);
		assert.equal(existsSync(join(root, "data-private")), false);
		const config = JSON.parse(readFileSync(result.configPath, "utf8"));
		assert.equal(config.enabled, false);
		assert.equal(config.discord.botUserId, "111111111111111111");
		assert.equal(config.discord.operatorUserIds[0], "222222222222222222");
		assert.equal(config.discord.bindings[0].guildId, "333333333333333333");
		assert.equal(config.workspace.issueTracker.repo, "example-org/example-repo");
		assert.equal(config.backend.selected, "opencode");
		assert.equal(config.discord.credentialRef, "discord-bot-token");
		assert.match(JSON.stringify(config), /"credentialRef"/);
		assert.equal(JSON.stringify(config).includes("Bot "), false);
	} finally { cleanup(); }
});

test("refuses to overwrite without --force", () => {
	const { root, cleanup } = fixture();
	try {
		initDiscordGateway({ adkRoot: root, instance: "default" });
		assert.throws(() => initDiscordGateway({ adkRoot: root, instance: "default" }), /already exists/);
		const again = initDiscordGateway({ adkRoot: root, instance: "default", force: true, enable: true });
		assert.equal(again.enabled, true);
	} finally { cleanup(); }
});
