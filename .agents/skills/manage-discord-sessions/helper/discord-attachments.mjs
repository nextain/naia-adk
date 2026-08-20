/**
 * Discord 첨부를 에이전트가 볼 수 있는 형태로 서술한다.
 *
 * 게이트웨이는 오랫동안 `message.content` 만 프롬프트로 옮겼다. 내려받는 기능은
 * `discord-history.mjs` 에 갖춰져 있었지만, 첨부 ID 를 알려주는 표면이 없어서
 * 에이전트가 그 기능을 부를 수가 없었다. 글과 함께 온 파일은 없는 것처럼 보였고,
 * 파일만 온 메시지는 본문이 비어 있다는 이유로 조용히 버려졌다.
 *
 * 여기서 만드는 것은 "무엇이 붙어 있는지"와 "그것을 어떻게 가져오는지" 두 줄이다.
 * 실제 다운로드는 기존 경로를 그대로 쓴다.
 */
import { sanitizeSummary } from "./sanitize.mjs";

const SNOWFLAKE = /^\d{17,20}$/;
const MAX_LISTED_ATTACHMENTS = 10;
const MAX_FILENAME_LENGTH = 120;

/**
 * 파일명은 에이전트가 저장 경로를 만들 때 쓸 수 있다. 경로 구분자와 상위 이동을
 * 지운 뒤에 넘긴다. 이름이 통째로 사라지면 식별용 대체 이름을 준다.
 */
export function safeAttachmentName(value) {
	const raw = typeof value === "string" ? value : "";
	const flattened = raw
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.replaceAll("\\", "/")
		.split("/")
		.pop() ?? "";
	const trimmed = flattened.replace(/^\.+/, "").trim().slice(0, MAX_FILENAME_LENGTH);
	if (!trimmed) return null;
	try { return sanitizeSummary(trimmed) || null; }
	catch { return null; }
}

/**
 * 신뢰할 수 있는 항목만 남긴다. ID 가 스노플레이크가 아니면 다운로드 명령이
 * 어차피 거부하므로 목록에서 뺀다 — 부를 수 없는 것을 알려주면 혼란만 준다.
 */
export function describeDiscordAttachments(message) {
	const raw = Array.isArray(message?.attachments) ? message.attachments : [];
	const attachments = [];
	for (const item of raw) {
		if (attachments.length >= MAX_LISTED_ATTACHMENTS) break;
		if (!item || typeof item !== "object") continue;
		const attachmentId = String(item.id ?? "");
		if (!SNOWFLAKE.test(attachmentId) || /^0+$/.test(attachmentId)) continue;
		const filename = safeAttachmentName(item.filename) ?? `attachment-${attachmentId}`;
		const size = Number.isSafeInteger(item.size) && item.size >= 0 ? item.size : null;
		let contentType = null;
		if (typeof item.content_type === "string" && item.content_type) {
			try { contentType = sanitizeSummary(item.content_type.slice(0, 80)) || null; }
			catch { contentType = null; }
		}
		attachments.push({ attachmentId, filename, size, contentType });
	}
	return { attachments, omitted: Math.max(0, raw.length - attachments.length) };
}

/** 이력 한 줄에 붙일 짧은 표기. 본문이 비어도 파일이 온 사실은 남는다. */
export function attachmentSummaryText(message) {
	const { attachments, omitted } = describeDiscordAttachments(message);
	if (attachments.length === 0) return "";
	const names = attachments.map((item) => item.filename).join(", ");
	return omitted > 0 ? `[attached: ${names} (+${omitted} more)]` : `[attached: ${names}]`;
}

/**
 * 프롬프트에 넣을 블록. 파일을 실제로 여는 방법까지 함께 준다. 식별자만 주면
 * 에이전트가 그것으로 무엇을 해야 하는지 몰라 다시 되묻게 된다.
 */
export function attachmentPromptSection(message, { channelId = null, instance = null } = {}) {
	const { attachments, omitted } = describeDiscordAttachments(message);
	if (attachments.length === 0) return "";
	const messageId = String(message?.id ?? "");
	const lines = ["Attached files:"];
	for (const item of attachments) {
		const size = item.size === null ? "unknown size" : `${item.size} bytes`;
		const type = item.contentType ? `, ${item.contentType}` : "";
		lines.push(`- ${item.filename} (${size}${type}) attachmentId=${item.attachmentId}`);
	}
	if (omitted > 0) lines.push(`- (${omitted} more attachment(s) were not listed)`);
	lines.push(
		"These files are not readable until you download them. Use the manage-discord-sessions skill:",
		`  node .agents/skills/manage-discord-sessions/helper/cli.mjs attachment${instance ? ` --instance ${instance}` : ""}${channelId && SNOWFLAKE.test(channelId) ? ` --channel ${channelId}` : ""}${SNOWFLAKE.test(messageId) ? ` --message ${messageId}` : ""} --attachment <attachmentId> --output <absolute path>`,
		"Download into a temporary working directory, read the file, and then answer. Never claim you cannot read an attached file without attempting this download first.",
	);
	return lines.join("\n");
}
