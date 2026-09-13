#!/usr/bin/env node
/**
 * Discord 게이트웨이 인스턴스 설정을 naia-settings 아래에 만든다.
 * 토큰은 쓰지 않는다. 자격 파일 경로만 알려 준다.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { messengerInstancePaths, normalizeMessengerInstance } from "../../manage-discord-sessions/helper/instance-paths.mjs";
import { protectOwnerOnly } from "../../manage-discord-sessions/helper/platform-security.mjs";

const SNOWFLAKE = /^\d{17,20}$/;
const BACKENDS = new Set(["opencode", "codex", "claude"]);

class UsageError extends Error {}

function parseArgs(argv) {
	const options = { enable: false, force: false };
	for (let i = 0; i < argv.length; i += 1) {
		const value = argv[i];
		if (value === "--enable") options.enable = true;
		else if (value === "--force") options.force = true;
		else if (value.startsWith("--")) {
			const key = {
				"--adk-root": "adkRoot",
				"--instance": "instance",
				"--bot-user-id": "botUserId",
				"--operator-user-id": "operatorUserId",
				"--guild-id": "guildId",
				"--channel-id": "channelId",
				"--dm-user-id": "dmUserId",
				"--backend": "backend",
				"--repo": "repo",
				"--workspace-id": "workspaceId",
			}[value];
			if (!key) throw new UsageError(`unknown option: ${value}`);
			const next = argv[i + 1];
			if (!next || next.startsWith("--")) throw new UsageError(`${value} requires a value`);
			options[key] = next;
			i += 1;
		} else throw new UsageError(`unexpected argument: ${value}`);
	}
	return options;
}

function requireSnowflake(value, label) {
	if (value === undefined) return undefined;
	if (!SNOWFLAKE.test(value)) throw new UsageError(`${label} must be a Discord snowflake`);
	return value;
}

function findAdkRoot(start) {
	let current = resolve(start);
	for (;;) {
		if (existsSync(resolve(current, "naia-settings/messenger-sessions/config.example.json"))) return current;
		const parent = dirname(current);
		if (parent === current) throw new UsageError("could not find naia-settings/messenger-sessions/config.example.json from --adk-root or cwd");
		current = parent;
	}
}

function applyIds(example, options) {
	const operator = options.operatorUserId;
	const bot = options.botUserId;
	const dm = options.dmUserId ?? operator;
	const config = structuredClone(example);
	if (options.workspaceId) config.workspaceId = options.workspaceId;
	if (options.repo) config.workspace.issueTracker.repo = options.repo;
	if (options.backend) {
		if (!BACKENDS.has(options.backend)) throw new UsageError(`--backend must be one of ${[...BACKENDS].join(", ")}`);
		if (!config.backend.profiles[options.backend]) throw new UsageError(`example config has no ${options.backend} profile`);
		config.backend.selected = options.backend;
	}
	if (bot) config.discord.botUserId = bot;
	if (operator) {
		config.discord.operatorUserIds = [operator];
		const profile = config.discord.participantProfiles["000000000000000000"];
		config.discord.participantProfiles = { [operator]: profile };
	}
	config.discord.bindings = config.discord.bindings.map((binding) => {
		const next = { ...binding };
		if (binding.kind === "guild_channel") {
			if (options.guildId) next.guildId = options.guildId;
			if (options.channelId) next.channelId = options.channelId;
			if (operator) next.allowedUserIds = [operator];
		}
		if (binding.kind === "dm") {
			if (dm) {
				next.userId = dm;
				next.allowedUserIds = [dm];
			}
		}
		return next;
	});
	config.enabled = options.enable === true;
	return config;
}

export function initDiscordGateway(options) {
	const adkRoot = findAdkRoot(options.adkRoot ?? process.cwd());
	const instance = normalizeMessengerInstance(options.instance ?? "default");
	const paths = messengerInstancePaths(adkRoot, instance);
	const examplePath = resolve(adkRoot, "naia-settings/messenger-sessions/config.example.json");
	const example = JSON.parse(readFileSync(examplePath, "utf8"));
	const config = applyIds(example, { ...options, instance });
	if (existsSync(paths.configPath) && options.force !== true) {
		throw new UsageError(`config already exists: ${paths.configPath} (pass --force to replace)`);
	}
	mkdirSync(dirname(paths.configPath), { recursive: true });
	mkdirSync(paths.credentialsDirectory, { recursive: true, mode: 0o700 });
	writeFileSync(paths.configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	chmodSync(paths.configPath, 0o600);
	protectOwnerOnly(paths.configPath, "file", "messenger config");
	protectOwnerOnly(paths.credentialsDirectory, "directory", "messenger credentials");
	const tokenPath = resolve(paths.credentialsDirectory, config.discord.credentialRef);
	return {
		adkRoot,
		instance,
		configPath: paths.configPath,
		credentialsDirectory: paths.credentialsDirectory,
		tokenPath,
		enabled: config.enabled === true,
		selectedBackend: config.backend.selected,
	};
}

function printUsage() {
	console.error(`Usage: init-discord-gateway.mjs --adk-root <naia-adk> [--instance <id>] [options]

Writes naia-settings/messenger-sessions[/instances/<id>]/config.json.
Does not write a Discord token.

Options:
  --bot-user-id --operator-user-id --guild-id --channel-id --dm-user-id
  --backend opencode|codex|claude --repo owner/name --workspace-id <id>
  --enable --force
`);
}

export async function runCli(argv = process.argv.slice(2)) {
	try {
		const result = initDiscordGateway(parseArgs(argv));
		console.log(JSON.stringify(result, null, 2));
		console.error(`Next: put the bot token in ${result.tokenPath} (owner-only, 0600), then:
  .agents/skills/manage-discord-sessions/scripts/manage-discord-sessions.sh --instance ${result.instance} service install`);
	} catch (error) {
		if (error instanceof UsageError) {
			printUsage();
			console.error(error.message);
			process.exitCode = 2;
			return;
		}
		throw error;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await runCli();
}
