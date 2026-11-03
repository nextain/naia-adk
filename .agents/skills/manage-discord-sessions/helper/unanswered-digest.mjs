const MAX_AGE_MS = 2 * 60 * 60 * 1_000;
const WAIT_MS = 30 * 60 * 1_000;
const validId = (value) => typeof value === "string" && /^\d{17,20}$/.test(value) && !/^0+$/.test(value);
const messageTime = (message, nowMs) => message.timestamp === undefined ? nowMs : Date.parse(message.timestamp);

// Notification bookkeeping only: observing a bot never authorizes a job.
// Runtime-local entries expire after two hours; restarts begin an empty digest.
export class UnansweredDigest {
	constructor() { this.entries = new Map(); }
	prune(nowMs) {
		for (const [id, entry] of this.entries) if (nowMs - entry.createdAt > MAX_AGE_MS) this.entries.delete(id);
	}
	track(message, nowMs) {
		this.prune(nowMs);
		const createdAt = messageTime(message, nowMs);
		if (!validId(message.id) || !validId(message.channel_id) || !validId(message.author?.id) || message.author.bot || message.webhook_id || (message.guild_id !== undefined && !validId(message.guild_id)) || !Number.isFinite(createdAt) || createdAt > nowMs || nowMs - createdAt > MAX_AGE_MS || this.entries.has(message.id)) return;
		this.entries.set(message.id, { id: message.id, channelId: message.channel_id, guildId: message.guild_id ?? null, createdAt, sent: false });
		if (this.entries.size > 1_000) this.entries.delete(this.entries.keys().next().value);
	}
	observeReply(message, teamBotUserIds, nowMs) {
		this.prune(nowMs);
		if (message.author?.bot !== true || message.webhook_id || !teamBotUserIds.includes(message.author.id)) return;
		const repliedAt = messageTime(message, nowMs);
		if (!Number.isFinite(repliedAt) || repliedAt > nowMs) return;
		for (const [id, entry] of this.entries) {
			if (entry.channelId === message.channel_id && entry.guildId === (message.guild_id ?? null) && repliedAt > entry.createdAt) this.entries.delete(id);
		}
	}
	due(nowMs) {
		this.prune(nowMs);
		return [...this.entries.values()].filter((entry) => !entry.sent && nowMs - entry.createdAt >= WAIT_MS).slice(0, 10);
	}
	markSent(entries) {
		for (const entry of entries) if (this.entries.get(entry.id) === entry) entry.sent = true;
	}
	format(entries) {
		return `30분 동안 팀 봇의 응답이 없는 요청 / Requests without a team bot response for 30 minutes\n${entries.map((entry) => `https://discord.com/channels/${entry.guildId ?? "@me"}/${entry.channelId}/${entry.id}`).join("\n")}`;
	}
}
