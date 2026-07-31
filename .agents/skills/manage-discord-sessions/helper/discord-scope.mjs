import { createHash } from "node:crypto";
import { assertOnlyKeys } from "./sanitize.mjs";

function snowflake(value, label) {
	if (typeof value !== "string" || !/^\d{17,20}$/.test(value) || /^0+$/.test(value)) throw new Error(`${label} must be a Discord snowflake`);
	return value;
}

export function classifyDiscordConversation(message, threadParents = new Map()) {
	const channelId = snowflake(message.channel_id, "channelId");
	const authorId = snowflake(message.author?.id, "authorId");
	if (!message.guild_id) return { kind: "dm", channelId, authorId };
	const guildId = snowflake(message.guild_id, "guildId");
	const thread = threadParents.get(channelId);
	if (thread) return { kind: "thread", guildId, channelId: snowflake(thread.parentChannelId, "parentChannelId"), threadId: channelId, authorId };
	return { kind: "guild_channel", guildId, channelId, authorId };
}

function bindingMatches(binding, scope) {
	if (binding.kind !== scope.kind) return false;
	if (binding.guildId && binding.guildId !== scope.guildId) return false;
	if (binding.channelId && binding.channelId !== scope.channelId) return false;
	if (binding.threadId && binding.threadId !== scope.threadId) return false;
	if (binding.userId && binding.userId !== scope.authorId) return false;
	return true;
}

export function discordScopeKey(scope) {
	return createHash("sha256").update(`${scope.kind}\0${scope.guildId ?? ""}\0${scope.channelId}\0${scope.threadId ?? ""}`).digest("hex").slice(0, 24);
}

function mentioned(message, botUserId) {
	return Array.isArray(message.mentions) && message.mentions.some((item) => item?.id === botUserId);
}

export function authorizeDiscordMessage({ message, bindings, operatorUserIds = [], botUserId, threadParents = new Map() }) {
	if (message.author?.bot || message.webhook_id) return { allowed: false, reasonCode: "automated_sender" };
	const scope = classifyDiscordConversation(message, threadParents);
	const scopeKey = discordScopeKey(scope);
	const binding = bindings.find((candidate) => bindingMatches(candidate, scope));
	if (!binding) return { allowed: false, reasonCode: "binding_missing", scope, scopeKey };
	if (!binding.allowedUserIds?.includes(scope.authorId)) return { allowed: false, reasonCode: "user_not_allowed", scope, scopeKey };
	if ((binding.respondWhen ?? "mentioned") === "mentioned" && !mentioned(message, botUserId)) return { allowed: false, reasonCode: "mention_required", scope, scopeKey };
	return { allowed: true, reasonCode: "authorized", scope, scopeKey, isOperator: operatorUserIds.includes(scope.authorId) && binding.operatorActions === true, binding };
}

export function validateDiscordBindings(bindings) {
	if (!Array.isArray(bindings) || bindings.length === 0) throw new Error("at least one Discord binding is required");
	return bindings.map((binding) => {
		assertOnlyKeys(binding, new Set(["kind", "guildId", "channelId", "threadId", "userId", "respondWhen", "allowedUserIds", "canStartConversation", "operatorActions"]), "Discord binding");
		if (!new Set(["dm", "guild_channel", "thread"]).has(binding.kind)) throw new Error("unsupported Discord binding kind");
		for (const [key, value] of Object.entries(binding)) {
			if (new Set(["guildId", "channelId", "threadId", "userId"]).has(key) && value !== undefined) snowflake(value, key);
		}
		if (!Array.isArray(binding.allowedUserIds) || binding.allowedUserIds.length === 0) throw new Error("binding allowedUserIds is required");
		binding.allowedUserIds.forEach((value) => snowflake(value, "allowedUserId"));
		if (!new Set(["mentioned", "always"]).has(binding.respondWhen ?? "mentioned")) throw new Error("unsupported respondWhen policy");
		if (binding.kind !== "dm" && binding.respondWhen === "always") throw new Error("guild and thread bindings require mentioned responses");
		if (binding.canStartConversation !== true && binding.canStartConversation !== false) throw new Error("canStartConversation must be boolean");
		if (binding.operatorActions !== undefined && typeof binding.operatorActions !== "boolean") throw new Error("operatorActions must be boolean");
		if (binding.kind === "dm" && !binding.userId && !binding.channelId) throw new Error("DM binding requires userId or channelId");
		if (binding.kind === "guild_channel" && (!binding.guildId || !binding.channelId)) throw new Error("guild channel binding requires guildId and channelId");
		if (binding.kind === "thread" && (!binding.guildId || !binding.channelId || !binding.threadId)) throw new Error("thread binding requires guildId, parent channelId, and threadId");
		if (binding.kind !== "thread" && binding.threadId) throw new Error("threadId is only valid for a thread binding");
		return { ...binding };
	});
}
