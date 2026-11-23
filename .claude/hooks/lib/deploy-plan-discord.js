"use strict";
// Plan gate responsibility: discord.
const { containsApprovalCode } = require("./deploy-human-approval.js");

// ── 디스코드 승인자 확인 ──────────────────────────────────────────
const SNOWFLAKE = /^\d{17,20}$/;

/**
 * 승인자 본인 디스코드 글에 code 가 있는가. 메시지는 AI 가 준 파일이 아니라 디스코드 REST 에서 직접 받는다.
 * 작성자 번호 = approverId(인스턴스 설정값), 봇·웹훅·앱 글 불인정, 글 시각은 코드 발급 뒤.
 */
async function discordConfirms({ code, sinceIso, refs, approverId, expectedApproverId, token, fetchImpl = globalThis.fetch, checkTimestamp = true, until = Infinity, messages }) {
	const configuredId = expectedApproverId !== undefined ? expectedApproverId : approverId;
	if (!SNOWFLAKE.test(String(approverId || "")) || !SNOWFLAKE.test(String(configuredId || ""))) {
		return { ok: false, why: "approver-id-unset" };
	}
	if (String(approverId) !== String(configuredId)) {
		return { ok: false, why: "approver-id-mismatch" };
	}
	if (typeof token !== "string" || !token) return { ok: false, why: "token-unavailable" };
	const since = Date.parse(sinceIso);
	if (checkTimestamp && !Number.isFinite(since)) return { ok: false, why: "invalid-issuance-time" };
	for (const r of Array.isArray(refs) ? refs : []) {
		if (!r || r.code !== code || !SNOWFLAKE.test(String(r.channelId || "")) || !SNOWFLAKE.test(String(r.messageId || ""))) continue;
		const key = `${r.channelId}/${r.messageId}`;
		let m = messages?.get(key);
		if (!m) {
			try {
				const res = await fetchImpl(`https://discord.com/api/v10/channels/${r.channelId}/messages/${r.messageId}`, { headers: { authorization: `Bot ${token}` }, signal: AbortSignal.timeout(8000) });
				if (!res?.ok) continue;
				m = await res.json();
				messages?.set(key, m);
			} catch { continue; }
		}
		if (!m || String(m.id) !== String(r.messageId)) continue;
		if (m.channel_id !== undefined && String(m.channel_id) !== String(r.channelId)) continue;
		const a = m.author || {};
		if (String(a.id || "") !== String(approverId) || a.bot === true || a.system === true || m.webhook_id || m.application_id) continue;
		if (!containsApprovalCode(m.content, code)) continue;
		const at = m.edited_timestamp ?? m.timestamp;
		const posted = Date.parse(m.timestamp);
		const contentAt = Date.parse(at);
		if (checkTimestamp && (!Number.isFinite(posted) || posted < since || !Number.isFinite(contentAt) || contentAt < posted || contentAt >= until)) continue;
		return { ok: true, at, via: `discord:${r.channelId}/${r.messageId}` };
	}
	return { ok: false, why: "no-discord-confirmation" };
}

module.exports = {
	SNOWFLAKE,
	discordConfirms,
};
