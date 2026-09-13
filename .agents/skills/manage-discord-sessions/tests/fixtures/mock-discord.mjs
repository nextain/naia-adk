// 디스코드를 대신하는 가짜 서버.
//
// 통합 시험(ET)은 진짜 디스코드에 붙지 않는다. 토큰이 필요하고, 남의 서버에
// 글을 쓰며, 실패해도 원인이 우리 코드인지 네트워크인지 가릴 수 없다. 그래서
// 게이트웨이가 디스코드에 기대하는 것만 최소한으로 흉내 낸다.
//
// 흉내 내는 것은 셋이다. 메시지가 들어오는 것, 회신이 나가는 것, 그리고 그
// 회신이 확인되었다는 영수증. 게이트웨이는 이 셋으로 한 요청을 끝까지 처리한다.
//
// 흉내 내지 않는 것도 밝혀 둔다. Gateway 웹소켓 수명주기, 속도 제한, 첨부
// 내려받기, 샤딩. 그것들은 각자의 시험이 따로 본다.

import { randomUUID } from "node:crypto";

/**
 * 가짜 디스코드 한 대.
 *
 * `deliver` 와 `send` 를 라우터에 넘기면 나가는 글이 여기 쌓인다. `receive` 로
 * 메시지를 밀어 넣으면 라우터가 그것을 한 요청으로 받는다.
 */
export function mockDiscord({ botUserId, channelId, userId } = {}) {
	const outbound = [];
	const inbound = [];
	let sequence = 0;

	return {
		outbound,
		inbound,

		/** 사람이 채널에 글을 쓴다. 라우터의 onDispatch 에 넘길 봉투를 만든다. */
		message(content, { mention = true } = {}) {
			sequence += 1;
			const envelope = {
				// 스노플레이크는 64비트라 자바스크립트 수로 더하면 정밀도를 잃는다.
				// 실제로 두 메시지가 같은 번호를 받아 둘째가 중복으로 버려졌다.
				id: `6666666666666660${String(sequence).padStart(2, "0")}`,
				guild_id: undefined,
				channel_id: channelId,
				author: { id: userId },
				mentions: mention ? [{ id: botUserId }] : [],
				content: mention ? `<@${botUserId}> ${content}` : content,
			};
			inbound.push(envelope);
			return { envelope, sequence };
		},

		/** 라우터가 최종 회신을 보낼 때 불린다. */
		async deliver({ content, jobId }) {
			outbound.push({ kind: "result", jobId, content, at: outbound.length });
			return { state: "confirmed", messageId: randomUUID() };
		},

		/** 라우터가 접수 알림이나 실패 통지를 보낼 때 불린다. */
		async send(input) {
			outbound.push({ kind: "control", content: input?.content ?? null, at: outbound.length });
			return { state: "confirmed" };
		},

		/** 사람이 채널에서 실제로 읽게 되는 글만 고른다. */
		results() {
			return outbound.filter((item) => item.kind === "result").map((item) => item.content);
		},

		/** 마지막으로 채널에 나간 결과. 없으면 null. */
		lastResult() {
			const results = this.results();
			return results.length === 0 ? null : results.at(-1);
		},
	};
}
