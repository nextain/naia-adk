import { sanitizeFinalResponse } from "./sanitize.mjs";
import { randomUUID } from "node:crypto";

const DISCORD_API = "https://discord.com/api/v10";
const MAX_DELIVERY_CHUNK_CHARS = 900;
const MAX_DELIVERY_CHUNK_BYTES = 1_500;

function snowflake(value, label) {
	if (typeof value !== "string" || !/^\d{17,20}$/.test(value)) throw new Error(`${label} must be a Discord snowflake`);
	return value;
}

function retryPause(delayMs, signal) {
	if (signal?.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		const abort = () => { clearTimeout(timer); resolve(false); };
		const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(true); }, delayMs);
		signal?.addEventListener("abort", abort, { once: true });
	});
}

export async function postDiscordMessage({ token, channelId, content, nonce, botUserId, fetchImpl = fetch, signal, timeoutMs = 15_000, maxAttempts = 3, retryDelayMs = 250 }) {
	snowflake(channelId, "channelId");
	if (typeof token !== "string" || token.length < 16) throw new Error("Discord credential is not ready");
	if (typeof content !== "string" || content.length === 0 || content.length > 2_000) throw new Error("Discord message length is invalid");
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) throw new Error("Discord request timeout is invalid");
	if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new Error("Discord retry count is invalid");
	if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 5_000) throw new Error("Discord retry delay is invalid");
	let last = { state: "unknown", reasonCode: "network_result_unknown", status: null };
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		const controller = new AbortController();
		const abort = () => controller.abort();
		if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
		const timeout = setTimeout(abort, timeoutMs);
		timeout.unref?.();
		try {
			const response = await fetchImpl(`${DISCORD_API}/channels/${channelId}/messages`, {
				method: "POST",
				headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
				body: JSON.stringify({ content, allowed_mentions: { parse: [] }, nonce, enforce_nonce: true }), signal: controller.signal,
			});
			if (response.ok) {
				const body = await response.json();
				if (body.channel_id !== channelId || (botUserId && body.author?.id !== botUserId) || String(body.nonce ?? "") !== nonce) return { state: "unknown", reasonCode: "receipt_identity_mismatch", status: response.status };
				return { state: "confirmed", messageId: snowflake(body.id, "messageId"), status: response.status };
			}
			if (response.status >= 400 && response.status < 500) return { state: "failed", reasonCode: response.status === 401 || response.status === 403 ? "authorization" : "request_rejected", status: response.status };
			last = { state: "unknown", reasonCode: "server_response_unknown", status: response.status };
		} catch {
			last = { state: "unknown", reasonCode: "network_result_unknown", status: null };
		} finally {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
		}
		if (signal?.aborted || attempt === maxAttempts || !(await retryPause(retryDelayMs, signal))) break;
	}
	return last;
}

export async function postDiscordDirectMessage({ token, userId, content, nonce, botUserId, fetchImpl = fetch, signal, timeoutMs = 15_000 }) {
	snowflake(userId, "userId");
	if (typeof token !== "string" || token.length < 16) throw new Error("Discord credential is not ready");
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
	const timeout = setTimeout(abort, timeoutMs);
	timeout.unref?.();
	try {
		const response = await fetchImpl(`${DISCORD_API}/users/@me/channels`, { method: "POST", headers: { authorization: `Bot ${token}`, "content-type": "application/json" }, body: JSON.stringify({ recipient_id: userId }), signal: controller.signal });
		if (!response.ok) return response.status >= 400 && response.status < 500 ? { state: "failed", reasonCode: response.status === 401 || response.status === 403 ? "authorization" : "request_rejected", status: response.status } : { state: "unknown", reasonCode: "server_response_unknown", status: response.status };
		const body = await response.json();
		const channelId = snowflake(body.id, "channelId");
		return postDiscordMessage({ token, channelId, content, nonce, botUserId, fetchImpl, signal, timeoutMs });
	} catch {
		return { state: "unknown", reasonCode: "network_result_unknown", status: null };
	} finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
}

export function splitDiscordContent(content) {
	const chunks = [];
	let current = "";
	for (const character of content) {
		const candidate = current + character;
		if (current && (candidate.length > MAX_DELIVERY_CHUNK_CHARS || Buffer.byteLength(candidate, "utf8") > MAX_DELIVERY_CHUNK_BYTES)) {
			chunks.push(current);
			current = character;
		} else current = candidate;
	}
	if (current) chunks.push(current);
	if (chunks.length <= 1) return chunks;
	return chunks.map((chunk, index) => `(${index + 1}/${chunks.length})\n${chunk}`);
}

function chunkNonce(nonce, index) {
	if (index === 0) return nonce;
	return `${nonce.slice(0, 19)}${String(index + 1).padStart(5, "0")}`;
}

export async function deliverJobResult({ store, jobId, attemptId, token, channelId, botUserId, content, fetchImpl = fetch, signal, now = () => new Date().toISOString() }) {
	const safeContent = sanitizeFinalResponse(content);
	const chunks = splitDiscordContent(safeContent);
	const candidateNonce = randomUUID().replaceAll("-", "").slice(0, 24);
	const reserved = store.reserveDelivery({ deliveryKey: `delivery:${candidateNonce}`, jobId, attemptId, nonce: candidateNonce, channelId, now: now() });
	if (reserved.status !== "started" || reserved.existing) return { state: reserved.status === "confirmed" ? "confirmed" : "unknown", receipts: [] };
	const { deliveryKey, nonce } = reserved;
	const receipts = [];
	for (let index = 0; index < chunks.length; index += 1) {
		const receipt = await postDiscordMessage({ token, channelId, content: chunks[index], nonce: chunkNonce(nonce, index), botUserId, fetchImpl, signal });
		receipts.push(receipt);
		if (receipt.state !== "confirmed") {
			store.finishDelivery({ deliveryKey, status: receipt.state, reasonCode: receipt.reasonCode === "authorization" ? "authorization" : "internal_error", now: now() });
			return { state: receipt.state, receipts };
		}
	}
	try {
		store.finishDelivery({ deliveryKey, status: "confirmed", messageId: receipts.at(-1).messageId, now: now() });
	} catch {
		try { store.finishDelivery({ deliveryKey, status: "unknown", now: now() }); } catch {}
		return { state: "unknown", receipts };
	}
	return { state: "confirmed", receipts };
}

export function formatOperatorStatus(status, jobs) {
	const service = status.service;
	const active = jobs.filter((job) => !["completed", "failed", "cancelled", "recovery_review"].includes(job.lifecycle));
	const stalled = jobs.filter((job) => job.activityHealth.value === "suspected_stalled").length;
	const review = jobs.filter((job) => job.lifecycle === "recovery_review").length;
	const deliveryIssues = jobs.filter((job) => new Set(["unknown", "failed"]).has(job.deliveryState)).length;
	const lines = [
		`Naia Discord service: ${service.state} (${service.reasonCode})`,
		`Current work ${active.length} · stalled ${stalled} · delivery issues ${deliveryIssues}`,
		"Foreign collaboration agent supervision: unsupported",
	];
	if (review > 0) lines.push(`Historical unresolved ${review} (not queued)`);
	for (const job of active.slice(0, 8)) lines.push(`${job.jobId}: ${job.lifecycle} / ${job.activityHealth.value} / ${job.currentActivity ?? job.safeSummary}`);
	return lines.join("\n").slice(0, 2_000);
}
