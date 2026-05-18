/**
 * Tool-agnostic Bash-guard policies (G-OC01 part2 — policy neutralization).
 *
 * Pure functions: (command, data, opts?) → { reason } | null  (a returned
 * { reason } means BLOCK). No host I/O envelope, no process.exit. Shared
 * by every host adapter: .claude/hooks/_claude-bash-guard.js (Claude) and
 * .pi/extensions/naia-harness.ts (pi) call the SAME policy here.
 *
 * Path-dependent guards (deploy DEPLOY_DIR, …) take host paths via `opts`
 * because the adapter — not this module — knows the host config dir
 * (__dirname differs once policy lives here). cwd-relative paths (e.g.
 * git-push marker = path.join(".claude",…) resolved vs process.cwd()) are
 * move-safe and stay in the guard policy as-is.
 *
 * Behavior of each policy is byte-identical to the part1 adapter it was
 * extracted from (golden parity 8/42/19 must stay green).
 */
const path = require("path");
const core = require(path.join(__dirname, "..", "core", "harness-core.js"));

/** destructive-git-guard — git checkout -- / reset --hard / clean -f */
function destructiveGit(command) {
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
}

module.exports = { destructiveGit };
