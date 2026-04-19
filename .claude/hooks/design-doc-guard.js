#!/usr/bin/env node
/**
 * Design Doc Guard Hook (PreToolUse on Edit|Write)
 *
 * Blocks edits to design/spec documents BEFORE they happen.
 * Design docs are the Source of Truth — the AI is a reviewer, not an author.
 *
 * Permission model:
 *   Code files:   AI = implementer (can read, modify, create, delete)
 *   Design docs:  AI = reviewer   (can ONLY report findings, not decide)
 *
 * Bypass: create .claude/design-doc-unlock to allow edits in current session.
 *   The AI must ask the user first, then create the unlock file, edit, and remove it.
 *
 * Allowed edits (after surfacing to user):
 *   - Typos / grammar
 *   - Internal contradictions within the doc
 *   - Broken links / references
 *   - Research additions / reference updates (with user approval)
 *
 * Forbidden edits (always, even with unlock):
 *   - Changing design decisions to match current implementation
 *   - Modifying tech choices, interface specs, numeric ranges without user approval
 *
 * If implementation diverges from design → escalate to user, do NOT silently fix.
 */

const { existsSync } = require("fs");
const { resolve } = require("path");

async function main() {
	let input = "";
	for await (const chunk of process.stdin) {
		input += chunk;
	}

	let data;
	try {
		data = JSON.parse(input);
	} catch {
		process.exit(0);
	}

	const toolName = data.tool_name || "";
	const filePath = data.tool_input?.file_path || data.parameters?.file_path || "";

	if (toolName !== "Edit" && toolName !== "Write") {
		process.exit(0);
	}

	const normalized = filePath.replace(/\\/g, "/");

	// Match design/spec document paths (path prefix + extension filter)
	const hasDesignExt = /\.(md|txt|yaml|json)$/.test(normalized);
	const isDesignDoc =
		(/\/docs\/design\//.test(normalized) && hasDesignExt) ||
		(/\/design\//.test(normalized) && hasDesignExt) ||
		(/\/spec\//.test(normalized) && hasDesignExt);

	if (!isDesignDoc) {
		process.exit(0);
	}

	// Check for user-approved unlock file (.claude/design-doc-unlock)
	const unlockFile = resolve(__dirname, "..", "design-doc-unlock");
	if (existsSync(unlockFile)) {
		// Allowed — user has explicitly approved this edit session
		process.stdout.write(JSON.stringify({ decision: "allow" }));
		process.exit(0);
	}

	const result = {
		decision: "block",
		reason:
			`[Harness] 설계 문서 편집 차단: ${filePath}\n` +
			"\n" +
			"설계 문서에서 AI의 역할은 리뷰어입니다 — 저자가 아닙니다.\n" +
			"편집을 계속하려면 아래 중 무엇인지 사용자에게 먼저 보고하세요:\n" +
			"\n" +
			"  (A) 오타/문법 수정        → 사용자에게 보고 후 진행 가능\n" +
			"  (B) 문서 내부 모순 수정   → 사용자에게 보고 후 진행 가능\n" +
			"  (C) 깨진 링크/참조 수정   → 사용자에게 보고 후 진행 가능\n" +
			"  (D) 설계 결정 변경        → 사용자 명시적 승인 필수\n" +
			"  (E) 구현이 설계와 다름    → 편집 금지. 에스컬레이션 경로 따를 것:\n" +
			"      1. GitHub Issue 코멘트: 설계-구현 괴리 발견 내용 + 선택지 제시\n" +
			"      2. 사용자 결정 대기\n" +
			"\n" +
			"사용자 승인 후: .claude/design-doc-unlock 파일 생성 → 편집 → 파일 삭제\n",
	};
	process.stdout.write(JSON.stringify(result));
	process.exit(0);
}

main().catch(() => process.exit(0));
