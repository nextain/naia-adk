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
const os = require("os");
const { spawnSync } = require("child_process");
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
	const cwd = (data && data.cwd) || process.cwd();
	const commitInvocations = extractGitCommitInvocations(command, cwd).filter(
		(inv) => inv.subcommand === "commit",
	);
	if (commitInvocations.length === 0) return null;
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

const PROD_PATTERNS = [
	{ pattern: /\bvercel\b.*(?:--prod|--production)\b/, platform: "vercel", label: "vercel --prod" },
	{ pattern: /\bgcloud(?:\s+(?:alpha|beta|preview|--[a-z0-9-]+(?:=\S+|\s+\S+)?|-q))*\s+run\s+deploy\s+(\S+)/, platform: "gcloud", label: "gcloud run deploy", serviceGroup: 1 },
	{ pattern: /\bgcloud(?:\s+(?:alpha|beta|preview|--[a-z0-9-]+(?:=\S+|\s+\S+)?|-q))*\s+app\s+deploy\b/, platform: "gcloud", label: "gcloud app deploy" },
	{ pattern: /\bgcloud(?:\s+(?:alpha|beta|preview|--[a-z0-9-]+(?:=\S+|\s+\S+)?|-q))*\s+builds?\s+submit\b/, platform: "gcloud", label: "gcloud builds submit", alwaysBlock: true },
	{ pattern: /\bgcloud(?:\s+(?:alpha|beta|preview|--[a-z0-9-]+(?:=\S+|\s+\S+)?|-q))*\s+run\s+services?\s+update\s+(\S+)/, platform: "gcloud", label: "gcloud run services update", serviceGroup: 1 },
	{ pattern: /\bgcloud(?:\s+(?:alpha|beta|preview|--[a-z0-9-]+(?:=\S+|\s+\S+)?|-q))*\s+run\s+services?\s+replace\b/, platform: "gcloud", label: "gcloud run services replace", alwaysBlock: true },
	{ pattern: /\bdocker(?:\s+(?:--?[a-zA-Z0-9-]+(?:=\S+|\s+\S+)?))*\s+(?:image\s+)?push\s+\S*(?:pkg\.dev|gcr\.io)\b/, platform: "gcloud", label: "docker push (registry)" },
];

function findApprovalGateRoot(cwd, deployDir) {
	if (process.env.DEPLOY_READINESS_ROOT) return path.resolve(process.env.DEPLOY_READINESS_ROOT);
	const candidates = [];
	if (cwd) {
		candidates.push(path.resolve(cwd));
		let cur = path.resolve(cwd);
		for (;;) {
			if (fs.existsSync(path.join(cur, ".agents", "progress")) || fs.existsSync(path.join(cur, "config", "deploy-gate.json")) || fs.existsSync(path.join(cur, ".git"))) {
				if (!candidates.includes(cur)) candidates.push(cur);
			}
			const parent = path.dirname(cur);
			if (parent === cur) break;
			cur = parent;
		}
	}
	if (deployDir) candidates.push(path.resolve(deployDir, "..", ".."));
	for (const c of candidates) {
		if (fs.existsSync(path.join(c, "config", "deploy-gate.json")) || hasAnyDeployPlan(c)) return c;
	}
	return candidates[0] || path.resolve(__dirname, "..", "..", "..");
}

function hasAnyDeployPlan(root) {
	try {
		const base = path.join(root, ".agents", "progress");
		const dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("_"));
		return dirs.some((d) => fs.existsSync(path.join(base, d.name, "gates", "deploy-plan.json")));
	} catch {
		return false;
	}
}

function hasApprovalPlanGate(root) {
	if (!root) return false;
	return (
		fs.existsSync(path.join(root, "config", "deploy-gate.json")) ||
		fs.existsSync(path.join(root, ".agents", "scripts", "approval-plan.mjs")) ||
		hasAnyDeployPlan(root)
	);
}

/**
 * deploy-guard — block prod deploy unless approved via approval-plan gate
 * (계획서 → 적대 리뷰 → 관문 발급 승인 코드 → 실행 때 바이트·고정 파일 sha 대조).
 * @param opts.deployDir REQUIRED — host config dir (adapter passes
 *   path.resolve(its __dirname,"..","deploy")).
 */
