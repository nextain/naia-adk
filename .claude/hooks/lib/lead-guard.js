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
const TIER_PROFILE_REL = "config/tier-profile.json";
const ADK_ROOT = path.resolve(__dirname, "../../..");
const STATE_DIR = path.join(ADK_ROOT, ".agents", "lead-guard");
const EXCEPTION_FILE = path.join(STATE_DIR, "exception.json");
const AUDIT_FILE = path.join(STATE_DIR, "audit.jsonl");
const MAX_EXCEPTION_MS = 8 * 60 * 60 * 1000;
const PLACEHOLDER_RE = /<(?:CLI|TIER|MODEL|EFFORT|WORKER)[^>]*>|\{\{[^}]*\}\}|^(?:MODEL_ID|CLI_ID)$/i;

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

function tierProfilePath(env = process.env, role = null) {
	const custom = role && role.cfg && typeof role.cfg.tier_profile === "string" && role.cfg.tier_profile.trim();
	if (custom && path.isAbsolute(custom)) return path.resolve(custom);
	const inst = env && typeof env.NAIA_ADK_ROOT === "string" && env.NAIA_ADK_ROOT.trim()
		? path.resolve(env.NAIA_ADK_ROOT.trim())
		: ADK_ROOT;
	return path.join(inst, "config", "tier-profile.json");
}

function validTierToken(val) {
	if (typeof val !== "string") return false;
	const s = val.trim();
	return s.length > 0 && !/[\r\n]/.test(s) && !PLACEHOLDER_RE.test(s);
}

/**
 * 인스턴스 층 프로파일(config/tier-profile.json)을 읽고 검증한다. 모델 이름 기본값은 절대 두지 않는다.
 * 반환: { status: "ok", configRel, path, priority, tier2 } | { status: "missing", configRel, path } | { status: "broken", configRel, path, reason }
 */
