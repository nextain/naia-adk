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

const DEFAULT_ARTIFACT_EXTENSIONS = [
	".nva",
	".exe",
	".msi",
	".dmg",
	".AppImage",
	".apk",
	".vrm",
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

function readDriftConfigFromRoot(dir) {
	if (!dir) return null;
	const driftJsonPath = path.join(dir, ".agents", "context", "drift-guard.json");
	if (fs.existsSync(driftJsonPath)) {
		try {
			const parsed = JSON.parse(fs.readFileSync(driftJsonPath, "utf8"));
			const exts = normalizeExtensions(parsed && parsed.artifact_extensions);
			if (exts) return exts;
		} catch {
			/* ignore malformed json and fall through */
		}
	}
	for (const rulesFile of ["agents-rules.json", "agents-rules-detail.json"]) {
		const rulesPath = path.join(dir, ".agents", "context", rulesFile);
		if (!fs.existsSync(rulesPath)) continue;
		try {
			const parsed = JSON.parse(fs.readFileSync(rulesPath, "utf8"));
			const candidate =
				parsed?.conventions?.drift_guard?.artifact_extensions ||
				parsed?.drift_guard?.artifact_extensions ||
				parsed?.artifact_extensions;
			const exts = normalizeExtensions(candidate);
			if (exts) return exts;
		} catch {
			/* ignore */
		}
	}
	return null;
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

function isInterpreterName(base) {
	return (
		PYTHON_BIN_RE.test(base) ||
		NODE_BIN_RE.test(base) ||
		SHELL_BIN_RE.test(base) ||
		OTHER_SCRIPT_BIN_RE.test(base) ||
		base === "deno"
	);
}

function extractScriptFromTokens(tokens, effectiveCwd) {
	let idx = 0;
	while (idx < tokens.length) {
		const t = tokens[idx];
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
			idx++;
			continue;
		}
		const base = path.basename(t);
		if (base === "env") {
			idx++;
			while (idx < tokens.length) {
				if (tokens[idx] === "-u" || tokens[idx] === "--unset" || tokens[idx] === "-C") {
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
			continue;
		}
		if (base === "nice") {
			idx++;
			if (tokens[idx] === "-n" && idx + 1 < tokens.length) idx += 2;
			else if (tokens[idx] && tokens[idx].startsWith("-")) idx++;
			continue;
		}
		if (base === "timeout") {
			idx++;
			while (idx < tokens.length && tokens[idx].startsWith("-")) {
				if ((tokens[idx] === "-k" || tokens[idx] === "-s" || tokens[idx] === "--kill-after" || tokens[idx] === "--signal") && idx + 1 < tokens.length) {
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
				if ((tokens[idx] === "-u" || tokens[idx] === "-g") && idx + 1 < tokens.length) idx += 2;
				else idx++;
			}
			continue;
		}
		break;
	}

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
			return { scriptArg: tokens[idx] };
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
			if (tok === "-c" || tok === "--command") return null;
			if (tok === "-m" && idx + 1 < tokens.length) {
				const modName = tokens[idx + 1];
				const relCandidate = `${modName.replace(/\./g, "/")}.py`;
				const absCandidate = path.resolve(effectiveCwd, relCandidate);
				if (fs.existsSync(absCandidate)) return { scriptArg: relCandidate };
				idx += 2;
				continue;
			}
			if ((tok === "-W" || tok === "-X") && idx + 1 < tokens.length) {
				idx += 2;
				continue;
			}
			if (tok === "--") {
				idx++;
				break;
			}
			if (tok.startsWith("-")) {
				idx++;
				continue;
			}
			return { scriptArg: tok };
		}
		return null;
	}

	if (NODE_BIN_RE.test(cmdBase)) {
		idx++;
		if (cmdBase.toLowerCase() === "bun" && tokens[idx] === "run") idx++;
		while (idx < tokens.length) {
			const tok = tokens[idx];
			if (tok === "-e" || tok === "--eval" || tok === "-p" || tok === "--print") return null;
			if (NODE_TWO_ARG_FLAGS.has(tok) && idx + 1 < tokens.length) {
				idx += 2;
				continue;
			}
			if (tok === "--") {
				idx++;
				break;
			}
			if (tok.startsWith("-")) {
				idx++;
				continue;
			}
			return { scriptArg: tok };
		}
		return null;
	}

	if (cmdBase.toLowerCase() === "deno") {
		idx++;
		if (tokens[idx] === "run") idx++;
		while (idx < tokens.length) {
			const tok = tokens[idx];
			if ((tok === "--config" || tok === "-c" || tok === "--import-map" || tok === "--lock") && idx + 1 < tokens.length) {
				idx += 2;
				continue;
			}
			if (tok === "--") {
				idx++;
				break;
			}
			if (tok.startsWith("-")) {
				idx++;
				continue;
			}
			return { scriptArg: tok };
		}
		return null;
	}

	if (SHELL_BIN_RE.test(cmdBase)) {
		idx++;
		while (idx < tokens.length) {
			const tok = tokens[idx];
			if (tok === "-c" && idx + 1 < tokens.length) {
				return { inlineCommand: tokens[idx + 1] };
			}
			if ((tok === "-o" || tok === "+o") && idx + 1 < tokens.length) {
				idx += 2;
				continue;
			}
			if (tok === "--") {
				idx++;
				break;
			}
			if (tok.startsWith("-") || tok.startsWith("+")) {
				idx++;
				continue;
			}
			return { scriptArg: tok };
		}
		return null;
	}

	if (OTHER_SCRIPT_BIN_RE.test(cmdBase)) {
		idx++;
		while (idx < tokens.length) {
			const tok = tokens[idx];
			if (tok === "-e" || tok === "-Command" || tok === "-c") return null;
			if (tok === "-File" || tok === "-f") {
				if (idx + 1 < tokens.length) return { scriptArg: tokens[idx + 1] };
				return null;
			}
			if (tok.startsWith("-")) {
				idx++;
				continue;
			}
			return { scriptArg: tok };
		}
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
		return { scriptArg: cmdToken };
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
	} else {
		return { ok: false, state: "untracked", absScript };
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
		return { ok: false, state: "uncommitted-repo", absScript };
	}

	const lsRes = spawnSync("git", ["-C", repoRoot, "ls-files", "--error-unmatch", "--", relPosix], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (lsRes.status !== 0) {
		return { ok: false, state: "untracked", absScript };
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
		return { ok: false, state: "modified", absScript };
	}

	return { ok: true, state: "committed", absScript, repoRoot, relPosix };
}

/**
 * uncommittedArtifact — block producing build/asset artifacts (.nva, .exe, .msi,
 * .dmg, .AppImage, .apk, .vrm, or configured extensions) from an uncommitted
 * (untracked/modified) script or an out-of-repo script (such as /tmp/...).
 */
function uncommittedArtifact(command, data, opts) {
	if (!command || typeof command !== "string") return null;
	if (/^\s*(echo|printf)\b/.test(command) && !command.includes("|")) return null;

	const baseCwd = (opts && opts.cwd) || (data && data.cwd) || process.cwd();
	const artifactExts = loadArtifactExtensions(baseCwd, opts);
	const segments = splitShellSegments(command);

	let effectiveCwd = path.resolve(baseCwd);
	const scriptsToCheck = [];
	const allArtifacts = [];

	for (const seg of segments) {
		const tokens = tokenizeSegment(seg.text);
		if (tokens.length === 0) continue;

		if (tokens[0] === "cd" && tokens[1] && seg.sep !== "|") {
			const targetDir = expandHomePath(tokens[1]);
			effectiveCwd = path.resolve(effectiveCwd, targetDir);
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

		const extracted = extractScriptFromTokens(tokens, effectiveCwd);
		if (extracted && extracted.inlineCommand) {
			const nested = uncommittedArtifact(
				extracted.inlineCommand,
				{ ...(data || {}), cwd: effectiveCwd },
				opts,
			);
			if (nested) return nested;
		} else if (extracted && extracted.scriptArg) {
			scriptsToCheck.push({
				scriptArg: extracted.scriptArg,
				cwd: effectiveCwd,
				segArtifacts,
			});
		}
	}

	if (allArtifacts.length === 0 || scriptsToCheck.length === 0) return null;

	for (const item of scriptsToCheck) {
		const artifactLabel = item.segArtifacts[0] || allArtifacts[0];
		const check = checkScriptGitStatus(item.scriptArg, item.cwd);
		if (!check.ok) {
			return {
				reason:
					`[Harness] ${ARTIFACT_DRIFT_MESSAGE}\n` +
					`대본: ${item.scriptArg} (${check.state}) → 산출물: ${artifactLabel}`,
			};
		}
	}

	return null;
}

module.exports = {
	destructiveGit,
	catastrophicDelete,
	commit,
	gitPush,
	emailSend,
	prGuard,
	deploy,
	uncommittedArtifact,
	loadArtifactExtensions,
	DEFAULT_ARTIFACT_EXTENSIONS,
	ARTIFACT_DRIFT_MESSAGE,
	PR_FAIL_REASON,
};
