// 업무 카드(task-cards.mjs) 시험. 임시 폴더를 --root 로 써서 실제 저장소를 건드리지 않는다.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { serializeCard, slugify, loadRoleCards } from "./task-cards.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "task-cards.mjs");
const NOW = "2026-10-28T07:20:00Z";
const NOW_MS = Date.parse(NOW);
const OWNER_ID = "100000000000000001";

let root = null;

function freshRoot() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "task-cards-"));
}

function run(args, now = NOW) {
	return spawnSync("node", [script, "--root", root, "--now", now, "--owner-id", OWNER_ID, ...args], { encoding: "utf8" });
}

function inboxFile(role, name, { sender = OWNER_ID, evt = "evt-abcdef1234", msg = "200000000000000001", mtime = NOW_MS } = {}) {
	const dir = path.join(root, ".agents", "work", "l4", "role-inbox", role);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, name);
	fs.writeFileSync(file, [
		"# 4층 깨움", "", "- 시각: 2026-10-28T07:00:00.000Z", `- 사건: ${evt} (discord/channel)`,
		`- 보낸 사람: owner-user (${sender})`, `- 원문 글: ${msg}`, "", "> 대표님 지시 본문", "",
	].join("\n"));
	fs.utimesSync(file, new Date(mtime), new Date(mtime));
	return file;
}

beforeEach(() => { root = freshRoot(); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); root = null; });

