/**
 * Tool-agnostic Bash-guard policies (G-OC01 part2 — policy neutralization).
 *
 * Pure: (command, data, opts?) → { reason } | null  ({ reason } = BLOCK).
 * No host I/O envelope, no process.exit. Shared by every host adapter —
 * .claude/hooks/_claude-bash-guard.js and .pi/extensions/naia-harness.ts
 * call the SAME policy here. Behavior byte-identical to the part1 adapters
 * (golden 8/42/19 + E2E 64 must stay green).
 *
 * Path notes: deploy DEPLOY_DIR is __dirname-dependent → its adapter must
 * pass it via opts (handled in the deploy policy when extracted). git-push
 * MARKER_PATH = path.join(".claude",…) is cwd-relative (resolved vs
 * process.cwd() at call time) → move-safe, stays here verbatim. pr/commit
 * use data.cwd + execSync (host-neutral node) → move-safe.
 */
const path = require("path");
const fs = require("fs");
const core = require(path.join(__dirname, "..", "core", "harness-core.js"));

/** destructive-git-guard */
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

const PHASE_ORDER = [
	"issue", "understand", "scope", "investigate", "plan", "build", "review",
	"e2e_test", "post_test_review", "sync", "sync_verify", "report", "commit",
];
const MIN_PHASE_FOR_COMMIT = "sync_verify";

