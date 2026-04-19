#!/usr/bin/env node
/**
 * Destructive Git Guard Hook (PreToolUse on Bash)
 *
 * Blocks destructive git commands that permanently discard changes.
 * These commands require explicit user confirmation before execution.
 *
 * Blocked patterns:
 *   git checkout -- <file>  (discard uncommitted changes)
 *   git reset --hard        (hard reset to commit)
 *   git clean -f / -fd / -fx (remove untracked files)
 */

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
	const command = data.tool_input?.command || "";

	if (toolName !== "Bash") {
		process.exit(0);
	}

	// Strip quoted strings to avoid false positives from echo/test commands
	// e.g. echo 'git reset --hard' | node hook.js should NOT be blocked
	const stripped = command
		.replace(/'[^']*'/g, "''")
		.replace(/"[^"]*"/g, '""');

	const destructivePatterns = [
		{ pattern: /git\s+checkout\s+--\s/, label: "git checkout -- <file>" },
		{ pattern: /git\s+reset\s+--hard\b/, label: "git reset --hard" },
		{ pattern: /git\s+clean\s+.*-[fdxX]*f[fdxX]*\b/, label: "git clean -f" },
	];

	for (const { pattern, label } of destructivePatterns) {
		if (pattern.test(stripped)) {
			const result = {
				decision: "block",
				reason:
					`[Harness] 파괴적 git 명령 차단: \`${label}\`\n` +
					"이 명령은 변경사항을 영구 삭제합니다. 되돌릴 수 없습니다.\n" +
					"실행 전 사용자에게 반드시 확인받으세요:\n" +
					`  \"이 명령을 실행하면 X가 삭제됩니다. 진행할까요?\"`,
			};
			process.stdout.write(JSON.stringify(result));
			process.exit(0);
		}
	}

	process.exit(0);
}

main().catch(() => process.exit(0));
