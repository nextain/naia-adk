#!/usr/bin/env node
/**
 * 업무 카드 1시간 알림 훅의 시험.
 *
 * 이 훅이 막는 것은 "1시간마다 보게"가 말뿐인 것이다. 그래서 재는 것도 그
 * 자리다 — 60분이 안 지났으면 조용하고(세션 흐름을 끊지 않음), 지났으면
 * additionalContext 로 카드 요약을 싣는지, 역할이 없거나 입력이 깨져도
 * 조용히 종료 0인지. 픽스처로만 돈다.
 */

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const hook = path.join(__dirname, "task-cards-tick.js");
const realScript = fs.readFileSync(path.join(__dirname, "..", "..", ".agents", "scripts", "task-cards.mjs"), "utf8");

const roots = [];

function fixtureRoot() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-cards-tick-"));
	roots.push(root);
	fs.mkdirSync(path.join(root, ".git"), { recursive: true });
	fs.mkdirSync(path.join(root, ".agents", "scripts"), { recursive: true });
	fs.writeFileSync(path.join(root, ".agents", "scripts", "task-cards.mjs"), realScript);
	return root;
}

function runHook(root, stdin, env = {}) {
	return spawnSync("node", [hook], {
		input: stdin,
		stdio: ["pipe", "pipe", "pipe"],
		encoding: "utf8",
		env: { ...process.env, ADK_AGENT_ROLE: "", ...env },
		timeout: 5000,
	});
}

function makeCard(root, role = "role-a") {
	const dir = path.join(root, "docs", "common", "team", "cards", role);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "20261028-알림-일.md"), [
		"---",
		"id: 20261028-알림-일",
		"title: 알림 일",
		`owner: ${role}`,
		"status: doing",
		"source: 어딘가",
		"received: 2026-10-28T07:00:00.000Z",
		"due: 2026-11-10",
		"next: 다음 행동",
		"moved: 2026-10-28T07:00:00.000Z",
		"calendar: yes",
		"progress: ",
		"wait_reason: ",
		"recheck_at: ",
		"request_ref: ",
		"defer_reason: ",
		"revisit: ",
		"defer_count: 0",
		"result: ",
		"---",
		"",
	].join("\n"));
}

try {
	// ── 1. 세션 id 가 없으면 조용히 끝 ──
	{
		const root = fixtureRoot();
		const run = runHook(root, JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: root }));
		assert.equal(run.status, 0);
		assert.equal(run.stdout, "", "출력 없이 끝나야 함");
	}

	// ── 2. 역할이 어디에도 없으면 조용히 끝 ──
	{
		const root = fixtureRoot();
		const run = runHook(root, JSON.stringify({ hook_event_name: "PostToolUse", cwd: root, session_id: "sess-x" }));
		assert.equal(run.status, 0);
		assert.equal(run.stdout, "");
	}

	// ── 3. 60분이 지나야 additionalContext 로 싣는다 ──
	{
		const root = fixtureRoot();
		makeCard(root, "role-a");
		const stdin = JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: root, session_id: "sess-1" });
		const first = runHook(root, stdin, { ADK_AGENT_ROLE: "role-a" });
		assert.equal(first.status, 0, first.stderr);
		const payload = JSON.parse(first.stdout);
		assert.equal(payload.hookSpecificOutput.hookEventName, "UserPromptSubmit");
		assert.match(payload.hookSpecificOutput.additionalContext, /\[업무 카드 정기 점검\]/);
		assert.match(payload.hookSpecificOutput.additionalContext, /알림-일/);
		const quiet = runHook(root, stdin, { ADK_AGENT_ROLE: "role-a" });
		assert.equal(quiet.status, 0);
		assert.equal(quiet.stdout, "", "60분이 안 지났으면 조용해야 함");
		assert.ok(fs.existsSync(path.join(root, ".agents", "work", "task-cards", "tick-sess-1.json")));
		assert.equal(fs.existsSync(path.join(root, ".agents", "work", "task-cards", "wait-wake-state.json")), false, "역할 tick은 공유 깨움 영수증을 쓰면 안 됨");
		assert.equal(fs.existsSync(path.join(root, ".agents", "work", "l4", "wake")), false, "역할 tick은 세션 글 알림만 해야 함");
	}

	// ── 4. 환경 값 없이 session-roles.json 으로도 역할을 찾는다 ──
	{
		const root = fixtureRoot();
		makeCard(root, "role-b");
		const dir = path.join(root, ".agents", "work", "task-cards");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "session-roles.json"), JSON.stringify({ "sess-b": "role-b" }));
		const run = runHook(root, JSON.stringify({ hook_event_name: "PostToolUse", cwd: root, session_id: "sess-b" }));
		assert.equal(run.status, 0, run.stderr);
		assert.match(JSON.parse(run.stdout).hookSpecificOutput.additionalContext, /\[업무 카드 정기 점검\]/);
	}

	// ── 5. 깨진 입력·없는 역할에도 조용히 종료 0 ──
	{
		const root = fixtureRoot();
		assert.equal(runHook(root, "깨진 입력 {{{").status, 0);
		assert.equal(runHook(root, "").status, 0);
		const bad = runHook(root, JSON.stringify({ hook_event_name: "PostToolUse", cwd: root, session_id: "s" }), { ADK_AGENT_ROLE: "../탈출" });
		assert.equal(bad.status, 0);
		assert.equal(bad.stdout, "");
	}

	// ── 6. 기존 공유 영수증과 옛 대기 카드가 있어도 세션 알림만 한다 ──
	{
		const root = fixtureRoot();
		makeCard(root, "role-a");
		const card = path.join(root, "docs", "common", "team", "cards", "role-a", "20261028-알림-일.md");
		fs.writeFileSync(card, fs.readFileSync(card, "utf8").replace(/^status: doing$/m, "status: waiting"));
		const state = path.join(root, ".agents", "work", "task-cards", "wait-wake-state.json");
		fs.mkdirSync(path.dirname(state), { recursive: true });
		const receipt = JSON.stringify({ version: 1, sent: { "external:remote-card": { role: "role-a", at: "2026-10-28T07:00:00Z" } } });
		fs.writeFileSync(state, receipt);
		const result = runHook(root, JSON.stringify({ hook_event_name: "PostToolUse", cwd: root, session_id: "legacy-no-wake" }), { ADK_AGENT_ROLE: "role-a" });
		assert.equal(result.status, 0, result.stderr);
		assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /까닭·시각 없는 대기/);
		assert.equal(fs.readFileSync(state, "utf8"), receipt, "세션 tick이 외부 깨움 영수증을 지우면 안 됨");
		assert.equal(fs.existsSync(path.join(root, ".agents", "work", "l4", "wake")), false);
	}

	console.log("task-cards tick hook: PASS");
} finally {
	for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
}
