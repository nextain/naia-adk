"use strict";
const path=require("node:path"),fs=require("node:fs"),os=require("node:os");
const {spawnSync}=require("node:child_process");
const core=require("../core/harness-core.js");
const {checkDetachedWorkerCommand}=require("../../../.claude/hooks/lib/effective-argv.js");
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
					"  - node send.js test (TEST_RECIPIENT 로 테스트 — 미지정 시 발신 계정)\n" +
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
	"명령을 직접 실행하거나 저장소 메인테이너에게 확인 요청하세요.";

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
	// Branch-protection bypass: `gh pr merge --admin` (flag position free, `--admin=true` too) and
	// the REST merge endpoint (`gh api -X PUT .../pulls/N/merge`) skip the protection a PR merge must respect.
	const flat = core.stripQuotesCollapse(command).replace(/\\\n/g, " ");
	for (const clause of flat.split(/&&|\|\||;|\||\n/)) {
		if ((/\bgh\b[^\n]*\bpr\s+merge\b/.test(clause) && /(?:^|\s)--admin(?:=\S*)?(?:\s|$)/.test(clause))
			|| (/\bgh\s+api\b/.test(clause) && /\/pulls\/\d+\/merge\b/.test(clause))) {
			return { reason: "[Guard] 관리자 우회 병합 차단 (gh pr merge --admin / gh api .../merge)\n보호 가지의 필수 검사·리뷰를 건너뛰는 병합입니다. --admin 없이 병합하거나 저장소 메인테이너가 직접 실행하세요." };
		}
	}
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
				"nextain/* 외의 repo 대상 쓰기 작업은 저장소 메인테이너의 명시적 승인이 필요합니다.\n" +
				"승인 후 직접 실행하거나 이 세션에서 명시적으로 승인을 요청하세요.",
		};
	}
	const externalRemote = findExternalUpstream(cwd);
	if (externalRemote) {
		return {
			reason:
				`[Guard] GitHub 쓰기 차단 — --repo 미지정 + 외부 upstream 감지\n` +
				`CWD(${cwd})에 외부 remote가 있습니다: ${externalRemote}\n` +
				"--repo nextain/<repo> 를 명시하거나 저장소 메인테이너의 승인 후 직접 실행하세요.",
		};
	}
	return {
		reason:
			"[Guard] GitHub 쓰기 차단 (--repo 미지정)\n" +
			"대상 repo를 확인할 수 없습니다. --repo nextain/<repo> 를 명시하거나 " +
			"저장소 메인테이너의 승인 후 직접 실행하세요.",
	};
}

/**
 * catastrophicDelete — block a recursive force delete aimed at a root-like target.
 *
 * Deliberately narrow. An earlier measured attempt keyed on "target outside the
 * workspace" and blocked a model cleaning up its own `/tmp` scratch files, which is
 * ordinary work; a guard that fires on ordinary work gets switched off and then
 * protects nothing. So this only fires on targets whose loss is unrecoverable:
 * filesystem root, the home directory itself, and `--no-preserve-root`.
 * Everything else — including `/tmp/...`, workspace paths, and relative paths — passes.
 */
function catastrophicDelete(command) {
	const stripped = core.stripQuotesBlank(command);
	if (/^\s*(echo|printf)\s/.test(stripped) && !stripped.includes("|")) return null;
	const home = (process.env.HOME || "").replace(/\/+$/, "");
	// Split only on statement separators. A pipe is overwhelmingly ordinary usage
	// (`... | xargs rm`) and splitting on it produced false positives.
	for (const segment of stripped.split(/&&|\|\||;|\n/)) {
		const match = segment.match(/(?:^|\s)rm(\s+.*)?$/);
		if (!match) continue;
		const args = (match[1] || "").trim().split(/\s+/).filter(Boolean);
		const flags = args.filter((a) => a.startsWith("-"));
		const recursive = flags.some((f) => /^--recursive$/.test(f) || /^-[A-Za-z]*[rR][A-Za-z]*$/.test(f));
		const forced = flags.some((f) => /^--force$/.test(f) || /^-[A-Za-z]*f[A-Za-z]*$/.test(f));
		if (!recursive) continue;
		if (flags.some((f) => f === "--no-preserve-root")) {
			return { reason: rootDeleteReason("--no-preserve-root") };
		}
		if (!forced) continue;
		for (const target of args.filter((a) => !a.startsWith("-"))) {
			// Trim trailing slashes, but "/" must not collapse to an empty string.
			const normalized = target.replace(/\/+$/, "") || (target.startsWith("/") ? "/" : target);
			const expanded = normalized.replace(/^(~|\$HOME|\$\{HOME\})/, home || "~");
			const rootLike =
				normalized === "/" ||
				normalized === "/*" ||
				/^(~|\$HOME|\$\{HOME\})$/.test(normalized) ||
				/^(~|\$HOME|\$\{HOME\})\/\*$/.test(normalized) ||
				(home && (expanded === home || expanded === `${home}/*`));
			if (rootLike) return { reason: rootDeleteReason(target) };
		}
	}
	return null;
}

function rootDeleteReason(target) {
	return (
		`[Harness] 복구 불가능한 삭제 차단: \`rm -rf ${target}\`\n` +
		"이 대상은 시스템 루트 또는 홈 디렉터리 자체입니다. 되돌릴 수 없습니다.\n" +
		"지우려는 것이 특정 하위 경로라면 그 경로를 명시하세요."
	);
}

/**
 * detached-worker-guard — block detached/asynchronous launches of worker CLIs
 * (agy, codex, claude -p/--print, muse exec, opencode run, etc.) outside the two
 * sanctioned entrypoints (scripts/worker-runner/spawn-worker.mjs and configured
 * server standard adapter script path).
 */
function detachedWorker(command, data, opts) {
	const cwd = (data && data.cwd) || (opts && opts.cwd) || process.cwd();
	const hit = checkDetachedWorkerCommand(command, {
		...(opts || {}),
		cwd,
		env: (opts && opts.env) || process.env,
	});
	if (!hit) return null;
	return { reason: hit.reason };
}


module.exports={emailSend,prGuard,catastrophicDelete,detachedWorker,PR_FAIL_REASON};