function loadTierProfile({ env = process.env, role = null, filePath } = {}) {
	const targetPath = filePath ? path.resolve(filePath) : tierProfilePath(env, role);
	const broken = (reason) => ({ status: "broken", configRel: TIER_PROFILE_REL, path: targetPath, reason });
	let raw;
	try {
		const st = fs.statSync(targetPath);
		if (!st.isFile() || st.size > 1 << 20) return broken("파일 크기 초과 또는 일반 파일 아님");
		raw = fs.readFileSync(targetPath, "utf8");
	} catch (err) {
		if (err && err.code === "ENOENT") return { status: "missing", configRel: TIER_PROFILE_REL, path: targetPath };
		return broken("파일 읽기 실패");
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return broken("JSON 파싱 실패");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return broken("최상위는 JSON 객체여야 함");
	if (parsed.schema !== undefined && parsed.schema !== "tier-profile/v1") return broken("지원하지 않는 schema");
	let priority = [];
	if (parsed.priority !== undefined) {
		if (!Array.isArray(parsed.priority) || !parsed.priority.length || !parsed.priority.every(validTierToken)) {
			return broken("priority 배열 형식 오류");
		}
		priority = parsed.priority.map((s) => s.trim());
	}
	if (!parsed.tiers || typeof parsed.tiers !== "object" || Array.isArray(parsed.tiers)) return broken("tiers 객체 누락");
	for (const [tierKey, tierVal] of Object.entries(parsed.tiers)) {
		if (!tierVal || typeof tierVal !== "object" || Array.isArray(tierVal)) return broken(`tiers.${tierKey} 형식 오류`);
		if (tierVal.candidates !== undefined) {
			if (!Array.isArray(tierVal.candidates) || !tierVal.candidates.length) return broken(`tiers.${tierKey}.candidates 비어 있음`);
			for (let i = 0; i < tierVal.candidates.length; i++) {
				const c = tierVal.candidates[i];
				if (!c || typeof c !== "object" || Array.isArray(c)) return broken(`tiers.${tierKey}.candidates[${i}] 형식 오류`);
				if (!validTierToken(c.cli)) return broken(`tiers.${tierKey}.candidates[${i}].cli 누락 또는 미치환 자리표시자`);
				if (!validTierToken(c.model)) return broken(`tiers.${tierKey}.candidates[${i}].model 누락 또는 미치환 자리표시자`);
				if (c.effort !== undefined && !validTierToken(c.effort)) return broken(`tiers.${tierKey}.candidates[${i}].effort 형식 오류`);
			}
		}
	}
	const tier2 = parsed.tiers["2"];
	if (!tier2) return broken("tiers.2 누락");
	if (tier2.max_parallel !== undefined && !(Number.isSafeInteger(tier2.max_parallel) && tier2.max_parallel >= 1)) {
		return broken("tiers.2.max_parallel 는 1 이상 정수여야 함");
	}
	if (!Array.isArray(tier2.candidates) || !tier2.candidates.length) return broken("tiers.2.candidates 누락");
	const candidates = [];
	for (let i = 0; i < tier2.candidates.length; i++) {
		const c = tier2.candidates[i];
		const cli = c.cli.trim();
		const model = c.model.trim();
		const effort = c.effort !== undefined ? c.effort.trim() : undefined;
		const tpl = typeof c.command_template === "string" ? c.command_template.trim() : "";
		if (!tpl || /[\r\n]/.test(tpl) || PLACEHOLDER_RE.test(tpl)) {
			return broken(`tiers.2.candidates[${i}].command_template 누락 또는 미치환 자리표시자`);
		}
		if (/\{effort\}/.test(tpl) && !effort) {
			return broken(`tiers.2.candidates[${i}].effort 누락`);
		}
		if (!(tpl.includes("{cli}") || tpl.includes(cli)) || !(tpl.includes("{model}") || tpl.includes(model))) {
			return broken(`tiers.2.candidates[${i}].command_template 가 cli·model 을 포함하지 않음`);
		}
		candidates.push({ cli, model, ...(effort ? { effort } : {}), commandTemplate: tpl });
	}
	return {
		status: "ok",
		configRel: TIER_PROFILE_REL,
		path: targetPath,
		priority,
		tier2: {
			maxParallel: tier2.max_parallel ?? null,
			candidates,
		},
	};
}

function renderTier2Command(candidate, { workDir = "<작업 폴더>" } = {}) {
	const map = {
		cli: candidate.cli,
		model: candidate.model,
		effort: candidate.effort || "",
		prompt_file: `${workDir}/<일>/prompt.md`,
		work_dir: `${workDir}/<일>`,
		result_file: `${workDir}/<일>/result.md`,
	};
	return String(candidate.commandTemplate || "").replace(
		/\{(cli|model|effort|prompt_file|work_dir|result_file)\}/g,
		(_, key) => map[key],
	);
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
 * 막는 것: (1) 자기 보호 — 역할 표지·훅 설정·층 프로파일 설정·예외/감사 기록·사용자 설정, (2) 저장소 작업 트리 안에서 허용 글롭 밖.
 * 저장소 밖(/tmp, 작업 폴더의 지시서·결과, 기억 파일, 진행 기록 파일)은 기본 허용이다.
 */
function classify(target, role, opts = {}) {
	const real = realPathLoose(target);
	const home = os.homedir();
	const env = (opts && opts.env) || process.env;
	const selfProtected = [
		path.join(home, ".claude", "settings.json"), path.join(home, ".claude", "settings.local.json"), path.join(home, ".claude", "hooks"),
		STATE_DIR,
		realPathLoose(path.join(ADK_ROOT, "config", "tier-profile.json")),
		realPathLoose(tierProfilePath(env, role)),
		...(Array.isArray(role.cfg.protect) ? role.cfg.protect.filter((p) => typeof p === "string" && path.isAbsolute(p)).map(realPathLoose) : []),
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

module.exports = { claudeAncestors, ROLE_FILE, TIER_PROFILE_REL, ADK_ROOT, STATE_DIR, EXCEPTION_FILE, AUDIT_FILE, MAX_EXCEPTION_MS, claudeAncestor, leadSession, classify, activeException, audit, realPathLoose, roleConfigFrom, guardMeta, tierProfilePath, loadTierProfile, renderTier2Command, readProcLink };
