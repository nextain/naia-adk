import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { proactiveDmRecipient } from "../helper/discord-router.mjs";

/**
 * 능동 DM 수신자는 오랫동안 소스에 상수로 박혀 있었다. 그 저장소를 받은 사람은
 * 자기 봇이 모르는 계정으로 DM 을 보내려 드는 상태로 시작했고, 공개 저장소에는
 * 그 사람의 Discord 계정 ID 가 그대로 남았다. 이제 설정에서만 온다.
 */

const OWNER = "100000000000000001";
const OTHER = "100000000000000002";

const withDiscord = (discord) => ({ discord });

test("설정에 있고 운영자이기도 하면 그 사람에게 간다", () => {
	assert.equal(proactiveDmRecipient(withDiscord({ operatorUserIds: [OWNER], proactiveDmRecipientUserId: OWNER })), OWNER);
});

test("설정이 없으면 기능이 꺼진다 — 기본 수신자는 없다", () => {
	assert.equal(proactiveDmRecipient(withDiscord({ operatorUserIds: [OWNER] })), null);
	assert.equal(proactiveDmRecipient(withDiscord({})), null);
	assert.equal(proactiveDmRecipient(undefined), null);
});

test("운영자가 아닌 사람은 설정에 적어도 수신자가 되지 못한다", () => {
	assert.equal(proactiveDmRecipient(withDiscord({ operatorUserIds: [OWNER], proactiveDmRecipientUserId: OTHER })), null);
});

test("스노플레이크가 아닌 값은 거부한다", () => {
	for (const bad of ["", "not-a-snowflake", "12345", 100000000000000001, null]) {
		assert.equal(proactiveDmRecipient(withDiscord({ operatorUserIds: [OWNER], proactiveDmRecipientUserId: bad })), null);
	}
});

test("소스에 개인 계정 ID 가 다시 박히지 않는다", () => {
	// 상수를 되살리는 변경이 조용히 들어오지 못하게 막는다.
	const source = readFileSync(new URL("../helper/discord-router.mjs", import.meta.url), "utf8");
	assert.doesNotMatch(source, /PROACTIVE_DM_RECIPIENT_USER_ID\s*=\s*"\d{17,20}"/);
	assert.doesNotMatch(source, /"\d{17,20}"/);
});
