/**
 * 3층(역할 세션) 쓰기 막기의 공용 판정. 훅(lead-write-guard.js)과 예외 대본(scripts/lead-guard-exception.mjs)이 같이 쓴다.
 *
 * 누가 3층인가는 환경 변수로 정하지 않는다. 3층이 명령 앞에 `NAIA_ROLE=worker` 를 붙여도 훅의 환경은 바뀌지 않지만,
 * 처음부터 환경 변수가 답을 정하는 구조면 "변수만 바꾸면 풀리는" 구멍이 된다. 그래서 두 사실만 본다.
 *   1. 세션을 띄운 폴더(claude 프로세스가 시작할 때의 CLAUDE_PROJECT_DIR, /proc 에서 읽는다)에서 위로 올라가며 찾은
 *      `.naia-role.json` 이 `lead_guard.enabled: true` 를 갖는다. (옛 `.agents/lead-sessions/<sid>.json` 자기 선언 표지는 쓰지 않는다.)
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
function parentOf(pid) {
	const stat = readProc(pid, "stat");
	if (!stat) return 0;
	const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	return Number(rest[1]) || 0;
}
function looksLikeClaude(argv) {
	return argv.slice(0, 3).some((a) => /(^|\/)claude(\.exe)?$/.test(a) || /claude-code/.test(a));
}
function isPrintMode(argv) {
	return argv.some((a) => a === "-p" || a === "--print" || a.startsWith("--print=") || /^-[A-Za-z]*p[A-Za-z]*$/.test(a));
}

/** 이 프로세스의 조상 중 가장 가까운 claude. { pid, headless, projectDir } | null. */
function claudeAncestor(startPid = process.ppid) {
	let pid = startPid;
	for (let i = 0; i < 10 && pid > 1; i++) {
		const raw = readProc(pid, "cmdline");
		const argv = raw ? raw.split("\0").filter(Boolean) : [];
		if (argv.length && looksLikeClaude(argv)) {
			const env = readProc(pid, "environ") || "";
			const m = env.split("\0").find((e) => e.startsWith("CLAUDE_PROJECT_DIR="));
			return { pid, headless: isPrintMode(argv), projectDir: m ? m.slice("CLAUDE_PROJECT_DIR=".length) : null };
		}
		pid = parentOf(pid);
	}
	return null;
}

/** 조상 중 모든 claude(가장 가까운 것부터). 3층이 일꾼을 띄워 예외를 열게 하는 길을 막는 데 쓴다. */
function claudeAncestors(startPid = process.ppid) {
	const out = [];
	let pid = startPid;
	for (let i = 0; i < 30 && pid > 1; i++) {
		const raw = readProc(pid, "cmdline");
		const argv = raw ? raw.split("\0").filter(Boolean) : [];
		if (argv.length && looksLikeClaude(argv)) {
			const env = readProc(pid, "environ") || "";
			const m = env.split("\0").find((e) => e.startsWith("CLAUDE_PROJECT_DIR="));
			out.push({ pid, headless: isPrintMode(argv), projectDir: m ? m.slice("CLAUDE_PROJECT_DIR=".length) : null });
		}
		pid = parentOf(pid);
	}
	return out;
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
	const starts = [anc && anc.projectDir, !anc && env.CLAUDE_PROJECT_DIR, !anc && !env.CLAUDE_PROJECT_DIR && input && input.cwd].filter(Boolean);
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
		".agents/progress/**",
		".agents/work/**",
		...(Array.isArray(role.cfg.allow) ? role.cfg.allow.filter((g) => typeof g === "string") : []),
	];
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
function classify(target, role) {
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
	const rel = path.relative(repo, real).split(path.sep).join("/");
	if (allowGlobs(role).some((g) => globToRegExp(g).test(rel))) return { ok: true };
	const ex = activeException();
	if (ex && ex.scope.some((s) => inside(real, s))) return { ok: true, exception: ex.id };
	return { ok: false, rule: "repo-write", repo, rel };
}

module.exports = { claudeAncestors, ROLE_FILE, ADK_ROOT, STATE_DIR, EXCEPTION_FILE, AUDIT_FILE, MAX_EXCEPTION_MS, claudeAncestor, leadSession, classify, activeException, audit, realPathLoose, roleConfigFrom };