describe("new/move/defer/done/ack 정상 흐름", () => {
	it("new 는 카드를 만들고 장부에 남긴다", () => {
		const r = run(["new", "--role", "role-a", "--title", "연습 카드", "--source", "src1", "--due", "2026-10-29", "--next", "다음 행동"]);
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /만듦 role-a\/20261028-연습-카드/);
		const card = path.join(root, "docs", "common", "team", "cards", "role-a", "20261028-연습-카드.md");
		assert.equal(fs.existsSync(card), true);
		const text = fs.readFileSync(card, "utf8");
		assert.match(text, /^status: doing$/m);
		assert.match(text, /^owner: role-a$/m);
		const ledger = fs.readFileSync(path.join(root, "docs", "common", "team", "cards", "ledger.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
		assert.equal(ledger.length, 1);
		assert.equal(ledger[0].cmd, "new");
	});

	it("같은 이름이면 -2, -3 이 붙는다", () => {
		run(["new", "--role", "role-a", "--title", "같은 일", "--source", "s", "--next", "n"]);
		const r = run(["new", "--role", "role-a", "--title", "같은 일", "--source", "s", "--next", "n"]);
		assert.match(r.stdout, /-2/);
	});

	it("move 는 정해진 대기 까닭·다시 볼 시각·요청 고리와 함께 대기 상태로 바꾼다", () => {
		run(["new", "--role", "role-a", "--title", "옮길 일", "--source", "s", "--next", "낡은 행동"]);
		const r = run([
			"move",
			"20261028-옮길-일",
			"--next", "새 행동",
			"--status", "waiting",
			"--wait-reason", "바깥 송출·게시",
			"--recheck-at", "2026-10-28T10:20:00Z",
			"--request-ref", "#업무-요청/200000000000000010",
		], "2026-10-28T08:20:00Z");
		assert.equal(r.status, 0, r.stderr);
		const text = fs.readFileSync(path.join(root, "docs", "common", "team", "cards", "role-a", "20261028-옮길-일.md"), "utf8");
		assert.match(text, /^status: waiting$/m);
		assert.match(text, /^wait_reason: 바깥 송출·게시$/m);
		assert.match(text, /^recheck_at: 2026-10-28T10:20:00.000Z$/m);
		assert.match(text, /^request_ref: #업무-요청\/200000000000000010$/m);
		assert.match(text, /새 행동/);
		assert.match(text, /2026-10-28T08:20:00/);
	});

	it("defer 는 미룸 횟수를 올리고 done 은 결과 없으면 막힌다", () => {
		run(["new", "--role", "role-a", "--title", "미룰 일", "--source", "s", "--next", "n"]);
		const d = run(["defer", "20261028-미룰-일", "--reason", "급한 일 먼저", "--revisit", "2026-10-30"]);
		assert.equal(d.status, 0, d.stderr);
		assert.match(fs.readFileSync(path.join(root, "docs", "common", "team", "cards", "role-a", "20261028-미룰-일.md"), "utf8"), /^defer_count: 1$/m);
		const done = run(["done", "20261028-미룰-일", "--result", "docs/done.md"]);
		assert.equal(done.status, 0, done.stderr);
		assert.match(done.stdout, /끝냄 role-a\/20261028-미룰-일/);
	});

	it("ack 는 카드 없이 장부에만 남긴다", () => {
		const r = run(["ack", "--role", "role-a", "--ref", "evt-abc123", "--reason", "읽고 끝낼 공지"]);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(fs.existsSync(path.join(root, "docs", "common", "team", "cards", "role-a")), false);
		const ledger = fs.readFileSync(path.join(root, "docs", "common", "team", "cards", "ledger.jsonl"), "utf8");
		assert.match(ledger, /"cmd":"ack"/);
	});
});

describe("대기(waiting/blocked/대기/보류) 까닭 넷·recheckAt·requestRef·깨움", () => {
	it("넷 밖 까닭(또는 까닭 없음)은 거절하고 '진행으로 두고 바로 하십시오'를 안내한다", () => {
		run(["new", "--role", "role-a", "--title", "내부 시험", "--source", "s", "--next", "n"]);
		const cardPath = path.join(root, "docs", "common", "team", "cards", "role-a", "20261028-내부-시험.md");
		const before = fs.readFileSync(cardPath, "utf8");

		for (const statusAlias of ["waiting", "blocked", "대기", "보류"]) {
			const badReason = run([
				"move", "20261028-내부-시험",
				"--status", statusAlias,
				"--wait-reason", "내부 시험 시작해도 될지 질문",
				"--recheck-at", "2026-10-28T09:00:00Z",
				"--request-ref", "#채널/123",
			]);
			assert.equal(badReason.status, 2);
			assert.match(badReason.stderr, /\[오류\]/);
			assert.match(badReason.stderr, /진행으로 두고 바로 하십시오/);
		}

		const noReason = run([
			"move", "20261028-내부-시험",
			"--status", "waiting",
			"--recheck-at", "2026-10-28T09:00:00Z",
		]);
		assert.equal(noReason.status, 2);
		assert.match(noReason.stderr, /진행으로 두고 바로 하십시오/);
		assert.equal(fs.readFileSync(cardPath, "utf8"), before, "거절된 명령은 카드를 건드리면 안 됨");
	});

	it("recheckAt 없음 및 최대 지금+4시간 초과를 거절한다", () => {
		run(["new", "--role", "role-a", "--title", "시각 시험", "--source", "s", "--next", "n"]);

		// recheckAt 없음 → 거절
		const missingRecheck = run([
			"move", "20261028-시각-시험",
			"--status", "waiting",
			"--wait-reason", "다른 사람 결과물",
		]);
		assert.equal(missingRecheck.status, 2);
		assert.match(missingRecheck.stderr, /\[오류\].*--recheck-at/);

		// 날짜만 있고 시각 없음 → 거절
		const dateOnly = run([
			"move", "20261028-시각-시험",
			"--status", "waiting",
			"--wait-reason", "다른 사람 결과물",
			"--recheck-at", "2026-10-28",
		]);
		assert.equal(dateOnly.status, 2);

		// 과거 시각 → 거절
		const pastRecheck = run([
			"move", "20261028-시각-시험",
			"--status", "waiting",
			"--wait-reason", "다른 사람 결과물",
			"--recheck-at", "2026-10-28T07:00:00Z",
		]);
		assert.equal(pastRecheck.status, 2);

		// 지금(07:20Z) + 4시간(11:20Z) 초과 → 거절
		const tooFar = run([
			"move", "20261028-시각-시험",
			"--status", "waiting",
			"--wait-reason", "다른 사람 결과물",
			"--recheck-at", "2026-10-28T11:21:00Z",
		]);
		assert.equal(tooFar.status, 2);
		assert.match(tooFar.stderr, /최대 지금\+4시간/);

		// 지금 + 4시간 이내(11:20Z) → 통과
		const ok = run([
			"move", "20261028-시각-시험",
			"--status", "보류",
			"--wait-reason", "다른 사람 결과물",
			"--recheck-at", "2026-10-28T11:20:00Z",
		]);
		assert.equal(ok.status, 0, ok.stderr);
	});

	it("사람 승인 기다림(앞 셋)인데 requestRef 없으면 거절하고, 있으면 통과한다", () => {
		run(["new", "--role", "role-a", "--title", "승인 시험", "--source", "s", "--next", "n"]);

		for (const reason of ["바깥 송출·게시", "운영 배포·운영 접속", "돈 드는 것"]) {
			const noRef = run([
				"move", "20261028-승인-시험",
				"--status", "waiting",
				"--wait-reason", reason,
				"--recheck-at", "2026-10-28T09:00:00Z",
			]);
			assert.equal(noRef.status, 2, `${reason} 에서 requestRef 누락이 거절되어야 함`);
			assert.match(noRef.stderr, /--request-ref/);

			const withRef = run([
				"move", "20261028-승인-시험",
				"--status", "waiting",
				"--wait-reason", reason,
				"--recheck-at", "2026-10-28T09:00:00Z",
				"--request-ref", "https://example.invalid/channels/1/2/3",
			]);
			assert.equal(withRef.status, 0, withRef.stderr);
		}
	});

	it("recheckAt 지남 → 담당 역할 깨움 파일 1건 생성 및 같은 시각 중복 없음", () => {
		run(["new", "--role", "role-a", "--title", "라디오 게시", "--source", "s", "--due", "2026-10-29", "--calendar", "yes", "--next", "게시 확인"]);
		const m = run([
			"move", "20261028-라디오-게시",
			"--status", "waiting",
			"--wait-reason", "바깥 송출·게시",
			"--recheck-at", "2026-10-28T08:00:00Z",
			"--request-ref", "#업무-요청/200000000000000055",
		]);
		assert.equal(m.status, 0, m.stderr);

		const wakeDir = path.join(root, ".agents", "work", "l4", "wake");

		// 1) recheckAt 전(07:50Z)에는 깨움 없음
		const beforeCheck = run(["check", "--role", "role-a"], "2026-10-28T07:50:00Z");
		assert.equal(beforeCheck.status, 0);
		assert.match(beforeCheck.stdout, /놓친 일 없음/);
		assert.equal(fs.existsSync(wakeDir), false);

		// 2) recheckAt 지남(08:01Z) → 깨움 1건 생성
		const dueCheck = run(["check", "--role", "role-a"], "2026-10-28T08:01:00Z");
		assert.equal(dueCheck.status, 0);
		assert.match(dueCheck.stdout, /\[다시 볼 시각 지남\] role-a\/20261028-라디오-게시/);
		const wakeFiles1 = fs.readdirSync(wakeDir).filter((n) => n.endsWith(".md"));
		assert.equal(wakeFiles1.length, 1);
		const wakeBody = fs.readFileSync(path.join(wakeDir, wakeFiles1[0]), "utf8");
		assert.match(wakeBody, /다시 볼 시각 지남/);
		assert.match(wakeBody, /바깥 송출·게시/);
		assert.match(wakeBody, /#업무-요청\/200000000000000055/);

		// 3) 같은 카드·같은 시각에 다시 점검해도 중복 깨움 없음
		const repeatCheck = run(["check", "--role", "role-a"], "2026-10-28T08:15:00Z");
		assert.equal(repeatCheck.status, 0);
		const wakeFiles2 = fs.readdirSync(wakeDir).filter((n) => n.endsWith(".md"));
		assert.equal(wakeFiles2.length, 1, "한 카드·한 시각당 한 번만 깨워야 함");

		// 4) 새 recheckAt 으로 갱신한 뒤 그 시각이 지나면 새 시각에 대해 1건 깨움
		const updateWait = run([
			"move", "20261028-라디오-게시",
			"--status", "waiting",
			"--wait-reason", "바깥 송출·게시",
			"--recheck-at", "2026-10-28T10:00:00Z",
			"--request-ref", "#업무-요청/200000000000000055",
		], "2026-10-28T08:20:00Z");
		assert.equal(updateWait.status, 0, updateWait.stderr);
		run(["check", "--role", "role-a"], "2026-10-28T10:05:00Z");
		const wakeFiles3 = fs.readdirSync(wakeDir).filter((n) => n.endsWith(".md"));
		assert.equal(wakeFiles3.length, 2, "새 다시 볼 시각이 지나면 한 번 더 깨워야 함");
	});

	it("옛 카드(필드 없는 대기)는 읽기는 되고, 감시가 '까닭·시각 없는 대기'로 한 번 깨운다", () => {
		const dir = path.join(root, "docs", "common", "team", "cards", "role-a");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "20261020-옛-대기-카드.md"), [
			"---",
			"id: 20261020-옛-대기-카드",
			"title: 옛 대기 카드",
			"owner: role-a",
			"status: waiting",
			"source: src-old",
			"received: 2026-10-20T01:00:00.000Z",
			"due: 2026-11-10",
			"next: 대표님 답변 기다림",
			"moved: 2026-10-20T01:00:00.000Z",
			"calendar: yes",
			"progress: ",
			"defer_reason: ",
			"revisit: ",
			"defer_count: 0",
			"result: ",
			"---",
			"",
		].join("\n"));

		// 1) 읽기(loadRoleCards, list)는 오류 없이 동작
		const loaded = loadRoleCards(root, "role-a");
		assert.equal(loaded.length, 1);
		assert.equal(loaded[0].status, "waiting");
		const listRes = run(["list", "--role", "role-a"]);
		assert.equal(listRes.status, 0, listRes.stderr);
		assert.match(listRes.stdout, /\[대기\] 20261020-옛-대기-카드/);

		// 2) 감시(check)가 "까닭·시각 없는 대기"로 잡아서 담당을 한 번 깨움
		const wakeDir = path.join(root, ".agents", "work", "l4", "wake");
		const c1 = run(["check", "--role", "role-a"]);
		assert.equal(c1.status, 0, c1.stderr);
		assert.match(c1.stdout, /\[까닭·시각 없는 대기\] role-a\/20261020-옛-대기-카드/);
		const files1 = fs.readdirSync(wakeDir).filter((n) => n.endsWith(".md"));
		assert.equal(files1.length, 1);
		const body = fs.readFileSync(path.join(wakeDir, files1[0]), "utf8");
		assert.match(body, /까닭·시각 없는 대기/);

		// 3) 다시 check 를 돌려도 중복 깨움 없음(한 번만 깨움)
		const c2 = run(["check", "--role", "role-a"], "2026-10-28T08:00:00Z");
		assert.equal(c2.status, 0);
		const files2 = fs.readdirSync(wakeDir).filter((n) => n.endsWith(".md"));
		assert.equal(files2.length, 1, "옛 카드는 한 번만 깨워야 함");

		// 4) 옛 대기 카드를 필드 없이 그대로 move(--next 만 변경)하려 하면 거절
		const moveKeepWait = run(["move", "20261020-옛-대기-카드", "--next", "여전히 대기"]);
		assert.equal(moveKeepWait.status, 2);
		assert.match(moveKeepWait.stderr, /진행으로 두고 바로 하십시오/);

		// 5) 진행(--status doing)으로 바꾸면 정상 통과
		const moveToDoing = run(["move", "20261020-옛-대기-카드", "--status", "doing", "--next", "바로 진행"]);
		assert.equal(moveToDoing.status, 0, moveToDoing.stderr);
	});
});

describe("오류는 [오류] 와 종료 2", () => {
	it("미룸 사유·날짜 둘 다 없으면 오류", () => {
		run(["new", "--role", "role-a", "--title", "미룸 오류", "--source", "s", "--next", "n"]);
		const r = run(["defer", "20261028-미룸-오류"]);
		assert.equal(r.status, 2);
		assert.match(r.stderr, /\[오류\]/);
	});
	it("끝 결과 없으면 오류", () => {
		run(["new", "--role", "role-a", "--title", "끝 오류", "--source", "s", "--next", "n"]);
		const r = run(["done", "20261028-끝-오류"]);
		assert.equal(r.status, 2);
		assert.match(r.stderr, /\[오류\]/);
	});
	it("제목·다음 행동 빠지면 오류, 역할·id 가드", () => {
		assert.equal(run(["new", "--role", "role-a", "--title", "t", "--source", "s"]).status, 2);
		assert.equal(run(["new", "--role", "RoleA", "--title", "t", "--source", "s", "--next", "n"]).status, 2);
		assert.equal(run(["move", "../탈출", "--next", "x"]).status, 2);
		assert.equal(run(["move", "없는-카드", "--next", "x"]).status, 2);
		assert.equal(run(["list"]).status, 2);
	});
});

describe("check 여덟 항목", () => {
	it("기한 지남·멈춤·다시 볼 날·빠진 칸·사라진 카드·연결 없는 지시·캘린더·계속 밀림을 각각 잡는다", () => {
		// 기한 지남 + 캘린더 안 올림
		run(["new", "--role", "role-a", "--title", "지난 일", "--source", "s", "--due", "2026-10-20", "--next", "n"]);
		// 멈춤: 25시간 전 카드
		run(["new", "--role", "role-a", "--title", "멈춘 일", "--source", "s", "--due", "2026-11-10", "--next", "n", "--calendar", "yes"], "2026-10-27T06:00:00Z");
		// 다시 볼 날 지남: 미룸 뒤 날짜가 지남
		run(["new", "--role", "role-a", "--title", "미룬 일", "--source", "s", "--due", "2026-11-10", "--next", "n", "--calendar", "yes"]);
		run(["defer", "20261028-미룬-일", "--reason", "나중에", "--revisit", "2026-10-20"]);
		// 빠진 칸: 끝인데 결과 없음(고의로 지움)
		run(["new", "--role", "role-a", "--title", "끝난 일", "--source", "s", "--next", "n"]);
		const doneFile = path.join(root, "docs", "common", "team", "cards", "role-a", "20261028-끝난-일.md");
		fs.writeFileSync(doneFile, fs.readFileSync(doneFile, "utf8").replace(/^status: doing$/m, "status: done"));
		// 사라진 카드
		run(["new", "--role", "role-a", "--title", "없어진 일", "--source", "s", "--next", "n"]);
		fs.rmSync(path.join(root, "docs", "common", "team", "cards", "role-a", "20261028-없어진-일.md"));
		// 카드 없는 대표님 지시
		inboxFile("role-a", "20261028120000000-evt-aaaabbbb1111.md", { evt: "evt-aaaabbbb1111", msg: "200000000000000001" });
		const r = run(["check", "--role", "role-a"]);
		assert.equal(r.status, 0);
		for (const kind of ["기한 지남", "멈춤", "다시 볼 날 지남", "빠진 칸", "사라진 카드", "카드 없는 대표님 지시", "캘린더 안 올림"]) {
			assert.match(r.stdout, new RegExp(`\\[${kind}\\]`), `${kind} 항목이 안 잡힘: ${r.stdout}`);
		}
	});

	it("계속 밀리는 일: 두 번 미루면 잡힌다", () => {
		run(["new", "--role", "role-a", "--title", "계속 일", "--source", "s", "--due", "2026-11-10", "--next", "n", "--calendar", "yes"]);
		run(["defer", "20261028-계속-일", "--reason", "한 번", "--revisit", "2026-11-01"]);
		let r = run(["check", "--role", "role-a"]);
		assert.doesNotMatch(r.stdout, /계속 밀리는 일/);
		run(["defer", "20261028-계속-일", "--reason", "두 번", "--revisit", "2026-11-02"]);
		r = run(["check", "--role", "role-a"]);
		assert.match(r.stdout, /\[계속 밀리는 일\]/);
	});

	it("ack 한 지시·대표님 아닌 글은 안 잡고 문제 없으면 놓친 일 없음", () => {
		inboxFile("role-a", "20261028120000000-evt-aaaabbbb1111.md", { evt: "evt-aaaabbbb1111", msg: "200000000000000001" });
		inboxFile("role-a", "20261028130000000-evt-ccccdddd2222.md", { sender: "123456789012345678", evt: "evt-ccccdddd2222", msg: "999988887777666555" });
		let r = run(["check", "--role", "role-a"]);
		assert.match(r.stdout, /카드 없는 대표님 지시/);
		run(["ack", "--role", "role-a", "--ref", "evt-aaaabbbb1111", "--reason", "읽고 끝"]);
		r = run(["check", "--role", "role-a"]);
		assert.doesNotMatch(r.stdout, /카드 없는 대표님 지시/);
		assert.match(r.stdout, /놓친 일 없음/);
	});

	it("--json 은 목록을 낸다", () => {
		run(["new", "--role", "role-a", "--title", "지난 일", "--source", "s", "--due", "2026-10-20", "--next", "n"]);
		const r = run(["check", "--role", "role-a", "--json"]);
		assert.equal(r.status, 0);
		const problems = JSON.parse(r.stdout);
		assert.ok(problems.some((p) => p.kind === "overdue" && p.id === "20261028-지난-일"));
	});
});

describe("board·tick·done 안내", () => {
	it("board 는 같은 입력에 같은 카드를 낸다", () => {
		run(["new", "--role", "role-a", "--title", "판 일", "--source", "s", "--due", "2026-10-29", "--next", "n"]);
		run(["board"]);
		const first = fs.readFileSync(path.join(root, "docs", "common", "team", "cards", "index.md"), "utf8");
		run(["board"]);
		const second = fs.readFileSync(path.join(root, "docs", "common", "team", "cards", "index.md"), "utf8");
		assert.equal(first, second);
		assert.match(first, /업무 카드판/);
		assert.match(first, /계속 밀리는 일/);
		assert.match(first, /놓친 일·밀리는 일/);
		assert.match(first, /판 일/);
	});

	it("tick 은 60분 안 지나면 조용하고 지나면 울린다", () => {
		run(["new", "--role", "role-a", "--title", "알림 일", "--source", "s", "--due", "2026-11-10", "--next", "n", "--calendar", "yes"]);
		const first = run(["tick", "--role", "role-a", "--session", "sess1"]);
		assert.equal(first.status, 0);
		assert.match(first.stdout, /\[업무 카드 정기 점검\]/);
		const quiet = run(["tick", "--role", "role-a", "--session", "sess1"]);
		assert.equal(quiet.status, 0);
		assert.equal(quiet.stdout, "");
		const later = run(["tick", "--role", "role-a", "--session", "sess1"], "2026-10-28T08:21:00Z");
		assert.match(later.stdout, /\[업무 카드 정기 점검\]/);
	});

	it("tick 은 이상해도 종료 0·출력 없음", () => {
		for (const args of [["tick"], ["tick", "--role", "BAD", "--session", "s"], ["tick", "--role", "role-a", "--session", "../탈출"]]) {
			const r = run(args);
			assert.equal(r.status, 0);
			assert.equal(r.stdout, "");
		}
	});

	it("done 은 남은 목록을 기한 순으로 낸다", () => {
		run(["new", "--role", "role-a", "--title", "먼저 일", "--source", "s", "--due", "2026-11-05", "--next", "n"]);
		run(["new", "--role", "role-a", "--title", "나중 일", "--source", "s", "--due", "2026-10-29", "--next", "n"]);
		run(["new", "--role", "role-a", "--title", "끝낼 일", "--source", "s", "--due", "2026-10-30", "--next", "n"]);
		const r = run(["done", "20261028-끝낼-일", "--result", "docs/r.md"]);
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /끝냄 role-a\/20261028-끝낼-일/);
		assert.match(r.stdout, /다음 일\(기한 순\)/);
		const rest = r.stdout.split("다음 일(기한 순):")[1].split("점검:")[0];
		assert.ok(rest.indexOf("20261028-나중-일") < rest.indexOf("20261028-먼저-일"), "기한 순이 아님");
		assert.doesNotMatch(rest, /20261028-끝낼-일/);
	});
});

