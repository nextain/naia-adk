#!/usr/bin/env node
// SessionStart hook for role sessions that run outside the ADK repository
// (e.g. /home/<user>/<role>). Project hooks never load there, so the user profile
// (templates/claude-user-profile) registers this file by absolute path.
//
// Reads `<session cwd>/.naia-role.json` — {"role": "<id>", "read": ["<abs path>", ...]} —
// and injects the role's mission paths. SessionStart fires again with
// source "compact" after compaction, so one hook covers both; PostCompact output
// is shown to the user only. The legacy mission list contains paths only.
// The installed role handoff adds its own configured notes and open cards.
const fs = require("fs");
const path = require("path");

const MAX_LINES = 20;
const ADK_ROOT = path.resolve(__dirname, "../..");
const MANDATORY = [".agents/context/agents-rules.json", ".agents/context/ai-work-index.yaml", ".agents/context/project-index.yaml", ".agents/context/terminology.yaml"];

function readStdin() {
	try {
		return JSON.parse(fs.readFileSync(0, "utf8") || "{}");
	} catch {
		return {};
	}
}

function brief(cwd, source, managed) {
	let role = {};
	if (managed) {
		role = { role: managed.role, read: [path.join(managed.workspace, "adk.json")] };
	} else {
		try { role = JSON.parse(fs.readFileSync(path.join(cwd, ".naia-role.json"), "utf8")); } catch {}
	}
	const read = (Array.isArray(role.read) ? role.read : []).filter((p) => typeof p === "string");
	const mandatory = MANDATORY.map((p) => path.join(ADK_ROOT, p));
	const fork = path.join(ADK_ROOT, "FORK.md");
	if (fs.existsSync(fork)) mandatory.push(fork);
	const head = source === "compact"
		? "맥락이 압축됐습니다. 다음 행동 전에 아래를 다시 읽으십시오."
		: "세션 시작. 다음 행동 전에 아래를 읽으십시오.";
	const lines = [
		`${head} 역할: ${typeof role.role === "string" ? role.role : path.basename(cwd)}`,
		...mandatory.map((p) => `  ${p}`),
		...(read.length ? read.map((p) => path.isAbsolute(p) && fs.existsSync(p) ? `  ${p}` : `없는 경로: ${p}`) : ["역할 미션 파일 없음"]),
		"요약 규칙: ~/.claude/CLAUDE.md 의 Compact instructions (미션·원문 지시·작업 문서·돌아가는 것을 남김)",
	];
	return lines.join("\n");
}

async function main() {
	const input = readStdin();
	const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
	const { roleHandoff } = await import("../../scripts/work-ledger/role-handoff.mjs");
	const handoff = await roleHandoff({ root: process.env.NAIA_ADK_ROOT || ADK_ROOT, cwd, checkClaudeMemory: true });
	const text = [brief(cwd, input.source, handoff?.data), handoff?.text].filter(Boolean).join("\n\n");
	process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }));
}

if (require.main === module) {
	main().catch(error => {
		process.stdout.write(JSON.stringify({ continue: false, stopReason: `Role handoff unavailable: ${error.message}` }));
	});
}

module.exports = { brief, MANDATORY };
