#!/usr/bin/env node
// SessionStart / PostCompact hook for role sessions that run outside the ADK
// repository (e.g. /home/<user>/<role>). Project hooks never load there, so the
// user profile (templates/claude-user-profile) registers this file by absolute path.
//
// Reads `<session cwd>/.naia-role.json` — {"role": "<id>", "read": ["<abs path>", ...]} —
// and re-injects the role's mission paths after compaction. Paths only, at most
// 20 lines; free text from the listed files is never copied into the prompt.
// Silent on any error: an inject hook must never break the session.
const fs = require("fs");
const path = require("path");

const MAX_LINES = 20;

function readStdin() {
	try {
		return JSON.parse(fs.readFileSync(0, "utf8") || "{}");
	} catch {
		return {};
	}
}

function brief(cwd, event) {
	let role;
	try {
		role = JSON.parse(fs.readFileSync(path.join(cwd, ".naia-role.json"), "utf8"));
	} catch {
		return null;
	}
	const read = (Array.isArray(role.read) ? role.read : [])
		.filter((p) => typeof p === "string" && path.isAbsolute(p) && fs.existsSync(p));
	const head = event === "PostCompact"
		? "맥락이 압축됐습니다. 다음 행동 전에 아래를 다시 읽으십시오."
		: "세션 시작. 다음 행동 전에 아래를 읽으십시오.";
	const lines = [
		`${head} 역할: ${typeof role.role === "string" ? role.role : path.basename(cwd)}`,
		...read.map((p, i) => `  ${i + 1}. ${p}`),
		"요약 규칙: ~/.claude/CLAUDE.md (미션·원문 지시·답 안 한 질문·경로를 남김)",
	];
	return lines.slice(0, MAX_LINES).join("\n");
}

function main() {
	const event = process.argv[2] === "PostCompact" ? "PostCompact" : "SessionStart";
	const input = readStdin();
	const text = brief(typeof input.cwd === "string" ? input.cwd : process.cwd(), event);
	if (!text) return;
	const out = event === "SessionStart"
		? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }
		: { additionalContext: text };
	process.stdout.write(JSON.stringify(out));
}

if (require.main === module) {
	try {
		main();
	} catch {
		// fail silent
	}
	process.exit(0);
}

module.exports = { brief };
