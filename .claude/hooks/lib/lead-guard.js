/**
 * 3층(역할 세션) 쓰기 막기의 공용 판정. 훅(lead-write-guard.js)과 예외 대본(scripts/lead-guard-exception.mjs)이 같이 쓴다.
 *
 * 누가 3층인가는 환경 변수로 정하지 않는다. 3층이 명령 앞에 `NAIA_ROLE=worker` 를 붙여도 훅의 환경은 바뀌지 않지만,
 * 처음부터 환경 변수가 답을 정하는 구조면 "변수만 바꾸면 풀리는" 구멍이 된다. 그래서 두 사실만 본다.
 *   1. 세션을 띄운 폴더(조상 claude 프로세스의 실제 cwd인 `/proc/<pid>/cwd`)에서 위로 올라가며 찾은
 *      `.naia-role.json` 이 `lead_guard.enabled: true` 를 갖는다. (환경 변수 CLAUDE_PROJECT_DIR 에 의존하지 않는다.)
 *   2. 그 claude 프로세스가 `-p/--print`(헤드리스 일꾼)가 아니고, 훅 입력에 agent_id(서브에이전트)가 없다.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROLE_FILE = ".naia-role.json";
const ADK_ROOT = path.resolve(__dirname, "../../..");
const STATE_DIR = path.join(ADK_ROOT, ".agents", "lead-guard");
const EXCEPTION_FILE = path.join(STATE_DIR, "exception.json");
const AUDIT_FILE = path.join(STATE_DIR, "audit.jsonl");
const MAX_EXCEPTION_MS = 8 * 60 * 60 * 1000;

function readProc(pid, name) {
	try { return fs.readFileSync(`/proc/${pid}/${name}`, "utf8"); } catch { return null; }
}
function readProcLink(pid, name) {
	try { return fs.readlinkSync(`/proc/${pid}/${name}`); } catch { return null; }
}
function parentOf(pid) {
	const stat = readProc(pid, "stat");
	if (!stat) return 0;
	const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	return Number(rest[1]) || 0;
}
function looksLikeClaude(argv) {
	return argv.slice(0, 3).some((a) => /(^|\/)claude(\.exe)?$/.test(a) || /claude-code/.test(a));
}
const CLAUDE_VALUE_OPTS = new Set([
	"-n", "--name", "--file", "--append-system-prompt", "--system-prompt", "--system-prompt-snapshot",
	"--model", "--fallback-model", "--session-id", "--permission-mode", "--permission-prompts",
	"--settings", "--setting-sources", "--add-dir", "--mcp-config", "--allowedTools", "--allowed-tools",
	"--disallowedTools", "--disallowed-tools", "--tools", "--output-format", "--input-format",
	"--json-schema", "--max-turns", "--max-budget-usd", "--agents", "--agent", "--betas",
	"--plugin-dir", "--plugin-url", "--debug-file", "--effort", "--environment", "--autocompact",
	"--remote-control-session-name-prefix", "--from-pr", "--resume-session-at",
]);
const CLAUDE_OPT_VALUE_OPTS = new Set(["-r", "--resume", "-d", "--debug"]);

function isPrintMode(argv) {
	let i = argv.findIndex((a) => /(^|\/)claude(\.exe)?$/.test(a) || /claude-code/.test(a));
	i = i >= 0 ? i + 1 : 1;
	for (; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--") break;
		if (a === "-p" || a === "--print" || a.startsWith("--print=")) return true;
		if (/^-[A-Za-z0-9]+$/.test(a) && a.includes("p")) return true;
		if (CLAUDE_VALUE_OPTS.has(a)) { i++; continue; }
		if (CLAUDE_OPT_VALUE_OPTS.has(a) && i + 1 < argv.length && !argv[i + 1].startsWith("-")) { i++; continue; }
	}
	return false;
}

/** 조상 중 모든 claude(가장 가까운 것부터). 3층이 일꾼을 띄워 예외를 열게 하는 길을 막는 데 쓴다. */
function claudeAncestors(startPid = process.ppid, maxHops = 30, limit = Infinity) {
	const out = [];
	let pid = startPid;
	for (let i = 0; i < maxHops && pid > 1; i++) {
		const raw = readProc(pid, "cmdline");
		const argv = raw ? raw.split("\0").filter(Boolean) : [];
		if (argv.length && looksLikeClaude(argv)) {
			const env = readProc(pid, "environ") || "";
			const m = env.split("\0").find((e) => e.startsWith("CLAUDE_PROJECT_DIR="));
			out.push({
				pid,
				headless: isPrintMode(argv),
				cwd: readProcLink(pid, "cwd"),
				projectDir: m ? m.slice("CLAUDE_PROJECT_DIR=".length) : null,
			});
			if (out.length >= limit) break;
		}
		pid = parentOf(pid);
	}
	return out;
}

