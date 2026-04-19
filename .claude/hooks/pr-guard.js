#!/usr/bin/env node
/**
 * OSS Communications Guard (PreToolUse on Bash)
 *
 * Blocks all GitHub write operations targeting external (non-nextain) repos
 * without explicit user approval.
 *
 * Blocked operations (to non-nextain/* repos):
 *   gh pr create / comment / reopen / edit / review / merge
 *   gh issue create / comment / edit
 *   gh release create
 *
 * Internal nextain/* repos: pass through (handled by other guards).
 *
 * Additionally: when --repo is absent, detects non-nextain upstream remotes
 * in the CWD and blocks with a specific warning.
 *
 * Format: https://docs.anthropic.com/en/docs/claude-code/hooks
 */

const { execSync } = require("child_process");

/**
 * Check if the given directory has any non-nextain git remote.
 * Returns the first offending remote URL, or null if all are safe.
 */
function findExternalUpstream(cwd) {
	try {
		const out = execSync("git remote -v", {
			cwd,
			timeout: 3000,
			stdio: ["pipe", "pipe", "pipe"],
		}).toString();
		const lines = out.split("\n").filter(Boolean);
		for (const line of lines) {
			// e.g. "upstream\thttps://github.com/mozilla-ai/any-llm.git (fetch)"
			const m = line.match(/\t([^\s]+)/);
			if (!m) continue;
			const url = m[1];
			// Flag any github.com URL that is NOT nextain/*
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
	const cwd = data.cwd || process.cwd();

	if (toolName !== "Bash") {
		process.exit(0);
	}

	// ── Fast-path: simple substring check (catches multiline/heredoc commands) ──
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
		process.exit(0);
	}

	// ── Check --repo flag ────────────────────────────────────────────────────────
	const repoMatch = command.match(/--repo\s+([^\s'"]+)/);

	if (repoMatch) {
		const repo = repoMatch[1];
		if (repo.startsWith("nextain/")) {
			// Internal repo — allow
			process.exit(0);
		}
		// External repo explicitly specified — block
		const result = {
			decision: "block",
			reason:
				`[Guard] 외부 repo 쓰기 차단: --repo ${repo}\n` +
				"nextain/* 외의 repo 대상 쓰기 작업은 Luke의 명시적 승인이 필요합니다.\n" +
				"승인 후 직접 실행하거나 이 세션에서 명시적으로 승인을 요청하세요.",
		};
		process.stdout.write(JSON.stringify(result));
		process.exit(0);
	}

	// ── No --repo: inspect CWD remotes ──────────────────────────────────────────
	const externalRemote = findExternalUpstream(cwd);
	if (externalRemote) {
		// CWD has a non-nextain remote — very high risk of accidental upstream post
		const result = {
			decision: "block",
			reason:
				`[Guard] GitHub 쓰기 차단 — --repo 미지정 + 외부 upstream 감지\n` +
				`CWD(${cwd})에 외부 remote가 있습니다: ${externalRemote}\n` +
				"--repo nextain/<repo> 를 명시하거나 Luke의 승인 후 직접 실행하세요.",
		};
		process.stdout.write(JSON.stringify(result));
		process.exit(0);
	}

	// ── No --repo, but no external remote either — still block (conservative) ───
	const result = {
		decision: "block",
		reason:
			"[Guard] GitHub 쓰기 차단 (--repo 미지정)\n" +
			"대상 repo를 확인할 수 없습니다. --repo nextain/<repo> 를 명시하거나 " +
			"Luke의 승인 후 직접 실행하세요.",
	};
	process.stdout.write(JSON.stringify(result));
	process.exit(0);
}

main().catch(() => {
	// Hook 오류 시 안전하게 차단
	const result = {
		decision: "block",
		reason:
			"[Guard] pr-guard 내부 오류 — 안전을 위해 GitHub 쓰기 차단.\n" +
			"명령을 직접 실행하거나 Luke에게 확인 요청하세요.",
	};
	process.stdout.write(JSON.stringify(result));
	process.exit(0);
});