/** commit-guard — block git commit before sync_verify */
function commit(command, data) {
	if (!command.match(/(?:^|[;&|])\s*git\s+commit\b/)) return null;
	const cwd = (data && data.cwd) || process.cwd();
	const progressDir = path.join(cwd, ".agents", "progress");
	if (!fs.existsSync(progressDir)) return null;
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
	if (!latestFile) return null;
	let progress;
	try {
		progress = JSON.parse(fs.readFileSync(latestFile, "utf8"));
	} catch {
		return null;
	}
	if (progress.issue_url) {
		const issueRepoMatch = progress.issue_url.match(/github\.com\/([^/]+\/[^/]+)\/issues/);
		if (issueRepoMatch) {
			try {
				const { execSync } = require("child_process");
				const remoteUrl = execSync("git remote get-url origin", { cwd, encoding: "utf8" }).trim();
				const remoteMatch = remoteUrl.match(/[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
				if (remoteMatch && remoteMatch[1] !== issueRepoMatch[1]) return null;
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
}

const MARKER_PATH = path.join(".claude", "git-push-approved.marker");
function checkAndConsumeApproval() {
	try {
		if (!fs.existsSync(MARKER_PATH)) return false;
		const raw = fs.readFileSync(MARKER_PATH, "utf8");
		const marker = JSON.parse(raw);
		const now = Date.now();
		if (!marker.expiresAt || marker.expiresAt < now) {
			try { fs.unlinkSync(MARKER_PATH); } catch {}
			return false;
		}
		const uses = typeof marker.uses === "number" ? marker.uses : 1;
		if (uses <= 0) {
			try { fs.unlinkSync(MARKER_PATH); } catch {}
			return false;
		}
		const remaining = uses - 1;
		if (remaining <= 0) {
			try { fs.unlinkSync(MARKER_PATH); } catch {}
		} else {
			marker.uses = remaining;
			fs.writeFileSync(MARKER_PATH, JSON.stringify(marker));
		}
		return true;
	} catch {
		return false;
	}
}

/** git-push-guard — block git push (force = extra), marker bypass */
function gitPush(command) {
	const stripped = core.stripQuotesBlank(command);
	if (/^\s*(echo|printf)\s/.test(stripped) && !stripped.includes("|")) return null;
	if (!stripped.match(/(?:^|[;&|()$`])\s*git\s+push\b/m)) return null;
	const isForce = /git\s+push\s+.*(?:--force|-f)\b/.test(command);
	const pushArgs = command.match(/git\s+push\s+(.*)/);
	let remote = "", branch = "";
	if (pushArgs) {
		const args = pushArgs[1].replace(/--[a-z-]+(=\S+)?/g, "").replace(/-[a-zA-Z]\s*/g, "").trim().split(/\s+/).filter(Boolean);
		if (args.length >= 1) remote = args[0];
		if (args.length >= 2) branch = args[1];
	}
	const remoteLabel = remote || "(default)";
	const branchLabel = branch || "(current branch)";
	if (checkAndConsumeApproval()) {
		if (isForce) {
			return { reason: `[Harness] ⚠️ FORCE PUSH는 일괄 승인 불가\n리모트: ${remoteLabel}, 브랜치: ${branchLabel}\n\nForce push는 매번 명시적 승인이 필요합니다.` };
		}
		return null;
	}
	if (isForce) {
		return { reason: `[Harness] ⚠️ FORCE PUSH 차단\n리모트: ${remoteLabel}, 브랜치: ${branchLabel}\n\nForce push는 원격 히스토리를 덮어씁니다. 되돌릴 수 없습니다.\n사용자에게 확인받으세요.` };
	}
	return { reason: `[Harness] git push 차단: 사용자 확인 필요\n리모트: ${remoteLabel}, 브랜치: ${branchLabel}\n명령: \`${command.trim().substring(0, 120)}\`\n\n원격 저장소에 push 전 사용자 확인이 필요합니다.\n\n사용자가 승인한 경우 다음 마커 파일 생성 후 재시도:\n  .claude/git-push-approved.marker\n  내용: { "expiresAt": <ms>, "uses": <n> }` };
}

/** email-send-guard */
function emailSend(command) {
	const cmd = core.stripQuotesCollapse(command);
	if (/send\.js\s+preview/.test(cmd)) return null;
	if (/send\.js\s+test/.test(cmd) && !/send\.js\s+send/.test(cmd)) return null;
	if (/send\.js\s+send\s+.*--test-only/.test(cmd)) return null;
	if (/send-cloud\.js\s+test/.test(cmd)) return null;
	if (/send-cloud\.js\s+preview/.test(cmd)) return null;
	if (/send-cloud\.js\s+send\s+.*--test-only/.test(cmd)) return null;
	if (/press-release-test/.test(cmd) && !/press-release-send/.test(cmd)) return null;
	if (/gcloud.*(?:describe|logs|list)/.test(cmd)) return null;
	if (/gcloud.*scheduler.*(?:pause|delete|describe)/.test(cmd)) return null;
	if (/check-replies\.js/.test(cmd)) return null;
	const SEND_PATTERNS = [
		{ pattern: /send\.js\s+send/, label: "send.js send (실제 기자 발송)" },
		{ pattern: /send-cloud\.js\s+send/, label: "send-cloud.js send (클라우드 발송)" },
		{ pattern: /gcloud\s+run\s+jobs\s+execute\s+press-release-send/, label: "Cloud Run Job 실행 (실제 발송)" },
		{ pattern: /gcloud\s+scheduler\s+jobs\s+(?:create|run|resume)\s+press-release/, label: "Cloud Scheduler 생성/실행 (예약 발송)" },
	];
	for (const p of SEND_PATTERNS) {
		if (p.pattern.test(cmd)) {
			return {
				reason:
					`[Harness] 외부 이메일 발송 차단: \`${p.label}\`\n\n` +
					"외부 수신자에게 이메일을 발송하려면 사용자의 명시적 승인이 필요합니다.\n\n" +
					"허용된 명령:\n" +
					"  - node send.js test (luke.yang@nextain.io로 테스트)\n" +
					"  - node send.js preview (수신자 목록 확인)\n" +
					"  - gcloud run jobs execute press-release-test (클라우드 테스트)\n\n" +
					"실제 발송은 사용자가 직접 터미널에서 실행하거나,\n" +
					"사용자가 '발송해' '보내' 등 명시적으로 지시한 경우에만 진행하세요.",
			};
		}
	}
	return null;
}

const PR_FAIL_REASON =
	"[Guard] pr-guard 내부 오류 — 안전을 위해 GitHub 쓰기 차단.\n" +
	"명령을 직접 실행하거나 Luke에게 확인 요청하세요.";

function findExternalUpstream(cwd) {
	try {
		const { execSync } = require("child_process");
		const out = execSync("git remote -v", { cwd, timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }).toString();
		const lines = out.split("\n").filter(Boolean);
		for (const line of lines) {
			const m = line.match(/\t([^\s]+)/);
			if (!m) continue;
			const url = m[1];
			if (url.includes("github.com") && !url.includes("github.com/nextain/")) return url;
		}
	} catch {
		// git not available or not a repo — safe to ignore
	}
	return null;
}

/** pr-guard — block GitHub writes to non-nextain repos (fail-closed via adapter) */
function prGuard(command, data) {
	const cwd = (data && data.cwd) || process.cwd();
	const WRITE_KEYWORDS = [
		"gh issue create", "gh issue comment", "gh issue edit",
		"gh pr create", "gh pr comment", "gh pr reopen", "gh pr edit",
		"gh pr review", "gh pr merge", "gh release create",
	];
	if (!WRITE_KEYWORDS.some((kw) => command.includes(kw))) return null;
	const repoMatch = command.match(/--repo\s+([^\s'"]+)/);
	if (repoMatch) {
		const repo = repoMatch[1];
		if (repo.startsWith("nextain/")) return null;
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
}

module.exports = { destructiveGit, commit, gitPush, emailSend, prGuard, PR_FAIL_REASON };
