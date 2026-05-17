#!/usr/bin/env node
/**
 * Design Doc Guard Hook (PreToolUse on Edit|Write) — policy-only adapter.
 * Envelope: ./_claude-edit-hook.js. Behavior byte-identical to original
 * (G-OC01 part1 S3, pure refactor). Blocks edits to design/spec docs;
 * .claude/design-doc-unlock bypasses (→ {decision:"allow"}).
 */
const { existsSync } = require("fs");
const { resolve } = require("path");
let H;
try {
	H = require("./_claude-edit-hook.js");
} catch {
	process.exit(0); // original main().catch fail-open
}

H.start((data) => {
	const filePath = data.tool_input?.file_path || data.parameters?.file_path || "";
	const normalized = filePath.replace(/\\/g, "/");

	// Match design/spec document paths (path prefix + extension filter)
	const hasDesignExt = /\.(md|txt|yaml|json)$/.test(normalized);
	const isDesignDoc =
		(/\/docs\/design\//.test(normalized) && hasDesignExt) ||
		(/\/design\//.test(normalized) && hasDesignExt) ||
		(/\/spec\//.test(normalized) && hasDesignExt);

	if (!isDesignDoc) {
		return null;
	}

	// Check for user-approved unlock file (.claude/design-doc-unlock)
	const unlockFile = resolve(__dirname, "..", "design-doc-unlock");
	if (existsSync(unlockFile)) {
		return { allow: true }; // user has explicitly approved this edit session
	}

	return {
		block:
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
});