async function deploy(command, data, opts) {
	const DEPLOY_DIR = (opts && opts.deployDir) || path.resolve(__dirname, "..", "..", "..", ".claude", "deploy");
	const CONFIG_PATH = path.join(DEPLOY_DIR, "config.json");
	const APPROVALS_PATH = path.join(DEPLOY_DIR, "approvals.json");
	const AUDIT_PATH = process.env.DEPLOY_AUDIT_PATH || path.join(DEPLOY_DIR, "audit.jsonl");
	const loadJSON = (fp, fb) => { try { return JSON.parse(fs.readFileSync(fp, "utf8")); } catch { return fb; } };
	const appendAudit = (entry) => {
		try {
			fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
			entry.ts = new Date().toISOString();
			fs.appendFileSync(AUDIT_PATH, JSON.stringify(entry) + "\n");
		} catch {}
	};
	const detectProject = (cmd, config, cwd) => {
		for (const [name, proj] of Object.entries(config.projects || {})) {
			if (proj.platform === "vercel" && /\bvercel\b/.test(cmd)) {
				if (/(?:--prod|--production)\b/.test(cmd)) { if (cwd.includes(proj.cwd)) return name; }
			}
			if (proj.platform === "gcloud" && /\bgcloud\b.*\brun\s+(?:deploy|services?\s+update)\b/.test(cmd)) {
				const sm = cmd.match(/\brun\s+(?:deploy|services?\s+update)\s+(\S+)/);
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

	const cwd = (data && data.cwd) || process.cwd();
	const sessionId = (data && data.session_id) || "unknown";
	const root = (opts && opts.rootDir) ? path.resolve(opts.rootDir) : findApprovalGateRoot(cwd, DEPLOY_DIR);
	const config = loadJSON(CONFIG_PATH, { projects: {} });
	const stripped = core.stripQuotesUnwrap(command);
	if (/^\s*(echo|printf)\s/.test(stripped) && !stripped.includes("|") && !/[;&\n]/.test(stripped)) return null;

	const hooksLibDir = path.resolve(__dirname, "..", "..", "..", ".claude", "hooks", "lib");
	const { shellClauses } = require(path.join(hooksLibDir, "git-command-parser.js"));
	const { classifyProdMutations, clauseText, executedShellFile, SCRIPT_READ_LIMIT } = require(path.join(hooksLibDir, "deploy-command-classifier.js"));
	const { effectiveCommands } = require(path.join(hooksLibDir, "effective-argv.js"));
	const { assessReadiness, loadDeployGateConfig, TEMPLATE: READINESS_TEMPLATE } = require(path.join(hooksLibDir, "deploy-readiness.js"));
	const deployPlan = require(path.join(hooksLibDir, "deploy-plan.js"));

	// Legacy .claude/deploy/config.json dev_service exemption (per clause only)
	const isLegacyDevService = (service) => {
		if (!service) return false;
		const s = String(service).toLowerCase();
		if (s.endsWith("-dev")) return true;
		for (const proj of Object.values(config.projects || {})) {
			if (proj.dev_service && String(proj.dev_service).toLowerCase() === s) return true;
		}
		return false;
	};
	const matchLegacyClause = (rawClause) => {
		const subClauses = shellClauses(core.stripQuotesUnwrap(rawClause));
		const list = subClauses.length
			? subClauses.map((t) => t.join(" ").replace(/'([^']*)'/g, "$1").replace(/"([^"]*)"/g, "$1"))
			: [rawClause];
		for (const sub of list) {
			for (const p of PROD_PATTERNS) {
				const m = sub.match(p.pattern);
				if (!m) continue;
				if (p.platform === "gcloud" && p.serviceGroup && !p.alwaysBlock && isLegacyDevService(m[p.serviceGroup])) {
					continue;
				}
				return { pattern: p, clause: sub };
			}
		}
		return null;
	};

	const useLegacyApprovals =
		fs.existsSync(APPROVALS_PATH) &&
		!process.env.DEPLOY_READINESS_ROOT &&
		!process.env.DEPLOY_APPROVAL_STATE_DIR &&
		!hasApprovalPlanGate(root);

	const precomputedMutations = classifyProdMutations(command, cwd, 0, false, root).filter((hit) => {
		if (hit && typeof hit.service === "string" && hit.service.startsWith("gcloud:run:")) {
			const svcName = hit.service.slice("gcloud:run:".length);
			if (svcName !== "replace" && isLegacyDevService(svcName)) return false;
		}
		return true;
	});
	const clauses = shellClauses(command);
	const nonDevLegacyMatches = [];
	for (const tokens of clauses) {
		if (tokens.length === 0 || /^(?:echo|printf)$/.test(tokens[0])) continue;
		const rawClause = tokens.join(" ").replace(/'([^']*)'/g, "$1").replace(/"([^"]*)"/g, "$1");
		const matched = matchLegacyClause(rawClause);
		if (matched) nonDevLegacyMatches.push({ ...matched, tokens });
	}

	const isLegacyCoveredMutation = (hit) => {
		if (!hit || hit.unclassified || typeof hit.service !== "string") return false;
		return (
			hit.service === "vercel:prod" ||
			hit.service === "gcloud:app:default" ||
			hit.service === "gcloud:builds:submit" ||
			hit.service.startsWith("gcloud:run:")
		);
	};
	const onlyLegacyMutations =
		precomputedMutations.length === 0 ||
		(nonDevLegacyMatches.length > 0 && precomputedMutations.every(isLegacyCoveredMutation));

	if (useLegacyApprovals && onlyLegacyMutations) {
		const firstLegacy = nonDevLegacyMatches[0];
		const matchedPattern = firstLegacy ? firstLegacy.pattern : null;
		if (matchedPattern) {
			const project = detectProject(firstLegacy.clause, config, cwd);
			const approval = !matchedPattern.alwaysBlock ? findApproval(project) : null;
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
		return null;
	}

	const hits = [];
	for (const hit of precomputedMutations) hits.push(hit);
	for (const { pattern: p, clause, tokens } of nonDevLegacyMatches) {
		if (
			hits.length > 0 &&
			[
				"vercel --prod",
				"gcloud run deploy",
				"gcloud app deploy",
				"gcloud builds submit",
				"gcloud run services update",
				"gcloud run services replace",
			].includes(p.label)
		) {
			continue;
		}
		const project = detectProject(clause, config, cwd);
		hits.push({ service: `legacy:${project || p.label}`, label: p.label, project, clause: clauseText(tokens) });
	}

	const unclassified = hits.filter((hit) => hit.unclassified);
	if (unclassified.length) {
		appendAudit({
			event: "blocked-unclassified",
			services: [...new Set(unclassified.map((hit) => hit.service))],
			session: sessionId,
			command: command.substring(0, 300),
			items: unclassified.map(({ service, label, clause, file }) => ({ service, label, clause, file: file || null })),
		});
		const lines = ["[Harness] 운영 도구가 보이지만 대상을 분류하지 못해 차단합니다."];
		for (const hit of unclassified.slice(0, 10)) {
			lines.push(`서비스: ${hit.service}`, `분류: ${hit.label}`, `절: ${hit.clause || "(원래 절을 확인할 수 없음)"}`, `스크립트 파일: ${hit.file || "(스크립트 파일 없음)"}`);
		}
		lines.push("", "대상을 글자 그대로 적거나 감싸기 인자를 고정하십시오.");
		return { reason: lines.join("\n") };
	}

	const seen = new Set();
	const unique = hits.filter((h) => (seen.has(h.service) ? false : seen.add(h.service)));
	if (unique.length === 0) {
		let matches = [];
		try {
			matches = deployPlan.plansForCommand(command, root);
			if (matches.length === 0) {
				for (const tokens of clauses) {
					if (!tokens.length || /^(?:echo|printf)$/.test(tokens[0])) continue;
					matches.push(...deployPlan.plansForCommand(clauseText(tokens), root));
				}
			}
		} catch { matches = []; }
		for (const m of matches) {
			const svc = Array.isArray(m.plan && m.plan.services) && m.plan.services.length ? m.plan.services : [`plan:${(m.plan && m.plan.planId) || "unknown"}`];
			for (const service of svc) if (!seen.has(service)) { seen.add(service); unique.push({ service, label: "계획서 단계 명령", clause: command.substring(0, 200) }); }
		}
	}

	const opaque = effectiveCommands(command, cwd).find((e) => e.opaque);
	if (opaque) {
		appendAudit({ event: "blocked-opaque", session: sessionId, command: command.substring(0, 300), reason: opaque.opaque });
		return {
			reason: [
				`[Harness] 무엇이 실행되는지 확인할 수 없어 막습니다: ${opaque.opaque}`,
				"",
				"셸에 넘기는 프로그램은 파일로 저장한 뒤 bash <파일> 로 실행하거나, 명령에 그대로 적으십시오. 따옴표가 닫히지 않았다면 고쳐서 다시 실행하십시오.",
			].join("\n"),
		};
	}

	const tooLarge = effectiveCommands(command, cwd)
		.map((e) => executedShellFile(e.argv, e.dir, e.dirKnown !== false, command, true))
		.find((f) => {
			if (!f) return false;
			try { return fs.statSync(f).size > SCRIPT_READ_LIMIT; } catch { return false; }
		});
	if (tooLarge) {
		appendAudit({ event: "blocked-opaque", session: sessionId, command: command.substring(0, 300), reason: `script too large: ${tooLarge}` });
		return {
			reason: [
				`[Harness] 무엇이 실행되는지 확인할 수 없어 막습니다: 스크립트가 커서(${SCRIPT_READ_LIMIT / 1024 / 1024}MB 넘음) 안을 읽지 않습니다(${tooLarge})`,
				"",
				"스크립트를 나눠 주십시오. 승인자에게 붙여 넣어 실행할 명령을 넘기지 마십시오(승인 보고 양식으로 승인 요청).",
			].join("\n"),
		};
	}

	if (unique.length === 0) return null;

	const prodServices = unique.map((h) => h.service);
	const runText = [...new Set(hits.map((h) => h.clause).filter(Boolean))].join(" ; ") || command;
	const gateConfigInfo = loadDeployGateConfig(root);
	const gateConfig = (gateConfigInfo && gateConfigInfo.config) || {};
	const res = await deployPlan.evaluate({
		command,
		cwd,
		services: prodServices,
		sessionId,
		transcriptPath: data && data.transcript_path,
		root,
		approverId: (gateConfig.approver && gateConfig.approver.discordUserId) || (config.approver && config.approver.discordUserId),
		readiness: (planBinding) => assessReadiness(prodServices, { root, auditPath: AUDIT_PATH, command: runText, cwd, planBinding }),
		readinessTemplate: READINESS_TEMPLATE,
		fileRefs: () => deployPlan.referencedFiles(command, cwd),
	});
	appendAudit({ ...(res.audit || {}), services: prodServices, session: sessionId, command: command.substring(0, 300) });
	if (res.allow) {
		if (res.notice) process.stderr.write(`${res.notice}\n`);
		return null;
	}
	return { reason: res.reason };
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

const { duplicateCodeFile } = require("./edit.js");

const DEFAULT_ARTIFACT_EXTENSIONS = [
	".nva",
	".exe",
	".msi",
	".dmg",
	".AppImage",
	".apk",
	".vrm",
];

const DEFAULT_ARTIFACT_SCRIPT_DIRS = [
	"naia-labs/avatar",
	"naia-labs/**/service",
	"scripts/build*",
];

const ARTIFACT_DRIFT_MESSAGE =
	"커밋 안 된 대본으로 산출물을 만들 수 없습니다. 공통 코드에 고쳐 가지에 커밋하고 PR 로 올린 뒤 실행하세요.";

function normalizeExtensions(list) {
	if (!Array.isArray(list) || list.length === 0) return null;
	const out = list
		.filter((item) => typeof item === "string" && item.trim().length > 0)
		.map((item) => {
			const trimmed = item.trim();
			return (trimmed.startsWith(".") ? trimmed : `.${trimmed}`).toLowerCase();
		});
	return out.length > 0 ? out : null;
}

function normalizeDirPatterns(list) {
	if (!Array.isArray(list) || list.length === 0) return [];
	return list
		.filter((item) => typeof item === "string" && item.trim().length > 0)
		.map((item) => item.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""))
		.filter(Boolean);
}

function readDriftConfigObjectFromDir(dir) {
	if (!dir) return null;
	const driftJsonPath = path.join(dir, ".agents", "context", "drift-guard.json");
	if (fs.existsSync(driftJsonPath)) {
		try {
			const parsed = JSON.parse(fs.readFileSync(driftJsonPath, "utf8"));
			if (parsed && typeof parsed === "object") return parsed;
		} catch {
			/* ignore malformed json and fall through */
		}
	}
	for (const rulesFile of ["agents-rules.json", "agents-rules-detail.json"]) {
		const rulesPath = path.join(dir, ".agents", "context", rulesFile);
		if (!fs.existsSync(rulesPath)) continue;
		try {
			const parsed = JSON.parse(fs.readFileSync(rulesPath, "utf8"));
			const dg = parsed?.conventions?.drift_guard || parsed?.drift_guard;
			if (dg && typeof dg === "object") return dg;
			if (parsed?.artifact_extensions || parsed?.artifact_script_dirs) return parsed;
		} catch {
			/* ignore */
		}
	}
	return null;
}

function readDriftConfigFromRoot(dir) {
	const cfg = readDriftConfigObjectFromDir(dir);
	if (!cfg) return null;
	return normalizeExtensions(cfg.artifact_extensions);
}

function loadArtifactExtensions(cwd, opts) {
	if (opts && Array.isArray(opts.artifactExtensions)) {
		const custom = normalizeExtensions(opts.artifactExtensions);
		if (custom) return custom;
	}
	let cur = path.resolve(cwd || process.cwd());
	while (cur) {
		const found = readDriftConfigFromRoot(cur);
		if (found) return found;
		const parent = path.dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	const wsRoot = path.resolve(__dirname, "..", "..", "..");
	const wsFound = readDriftConfigFromRoot(wsRoot);
	if (wsFound) return wsFound;
	return DEFAULT_ARTIFACT_EXTENSIONS.map((e) => e.toLowerCase());
}

function loadArtifactScriptDirs(cwd, opts, extraRoots = []) {
	const merged = new Set(normalizeDirPatterns(DEFAULT_ARTIFACT_SCRIPT_DIRS));
	if (opts && Array.isArray(opts.artifactScriptDirs)) {
		for (const p of normalizeDirPatterns(opts.artifactScriptDirs)) merged.add(p);
	}
	const searchDirs = [];
	const pushHierarchy = (startDir) => {
		if (!startDir) return;
		let cur = path.resolve(startDir);
		while (cur) {
			if (!searchDirs.includes(cur)) searchDirs.push(cur);
			const parent = path.dirname(cur);
			if (parent === cur) break;
			cur = parent;
		}
	};
	pushHierarchy(cwd || process.cwd());
	for (const r of extraRoots) pushHierarchy(r);
	const wsRoot = path.resolve(__dirname, "..", "..", "..");
	if (!searchDirs.includes(wsRoot)) searchDirs.push(wsRoot);

	for (const d of searchDirs) {
		const cfg = readDriftConfigObjectFromDir(d);
		if (!cfg) continue;
		const patterns = normalizeDirPatterns(cfg.artifact_script_dirs || cfg.artifact_producer_dirs);
		for (const p of patterns) merged.add(p);
	}
	return [...merged];
}

function matchesArtifactScriptPattern(relPath, pattern) {
	if (!relPath || !pattern) return false;
	const normPath = relPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
	const normPat = pattern.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
	if (!normPath || !normPat) return false;
	if (normPath.startsWith("..")) return false;

	// Convert glob pattern into regex:
	// /**/ matches "/" or "/any/nested/"
	const DOUBLE_STAR_SLASH = "\x00DOUBLE_STAR_SLASH\x00";
	const DOUBLE_STAR = "\x00DOUBLE_STAR\x00";
	const SINGLE_STAR = "\x00SINGLE_STAR\x00";
	const QUESTION = "\x00QUESTION\x00";

	const regexBody = normPat
		.replace(/\/\*\*\//g, DOUBLE_STAR_SLASH)
		.replace(/\*\*/g, DOUBLE_STAR)
		.replace(/\*/g, SINGLE_STAR)
		.replace(/\?/g, QUESTION)
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replaceAll(DOUBLE_STAR_SLASH, "(?:/|/.+/)")
		.replaceAll(DOUBLE_STAR, ".*")
		.replaceAll(SINGLE_STAR, "[^/]*")
		.replaceAll(QUESTION, "[^/]");

	const re = new RegExp(`(?:^|/)${regexBody}(?:/.*|$)`, "i");
	return re.test(normPath);
}

function isArtifactProducerScript(scriptArg, effectiveCwd, checkResult, dirPatterns) {
	if (!Array.isArray(dirPatterns) || dirPatterns.length === 0) return false;
	const candidates = [];
	if (checkResult && checkResult.relPosix) {
		candidates.push(checkResult.relPosix);
	}
	if (checkResult && checkResult.absScript && effectiveCwd) {
		const relToCwd = path.relative(effectiveCwd, checkResult.absScript).replace(/\\/g, "/");
		if (relToCwd && !relToCwd.startsWith("..") && !path.isAbsolute(relToCwd)) {
			candidates.push(relToCwd);
		}
	}
	if (scriptArg && typeof scriptArg === "string") {
		const normArg = scriptArg.replace(/\\/g, "/").replace(/^\.\//, "");
		if (normArg && !normArg.startsWith("/") && !normArg.startsWith("..")) {
			candidates.push(normArg);
		}
	}
	for (const candidate of candidates) {
		for (const pattern of dirPatterns) {
			if (matchesArtifactScriptPattern(candidate, pattern)) {
				return true;
			}
		}
	}
	return false;
}

function splitShellSegments(command) {
	const segments = [];
	let current = "";
	let quote = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			current += ch;
			if (ch === "\\" && quote === '"' && i + 1 < command.length) {
				current += command[++i];
			} else if (ch === quote) {
				quote = null;
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			current += ch + command[++i];
			continue;
		}
		if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|")) {
			segments.push({ text: current, sep: ch + ch });
			current = "";
			i++;
			continue;
		}
		if (ch === ";" || ch === "\n" || ch === "|") {
			segments.push({ text: current, sep: ch });
			current = "";
			continue;
		}
		current += ch;
	}
	if (current.trim().length > 0) segments.push({ text: current, sep: "" });
	return segments;
}

function tokenizeSegment(segmentText) {
	const tokens = [];
	let cur = "";
	let quote = null;
	for (let i = 0; i < segmentText.length; i++) {
		const ch = segmentText[i];
		if (quote) {
			if (ch === "\\" && quote === '"' && i + 1 < segmentText.length) {
				cur += segmentText[++i];
			} else if (ch === quote) {
				quote = null;
			} else {
				cur += ch;
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "\\" && i + 1 < segmentText.length) {
			cur += segmentText[++i];
			continue;
		}
		if (/\s/.test(ch)) {
			if (cur.length > 0) {
				tokens.push(cur);
				cur = "";
			}
			continue;
		}
		cur += ch;
	}
	if (cur.length > 0) tokens.push(cur);
	return tokens;
}

function unwrapGroupingTokens(rawTokens) {
	const tokens = [...rawTokens];
	let openParens = 0;
	let closeParens = 0;

	while (tokens.length > 0) {
		const first = tokens[0];
		if (first === "(" || first === "{") {
			if (first === "(") openParens++;
			tokens.shift();
			continue;
		}
		if (first === ")" || first === "}" || first === ";") {
			if (first === ")") closeParens++;
			tokens.shift();
			continue;
		}
		if (first.startsWith("(")) {
			const m = first.match(/^\(+/);
			if (m) openParens += m[0].length;
			tokens[0] = first.replace(/^\(+/, "");
			if (!tokens[0]) tokens.shift();
			continue;
		}
		if (first.startsWith("{") && first !== "{}" && !first.startsWith("${")) {
			tokens[0] = first.replace(/^\{+/, "");
			if (!tokens[0]) tokens.shift();
			continue;
		}
		break;
	}

	while (tokens.length > 0) {
		const last = tokens[tokens.length - 1];
		if (last === ")" || last === "}" || last === ";") {
			if (last === ")") closeParens++;
			tokens.pop();
			continue;
		}
		if (
			/[;)\}]+$/.test(last) &&
			last !== "{}" &&
			!last.endsWith("{}") &&
			!/\$\{[^}]*\}$/.test(last) &&
			!/\(\d+\)$/.test(last)
		) {
			const parenMatches = last.match(/\)+$/);
			if (parenMatches) closeParens += parenMatches[0].length;
			tokens[tokens.length - 1] = last.replace(/[;)\}]+$/, "");
			if (!tokens[tokens.length - 1]) tokens.pop();
			continue;
		}
		break;
	}

	return { tokens, openParens, closeParens };
}

function expandShellVars(token, varMap) {
	if (!token || typeof token !== "string" || !token.includes("$") || !varMap || varMap.size === 0) {
		return token;
	}
	return token.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, g1, g2) => {
		const key = g1 || g2;
		return varMap.has(key) ? varMap.get(key) : m;
	});
}