describe("slugify", () => {
	it("한글은 살리고 같은 이름 충돌은 번호로", () => {
		assert.equal(slugify("업무 카드 체계"), "업무-카드-체계");
		assert.equal(slugify("!!!"), "card");
	});
});

describe("받은편지 대조·defer 필수·board 표시", () => {
	function inboxReal(role, name, { sender = OWNER_ID, senderName = "owner-user", evt = "evt-abcdef1234", channel = "general (300000000000000001)", msg = null, body = "> 대표님 지시 본문", subdir = "", mtime = NOW_MS } = {}) {
		const dir = path.join(root, ".agents", "work", "l4", "role-inbox", role, subdir);
		fs.mkdirSync(dir, { recursive: true });
		const head = [
			"# 4층 깨움", "", "- 시각: 2026-10-28T07:00:00.000Z", `- 사건: ${evt} (discord/channel)`,
			`- 보낸 사람: ${senderName} (${sender})`, `- 채널: ${channel}`,
			...(msg ? [`- 원문 글: ${msg}`] : []),
			"", body, "",
		];
		const file = path.join(dir, name);
		fs.writeFileSync(file, head.join("\n"));
		fs.utimesSync(file, new Date(mtime), new Date(mtime));
		return file;
	}

	function ledgerEntries() {
		const file = path.join(root, "docs", "common", "team", "cards", "ledger.jsonl");
		if (!fs.existsSync(file)) return [];
		return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map(JSON.parse);
	}

	it("멘션만 한 글은 대표님 지시가 아니다", () => {
		inboxReal("role-a", "20261028120000000-evt-ffff00001111.md", {
			sender: "100000000000000002", senderName: "member-user",
			evt: "evt-ffff00001111", msg: "200000000000000002",
			body: `> 관리자 권한 <@${OWNER_ID}> 에게 어떻게 이양해?`,
		});
		const r = run(["check", "--role", "role-a"]);
		assert.equal(r.status, 0);
		assert.doesNotMatch(r.stdout, /카드 없는 대표님 지시/);
		assert.match(r.stdout, /놓친 일 없음/);
	});

	it("read/ 로 옮겨진 대표님 지시도 잡힌다", () => {
		inboxReal("role-a", "20261028120000000-evt-aaaabbbb1111.md", {
			evt: "evt-aaaabbbb1111", msg: "200000000000000001", subdir: "read",
		});
		const r = run(["check", "--role", "role-a"]);
		assert.equal(r.status, 0);
		assert.match(r.stdout, /카드 없는 대표님 지시/);
	});

	it("채널 아이디만 같은 카드로는 대조되지 않는다", () => {
		const channel = "300000000000000001";
		const msg = "200000000000000001";
		inboxReal("role-a", "20261028120000000-evt-aaaabbbb1111.md", {
			evt: "evt-aaaabbbb1111", channel: `general (${channel})`, msg,
		});
		run(["new", "--role", "role-a", "--title", "채널 주소 카드", "--source", `discord:${channel}`, "--due", "2026-11-10", "--next", "n", "--calendar", "yes"]);
		let r = run(["check", "--role", "role-a"]);
		assert.equal(r.status, 0);
		assert.match(r.stdout, /카드 없는 대표님 지시/, `채널 ID만으로는 엮이면 안 됨: ${r.stdout}`);
		run(["new", "--role", "role-a", "--title", "글 번호 카드", "--source", `https://discord.com/channels/1/${channel}/${msg}`, "--due", "2026-11-10", "--next", "n", "--calendar", "yes"]);
		r = run(["check", "--role", "role-a"]);
		assert.doesNotMatch(r.stdout, /카드 없는 대표님 지시/);
	});

	it("defer 는 사유만 있으면 오류이고 장부·카드를 바꾸지 않는다", () => {
		run(["new", "--role", "role-a", "--title", "미룸 하나", "--source", "s", "--next", "n"]);
		const cardFile = path.join(root, "docs", "common", "team", "cards", "role-a", "20261028-미룸-하나.md");
		const before = fs.readFileSync(cardFile, "utf8");
		const r = run(["defer", "20261028-미룸-하나", "--reason", "급한 일 먼저"]);
		assert.equal(r.status, 2);
		assert.match(r.stderr, /\[오류\]/);
		assert.equal(fs.readFileSync(cardFile, "utf8"), before);
		assert.deepEqual(ledgerEntries().map((e) => e.cmd), ["new"]);
	});

	it("defer 는 다시 볼 날만 있으면 오류이고 장부·카드를 바꾸지 않는다", () => {
		run(["new", "--role", "role-a", "--title", "미룸 둘", "--source", "s", "--next", "n"]);
		const cardFile = path.join(root, "docs", "common", "team", "cards", "role-a", "20261028-미룸-둘.md");
		const before = fs.readFileSync(cardFile, "utf8");
		const r = run(["defer", "20261028-미룸-둘", "--revisit", "2026-10-30"]);
		assert.equal(r.status, 2);
		assert.match(r.stderr, /\[오류\]/);
		assert.equal(fs.readFileSync(cardFile, "utf8"), before);
		assert.deepEqual(ledgerEntries().map((e) => e.cmd), ["new"]);
	});

	it("board 표는 기한 지남·멈춤·다시 볼 날 지남을 상태 칸에 구분해 보인다", () => {
		run(["new", "--role", "role-a", "--title", "지난 카드", "--source", "s", "--due", "2026-10-20", "--next", "n", "--calendar", "yes"]);
		run(["new", "--role", "role-a", "--title", "멈춘 카드", "--source", "s", "--due", "2026-11-10", "--next", "n", "--calendar", "yes"], "2026-10-27T06:00:00Z");
		run(["new", "--role", "role-a", "--title", "미룸 카드", "--source", "s", "--due", "2026-11-10", "--next", "n", "--calendar", "yes"]);
		run(["defer", "20261028-미룸-카드", "--reason", "나중에", "--revisit", "2026-10-20"]);
		run(["board"]);
		const index = fs.readFileSync(path.join(root, "docs", "common", "team", "cards", "index.md"), "utf8");
		assert.match(index, /\| 진행 \[기한 지남\] \| 지난 카드/);
		assert.match(index, /\| 진행 \[멈춤\] \| 멈춘 카드/);
		assert.match(index, /\| 미룸 \[다시 볼 날 지남\] \| 미룸 카드/);
	});

	it("기존 역할별 work-watch 설정과 관계없이 to-ledger 는 소비자 단일 폴더에 깨움을 만든다", () => {
		const ctxDir = path.join(root, ".agents", "context");
		fs.mkdirSync(ctxDir, { recursive: true });
		fs.writeFileSync(path.join(ctxDir, "work-watch.json"), JSON.stringify({
			defaultRole: "lead",
			roles: [
				{ id: "lead", wakeDir: ".agents/work/l4/wake" },
				{ id: "role-a", wakeDir: ".agents/work/l4/wake/role-a" },
			],
		}));
		run(["new", "--role", "lead", "--title", "대표 승인", "--source", "s", "--next", "n"]);
		run([
			"wait", "20261028-대표-승인",
			"--wait-reason", "돈 드는 것",
			"--recheck-at", "2026-10-28T08:00:00Z",
			"--request-ref", "#업무-요청/200000000000000077",
		]);
		const outLedger = path.join(root, "work-ledger.json");
		const r = run(["to-ledger", outLedger], "2026-10-28T08:05:00Z");
		assert.equal(r.status, 0, r.stderr);
		const leadWakeDir = path.join(root, ".agents", "work", "l4", "wake");
		const wakeFiles = fs.readdirSync(leadWakeDir).filter((n) => n.endsWith(".md"));
		assert.equal(wakeFiles.length, 1);
		assert.match(wakeFiles[0], /-route-lead\.md$/);
		const exported = JSON.parse(fs.readFileSync(outLedger, "utf8"));
		assert.equal(exported.work.length, 1);
		assert.equal(exported.work[0].status, "대기");
		assert.equal(exported.work[0].wait_reason, "돈 드는 것");
	});
});