/** 이 프로세스의 조상 중 가장 가까운 claude. { pid, headless, cwd, projectDir } | null. */
function claudeAncestor(startPid = process.ppid) {
	return claudeAncestors(startPid, 20, 1)[0] || null;
}

function roleConfigFrom(startDir) {
	let cur = path.resolve(startDir);
	for (;;) {
		const file = path.join(cur, ROLE_FILE);
		try {
			const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
			const lg = parsed && typeof parsed.lead_guard === "object" && parsed.lead_guard;
			// 가장 가까운 표지가 정한다. 켜져 있지 않으면 3층이 아니다.
			return lg && lg.enabled === true ? { dir: cur, file, role: typeof parsed.role === "string" ? parsed.role : path.basename(cur), cfg: lg } : null;
		} catch {}
		const parent = path.dirname(cur);
		if (parent === cur) return null;
		cur = parent;
	}
}

/**
 * 이 훅 호출이 3층 세션의 것인가. { lead: true, role, dir, cfg } | { lead: false, why }.
 * 일꾼(헤드리스 claude -p, 서브에이전트)은 3층이 아니다. codex·agy·muse 는 이 훅이 아예 돌지 않는다.
 */
function leadSession(input, env = process.env) {
	if (input && (input.agent_id || input.agent_type)) return { lead: false, why: "서브에이전트" };
	const anc = claudeAncestor();
	if (anc && anc.headless) return { lead: false, why: "헤드리스 일꾼(claude -p)" };
	const starts = anc ? [anc.cwd || anc.projectDir].filter(Boolean) : [env.CLAUDE_PROJECT_DIR, input && input.cwd].filter(Boolean);
	for (const s of starts) {
		const role = roleConfigFrom(s);
		if (role) return { lead: true, ...role };
	}
	return { lead: false, why: "역할 표지 없음" };
}

function realPathLoose(target) {
	try { return fs.realpathSync(target); } catch {}
	let cur = path.resolve(target);
	const tail = [];
	while (!fs.existsSync(cur) && cur !== path.dirname(cur)) {
		tail.unshift(path.basename(cur));
		cur = path.dirname(cur);
	}
	try { return path.join(fs.realpathSync(cur), ...tail); } catch { return path.resolve(target); }
}
function inside(child, parent) {
	return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}