function expandHomePath(p) {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	if (!home) return p;
	if (p === "~") return home;
	if (p.startsWith("~/")) return path.join(home, p.slice(2));
	if (p.startsWith("$HOME/")) return path.join(home, p.slice(6));
	if (p.startsWith("${HOME}/")) return path.join(home, p.slice(8));
	return p;
}

function matchArtifactToken(token, artifactExts) {
	if (!token || typeof token !== "string") return null;
	const candidates = [token];
	const eqIdx = token.indexOf("=");
	if (eqIdx >= 0) candidates.push(token.slice(eqIdx + 1));
	const redirMatch = token.match(/^(?:\d*>>?|\&>>?)(.+)$/);
	if (redirMatch) candidates.push(redirMatch[1]);
	for (const part of token.split(/[\s'"()`,;:=<>[\]{}|&]+/)) {
		if (part) candidates.push(part);
	}

	for (const raw of candidates) {
		const cleaned = raw.replace(/^['"]+|['",;)]+$/g, "").trim();
		if (!cleaned) continue;
		const lower = cleaned.toLowerCase();
		for (const ext of artifactExts) {
			if (lower.length > ext.length && lower.endsWith(ext)) {
				return cleaned;
			}
		}
	}
	return null;
}

const PYTHON_BIN_RE = /^(?:python(?:\d+(?:\.\d+)*)?|py|pypy3?)$/i;
const NODE_BIN_RE = /^(?:node|nodejs|tsx|ts-node|bun)$/i;
const SHELL_BIN_RE = /^(?:bash|sh|zsh|dash|ksh)$/i;
const OTHER_SCRIPT_BIN_RE = /^(?:ruby|perl|php|rscript|pwsh|powershell)$/i;
const DIRECT_SCRIPT_EXT_RE = /\.(?:py|sh|bash|zsh|js|mjs|cjs|ts|tsx|rb|pl|ps1)$/i;

const UV_TWO_ARG_FLAGS = new Set([
	"--python",
	"-p",
	"--with",
	"--with-editable",
	"--with-requirements",
	"--directory",
	"--project",
	"--config-file",
	"--index-url",
	"--extra-index-url",
	"--find-links",
	"--package",
	"--env-file",
]);

const NODE_TWO_ARG_FLAGS = new Set([
	"-r",
	"--require",
	"--import",
	"--loader",
	"--experimental-loader",
	"--tsconfig",
	"--env-file",
	"--conditions",
	"-C",
]);

const XARGS_TWO_ARG_FLAGS = new Set([
	"-L",
	"-n",
	"-P",
	"-s",
	"-a",
	"-d",
	"-E",
	"-e",
	"--max-args",
	"--max-procs",
	"--max-chars",
	"--arg-file",
	"--delimiter",
	"--eof",
	"--process-slot-var",
]);

const RSYNC_TWO_ARG_FLAGS = new Set([
	"-e",
	"--rsh",
	"--exclude",
	"--include",
	"--exclude-from",
	"--include-from",
	"--files-from",
	"--log-file",
	"--temp-dir",
	"--backup-dir",
	"--suffix",
	"--compare-dest",
	"--copy-dest",
	"--link-dest",
	"--chmod",
	"--chown",
	"--max-size",
	"--min-size",
	"--bwlimit",
	"--timeout",
	"--port",
]);

function isInterpreterName(base) {
	return (
		PYTHON_BIN_RE.test(base) ||
		NODE_BIN_RE.test(base) ||
		SHELL_BIN_RE.test(base) ||
		OTHER_SCRIPT_BIN_RE.test(base) ||
		base === "deno"
	);
}

function skipLeadingCommandWrappers(tokens, startIdx = 0, context = {}) {
	let idx = startIdx;
	while (idx < tokens.length) {
		const t = tokens[idx];
		if (t === "(" || t === "{" || t === "!" || t === "command" || t === "builtin" || t === "exec") {
			idx++;
			continue;
		}
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
			idx++;
			continue;
		}
		const base = path.basename(t);
		if (base === "env") {
			idx++;
			while (idx < tokens.length) {
				if (tokens[idx] === "--") {
					idx++;
					break;
				}
				if (
					(tokens[idx] === "-u" ||
						tokens[idx] === "--unset" ||
						tokens[idx] === "-C" ||
						tokens[idx] === "--chdir" ||
						tokens[idx] === "-S" ||
						tokens[idx] === "--split-string") &&
					idx + 1 < tokens.length
				) {
					idx += 2;
				} else if (tokens[idx].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) {
					idx++;
				} else {
					break;
				}
			}
			continue;
		}
		if (base === "nohup" || base === "time") {
			idx++;
			while (idx < tokens.length && tokens[idx].startsWith("-")) {
				if (tokens[idx] === "--") {
					idx++;
					break;
				}
				idx++;
			}
			continue;
		}
		if (base === "nice") {
			idx++;
			if ((tokens[idx] === "-n" || tokens[idx] === "--adjustment") && idx + 1 < tokens.length) idx += 2;
			else if (tokens[idx] && tokens[idx].startsWith("-")) idx++;
			continue;
		}
		if (base === "timeout") {
			idx++;
			while (idx < tokens.length && tokens[idx].startsWith("-")) {
				if (
					(tokens[idx] === "-k" ||
						tokens[idx] === "-s" ||
						tokens[idx] === "--kill-after" ||
						tokens[idx] === "--signal") &&
					idx + 1 < tokens.length
				) {
					idx += 2;
				} else {
					idx++;
				}
			}
			if (idx < tokens.length) idx++; // skip duration
			continue;
		}
		if (base === "sudo") {
			idx++;
			while (idx < tokens.length && tokens[idx].startsWith("-")) {
				if (tokens[idx] === "--") {
					idx++;
					break;
				}
				if (
					(tokens[idx] === "-u" ||
						tokens[idx] === "-g" ||
						tokens[idx] === "-C" ||
						tokens[idx] === "-D" ||
						tokens[idx] === "-h" ||
						tokens[idx] === "-p" ||
						tokens[idx] === "-r" ||
						tokens[idx] === "-t" ||
						tokens[idx] === "-T" ||
						tokens[idx] === "-U") &&
					idx + 1 < tokens.length
				) {
					idx += 2;
				} else {
					idx++;
				}
			}
			continue;
		}
		if (base === "xargs") {
			idx++;
			let replacePlaceholder = "{}";
			while (idx < tokens.length && tokens[idx].startsWith("-")) {
				const flag = tokens[idx];
				if (flag === "--") {
					idx++;
					break;
				}
				if (flag === "-I" || flag === "--replace") {
					if (idx + 1 < tokens.length) {
						replacePlaceholder = tokens[idx + 1] || "{}";
						idx += 2;
					} else {
						idx++;
					}
					continue;
				}
				if (flag.startsWith("-I") && flag.length > 2) {
					replacePlaceholder = flag.slice(2);
					idx++;
					continue;
				}
				if (flag.startsWith("--replace=")) {
					replacePlaceholder = flag.slice("--replace=".length) || "{}";
					idx++;
					continue;
				}
				if (XARGS_TWO_ARG_FLAGS.has(flag) && idx + 1 < tokens.length) {
					idx += 2;
					continue;
				}
				idx++;
			}
			context.viaXargs = true;
			context.placeholder = replacePlaceholder;
			continue;
		}
		if (base === "find") {
			let execIdx = -1;
			let findNameCandidate = null;
			const searchPaths = [];
			for (let j = idx + 1; j < tokens.length; j++) {
				const ft = tokens[j];
				if (ft === "-exec" || ft === "-execdir" || ft === "-ok" || ft === "-okdir") {
					execIdx = j;
					break;
				}
				if ((ft === "-name" || ft === "-iname" || ft === "-path" || ft === "-wholename") && j + 1 < tokens.length) {
					findNameCandidate = tokens[j + 1];
					j++;
					continue;
				}
				if (!ft.startsWith("-") && ft !== "!" && ft !== "(" && ft !== ")" && searchPaths.length === 0 && j === idx + 1) {
					searchPaths.push(ft);
				}
			}
			if (execIdx >= 0 && execIdx + 1 < tokens.length) {
				context.viaFindExec = true;
				context.placeholder = "{}";
				if (findNameCandidate) {
					const baseDir = searchPaths[0] && searchPaths[0] !== "." ? searchPaths[0] : "";
					context.findCandidate = baseDir
						? `${baseDir.replace(/\/+$/, "")}/${findNameCandidate}`
						: findNameCandidate;
				}
				while (tokens.length > execIdx + 1) {
					const tail = tokens[tokens.length - 1];
					if (tail === ";" || tail === "\\;" || tail === "+") tokens.pop();
					else break;
				}
				idx = execIdx + 1;
				continue;
			}
		}
		break;
	}
	return idx;
}

function extractFileTransferOp(rawTokens) {
	const tokens = [...rawTokens];
	const idx = skipLeadingCommandWrappers(tokens, 0, {});
	if (idx >= tokens.length) return null;
	const cmdBase = path.basename(tokens[idx]);
	if (
		cmdBase !== "cp" &&
		cmdBase !== "mv" &&
		cmdBase !== "ln" &&
		cmdBase !== "install" &&
		cmdBase !== "rsync"
	) {
		return null;
	}

	let i = idx + 1;
	let targetDir = null;
	let forceNoTargetDir = false;
	const positional = [];
	let endOfFlags = false;

	while (i < tokens.length) {
		const tok = tokens[i];
		if (!endOfFlags && tok === "--") {
			endOfFlags = true;
			i++;
			continue;
		}
		if (/^(?:\d*>>?|\&>>?|\d*<&?\d*)/.test(tok)) {
			i++;
			continue;
		}
		if (!endOfFlags && tok.startsWith("-") && tok !== "-") {
			if ((tok === "-t" || tok === "--target-directory") && i + 1 < tokens.length) {
				targetDir = tokens[i + 1];
				i += 2;
				continue;
			}
			if (tok.startsWith("--target-directory=")) {
				targetDir = tok.slice("--target-directory=".length);
				i++;
				continue;
			}
			if (tok === "-T" || tok === "--no-target-directory") {
				forceNoTargetDir = true;
				i++;
				continue;
			}
			if (
				cmdBase === "install" &&
				(tok === "-m" ||
					tok === "--mode" ||
					tok === "-o" ||
					tok === "--owner" ||
					tok === "-g" ||
					tok === "--group" ||
					tok === "-S" ||
					tok === "--suffix" ||
					tok === "-Z" ||
					tok === "--context") &&
				i + 1 < tokens.length
			) {
				i += 2;
				continue;
			}
			if (
				(cmdBase === "cp" || cmdBase === "mv" || cmdBase === "ln") &&
				(tok === "-S" || tok === "--suffix") &&
				i + 1 < tokens.length
			) {
				i += 2;
				continue;
			}
			if (cmdBase === "rsync" && RSYNC_TWO_ARG_FLAGS.has(tok) && i + 1 < tokens.length) {
				i += 2;
				continue;
			}
			i++;
			continue;
		}
		positional.push(tok);
		i++;
	}

	if (targetDir) {
		if (positional.length === 0) return null;
		return { cmd: cmdBase, sources: positional, dest: null, destDir: targetDir, forceNoTargetDir };
	}
	if (positional.length < 2) return null;
	return {
		cmd: cmdBase,
		sources: positional.slice(0, -1),
		dest: positional[positional.length - 1],
		destDir: null,
		forceNoTargetDir,
	};
}

function resolvePlaceholderScript(rawScriptArg, context) {
	if (!rawScriptArg) return null;
	const placeholder = (context && context.placeholder) || "{}";
	if (rawScriptArg === placeholder || rawScriptArg === "{}" || rawScriptArg.includes(placeholder)) {
		if (context && context.findCandidate && !/[*?\[]/.test(context.findCandidate)) {
			return {
				scriptArg: rawScriptArg.replace(placeholder, context.findCandidate).replace("{}", context.findCandidate),
			};
		}
		if (context && Array.isArray(context.pipedCandidates) && context.pipedCandidates.length > 0) {
			const candidate = context.pipedCandidates[0];
			return {
				scriptArg: rawScriptArg.replace(placeholder, candidate).replace("{}", candidate),
			};
		}
		return {
			unresolvedPlaceholder: rawScriptArg,
			viaWrapper: context && context.viaFindExec ? "find -exec" : "xargs",
		};
	}
	return { scriptArg: rawScriptArg };
}

function extractScriptFromTokens(rawTokens, effectiveCwd, context = {}) {
	const tokens = [...rawTokens];
	let idx = skipLeadingCommandWrappers(tokens, 0, context);

	if (idx >= tokens.length) return null;
	let cmdToken = tokens[idx];
	let cmdBase = path.basename(cmdToken);

	// Handle uv run / poetry run / pipenv run / pdm run
	if ((cmdBase === "uv" || cmdBase === "poetry" || cmdBase === "pipenv" || cmdBase === "pdm") && tokens[idx + 1] === "run") {
		idx += 2;
		while (idx < tokens.length) {
			const tok = tokens[idx];
			if (tok === "--") {
				idx++;
				break;
			}
			if (UV_TWO_ARG_FLAGS.has(tok)) {
				idx += 2;
				continue;
			}
			if (tok.startsWith("-")) {
				idx++;
				continue;
			}
			break;
		}
		if (idx >= tokens.length) return null;
		const nextBase = path.basename(tokens[idx]);
		if (isInterpreterName(nextBase)) {
			cmdToken = tokens[idx];
			cmdBase = nextBase;
		} else {
			return resolvePlaceholderScript(tokens[idx], context);
		}
	}

	// Handle npx / pnpx / bunx / pnpm / yarn / npm invoking tsx / ts-node / node
	if (/^(?:npx|pnpx|bunx|pnpm|yarn)$/i.test(cmdBase)) {
		let scan = idx + 1;
		while (scan < tokens.length) {
			const tok = tokens[scan];
			if (tok === "exec" || tok === "dlx" || tok === "run" || tok === "-y" || tok === "--yes") {
				scan++;
				continue;
			}
			if ((tok === "-p" || tok === "--package") && scan + 1 < tokens.length) {
				scan += 2;
				continue;
			}
			if (tok.startsWith("-")) {
				scan++;
				continue;
			}
			break;
		}
		if (scan < tokens.length && isInterpreterName(path.basename(tokens[scan]))) {
			idx = scan;
			cmdToken = tokens[idx];
			cmdBase = path.basename(cmdToken);
		}
	}

	if (PYTHON_BIN_RE.test(cmdBase)) {
		idx++;
		while (idx < tokens.length) {
			const tok = tokens[idx];
			if (tok === "-c" || tok === "--command" || (tok.startsWith("-c") && tok.length > 2)) {
				return { inlineCode: `${cmdBase} -c` };
			}
			if (tok === "-m" && idx + 1 < tokens.length) {
				const modName = tokens[idx + 1];
				const modRel = modName.replace(/\./g, "/");
				const candidates = [
					`${modRel}.py`,
					`${modRel}/__main__.py`,
					`${modRel}/__init__.py`,
				];
				for (const relCandidate of candidates) {
					const absCandidate = path.resolve(effectiveCwd, relCandidate);
					try {
						if (fs.existsSync(absCandidate) && fs.statSync(absCandidate).isFile()) {
							return { scriptArg: relCandidate };
						}
					} catch {
						/* ignore */
					}
				}
				if (modName.includes(".")) {
					const topPkg = modRel.split("/")[0];
					const topPkgAbs = path.resolve(effectiveCwd, topPkg);
					try {
						if (fs.existsSync(topPkgAbs) && fs.statSync(topPkgAbs).isDirectory()) {
							return { scriptArg: `${modRel}.py` };
						}
					} catch {
						/* ignore */
					}
				}
				// External/stdlib module (e.g. pytest, unittest, pip): -m consumes the rest of argv
				return null;
			}
			if ((tok === "-W" || tok === "-X") && idx + 1 < tokens.length) {
				idx += 2;
				continue;
			}
			if (tok === "-") {
				return { stdinProgram: cmdBase };
			}
			if (tok === "--") {
				idx++;
				break;
			}
			if (tok.startsWith("-")) {
				idx++;
				continue;
			}
			return resolvePlaceholderScript(tok, context);
		}
		if (idx < tokens.length) {
			return resolvePlaceholderScript(tokens[idx], context);
		}
		if (context.viaXargs && Array.isArray(context.pipedCandidates) && context.pipedCandidates.length > 0) {
			return { scriptArg: context.pipedCandidates[0] };
		}
		if (context.fromPipe) {
			return { stdinProgram: cmdBase };
		}
		return null;
	}

	if (NODE_BIN_RE.test(cmdBase)) {
		idx++;
		if (cmdBase.toLowerCase() === "bun" && tokens[idx] === "run") idx++;
		while (idx < tokens.length) {
			const tok = tokens[idx];
			if (tok === "-e" || tok === "--eval" || tok === "-p" || tok === "--print") {
				return { inlineCode: `${cmdBase} ${tok}` };
			}
			if (NODE_TWO_ARG_FLAGS.has(tok) && idx + 1 < tokens.length) {
				idx += 2;
				continue;
			}
			if (tok === "-") {
				return { stdinProgram: cmdBase };
			}
			if (tok === "--") {
				idx++;
				break;
			}
			if (tok.startsWith("-")) {
				idx++;
				continue;
			}
			return resolvePlaceholderScript(tok, context);
		}
		if (idx < tokens.length) {
			return resolvePlaceholderScript(tokens[idx], context);
		}
		if (context.viaXargs && Array.isArray(context.pipedCandidates) && context.pipedCandidates.length > 0) {
			return { scriptArg: context.pipedCandidates[0] };
		}
		if (context.fromPipe) {
			return { stdinProgram: cmdBase };
		}
		return null;
	}

	if (cmdBase.toLowerCase() === "deno") {
		idx++;
		if (tokens[idx] === "run") idx++;
		while (idx < tokens.length) {
			const tok = tokens[idx];
			if (tok === "eval") return { inlineCode: "deno eval" };
			if ((tok === "--config" || tok === "-c" || tok === "--import-map" || tok === "--lock") && idx + 1 < tokens.length) {
				idx += 2;
				continue;
			}
			if (tok === "-") return { stdinProgram: "deno" };
			if (tok === "--") {
				idx++;
				break;
			}
			if (tok.startsWith("-")) {
				idx++;
				continue;
			}
			return resolvePlaceholderScript(tok, context);
		}
		if (context.fromPipe) return { stdinProgram: "deno" };
		return null;
	}

	if (SHELL_BIN_RE.test(cmdBase)) {
		idx++;
		let stdinFlag = false;
		while (idx < tokens.length) {
			const tok = tokens[idx];
			if (tok === "-c" && idx + 1 < tokens.length) {
				return { inlineCommand: tokens[idx + 1], inlineCode: `${cmdBase} -c` };
			}
			if (tok === "-s") {
				stdinFlag = true;
				idx++;
				continue;
			}
			if ((tok === "-o" || tok === "+o") && idx + 1 < tokens.length) {
				idx += 2;
				continue;
			}
			if (tok === "-") {
				stdinFlag = true;
				idx++;
				break;
			}
			if (tok === "--") {
				idx++;
				break;
			}
			if (tok.startsWith("-") || tok.startsWith("+")) {
				idx++;
				continue;
			}
			if (stdinFlag) {
				return { stdinProgram: cmdBase };
			}
			return resolvePlaceholderScript(tok, context);
		}
		if (stdinFlag || context.fromPipe) {
			return { stdinProgram: cmdBase };
		}
		if (idx < tokens.length) {
			return resolvePlaceholderScript(tokens[idx], context);
		}
		return null;
	}

	if (OTHER_SCRIPT_BIN_RE.test(cmdBase)) {
		idx++;
		while (idx < tokens.length) {
			const tok = tokens[idx];
			if (tok === "-e" || tok === "-Command" || tok === "-c" || tok === "-r") {
				return { inlineCode: `${cmdBase} ${tok}` };
			}
			if (tok === "-File" || tok === "-f") {
				if (idx + 1 < tokens.length) return resolvePlaceholderScript(tokens[idx + 1], context);
				return null;
			}
			if (tok === "-") return { stdinProgram: cmdBase };
			if (tok.startsWith("-")) {
				idx++;
				continue;
			}
			return resolvePlaceholderScript(tok, context);
		}
		if (context.fromPipe) return { stdinProgram: cmdBase };
		return null;
	}

	// Direct script path execution (e.g. ./stream_render.py, /tmp/gen.sh, scripts/bake.py)
	const expandedCmd = expandHomePath(cmdToken);
	if (
		cmdToken.includes("/") &&
		(DIRECT_SCRIPT_EXT_RE.test(cmdToken) ||
			expandedCmd.startsWith("/tmp/") ||
			expandedCmd.startsWith(os.tmpdir() + path.sep))
	) {
		return resolvePlaceholderScript(cmdToken, context);
	}

	return null;
}

function findExistingDir(startDir) {
	let cur = path.resolve(startDir);
	while (cur && !fs.existsSync(cur)) {
		const parent = path.dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	return cur;
}

function checkScriptGitStatus(scriptArg, effectiveCwd) {
	const expanded = expandHomePath(scriptArg);
	const absScript = path.resolve(effectiveCwd, expanded);
	const probeDir = findExistingDir(path.dirname(absScript));

	const topRes = spawnSync("git", ["-C", probeDir, "rev-parse", "--show-toplevel"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (topRes.status !== 0 || !topRes.stdout || !topRes.stdout.trim()) {
		return { ok: false, state: "outside-git", absScript };
	}

	const repoRoot = fs.realpathSync.native
		? (() => {
				try {
					return fs.realpathSync.native(topRes.stdout.trim());
				} catch {
					return path.resolve(topRes.stdout.trim());
				}
			})()
		: path.resolve(topRes.stdout.trim());

	let realScript = absScript;
	if (fs.existsSync(absScript)) {
		try {
			realScript = fs.realpathSync.native ? fs.realpathSync.native(absScript) : fs.realpathSync(absScript);
		} catch {
			realScript = absScript;
		}
		try {
			const stat = fs.statSync(realScript);
			if (stat.isDirectory()) {
				const mainPy = path.join(realScript, "__main__.py");
				if (fs.existsSync(mainPy)) {
					realScript = mainPy;
				} else {
					return { ok: true, state: "directory", absScript, repoRoot };
				}
			}
		} catch {
			/* ignore */
		}
	} else {
		return { ok: false, state: "untracked", absScript, repoRoot };
	}

	const rel = path.relative(repoRoot, realScript);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
		return { ok: false, state: "outside-git", absScript };
	}
	const relPosix = rel.replace(/\\/g, "/");

	const headRes = spawnSync("git", ["-C", repoRoot, "rev-parse", "--verify", "HEAD"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (headRes.status !== 0) {
		return { ok: false, state: "uncommitted-repo", absScript, repoRoot, relPosix };
	}

	const lsRes = spawnSync("git", ["-C", repoRoot, "ls-files", "--error-unmatch", "--", relPosix], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (lsRes.status !== 0) {
		return { ok: false, state: "untracked", absScript, repoRoot, relPosix };
	}

	const statusRes = spawnSync(
		"git",
		["-c", "core.quotePath=false", "-C", repoRoot, "status", "--porcelain", "--untracked-files=all", "--", relPosix],
		{
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		},
	);
	if (statusRes.status !== 0 || (statusRes.stdout && statusRes.stdout.trim().length > 0)) {
		return { ok: false, state: "modified", absScript, repoRoot, relPosix };
	}

	return { ok: true, state: "committed", absScript, repoRoot, relPosix };
}

/**
 * uncommittedArtifact — block producing build/asset artifacts (.nva, .exe, .msi,
 * .dmg, .AppImage, .apk, .vrm, or configured extensions) from an uncommitted
 * (untracked/modified) script or an out-of-repo script (such as /tmp/...),
 * running an uncommitted script inside configured artifact_script_dirs even
 * without CLI artifact tokens, inline/stdin artifact generation, or copying/
 * renaming uncommitted artifacts or variant code files via cp/mv/ln/install/rsync.
 */
function uncommittedArtifact(command, data, opts) {
	if (!command || typeof command !== "string") return null;

	const baseCwd = (opts && opts.cwd) || (data && data.cwd) || process.cwd();
	const artifactExts = loadArtifactExtensions(baseCwd, opts);
	const segments = splitShellSegments(command);

	let effectiveCwd = path.resolve(baseCwd);
	const cwdStack = [];
	const varMap = new Map();
	const scriptsToCheck = [];
	const inlineOrStdinToCheck = [];
	const allArtifacts = [];

	let prevSep = "";
	let pipedEchoStrings = [];
	let pipedScriptCandidates = [];

	for (const seg of segments) {
		const rawTokens = tokenizeSegment(seg.text);
		const { tokens: unwrapped, openParens, closeParens } = unwrapGroupingTokens(rawTokens);
		for (let p = 0; p < openParens; p++) cwdStack.push(effectiveCwd);

		const finishSegment = (nextEchoStrings = [], nextScriptCandidates = []) => {
			for (let p = 0; p < closeParens; p++) {
				if (cwdStack.length > 0) effectiveCwd = cwdStack.pop();
			}
			prevSep = seg.sep;
			pipedEchoStrings = seg.sep === "|" ? nextEchoStrings : [];
			pipedScriptCandidates = seg.sep === "|" ? nextScriptCandidates : [];
		};

		if (unwrapped.length === 0) {
			finishSegment();
			continue;
		}

		// Record and expand shell variables (e.g., OUT=a.nva; python ... $OUT)
		const tokens = [];
		for (const rawTok of unwrapped) {
			const assignMatch = rawTok.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
			if (assignMatch && tokens.length === 0) {
				const expandedVal = expandShellVars(assignMatch[2].replace(/^['"]|['"]$/g, ""), varMap);
				varMap.set(assignMatch[1], expandedVal);
				tokens.push(`${assignMatch[1]}=${expandedVal}`);
			} else {
				tokens.push(expandShellVars(rawTok, varMap));
			}
		}

		// Handle cd
		if (tokens[0] === "cd" && seg.sep !== "|") {
			let cdIdx = 1;
			while (cdIdx < tokens.length && (tokens[cdIdx] === "-P" || tokens[cdIdx] === "-L" || tokens[cdIdx] === "--")) {
				cdIdx++;
			}
			if (tokens[cdIdx]) {
				const targetDir = expandHomePath(tokens[cdIdx]);
				effectiveCwd = path.resolve(effectiveCwd, targetDir);
			}
			finishSegment();
			continue;
		}

		// Handle echo / printf
		if (tokens[0] === "echo" || tokens[0] === "printf") {
			if (seg.sep !== "|") {
				finishSegment();
				continue;
			}
			const echoArgs = tokens.slice(1).filter((t) => !t.startsWith("-"));
			for (const tok of echoArgs) {
				const matched = matchArtifactToken(tok, artifactExts);
				if (matched) allArtifacts.push(matched);
			}
			const candidates = [];
			for (const tok of echoArgs) {
				for (const part of tok.split(/\s+/)) {
					if (part && (DIRECT_SCRIPT_EXT_RE.test(part) || !part.startsWith("-"))) {
						candidates.push(part);
					}
				}
			}
			finishSegment(echoArgs, candidates);
			continue;
		}

		const segArtifacts = [];
		for (const tok of tokens) {
			const matched = matchArtifactToken(tok, artifactExts);
			if (matched) {
				segArtifacts.push(matched);
				allArtifacts.push(matched);
			}
		}

		// Check cp / mv / ln / install / rsync (Item 4: P1-3 & P1-7)
		const transferOp = extractFileTransferOp(tokens);
		if (transferOp) {
			for (const src of transferOp.sources) {
				let destPath = transferOp.dest;
				if (transferOp.destDir) {
					destPath = path.join(transferOp.destDir, path.basename(src));
				} else if (destPath && !transferOp.forceNoTargetDir) {
					const absDestProbe = path.resolve(effectiveCwd, expandHomePath(destPath));
					let isDestDir = destPath.endsWith("/") || transferOp.sources.length > 1;
					if (!isDestDir && fs.existsSync(absDestProbe)) {
						try {
							isDestDir = fs.statSync(absDestProbe).isDirectory();
						} catch {
							isDestDir = false;
						}
					}
					if (isDestDir) {
						destPath = path.join(destPath, path.basename(src));
					}
				}
				if (!destPath) continue;

				// (a) Target has an artifact extension and source is uncommitted
				const matchedDestArtifact = matchArtifactToken(destPath, artifactExts);
				if (matchedDestArtifact) {
					const srcCheck = checkScriptGitStatus(src, effectiveCwd);
					if (!srcCheck.ok) {
						return {
							reason:
								`[Harness] ${ARTIFACT_DRIFT_MESSAGE}\n` +
								`원본: ${src} (${srcCheck.state}) → 산출물: ${matchedDestArtifact}`,
						};
					}
				}

				// (b) Target is a variant/copy name of a sibling code file (shared edit.js duplicateCodeFile)
				const absSrc = path.resolve(effectiveCwd, expandHomePath(src));
				const absDest = path.resolve(effectiveCwd, expandHomePath(destPath));
				const extraSiblings =
					path.dirname(absSrc) === path.dirname(absDest) ? [path.basename(absSrc)] : [];
				const dupDecision = duplicateCodeFile(
					{
						cwd: effectiveCwd,
						tool_name: "Write",
						tool_input: { file_path: destPath },
					},
					{
						...(opts || {}),
						cwd: effectiveCwd,
						extraSiblings,
					},
				);
				if (dupDecision && dupDecision.block) {
					return { reason: dupDecision.block };
				}
			}
			finishSegment();
			continue;
		}

		const extractCtx = {
			fromPipe: prevSep === "|",
			pipedCandidates: pipedScriptCandidates,
		};
		const extracted = extractScriptFromTokens(tokens, effectiveCwd, extractCtx);
		if (extracted) {
			if (extracted.inlineCommand) {
				const nested = uncommittedArtifact(
					extracted.inlineCommand,
					{ ...(data || {}), cwd: effectiveCwd },
					opts,
				);
				if (nested) return nested;
			}
			if (extracted.stdinProgram && prevSep === "|" && pipedEchoStrings.length > 0) {
				const pipedCmd = pipedEchoStrings.join(" ");
				const nested = uncommittedArtifact(
					pipedCmd,
					{ ...(data || {}), cwd: effectiveCwd },
					opts,
				);
				if (nested) return nested;
			}
			if (extracted.stdinProgram) {
				inlineOrStdinToCheck.push({
					label: `<stdin:${extracted.stdinProgram}>`,
					state: "uncommitted-stdin",
					segArtifacts,
				});
			} else if (extracted.inlineCode && !extracted.inlineCommand) {
				inlineOrStdinToCheck.push({
					label: `<inline:${extracted.inlineCode}>`,
					state: "inline-code",
					segArtifacts,
				});
			} else if (extracted.unresolvedPlaceholder) {
				inlineOrStdinToCheck.push({
					label: `${extracted.unresolvedPlaceholder} (${extracted.viaWrapper})`,
					state: "untracked",
					segArtifacts,
				});
			} else if (extracted.scriptArg) {
				scriptsToCheck.push({
					scriptArg: extracted.scriptArg,
					cwd: effectiveCwd,
					segArtifacts,
				});
			}
		}

		finishSegment();
	}

	if (allArtifacts.length > 0 && inlineOrStdinToCheck.length > 0) {
		const item = inlineOrStdinToCheck[0];
		const artifactLabel = item.segArtifacts[0] || allArtifacts[0];
		return {
			reason:
				`[Harness] ${ARTIFACT_DRIFT_MESSAGE}\n` +
				`대본: ${item.label} (${item.state}) → 산출물: ${artifactLabel}`,
		};
	}

	for (const item of scriptsToCheck) {
		const check = checkScriptGitStatus(item.scriptArg, item.cwd);
		const dirPatterns = loadArtifactScriptDirs(
			item.cwd,
			opts,
			check.repoRoot ? [check.repoRoot] : [],
		);
		const inProducerDir = isArtifactProducerScript(
			item.scriptArg,
			item.cwd,
			check,
			dirPatterns,
		);
		if ((allArtifacts.length > 0 || inProducerDir) && !check.ok) {
			const artifactLabel =
				item.segArtifacts[0] || allArtifacts[0] || "(산출물 생산 폴더 대본)";
			return {
				reason:
					`[Harness] ${ARTIFACT_DRIFT_MESSAGE}\n` +
					`대본: ${item.scriptArg} (${check.state}) → 산출물: ${artifactLabel}`,
			};
		}
	}

	return null;
}

// Public intent-guard surface re-exported for host adapters (.claude/hooks/intent-guard.js, .pi/extensions/naia-harness.ts):
// Only designIntentRecheck, intentGuard, and checkRepositoryDesignIntent are part of the public bash policy contract.
const {
	designIntentRecheck,
	intentGuard,
	checkRepositoryDesignIntent,
	extractGitCommitInvocations,
} = require("./design-intent-guard.js");

module.exports = {
	destructiveGit,
	catastrophicDelete,
	commit,
	gitPush,
	emailSend,
	prGuard,
	deploy,
	uncommittedArtifact,
	designIntentRecheck,
	intentGuard,
	checkRepositoryDesignIntent,
	loadArtifactExtensions,
	loadArtifactScriptDirs,
	DEFAULT_ARTIFACT_EXTENSIONS,
	DEFAULT_ARTIFACT_SCRIPT_DIRS,
	ARTIFACT_DRIFT_MESSAGE,
	PR_FAIL_REASON,
};
