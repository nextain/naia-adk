import test from "node:test";
import assert from "node:assert/strict";
import { boundRequestPrompt } from "../helper/discord-router.mjs";
import { currentExecutionProfile } from "../helper/execution-profile.mjs";

/**
 * 읽기 전용 상한은 포크 고유 기능인데 2026-08-14 업스트림 동기화 머지에서
 * 구현만 사라지고 호출부만 남았다. JavaScript 는 남는 인자를 조용히 버리므로
 * 기존 테스트는 계속 통과했다 — 아무것도 검증하지 않은 채로.
 *
 * 그래서 여기서는 인자를 넘겼다는 사실이 아니라 결과가 실제로 낮아지는지를 본다.
 */

const USER = "865850174651498506";

function config() {
	return {
		schemaVersion: 1,
		persona: { name: "Tester", instructions: "Be exact." },
		role: { name: "operator", allowedActions: ["read", "reply", "write", "execute"], requiresApproval: [] },
		backend: { selected: "codex", profiles: { codex: { costProfile: "balanced" } } },
		runtime: { approvalPolicy: "never" },
		discord: { operatorUserIds: [USER] },
	};
}

const authority = { binding: { operatorActions: true }, participantProfile: null, isOperator: true };

test("상한이 없으면 변경 권한이 그대로 산출된다", () => {
	const profile = currentExecutionProfile(config(), "codex", authority);
	assert.equal(profile.access, "workspace-write");
});

test("읽기 전용 상한은 실행 프로필을 실제로 낮춘다", () => {
	const profile = currentExecutionProfile(config(), "codex", authority, { accessCeiling: "read-only" });
	assert.equal(profile.access, "read-only");
});

test("상한은 낮추는 값만 받는다", () => {
	assert.throws(() => currentExecutionProfile(config(), "codex", authority, { accessCeiling: "workspace-write" }), /access ceiling/);
	assert.throws(() => currentExecutionProfile(config(), "codex", authority, { accessCeiling: "danger-full-access" }), /access ceiling/);
});

test("상한이 걸리면 프롬프트의 행동 목록에서 write 와 execute 가 빠진다", () => {
	const open = boundRequestPrompt("작업해줘", config(), authority, null, null);
	const bounded = boundRequestPrompt("작업해줘", config(), authority, null, "read-only");
	assert.match(open, /Allowed actions: [^\n]*write/);
	assert.doesNotMatch(bounded, /Allowed actions: [^\n]*write/);
	assert.doesNotMatch(bounded, /Allowed actions: [^\n]*execute/);
	assert.match(bounded, /This job is read-only/);
});
