#!/usr/bin/env node
/**
 * OSS Communications Guard (PreToolUse on Bash) — policy-only adapter.
 * Envelope: ./_claude-bash-guard.js (fail-closed). Behavior byte-identical
 * to original (G-OC01 part1 S2, pure refactor).
 *
 * Blocks GitHub write ops to non-nextain repos without approval.
 */
const { execSync } = require("child_process");

const PR_FAIL_REASON =
	"[Guard] pr-guard 내부 오류 — 안전을 위해 GitHub 쓰기 차단.\n" +
	"명령을 직접 실행하거나 Luke에게 확인 요청하세요.";

let H;
try {
	H = require("./_claude-bash-guard.js");
} catch {
	// original main().catch is fail-CLOSED
	process.stdout.write(JSON.stringify({ decision: "block", reason: PR_FAIL_REASON }));
	process.exit(0);
}

/** First non-nextain git remote URL in cwd, or null if all safe. */
function findExternalUpstream(cwd) {
	try {
		const out = execSync("git remote -v", {
			cwd,
			timeout: 3000,
			stdio: ["pipe", "pipe", "pipe"],
		}).toString();
		const lines = out.split("\n").filter(Boolean);
		for (const line of lines) {
			const m = line.match(/\t([^\s]+)/);
			if (!m) continue;
			const url = m[1];
			if (
				url.includes("github.com") &&
				!url.includes("github.com/nextain/")
			) {
				return url;
			}
		}
	} catch {
		// git not available or not a repo — safe to ignore
	}
	return null;
}

H.start(
	(command, data) => {
		const cwd = data.cwd || process.cwd();

		// Fast-path: simple substring check (catches multiline/heredoc)
		const WRITE_KEYWORDS = [
			"gh issue create",
			"gh issue comment",
			"gh issue edit",
			"gh pr create",
			"gh pr comment",
			"gh pr reopen",
			"gh pr edit",
			"gh pr review",
			"gh pr merge",
			"gh release create",
		];
		const hasWriteOp = WRITE_KEYWORDS.some((kw) => command.includes(kw));
		if (!hasWriteOp) {
			return null;
		}

		const repoMatch = command.match(/--repo\s+([^\s'"]+)/);

		if (repoMatch) {
			const repo = repoMatch[1];
			if (repo.startsWith("nextain/")) {
				return null; // Internal repo — allow
			}
			return {
				reason:
					`[Guard] 외부 repo 쓰기 차단: --repo ${repo}\n` +
					"nextain/* 외의 repo 대상 쓰기 작업은 Luke의 명시적 승인이 필요합니다.\n" +
					"승인 후 직접 실행하거나 이 세션에서 명시적으로 승인을 요청하세요.",
			};
		}

		const externalRemote = findExternalUpstream(cwd);
		if (externalRemote) {
			return {
				reason:
					`[Guard] GitHub 쓰기 차단 — --repo 미지정 + 외부 upstream 감지\n` +
					`CWD(${cwd})에 외부 remote가 있습니다: ${externalRemote}\n` +
					"--repo nextain/<repo> 를 명시하거나 Luke의 승인 후 직접 실행하세요.",
			};
		}

		return {
			reason:
				"[Guard] GitHub 쓰기 차단 (--repo 미지정)\n" +
				"대상 repo를 확인할 수 없습니다. --repo nextain/<repo> 를 명시하거나 " +
				"Luke의 승인 후 직접 실행하세요.",
		};
	},
	{ failClosed: true, failClosedReason: PR_FAIL_REASON },
);
