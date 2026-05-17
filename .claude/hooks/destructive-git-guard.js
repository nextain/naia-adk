#!/usr/bin/env node
/**
 * Destructive Git Guard Hook (PreToolUse on Bash) — policy-only adapter.
 * Envelope: ./_claude-bash-guard.js. Sanitizer: harness-core (tool-agnostic).
 * Behavior byte-identical to the original (G-OC01 part1 S2, pure refactor).
 *
 * Blocks: git checkout -- <file> | git reset --hard | git clean -f/-fd/-fx
 */
const path = require("path");
let H, core;
try {
	H = require("./_claude-bash-guard.js");
	core = require(path.join(__dirname, "..", "..", ".agents", "hooks", "core", "harness-core.js"));
} catch {
	process.exit(0); // original main().catch fail-open
}

H.start((command) => {
	// Strip quoted strings to avoid false positives from echo/test commands
	const stripped = core.stripQuotesBlank(command);

	const destructivePatterns = [
		{ pattern: /git\s+checkout\s+--\s/, label: "git checkout -- <file>" },
		{ pattern: /git\s+reset\s+--hard\b/, label: "git reset --hard" },
		{ pattern: /git\s+clean\s+.*-[fdxX]*f[fdxX]*\b/, label: "git clean -f" },
	];

	for (const { pattern, label } of destructivePatterns) {
		if (pattern.test(stripped)) {
			return {
				reason:
					`[Harness] 파괴적 git 명령 차단: \`${label}\`\n` +
					"이 명령은 변경사항을 영구 삭제합니다. 되돌릴 수 없습니다.\n" +
					"실행 전 사용자에게 반드시 확인받으세요:\n" +
					`  \"이 명령을 실행하면 X가 삭제됩니다. 진행할까요?\"`,
			};
		}
	}
	return null;
});
