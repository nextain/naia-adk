"use strict";
const path=require("node:path"),fs=require("node:fs"),os=require("node:os");
const {spawnSync}=require("node:child_process");
const core=require("../core/harness-core.js");
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
	const found = gitInvocation(command, subcommand);
	return found ? found.args : null;
}

/** Directory arithmetic that stays relative until the hook's own cwd is known. */
function joinDir(base, next) {
	return path.isAbsolute(next) ? path.normalize(next) : path.join(base || ".", next);
}

/** Like gitCommandArgs, plus the directory the command runs in: earlier `cd <dir>` segments and `git -C <dir>` / `--git-dir` / `--work-tree`. */
function gitInvocation(command, subcommand) {
	const normalized = core.stripQuotesUnwrap(command);
	const optionWithValue = new Set(["-c", "-C", "--config-env", "--git-dir", "--work-tree", "--namespace"]);
	const optionWithoutValue = new Set([
		"-p", "--paginate", "-P", "--no-pager", "--bare", "--no-replace-objects",
		"--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs",
	]);
	let cdDir = "";
	for (const segment of normalized.split(/[;&|\r\n]+/)) {
		const tokens = segment.trim().replace(/^[({\s]+/, "").replace(/[)}\s]+$/, "").split(/\s+/).filter(Boolean);
		if (tokens[0] === "cd" && tokens[1] && tokens[1] !== "-" && !tokens[1].startsWith("~") && !/[$`]/.test(tokens[1])) {
			cdDir = joinDir(cdDir, tokens[1].replace(/^["']|["']$/g, ""));
			continue;
		}
		for (let i = 0; i < tokens.length; i++) {
			if (!/(?:^|[\\/])git(?:\.exe)?$/i.test(tokens[i])) continue;
			let j = i + 1;
			let dir = cdDir;
			let gitDir = "";
			let workTree = "";
			while (j < tokens.length) {
				const token = tokens[j];
				const strip = (value) => (value || "").replace(/^["']|["']$/g, "");
				if (token === "-C") { dir = joinDir(dir, strip(tokens[j + 1])); j += 2; continue; }
				if (token === "--git-dir") { gitDir = strip(tokens[j + 1]); j += 2; continue; }
				if (token === "--work-tree") { workTree = strip(tokens[j + 1]); j += 2; continue; }
				if (/^--git-dir=\S+$/.test(token)) { gitDir = strip(token.slice(token.indexOf("=") + 1)); j += 1; continue; }
				if (/^--work-tree=\S+$/.test(token)) { workTree = strip(token.slice(token.indexOf("=") + 1)); j += 1; continue; }
				if (optionWithValue.has(token)) { j += 2; continue; }
				if (optionWithoutValue.has(token) || /^--(?:config-env|namespace)=\S+$/.test(token)) { j += 1; continue; }
				break;
			}
			if (tokens[j] === subcommand) return { args: tokens.slice(j + 1), dir, gitDir, workTree };
		}
	}
	return null;
}

const PROTECTED_BRANCHES_FILE = path.join(__dirname, "..", "..", "context", "push-protected-branches.json");

/** Opt-in list of branches that take no direct push. Empty (the default) keeps routine push open. */
function readProtectedBranches(opts) {
	if (Array.isArray(opts && opts.protectedBranches)) return opts.protectedBranches;
	try {
		const list = JSON.parse(fs.readFileSync(PROTECTED_BRANCHES_FILE, "utf8")).protected_branches;
		return Array.isArray(list) ? list.filter((name) => typeof name === "string" && name) : [];
	} catch {
		return [];
	}
}

function currentBranchOf(opts, target = {}) {
	if (opts && typeof opts.currentBranch === "string") return opts.currentBranch;
	try {
		const { execFileSync } = require("child_process");
		const base = (opts && opts.cwd) || process.cwd();
		const gitArgs = [];
		if (target.gitDir) gitArgs.push("--git-dir", path.resolve(target.dir || base, target.gitDir));
		if (target.workTree) gitArgs.push("--work-tree", path.resolve(target.dir || base, target.workTree));
		gitArgs.push("rev-parse", "--abbrev-ref", "HEAD");
		return execFileSync("git", gitArgs, { cwd: path.resolve(base, target.dir || "."), timeout: 3000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
}

/** Non-force, non-deleting push: block `--all` / `--branches`, and a direct push to a protected branch when the list is not empty. */
function pushScopeViolation(args, opts, target) {
	const clean = args.map((arg) => arg.replace(/^["']|["']$/g, ""));
	if (clean.some((arg) => arg === "--all" || arg === "--branches")) {
		return { reason: "[Harness] ⚠️ PUSH --all 차단\n\n--all(--branches) 는 모든 로컬 브랜치를 한꺼번에 밀어 보호 가지까지 건드립니다. 가지를 하나씩 지정하세요." };
	}
	const protectedBranches = readProtectedBranches(opts);
	if (!protectedBranches.length) return null;
	const valueOptions = new Set(["-o", "--push-option", "--receive-pack", "--exec", "--repo"]);
	const positional = [];
	for (let i = 0; i < clean.length; i++) {
		const arg = clean[i];
		if (arg === "--") { positional.push(...clean.slice(i + 1)); break; }
		if (valueOptions.has(arg)) { i += 1; continue; }
		if (!arg.startsWith("-")) positional.push(arg);
	}
	const refspecs = positional.slice(1);
	const current = currentBranchOf(opts, target);
	const targets = refspecs.length
		? refspecs.map((spec) => {
			const dst = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : spec;
			const name = dst.replace(/^refs\/heads\//, "");
			return name === "HEAD" || name === "@" ? current : name;
		})
		: [current];
	const hit = targets.find((name) => name && protectedBranches.includes(name));
	if (!hit) return null;
	return { reason: `[Harness] ⚠️ 보호 가지 직접 push 차단\n가지: ${hit}\n\n이 가지는 push-protected-branches.json 의 보호 목록에 있습니다. 작업 가지로 올려 PR 로 병합하세요.` };
}

/** git-push-guard — allow routine push; block remote deletion/history rewriting */
function gitPush(command, opts = {}) {
	const stripped = core.stripQuotesBlank(command);
	if (/^\s*(echo|printf)\s/.test(stripped) && !stripped.includes("|")) return null;
	const invocation = gitInvocation(command, "push");
	if (!invocation) return null;
	const args = invocation.args;
	const pushClause = ` ${args.join(" ")}`;
	const isRemoteRefDelete = /(?:^|\s)--delete(?:=|\s|$)/.test(pushClause)
		|| /(?:^|\s)-d(?:\s|$)/.test(pushClause)
		|| /(?:^|\s)--(?:mirror|prune)(?:\s|$)/.test(pushClause)
		|| /(?:^|\s)["']?:(?:refs\/(?:heads|tags)\/)?[^\s"';&|]+/.test(pushClause);
	const isForce = /(?:^|\s)--force(?:-with-lease|-if-includes)?(?:=\S+)?(?:\s|$)/.test(pushClause)
		|| /(?:^|\s)-(?!-)[A-Za-z]*f[A-Za-z]*(?:\s|$)/.test(pushClause)
		|| /(?:^|\s)\+\S+/.test(pushClause);
	if (!isRemoteRefDelete && !isForce) return pushScopeViolation(args, opts, invocation);
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


module.exports={destructiveGit,commit,gitPush};
