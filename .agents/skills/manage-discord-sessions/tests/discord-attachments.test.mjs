import test from "node:test";
import assert from "node:assert/strict";
import { attachmentPromptSection, attachmentSummaryText, describeDiscordAttachments, safeAttachmentName } from "../helper/discord-attachments.mjs";
import { discordRequestText, transientPrompt } from "../helper/discord-router.mjs";
import { renderParticipantConversation } from "../helper/discord-conversation.mjs";

const BOT = "1534135048046116864";
const USER = "865850174651498506";
const CHANNEL = "1489634850116735176";
const MESSAGE = "1539796771872448603";
const ATTACHMENT = "1539796771331985429";

function config() {
	return {
		schemaVersion: 1,
		persona: { name: "Tester", instructions: "Be exact." },
		role: { name: "reader", allowedActions: ["read", "reply"], requiresApproval: [] },
		backend: { selected: "codex", profiles: { codex: { costProfile: "balanced" } } },
	};
}

const authorization = { scope: { channelId: CHANNEL, threadId: null, authorId: USER }, binding: {}, participantProfile: null };

test("파일만 보낸 메시지도 요청으로 성립한다", () => {
	const message = { id: MESSAGE, content: "", attachments: [{ id: ATTACHMENT, filename: "report.pdf", size: 1234, content_type: "application/pdf" }] };
	const request = discordRequestText(message, BOT, { authorization, instance: "onmam" });
	assert.ok(request.length > 0, "본문이 비어도 요청 문자열이 만들어져야 한다");
	assert.match(request, /report\.pdf/);
	assert.match(request, new RegExp(`attachmentId=${ATTACHMENT}`));
	assert.match(request, new RegExp(`--message ${MESSAGE}`));
	assert.match(request, new RegExp(`--channel ${CHANNEL}`));
	assert.match(request, /--instance onmam/);
});

test("글과 파일이 함께 오면 둘 다 프롬프트에 들어간다", () => {
	const message = { id: MESSAGE, content: "이 문서 검토해줘", attachments: [{ id: ATTACHMENT, filename: "plan.hwp", size: 9, content_type: null }] };
	const prompt = transientPrompt(message, BOT, config(), authorization, null, { instance: "onmam" });
	assert.match(prompt, /이 문서 검토해줘/);
	assert.match(prompt, /plan\.hwp/);
});

test("첨부가 없으면 프롬프트가 예전과 같다", () => {
	const message = { id: MESSAGE, content: "안녕", attachments: [] };
	assert.equal(discordRequestText(message, BOT, { authorization }), "안녕");
});

test("본문도 첨부도 없으면 여전히 빈 요청이다", () => {
	const message = { id: MESSAGE, content: "   ", attachments: [] };
	assert.equal(discordRequestText(message, BOT, { authorization }), "");
	assert.throws(() => transientPrompt(message, BOT, config(), authorization), /empty or too large/);
});

test("스노플레이크가 아닌 첨부 ID 는 목록에서 빠진다", () => {
	// 내려받기 함수가 어차피 거부하는 값이다. 부를 수 없는 것을 알려주면 안 된다.
	const described = describeDiscordAttachments({ attachments: [{ id: "not-a-snowflake", filename: "x.png", size: 1 }, { id: "0000000000000000000", filename: "y.png", size: 1 }] });
	assert.equal(described.attachments.length, 0);
	assert.equal(described.omitted, 2);
});

test("파일명에서 경로 구성 요소를 걷어낸다", () => {
	assert.equal(safeAttachmentName("../../etc/passwd"), "passwd");
	assert.equal(safeAttachmentName("dir\\sub\\note.txt"), "note.txt");
	assert.equal(safeAttachmentName("..."), null);
	assert.equal(safeAttachmentName(""), null);
});

test("이름이 모두 걸러진 첨부도 ID 로 식별된다", () => {
	const described = describeDiscordAttachments({ attachments: [{ id: ATTACHMENT, filename: "...", size: 3 }] });
	assert.equal(described.attachments.length, 1);
	assert.equal(described.attachments[0].filename, `attachment-${ATTACHMENT}`);
});

test("첨부 목록은 열 개까지만 싣고 나머지 수를 밝힌다", () => {
	const many = Array.from({ length: 14 }, (_, index) => ({ id: String(1539796771331985429n + BigInt(index)), filename: `f${index}.png`, size: index }));
	const described = describeDiscordAttachments({ attachments: many });
	assert.equal(described.attachments.length, 10);
	assert.equal(described.omitted, 4);
	assert.match(attachmentPromptSection({ id: MESSAGE, attachments: many }, { channelId: CHANNEL }), /4 more attachment/);
});

test("파일만 보낸 메시지가 대화 이력에서 사라지지 않는다", () => {
	const messages = [{ id: MESSAGE, author: { id: USER }, content: "", attachments: [{ id: ATTACHMENT, filename: "screenshot.jpg", size: 5 }] }];
	const history = renderParticipantConversation(messages, { botUserId: BOT, allowedUserIds: [USER] });
	assert.match(history, /screenshot\.jpg/);
});

test("이력 표기는 파일명만 남기고 다운로드 안내는 넣지 않는다", () => {
	const summary = attachmentSummaryText({ attachments: [{ id: ATTACHMENT, filename: "a.png", size: 1 }] });
	assert.equal(summary, "[attached: a.png]");
});
