#!/usr/bin/env node
/**
 * Commit Guard Hook (PreToolUse on Bash) — policy-only adapter.
 * Envelope: ./_claude-bash-guard.js. Behavior byte-identical to original
 * (G-OC01 part1 S2, pure refactor). Blocks `git commit` before sync_verify.
 */
const fs = require("fs");
const path = require("path");
let H;
try {
	H = require("./_claude-bash-guard.js");
} catch {
	process.exit(0); // original main().catch fail-open
}

const PHASE_ORDER = [
	"issue",
	"understand",
	"scope",
	"investigate",
	"plan",
	"build",
	"review",
	"e2e_test",
	"post_test_review",
	"sync",
	"sync_verify",
	"report",
	"commit",
];

const MIN_PHASE_FOR_COMMIT = "sync_verify";

H.start((command, data) => {
	// Match git commit only as a real shell command (not inside echo/heredoc args)
	if (!command.match(/(?:^|[;&|])\s*git\s+commit\b/)) {
		return null;
	}

	const cwd = data.cwd || process.cwd();
	const progressDir = path.join(cwd, ".agents", "progress");

	if (!fs.existsSync(progressDir)) {
		return null;
	}

	let latestFile = null;
	let latestMtime = 0;
	try {
		const files = fs.readdirSync(progressDir).filter((f) => f.endsWith(".json"));
		for (const file of files) {
			const filePath = path.join(progressDir, file);
			const stat = fs.statSync(filePath);
			if (stat.mtimeMs > latestMtime) {
				latestMtime = stat.mtimeMs;
				latestFile = filePath;
			}
		}
	} catch {
		return null;
	}

	if (!latestFile) {
		return null;
	}

	let progress;
	try {
		progress = JSON.parse(fs.readFileSync(latestFile, "utf8"));
	} catch {
		return null;
	}

	// Skip check if progress file belongs to a different repo
	if (progress.issue_url) {
		const issueRepoMatch = progress.issue_url.match(
			/github\.com\/([^/]+\/[^/]+)\/issues/,
		);
		if (issueRepoMatch) {
			try {
				const { execSync } = require("child_process");
				const remoteUrl = execSync("git remote get-url origin", {
					cwd,
					encoding: "utf8",
				}).trim();
				const remoteMatch = remoteUrl.match(/[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
				if (remoteMatch && remoteMatch[1] !== issueRepoMatch[1]) {
					return null; // different repo — skip phase check
				}
			} catch {
				// Cannot determine remote, proceed with check conservatively
			}
		}
	}

	const currentPhase = progress.current_phase || "";
	const currentIndex = PHASE_ORDER.indexOf(currentPhase);
	const minIndex = PHASE_ORDER.indexOf(MIN_PHASE_FOR_COMMIT);

	if (currentIndex >= 0 && currentIndex < minIndex) {
		const remaining = PHASE_ORDER.slice(currentIndex + 1, minIndex + 1);
		return {
			reason:
				`[Harness] 커밋 차단: 현재 phase "${currentPhase}" — ` +
				`커밋 전 남은 phases: ${remaining.join(" → ")}. ` +
				`Issue: ${progress.issue || "unknown"}. ` +
				`E2E 테스트와 컨텍스트 싱크를 완료한 후 커밋하세요.`,
		};
	}

	return null;
});
