import { randomUUID } from "node:crypto";
import { formatOperatorStatus, postDiscordMessage } from "./discord-delivery.mjs";

const DISCORD_API = "https://discord.com/api/v10";

export class DiscordStatusProjection {
	constructor({ store, token, botUserId, fetchImpl = fetch }) { this.store = store; this.token = token; this.botUserId = botUserId; this.fetchImpl = fetchImpl; }

	async publishScope({ scopeKey, channelId }) {
		const content = formatOperatorStatus(this.store.status(), this.store.listJobsForScope(scopeKey));
		const existing = this.store.loadDiscordProjection(scopeKey);
		if (existing?.channelId === channelId) {
			try {
				const response = await this.fetchImpl(`${DISCORD_API}/channels/${channelId}/messages/${existing.messageId}`, { method: "PATCH", headers: { authorization: `Bot ${this.token}`, "content-type": "application/json" }, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) });
				if (response.ok) return { state: "updated", messageId: existing.messageId };
			} catch {}
		}
		const nonce = randomUUID().replaceAll("-", "").slice(0, 24);
		const receipt = await postDiscordMessage({ token: this.token, channelId, content, nonce, botUserId: this.botUserId, fetchImpl: this.fetchImpl });
		if (receipt.state !== "confirmed") return receipt;
		this.store.saveDiscordProjection({ scopeKey, channelId, messageId: receipt.messageId });
		try { await this.fetchImpl(`${DISCORD_API}/channels/${channelId}/pins/${receipt.messageId}`, { method: "PUT", headers: { authorization: `Bot ${this.token}` } }); } catch {}
		return { state: "created", messageId: receipt.messageId };
	}
}