function repoRootOf(real) {
	let cur = real;
	try { if (!fs.statSync(cur).isDirectory()) cur = path.dirname(cur); } catch { cur = path.dirname(cur); }
	for (;;) {
		if (fs.existsSync(path.join(cur, ".git"))) return cur;
		const parent = path.dirname(cur);
		if (parent === cur) return null;
		cur = parent;
	}
}
function globToRegExp(glob) {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		if (glob.slice(i, i + 4) === "/**/") { re += "(?:\\/.*)?\\/"; i += 3; continue; }
		if (glob.slice(i) === "/**") { re += "(?:\\/.*)?"; break; }
		const c = glob[i];
		if (c === "*" && glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
		else if (c === "*") re += "[^/]*";
		else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`);
}

/** 저장소 안에서도 3층이 쓸 수 있는 곳(저장소 기준 상대 글롭). 설정의 lead_guard.allow 가 더한다. */
function allowGlobs(role) {
	const safeRole = String(role.role).replace(/[^A-Za-z0-9._-]/g, "");
	return [
		`docs/common/${safeRole}/**`,
		`docs/common/team/now/${safeRole}.md`,
		`docs/common/team/now/${safeRole}/**`,
		".agents/progress/**",
		".agents/work/**",
		...(Array.isArray(role.cfg.allow) ? role.cfg.allow.filter((g) => typeof g === "string") : []),
	];
}

function guardMeta(role) {
	const cfg = (role && role.cfg) || {};
	const pick = (k) => (typeof cfg[k] === "string" && cfg[k].trim() ? cfg[k].trim() : "");
	return {
		workDir: pick("work_dir") || "<작업 폴더>",
		workerGuide: pick("worker_guide"),
		approverLabel: pick("approver_label") || "승인자",
	};
}

/** 예외 기록 하나. 유효하면 { id, scope[], expires_at }, 없거나 틀리면 null. 3층이 쓸 수 없는 파일이다(훅이 STATE_DIR 쓰기를 막는다). */
function activeException(now = Date.now()) {
	try {
		const r = JSON.parse(fs.readFileSync(EXCEPTION_FILE, "utf8"));
		const created = Date.parse(r.created_at), expires = Date.parse(r.expires_at);
		if (!r.id || !r.approved_by || String(r.approval_ref || "").length < 8) return null;
		if (!Number.isFinite(created) || !Number.isFinite(expires) || expires <= now || expires - created > MAX_EXCEPTION_MS) return null;
		const scope = (Array.isArray(r.scope) ? r.scope : []).filter((s) => typeof s === "string" && path.isAbsolute(s) && path.resolve(s).split(path.sep).filter(Boolean).length >= 3).map((s) => realPathLoose(s));
		return scope.length ? { id: r.id, scope, expires_at: r.expires_at } : null;
	} catch { return null; }
}

function audit(event) {
	try {
		fs.mkdirSync(STATE_DIR, { recursive: true });
		fs.appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
	} catch {}
}

/**
 * 이 경로에 3층이 쓸 수 있는가. { ok: true, exception? } | { ok: false, rule }.
 * 막는 것: (1) 자기 보호 — 역할 표지·훅 설정·예외/감사 기록·사용자 설정, (2) 저장소 작업 트리 안에서 허용 글롭 밖.
 * 저장소 밖(/tmp, 작업 폴더의 지시서·결과, 기억 파일, 진행 기록 파일)은 기본 허용이다.
 */
function classify(target, role, opts = {}) {
	const real = realPathLoose(target);
	const home = os.homedir();
	const selfProtected = [
		path.join(home, ".claude", "settings.json"), path.join(home, ".claude", "settings.local.json"), path.join(home, ".claude", "hooks"),
		STATE_DIR, ...(Array.isArray(role.cfg.protect) ? role.cfg.protect.filter((p) => typeof p === "string" && path.isAbsolute(p)).map(realPathLoose) : []),
	];
	if (path.basename(real) === ROLE_FILE) return { ok: false, rule: "self:role-file" };
	if (selfProtected.some((p) => inside(real, p))) return { ok: false, rule: "self:protected-path" };
	const repo = repoRootOf(real);
	if (!repo) return { ok: true };
	// 일회용 연결 git worktree 전체 통삭제는(자기 자신·역할 폴더가 아니면) 정리로 허용한다.
	if (opts && opts.wholeWorktreeRemove && real === repo && !inside(ADK_ROOT, real) && (!role || !inside(role.dir, real))) {
		try {
			const dotGit = path.join(repo, ".git");
			if (fs.lstatSync(dotGit).isFile() && fs.readFileSync(dotGit, "utf8").startsWith("gitdir:")) return { ok: true };
		} catch {}
	}
	const rel = path.relative(repo, real).split(path.sep).join("/");
	if (allowGlobs(role).some((g) => globToRegExp(g).test(rel))) return { ok: true };
	const ex = activeException();
	if (ex && ex.scope.some((s) => inside(real, s))) return { ok: true, exception: ex.id };
	return { ok: false, rule: "repo-write", repo, rel };
}

module.exports = { claudeAncestors, ROLE_FILE, ADK_ROOT, STATE_DIR, EXCEPTION_FILE, AUDIT_FILE, MAX_EXCEPTION_MS, claudeAncestor, leadSession, classify, activeException, audit, realPathLoose, roleConfigFrom, guardMeta, readProcLink };
