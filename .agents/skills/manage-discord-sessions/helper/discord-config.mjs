import { constants as fsConstants, lstatSync, openSync, readFileSync, closeSync } from "node:fs";
import { isAbsolute, parse, relative, resolve } from "node:path";
import { assertOnlyKeys, safeIdentifier } from "./sanitize.mjs";
import { validateDiscordBindings } from "./discord-scope.mjs";
import { assertOwnerOnly } from "./platform-security.mjs";

function privateFile(path, label) {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a real file`);
	assertOwnerOnly(path, "file", label);
}

function privateDirectory(path, label) {
	const resolved = resolve(path);
	const root = parse(resolved).root;
	let cursor = root;
	for (const part of resolved.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
		cursor = resolve(cursor, part);
		const stat = lstatSync(cursor);
		if (stat.isSymbolicLink()) throw new Error(`${label} path contains a symbolic link`);
	}
	const stat = lstatSync(resolved);
	if (!stat.isDirectory()) throw new Error(`${label} must be a directory`);
	assertOwnerOnly(resolved, "directory", label);
}

export function loadMessengerConfig(path) {
	const resolved = resolve(path);
	privateFile(resolved, "messenger config");
	const fd = openSync(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	let config;
	try { config = JSON.parse(readFileSync(fd, "utf8")); } finally { closeSync(fd); }
	assertOnlyKeys(config, new Set(["schemaVersion", "enabled", "workspaceId", "persona", "role", "backend", "discord", "runtime", "observability", "service", "recovery"]), "messenger config");
	for (const [value, keys, label] of [
		[config.persona, ["name", "instructions"], "persona"],
		[config.role, ["name", "allowedActions", "requiresApproval"], "role"],
		[config.backend, ["selected", "profiles"], "backend"],
		[config.discord, ["credentialRef", "botUserId", "operatorUserIds", "bindings", "messageContentIntent"], "discord"],
		[config.runtime ?? {}, ["softSilenceSeconds", "heartbeatSeconds", "maxConcurrentJobs", "approvalPolicy", "permissionProfileEpoch", "noProgressInterventionSeconds", "operatorResponseSeconds", "conversationCoordinator"], "runtime"],
		[config.observability ?? {}, ["discordStatusProjection"], "observability"],
		[config.service ?? {}, ["autoStart", "startAt"], "service"],
		[config.recovery ?? {}, ["autoRetry"], "recovery"],
	]) assertOnlyKeys(value ?? {}, new Set(keys), label);
	if (config.schemaVersion !== 1) throw new Error("unsupported messenger config schema");
	if (config.enabled !== true) throw new Error("messenger service is disabled");
	if (!config.persona?.name || !config.persona?.instructions) throw new Error("persona name and instructions are required");
	if (config.persona.name.length > 80 || config.persona.instructions.length > 4_000) throw new Error("persona fields are too long");
	if (!config.role?.name || !Array.isArray(config.role.allowedActions)) throw new Error("role and allowedActions are required");
	const actions = new Set(["read", "reply", "write", "execute", "cancel", "retry"]);
	if (config.role.allowedActions.length === 0 || config.role.allowedActions.some((value) => !actions.has(value))) throw new Error("role contains an unsupported allowed action");
	if (config.role.requiresApproval?.some((value) => !actions.has(value))) throw new Error("role contains an unsupported approval action");
	if (!new Set(["codex", "claude"]).has(config.backend?.selected)) throw new Error("selected backend is not supported");
	if (config.backend.profiles?.[config.backend.selected]?.enabled !== true) throw new Error("selected backend profile is disabled");
	for (const [name, profile] of Object.entries(config.backend.profiles ?? {})) {
		if (!new Set(["codex", "claude"]).has(name)) throw new Error("unsupported backend profile");
		assertOnlyKeys(profile, new Set(["enabled"]), "backend profile");
		if (typeof profile.enabled !== "boolean") throw new Error("backend profile enabled must be boolean");
	}
	safeIdentifier(config.discord?.credentialRef, "credentialRef");
	if (!/^\d{17,20}$/.test(config.discord?.botUserId ?? "") || /^0+$/.test(config.discord.botUserId)) throw new Error("invalid Discord bot user ID");
	config.discord.operatorUserIds?.forEach((value) => {
		if (!/^\d{17,20}$/.test(value) || /^0+$/.test(value)) throw new Error("invalid operator Discord ID");
	});
	if (config.discord.messageContentIntent !== undefined && typeof config.discord.messageContentIntent !== "boolean") throw new Error("messageContentIntent must be boolean");
	config.discord.bindings = validateDiscordBindings(config.discord.bindings, { messageContentIntent: config.discord.messageContentIntent === true });
	const maxConcurrent = config.runtime?.maxConcurrentJobs ?? 1;
	if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) throw new Error("maxConcurrentJobs must be between 1 and 8");
	const heartbeatSeconds = config.runtime?.heartbeatSeconds ?? 10;
	const softSilenceSeconds = config.runtime?.softSilenceSeconds ?? 120;
	if (!Number.isSafeInteger(heartbeatSeconds) || heartbeatSeconds < 1 || heartbeatSeconds > 60) throw new Error("heartbeatSeconds must be between 1 and 60");
	if (!Number.isSafeInteger(softSilenceSeconds) || softSilenceSeconds < 1 || softSilenceSeconds > 3_600) throw new Error("softSilenceSeconds must be between 1 and 3600");
	if (config.runtime?.approvalPolicy !== undefined && !new Set(["managed", "never"]).has(config.runtime.approvalPolicy)) throw new Error("approvalPolicy must be managed or never");
	if (config.runtime?.permissionProfileEpoch !== undefined) safeIdentifier(config.runtime.permissionProfileEpoch, "permissionProfileEpoch");
	const noProgressInterventionSeconds = config.runtime?.noProgressInterventionSeconds ?? softSilenceSeconds;
	const operatorResponseSeconds = config.runtime?.operatorResponseSeconds ?? 30;
	if (!Number.isSafeInteger(noProgressInterventionSeconds) || noProgressInterventionSeconds < softSilenceSeconds || noProgressInterventionSeconds > 3_600) throw new Error("noProgressInterventionSeconds must be between softSilenceSeconds and 3600");
	if (!Number.isSafeInteger(operatorResponseSeconds) || operatorResponseSeconds < 1 || operatorResponseSeconds > 3_600) throw new Error("operatorResponseSeconds must be between 1 and 3600");
	if (config.runtime?.conversationCoordinator !== undefined && typeof config.runtime.conversationCoordinator !== "boolean") throw new Error("conversationCoordinator must be boolean");
	if (config.recovery?.autoRetry !== undefined && typeof config.recovery.autoRetry !== "boolean") throw new Error("recovery autoRetry must be boolean");
	if (!new Set(["login", "boot"]).has(config.service?.startAt ?? "login")) throw new Error("service startAt must be login or boot");
	if (config.service?.autoStart !== undefined && typeof config.service.autoStart !== "boolean") throw new Error("service autoStart must be boolean");
	if (config.observability?.discordStatusProjection !== undefined && typeof config.observability.discordStatusProjection !== "boolean") throw new Error("discordStatusProjection must be boolean");
	return config;
}

export class FileCredentialResolver {
	constructor(credentialsDirectory) { this.credentialsDirectory = resolve(credentialsDirectory); }
	resolve(reference) {
		safeIdentifier(reference, "credentialRef");
		privateDirectory(this.credentialsDirectory, "credentials directory");
		const path = resolve(this.credentialsDirectory, reference);
		const relativePath = relative(this.credentialsDirectory, path);
		if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error("credential path escaped its directory");
		privateFile(path, "Discord credential");
		const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
		try {
			const value = readFileSync(fd, "utf8").trim();
			if (value.length < 16) throw new Error("Discord credential is empty or invalid");
			return value;
		} finally { closeSync(fd); }
	}
}
