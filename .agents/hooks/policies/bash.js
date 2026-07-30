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
 * is stateless: routine non-force, non-deleting pushes pass; force variants
 * and remote-ref deletion block.
 * pr/commit use data.cwd + execSync (host-neutral node) → move-safe.
 */
const path = require("path");
const fs = require("fs");
const core = require(path.join(__dirname, "..", "core", "harness-core.js"));

/** destructive-git-guard */
function destructiveGit(command) {
	const stripped = core.stripQuotesBlank(command);
	if (/^\s*(echo|printf)\s/.test(stripped) && !stripped.includes("|")) return null;
	const destructiveCommands = [
		{ args: gitCommandArgs(command, "checkout"), check: (args) => args.includes("--"), label: "git checkout -- <file>" },
		{ args: gitCommandArgs(command, "reset"), check: (args) => args.includes("--hard"), label: "git reset --hard" },
		{ args: gitCommandArgs(command, "clean"), check: (args) => args.some((arg) => /^-[A-Za-z]*f[A-Za-z]*$/.test(arg)), label: "git clean -f" },
	];
	for (const { args, check, label } of destructiveCommands) {
		if (args && check(args)) {
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

function gitCommandArgs(command, subcommand) {
	const normalized = core.stripQuotesUnwrap(command);
	const optionWithValue = new Set(["-c", "-C", "--config-env", "--git-dir", "--work-tree", "--namespace"]);
	const optionWithoutValue = new Set([
		"-p", "--paginate", "-P", "--no-pager", "--bare", "--no-replace-objects",
		"--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs",
	]);
	for (const segment of normalized.split(/[;&|\r\n]+/)) {
		const tokens = segment.trim().split(/\s+/).filter(Boolean);
		for (let i = 0; i < tokens.length; i++) {
			if (!/(?:^|[\\/])git(?:\.exe)?$/i.test(tokens[i])) continue;
			let j = i + 1;
			while (j < tokens.length) {
				const token = tokens[j];
				if (optionWithValue.has(token)) { j += 2; continue; }
				if (optionWithoutValue.has(token) || /^--(?:config-env|git-dir|work-tree|namespace)=\S+$/.test(token)) { j += 1; continue; }
				break;
			}
			if (tokens[j] === subcommand) return tokens.slice(j + 1);
		}
	}
	return null;
}

/** git-push-guard — allow routine push; block remote deletion/history rewriting */
function gitPush(command) {
	const stripped = core.stripQuotesBlank(command);
	if (/^\s*(echo|printf)\s/.test(stripped) && !stripped.includes("|")) return null;
	const args = gitCommandArgs(command, "push");
	if (!args) return null;
	const pushClause = ` ${args.join(" ")}`;
	const isRemoteRefDelete = /(?:^|\s)--delete(?:=|\s|$)/.test(pushClause)
		|| /(?:^|\s)-d(?:\s|$)/.test(pushClause)
		|| /(?:^|\s)--(?:mirror|prune)(?:\s|$)/.test(pushClause)
		|| /(?:^|\s)["']?:(?:refs\/(?:heads|tags)\/)?[^\s"';&|]+/.test(pushClause);
	const isForce = /(?:^|\s)--force(?:-with-lease|-if-includes)?(?:=\S+)?(?:\s|$)/.test(pushClause)
		|| /(?:^|\s)-(?!-)[A-Za-z]*f[A-Za-z]*(?:\s|$)/.test(pushClause)
		|| /(?:^|\s)\+\S+/.test(pushClause);
	if (!isRemoteRefDelete && !isForce) return null;
	let remote = "", branch = "";
	const positional = args.filter((arg) => !/^--?[A-Za-z]/.test(arg));
	if (positional.length >= 1) remote = positional[0];
	if (positional.length >= 2) branch = positional[1];
	const remoteLabel = remote || "(default)";
	const branchLabel = branch || "(current branch)";
	if (isRemoteRefDelete) {
		return { reason: `[Harness] ⚠️ REMOTE REF DELETE 차단\n리모트: ${remoteLabel}, 대상: ${branchLabel}\n\n원격 브랜치나 태그 삭제는 되돌리기 어려운 변경입니다.\n사용자에게 명시적으로 확인받으세요.` };
	}
	return { reason: `[Harness] ⚠️ FORCE PUSH 차단\n리모트: ${remoteLabel}, 브랜치: ${branchLabel}\n\nForce push는 원격 히스토리를 덮어씁니다. 되돌리기 어려울 수 있습니다.\n사용자에게 명시적으로 확인받으세요.` };
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

const PROD_PATTERNS = [
	{ pattern: /\bvercel\b.*(?:--prod|--production)\b/, platform: "vercel", label: "vercel --prod" },
	{ pattern: /\bgcloud\s+run\s+deploy\s+(\S+)/, platform: "gcloud", label: "gcloud run deploy", serviceGroup: 1 },
	{ pattern: /\bgcloud\s+app\s+deploy\b/, platform: "gcloud", label: "gcloud app deploy" },
	{ pattern: /\bgcloud\s+builds?\s+submit\b/, platform: "gcloud", label: "gcloud builds submit", alwaysBlock: true },
	{ pattern: /\bgcloud\s+run\s+services?\s+update\s+(\S+)/, platform: "gcloud", label: "gcloud run services update", serviceGroup: 1 },
	{ pattern: /\bgcloud\s+run\s+services?\s+replace\b/, platform: "gcloud", label: "gcloud run services replace" },
	{ pattern: /\bdocker\s+push\s+\S*(?:pkg\.dev|gcr\.io)\b/, platform: "gcloud", label: "docker push (registry)" },
];

/**
 * deploy-guard — block prod deploy unless approved.
 * @param opts.deployDir REQUIRED — host config dir (adapter passes
 *   path.resolve(its __dirname,"..","deploy"); byte-identical to original
 *   __dirname-based DEPLOY_DIR which this module cannot resolve itself).
 */
function deploy(command, data, opts) {
	const DEPLOY_DIR = opts.deployDir;
	const CONFIG_PATH = path.join(DEPLOY_DIR, "config.json");
	const APPROVALS_PATH = path.join(DEPLOY_DIR, "approvals.json");
	const AUDIT_PATH = path.join(DEPLOY_DIR, "audit.jsonl");
	const loadJSON = (fp, fb) => { try { return JSON.parse(fs.readFileSync(fp, "utf8")); } catch { return fb; } };
	const appendAudit = (entry) => {
		try { entry.ts = new Date().toISOString(); fs.appendFileSync(AUDIT_PATH, JSON.stringify(entry) + "\n"); } catch {}
	};
	const detectProject = (cmd, config, cwd) => {
		for (const [name, proj] of Object.entries(config.projects || {})) {
			if (proj.platform === "vercel" && /\bvercel\b/.test(cmd)) {
				if (/(?:--prod|--production)\b/.test(cmd)) { if (cwd.includes(proj.cwd)) return name; }
			}
			if (proj.platform === "gcloud" && /\bgcloud\s+run\s+deploy\b/.test(cmd)) {
				const sm = cmd.match(/gcloud\s+run\s+deploy\s+(\S+)/);
				if (sm) {
					const service = sm[1];
					if (name === service || proj.prod_command?.includes(service)) {
						if (proj.dev_service && service === proj.dev_service) continue;
						return name;
					}
				}
			}
		}
		if (/\bvercel\b/.test(cmd) && /(?:--prod|--production)\b/.test(cmd)) {
			for (const [name, proj] of Object.entries(config.projects || {})) {
				if (proj.platform === "vercel" && cwd.includes(proj.cwd)) return name;
			}
		}
		return null;
	};
	const findApproval = (project) => {
		const approvals = loadJSON(APPROVALS_PATH, { approvals: [] });
		const now = new Date();
		for (const a of approvals.approvals || []) {
			if (a.project !== project) continue;
			if (new Date(a.expires_at) > now) return a;
		}
		return null;
	};
	const consumeApproval = (project, approvedAt) => {
		try {
			const raw = fs.readFileSync(APPROVALS_PATH, "utf8");
			const approvals = JSON.parse(raw);
			const before = approvals.approvals.length;
			approvals.approvals = approvals.approvals.filter(
				(a) => !(a.project === project && a.approved_at === approvedAt && a.single_use));
			if (approvals.approvals.length < before) fs.writeFileSync(APPROVALS_PATH, JSON.stringify(approvals, null, 2));
		} catch {}
	};

	const stripped = core.stripQuotesUnwrap(command);
	if (/^\s*(echo|printf)\s/.test(stripped) && !stripped.includes("|")) return null;
	let matchedPattern = null;
	for (const p of PROD_PATTERNS) { if (p.pattern.test(stripped)) { matchedPattern = p; break; } }
	if (!matchedPattern) return null;
	if (matchedPattern.platform === "gcloud" && matchedPattern.serviceGroup && !matchedPattern.alwaysBlock) {
		const sm = stripped.match(matchedPattern.pattern);
		if (sm) {
			const service = sm[matchedPattern.serviceGroup];
			const config = loadJSON(CONFIG_PATH, { projects: {} });
			for (const proj of Object.values(config.projects || {})) {
				if (proj.dev_service === service || service.endsWith("-dev")) return null;
			}
		}
	}
	const config = loadJSON(CONFIG_PATH, { projects: {} });
	const cwd = (data && data.cwd) || process.cwd();
	const project = detectProject(stripped, config, cwd);
	const sessionId = (data && data.session_id) || "unknown";
	const approval = findApproval(project);
	if (approval) {
		appendAudit({
			event: "executed", project: project || "unknown", session: sessionId,
			command: stripped.substring(0, 200), original_command: command.substring(0, 200),
			approved_by: approval.approved_by, approval_expires: approval.expires_at,
		});
		if (approval.single_use) {
			consumeApproval(project, approval.approved_at);
			appendAudit({ event: "approval_consumed", project: project || "unknown", single_use: true });
		}
		return null;
	}
	appendAudit({
		event: "blocked", project: project || "unknown",
		command: stripped.substring(0, 200), session: sessionId,
		reason: project ? "no_approval" : "unknown_project",
	});
	const projectLabel = project || "(project not detected from cwd)";
	const remainingMin = config.default_ttl_minutes || 30;
	return {
		reason:
			`[Harness] prod 배포 명령 차단: \`${matchedPattern.label}\`\n` +
			`프로젝트: ${projectLabel}\n\n` +
			"prod 배포는 사전 승인이 필요합니다.\n\n" +
			"승인 방법:\n" +
			`  1. .claude/deploy/approvals.json에 "${project || "project"}" 승인 항목 추가\n` +
			`  2. 또는 .claude/deploy/prod-deploy.sh 사용\n\n` +
			`승인 TTL: ${remainingMin}분\n` +
			"AI는 prod 배포를 직접 실행하지 않습니다.",
	};
}

module.exports = { destructiveGit, commit, gitPush, emailSend, prGuard, deploy, PR_FAIL_REASON };
