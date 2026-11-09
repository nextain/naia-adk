#!/usr/bin/env node
/**
 * 업무 카드 1시간 알림 훅 (PostToolUse·UserPromptSubmit 공용).
 *
 * 왜 두는가: 한 가지 업무에 몰입하면 다른 업무나 대기 중인 카드의 다시 볼 시각을
 * 놓치기 쉽기 때문이다. 이 훅은 게이트가 아니다. 마지막 점검에서 60분이 지났을 때만
 * 자기 카드 요약·점검 요약을 맥락에 싣고(다시 볼 시각이 지난 대기 카드나 까닭·시각 없는
 * 옛 대기 카드가 있으면 깨움 파일도 함께 남김), 그 전에는 조용하다.
 * 시각 기록은 `.agents/work/task-cards/session-roles.json` 옆 `tick-<세션>.json`에 둔다.
 *
 * 역할은 환경 값 ADK_AGENT_ROLE, 없으면 저장소
 * `.agents/work/task-cards/session-roles.json`({세션 id: 역할})에서 찾는다.
 * 둘 다 없으면 아무것도 안 한다. 1초 안에 끝나고, 어떤 실패에도 조용히 종료 0.
 * 등록(.claude/settings.json)은 인스턴스 조정자가 한다. 이 파일은 등록하지 않는다.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const TIMEOUT_MS = 900;

function findRoot(start) {
	let current = path.resolve(start || process.cwd());
	while (true) {
		try {
			if (fs.statSync(path.join(current, ".git")).isFile() || fs.statSync(path.join(current, ".git")).isDirectory()) return current;
		} catch { /* 위로 */ }
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function resolveRole(root, sessionId) {
	const env = (process.env.ADK_AGENT_ROLE || "").trim();
	if (env) return env;
	try {
		const mapping = JSON.parse(fs.readFileSync(path.join(root, ".agents", "work", "task-cards", "session-roles.json"), "utf8"));
		const role = mapping && mapping[sessionId];
		return typeof role === "string" ? role.trim() : "";
	} catch {
		return "";
	}
}

function readInput() {
	let text = "";
	try {
		text = fs.readFileSync(0, "utf8");
	} catch {
		return {};
	}
	if (!text.trim()) return {};
	try {
		return JSON.parse(text);
	} catch {
		return {};
	}
}

function main() {
	const input = readInput();
	const sessionId = typeof input.session_id === "string" ? input.session_id : "";
	if (!sessionId) process.exit(0);
	const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
	const root = findRoot(cwd);
	if (!root) process.exit(0);
	const role = resolveRole(root, sessionId);
	if (!role) process.exit(0);
	const eventName = input.hook_event_name || process.argv[2] || "PostToolUse";
	const script = path.join(root, ".agents", "scripts", "task-cards.mjs");
	let output = "";
	try {
		const run = spawnSync("node", [script, "--root", root, "tick", "--role", role, "--session", sessionId], {
			encoding: "utf8",
			timeout: TIMEOUT_MS,
		});
		if (run.error) process.exit(0);
		output = (run.stdout || "").trim();
	} catch {
		process.exit(0);
	}
	if (!output) process.exit(0);
	process.stdout.write(JSON.stringify({
		hookSpecificOutput: { hookEventName: eventName, additionalContext: output },
	}));
	process.exit(0);
}

module.exports = { findRoot, resolveRole, readInput };

if (require.main === module) {
	try {
		main();
	} catch {
		process.exit(0);
	}
}
