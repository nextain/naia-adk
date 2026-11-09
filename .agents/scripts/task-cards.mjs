#!/usr/bin/env node
// 업무 카드 — 역할별 일을 카드 파일로 쌓고 정기 점검하는 대본.
//
// 왜 있나:
// 1) 업무를 받으면 역할별 카드로 만들고 정기 조사해, 급한 일이나 크레딧 때문에 미룰 수는
//    있어도 조용히 사라지지 않게 한다.
// 2) 카드를 대기(waiting/blocked/대기/보류)로 바꿀 때는 정해진 네 가지 까닭(바깥 송출·게시 /
//    운영 배포·운영 접속 / 돈 드는 것 / 다른 사람 결과물)과 다시 볼 시각(recheckAt, 최대
//    지금+4시간), 그리고 사람 승인 기다림(앞 셋)이면 요청 글 주소·번호(requestRef)를 필수로
//    받는다. 이미 지시가 있고 되돌릴 수 있는 일은 대기에 넣지 않고 진행한다.
// 3) 다시 볼 시각(recheckAt)이 지나면 그 인스턴스의 역할 깨움 경로 규칙대로 담당 역할 깨움
//    파일을 한 카드·한 시각당 한 번 만든다. 옛 카드(필드 없는 대기)는 읽기는 되되 감시가
//    "까닭·시각 없는 대기"로 담당을 한 번 깨워 채우거나 진행으로 바꾸게 한다.
// 자세한 규칙은 docs/guides/task-cards.md.
//
// 사용:
//   node .agents/scripts/task-cards.mjs [--root <저장소 뿌리>] [--now <ISO>] [--config <경로>] <명령> ...
//   new --role <역할> --title <제목> --source <원문 주소> [--due <YYYY-MM-DD[THH:MM]>]
//       --next <다음 행동> [--progress <경로>] [--calendar yes|no]
//       [--status doing|waiting] [--wait-reason <까닭>] [--recheck-at <ISO>] [--request-ref <주소>]
//   move <id> [--next <글>] [--status doing|waiting|blocked|대기|보류] [--due ...] [--calendar yes|no]
//       [--progress ...] [--wait-reason <까닭>] [--recheck-at <ISO>] [--request-ref <주소>]
//   wait <id> --wait-reason <까닭> --recheck-at <ISO> [--request-ref <주소>] [--next <글>]
//   defer <id> --reason <사유> --revisit <YYYY-MM-DD>   (둘 다 필수, 하나라도 없으면 오류)
//   done <id> --result <결과 주소>
//   ack --role <역할> --ref <evt 번호 또는 글 번호> --reason <왜 카드가 아닌지>
//   list --role <역할>
//   check [--role <역할>] [--since-hours 72] [--stale-hours 24] [--wake] [--json]
//   board [--wake]
//   tick --role <역할> --session <세션 id> [--every-min 60]
//   to-ledger [<카드 폴더>] <출력 파일>
//
// 지키는 것:
// - 오류는 `[오류] ...` 로 표준 오류에 내고 종료 2. 단 tick 은 훅이 세션을 막지 않게
//   어떤 오류에도 조용히 종료 0, 출력 없음.
// - check 는 문제 있어도 종료 0.
// - 장부(ledger.jsonl)는 덧붙이기만 한다. 고치거나 줄이는 명령은 없다.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

export const DEFAULT_MAX_RECHECK_HOURS = 4;

export const WAIT_REASONS = Object.freeze([
	"바깥 송출·게시",
	"운영 배포·운영 접속",
	"돈 드는 것",
	"다른 사람 결과물",
]);

export const HUMAN_APPROVAL_WAIT_REASONS = Object.freeze([
	"바깥 송출·게시",
	"운영 배포·운영 접속",
	"돈 드는 것",
]);

const WAITING_STATUS_INPUTS = new Set(["waiting", "blocked", "대기", "보류"]);
const DOING_STATUS_INPUTS = new Set(["doing", "진행", "진행 중", "진행중"]);

const ROLE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const DEFER_MAX_MS = 366 * 24 * 3600_000;

// 장부용 시각: 날짜만·초 없는 시각·시간대 붙은 시각을 Z 표준 ISO 로 바꾸고, 없는 날(2/30)·숫자 하나(0) 등은 null.
export function strictIso(v) {
	if (typeof v !== "string" || !v) return null;
	const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(v.trim());
	if (!m) return null;
	const [, y, mo, d] = m.map((x) => x);
	const day = new Date(Date.UTC(+y, +mo - 1, +d));
	if (day.getUTCFullYear() !== +y || day.getUTCMonth() !== +mo - 1 || day.getUTCDate() !== +d) return null;
	const s = m[4] === undefined ? `${v.trim()}T23:59:59Z` : m[7] === undefined ? `${v.trim()}Z` : v.trim();
	const ms = Date.parse(s);
	return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function isKnownStatus(status) {
	return status === "doing" || status === "done" || status === "deferred" || isWaitingStatus(status);
}
const STATUS_KO = {
	doing: "진행",
	waiting: "대기",
	blocked: "대기",
	대기: "대기",
	보류: "대기",
	deferred: "미룸",
	done: "끝",
};
const KIND_KO = {
	"wait-recheck": "다시 볼 시각 지남",
	"legacy-waiting": "까닭·시각 없는 대기",
	overdue: "기한 지남",
	stale: "멈춤",
	revisit: "다시 볼 날 지남",
	"missing-field": "빠진 칸",
	vanished: "사라진 카드",
	"unlinked-inbox": "카드 없는 대표님 지시",
	"no-calendar": "캘린더 안 올림",
	repeat: "계속 밀리는 일",
};
const CHECK_ORDER = [
	"unlinked-inbox",
	"overdue",
	"stale",
	"wait-recheck",
	"legacy-waiting",
	"revisit",
	"missing-field",
	"vanished",
	"no-calendar",
	"repeat",
];
const CARD_KEYS = [
	"id",
	"title",
	"owner",
	"status",
	"source",
	"received",
	"due",
	"next",
	"moved",
	"calendar",
	"progress",
	"wait_reason",
	"recheck_at",
	"request_ref",
	"defer_reason",
	"revisit",
	"defer_count",
	"result",
];
const DUE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;
const RECHECK_WITH_TZ_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:\d{2})$/;

export function fail(message) {
	throw new Error(message);
}

function isPlainObject(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseCli(argv) {
	const global = { root: DEFAULT_ROOT, now: null, configPath: null, ownerIds: [], maxRecheckHours: null };
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--root" && i + 1 < argv.length) { global.root = argv[++i]; continue; }
		if (arg.startsWith("--root=")) { global.root = arg.slice("--root=".length); continue; }
		if (arg === "--now" && i + 1 < argv.length) { global.now = argv[++i]; continue; }
		if (arg.startsWith("--now=")) { global.now = arg.slice("--now=".length); continue; }
		if (arg === "--config" && i + 1 < argv.length) { global.configPath = argv[++i]; continue; }
		if (arg.startsWith("--config=")) { global.configPath = arg.slice("--config=".length); continue; }
		if (arg === "--owner-id" && i + 1 < argv.length) { global.ownerIds.push(argv[++i]); continue; }
		if (arg.startsWith("--owner-id=")) { global.ownerIds.push(arg.slice("--owner-id=".length)); continue; }
		if (arg === "--max-recheck-hours" && i + 1 < argv.length) { global.maxRecheckHours = Number(argv[++i]); continue; }
		if (arg.startsWith("--max-recheck-hours=")) { global.maxRecheckHours = Number(arg.slice("--max-recheck-hours=".length)); continue; }
		rest.push(arg);
	}
	return { global, rest };
}

const BOOLEAN_FLAGS = new Set(["no-wake", "wake", "json"]);

function parseFlags(args) {
	const flags = {};
	const positional = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			if (eq >= 0) { flags[arg.slice(2, eq)] = arg.slice(eq + 1); continue; }
			const key = arg.slice(2);
			if (BOOLEAN_FLAGS.has(key)) { flags[key] = "yes"; continue; }
			if (i + 1 < args.length && !args[i + 1].startsWith("--")) flags[key] = args[++i];
			else {
				if (["wait-reason", "waitReason", "wait_reason", "recheck-at", "recheckAt", "recheck_at", "request-ref", "requestRef", "request_ref", "reason", "revisit"].includes(key)) fail(`--${key} 값이 필요합니다`);
				flags[key] = "yes";
			}
		} else positional.push(arg);
	}
	return { flags, positional };
}

export function loadTaskCardsConfig(root, options = {}) {
	const explicitPath = options.configPath || process.env.ADK_TASK_CARDS_CONFIG || null;
	const candidates = explicitPath
		? [path.resolve(root, explicitPath)]
		: [
			path.join(root, "config", "task-cards.json"),
			path.join(root, ".agents", "context", "task-cards.json"),
		];
	let rawConfig = {};
	for (const candidate of candidates) {
		if (!fs.existsSync(candidate)) continue;
		try {
			const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
			if (isPlainObject(parsed)) {
				rawConfig = parsed;
				break;
			}
		} catch (err) {
			if (explicitPath) fail(`설정 파일을 읽을 수 없습니다(${candidate}): ${err.message}`);
		}
	}

	if (rawConfig.timeZone && rawConfig.timeZone !== "UTC") fail("task-cards timeZone must be UTC");
	let maxRecheckHours = DEFAULT_MAX_RECHECK_HOURS;
	if (options.maxRecheckHours !== undefined && options.maxRecheckHours !== null) {
		maxRecheckHours = Number(options.maxRecheckHours);
	} else if (rawConfig.maxRecheckHours !== undefined) {
		maxRecheckHours = Number(rawConfig.maxRecheckHours);
	} else if (process.env.ADK_MAX_RECHECK_HOURS) {
		maxRecheckHours = Number(process.env.ADK_MAX_RECHECK_HOURS);
	}
	if (!Number.isFinite(maxRecheckHours) || maxRecheckHours <= 0) {
		fail(`최대 다시 볼 시간(maxRecheckHours)은 양수여야 합니다: ${maxRecheckHours}`);
	}

	const ownerIds = new Set();
	for (const id of options.ownerIds || []) {
		if (typeof id === "string" && id.trim()) ownerIds.add(id.trim());
	}
	if (Array.isArray(rawConfig.ownerSenderIds)) {
		for (const id of rawConfig.ownerSenderIds) {
			if (typeof id === "string" && id.trim() && !id.includes("<")) ownerIds.add(id.trim());
		}
	}
	if (process.env.ADK_OWNER_SENDER_IDS) {
		for (const id of process.env.ADK_OWNER_SENDER_IDS.split(",")) {
			if (id.trim()) ownerIds.add(id.trim());
		}
	}
	// 인스턴스 로컬 파일(.agents/work/l4/discord-watch.json)에 대표님 ID가 있으면 함께 읽는다.
	const discordWatchPath = path.join(root, ".agents", "work", "l4", "discord-watch.json");
	if (fs.existsSync(discordWatchPath)) {
		try {
			const dw = JSON.parse(fs.readFileSync(discordWatchPath, "utf8"));
			for (const list of [dw?.ownerUserIds]) {
				if (Array.isArray(list)) {
					for (const id of list) {
						if (typeof id === "string" && id.trim()) ownerIds.add(id.trim());
					}
				}
			}
		} catch { /* 무시 */ }
	}


	return {
		timeZone: "UTC",
		wakeRoot: rawConfig.wakeRoot,
		stateFile: rawConfig.stateFile,
		maxRecheckHours,
		ownerSenderIds: [...ownerIds],
	};
}

export function checkRole(role) {
	if (!ROLE_RE.test(role || "")) fail(`역할 이름이 틀렸습니다: ${role}`);
	return role;
}

export function checkId(id) {
	const base = String(id || "").replace(/\.md$/, "");
	if (!base || base.length > 160 || base.startsWith(".") || base.includes("..") || /[\\/]/.test(base)) {
		fail(`카드 id가 폴더를 벗어납니다: ${id}`);
	}
	return base;
}

function nowMs(nowOpt) {
	if (!nowOpt) return Date.now();
	const ms = Date.parse(nowOpt);
	if (!Number.isFinite(ms)) fail(`시각(--now)이 틀렸습니다: ${nowOpt}`);
	return ms;
}

function nowIso(ms) {
	return new Date(ms).toISOString();
}

function datePrefix(ms) {
	return nowIso(ms).slice(0, 10).replaceAll("-", "");
}

export function timestampKey(date = new Date()) {
	return date.toISOString().replace(/[-:.TZ]/g, "");
}

// 제목에서 파일 이름에 쓸 짧은이름을 뽑는다. 한글은 살리고 칸은 붙임표로.
export function slugify(title) {
	const slug = String(title || "").trim().replace(/[\s_]+/g, "-").replace(/[^0-9A-Za-z가-힣_-]/g, "").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
	return slug || "card";
}

function validCalendarDate(datePart) {
	const ms = Date.parse(`${datePart}T00:00:00Z`);
	if (!Number.isFinite(ms)) return false;
	return new Date(ms).toISOString().slice(0, 10) === datePart;
}

// 날짜만이면 그날 끝(UTC), 시각까지 있으면 그 시각(UTC)으로 읽는다.
export function dueMs(value) {
	if (!value) return null;
	const text = String(value).trim();
	if (RECHECK_WITH_TZ_RE.test(text)) {
		const ms = tryRecheckMs(text);
		if (ms === null) fail(`날짜가 틀렸습니다: ${value}`);
		return ms;
	}
	if (!DUE_RE.test(text)) fail(`날짜가 틀렸습니다(YYYY-MM-DD 또는 YYYY-MM-DDTHH:MM): ${value}`);
	const datePart = text.slice(0, 10);
	if (!validCalendarDate(datePart)) fail(`날짜가 틀렸습니다: ${value}`);
	const ms = text.length === 10 ? Date.parse(`${text}T23:59:59Z`) : Date.parse(`${text}:00Z`);
	if (!Number.isFinite(ms)) fail(`날짜가 틀렸습니다: ${value}`);
	return ms;
}

export function tryDueMs(value) {
	try { return dueMs(value); } catch { return null; }
}

function meaningful(value) {
	return !!String(value || "").trim() && !/^(?:0+|-|없음|none|null|n\/a|yes)$/i.test(String(value).trim());
}

// Waiting wake timestamps require an explicit ISO-8601 timezone.
export function tryRecheckMs(value) {
	if (value === undefined || value === null) return null;
	const text = String(value).trim();
	if (!text) return null;
	let datePart = null;
	let isoText = null;
	let match = RECHECK_WITH_TZ_RE.exec(text);
	if (match) {
		datePart = match[1];
		const timePart = match[2].length === 5 ? `${match[2]}:00` : match[2];
		isoText = `${match[1]}T${timePart}${match[3]}`;
	} else {
		return null;
	}
	if (!validCalendarDate(datePart)) return null;
	const ms = Date.parse(isoText);
	return Number.isFinite(ms) ? ms : null;
}

export function recheckMs(value) {
	const ms = tryRecheckMs(value);
	if (ms === null) {
		fail(`다시 볼 시각(--recheck-at) 형식이 틀렸습니다(시간대 Z 또는 ±HH:MM을 포함한 ISO 시각): ${value}`);
	}
	return ms;
}

export function isWaitingStatus(status) {
	return WAITING_STATUS_INPUTS.has(String(status || "").trim());
}

export function normalizeMoveStatus(status) {
	const raw = String(status || "").trim();
	if (DOING_STATUS_INPUTS.has(raw)) return "doing";
	if (WAITING_STATUS_INPUTS.has(raw)) return "waiting";
	fail("move 상태는 doing(진행) 또는 waiting(대기/blocked/보류)입니다");
}

export function normalizeWaitReason(value) {
	if (value === undefined || value === null) return null;
	const trimmed = String(value).trim()
		.replace(/^바깥\s*송출\s*[·•ㆍ/.]\s*게시$/, "바깥 송출·게시")
		.replace(/^운영\s*배포\s*[·•ㆍ/.]\s*운영\s*접속$/, "운영 배포·운영 접속");
	return WAIT_REASONS.includes(trimmed) ? trimmed : null;
}

export function validRequestRef(value) {
	const text = String(value || "").trim();
	if (!meaningful(text.replace(/^(?:#|discord:|evt-)/, ""))) return false;
	return /^(?:https?:\/\/\S+|discord:\S+|#\S+|\d+|evt-[a-zA-Z0-9_-]+)$/.test(String(value || "").trim());
}

export function validateWaitCardFields({ waitReason, recheckAt, requestRef, now = Date.now(), maxRecheckHours = DEFAULT_MAX_RECHECK_HOURS }) {
	const canonicalReason = normalizeWaitReason(waitReason);
	if (!canonicalReason) {
		fail(
			`대기 까닭(--wait-reason)은 넷(${WAIT_REASONS.join(" / ")}) 중 하나여야 합니다. 그 밖의 일은 대기에 넣지 말고 진행으로 두고 바로 하십시오.`
		);
	}
	const rawRecheck = recheckAt === undefined || recheckAt === null ? "" : String(recheckAt).trim();
	if (!rawRecheck) {
		fail("대기 상태에는 다시 볼 시각(--recheck-at)이 필수입니다.");
	}
	const targetMs = recheckMs(rawRecheck);
	if (targetMs <= now) {
		fail(`다시 볼 시각(--recheck-at)은 현재 시각(${nowIso(now)}) 이후여야 합니다: ${rawRecheck}`);
	}
	const maxMs = now + maxRecheckHours * 3600_000;
	if (targetMs > maxMs) {
		fail(`다시 볼 시각(--recheck-at)은 최대 지금+${maxRecheckHours}시간(${nowIso(maxMs)}) 이내여야 합니다: ${rawRecheck}`);
	}
	const cleanRef = requestRef === undefined || requestRef === null ? "" : String(requestRef).trim();
	if (HUMAN_APPROVAL_WAIT_REASONS.includes(canonicalReason) && !validRequestRef(cleanRef)) {
		fail(`사람 승인 기다림(${canonicalReason})에는 요청 글 주소·번호(--request-ref, 예: #업무-요청 글 주소/번호)가 필수입니다.`);
	}
	return {
		wait_reason: canonicalReason,
		recheck_at: new Date(targetMs).toISOString(),
		request_ref: cleanRef,
	};
}

export function parseCard(text) {
	const match = String(text).match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!match) fail("카드 머리(--- 칸)가 없습니다");
	const card = {};
	for (const line of match[1].split("\n")) {
		if (!line.trim()) continue;
		const idx = line.indexOf(":");
		if (idx < 0) continue;
		card[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}
	card.wait_reason = card.wait_reason ?? card.waitReason ?? "";
	card.recheck_at = card.recheck_at ?? card.recheckAt ?? "";
	card.request_ref = card.request_ref ?? card.requestRef ?? "";
	card.defer_count = Number.parseInt(card.defer_count || "0", 10) || 0;
	card.body = match[2];
	return card;
}

export function serializeCard(card) {
	const lines = ["---"];
	for (const key of CARD_KEYS) {
		let value = card[key] ?? "";
		if (key === "defer_count") value = String(Number.parseInt(value, 10) || 0);
		lines.push(`${key}: ${String(value).replace(/\n/g, " ")}`);
	}
	lines.push("---", card.body || "");
	return lines.join("\n");
}

// ── 저장소 자리 ─────────────────────────────────────────────

export function cardsDir(root, role) {
	return path.join(root, "docs", "common", "team", "cards", role);
}

export function cardFile(root, role, id) {
	return path.join(cardsDir(root, role), `${id}.md`);
}

export function ledgerFile(root) {
	return path.join(root, "docs", "common", "team", "cards", "ledger.jsonl");
}

export function boardFile(root) {
	return path.join(root, "docs", "common", "team", "cards", "index.md");
}

export function inboxDir(root, role) {
	return path.join(root, ".agents", "work", "l4", "role-inbox", role);
}

export function tickFile(root, session) {
	return path.join(root, ".agents", "work", "task-cards", `tick-${session}.json`);
}

export function waitWakeStateFile(root, config = null) {
	const cfg = config || loadTaskCardsConfig(root);
	return path.resolve(root, cfg.stateFile || ".agents/work/task-cards/wait-wake-state.json");
}

// All roles share the consumer folder; route-role in the filename selects the recipient.
export function resolveRoleWakeDir(root, role, config = null) {
	checkRole(role);
	const cfg = config || loadTaskCardsConfig(root);
	return path.resolve(root, cfg.wakeRoot || ".agents/work/l4/wake");
}

function writeAtomic(filePath, content) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
	fs.writeFileSync(tmpPath, content, { mode: 0o600 });
	fs.renameSync(tmpPath, filePath);
	try { fs.chmodSync(filePath, 0o600); } catch { /* 무시 */ }
}

function loadWaitWakeState(root, config) {
	const file = waitWakeStateFile(root, config);
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		if (isPlainObject(parsed) && parsed.version === 1 && isPlainObject(parsed.sent)) {
			return parsed;
		}
	} catch { /* 무시 */ }
	return { version: 1, sent: {} };
}

function saveWaitWakeState(root, state, config) {
	writeAtomic(waitWakeStateFile(root, config), `${JSON.stringify(state, null, 2)}\n`);
}

function safeWakeSlug(id) {
	const cleaned = String(id || "")
		.replace(/[^0-9A-Za-z가-힣_-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	return cleaned || "card";
}

// recheckAt 경과 및 옛 대기 카드(까닭·시각 없는 대기)에 대해 담당 역할 깨움 파일을
// 한 카드·한 시각당 한 번(옛 카드는 카드당 한 번) 만든다.
export function emitWaitWakes(root, problems, { now = Date.now(), config = null, roles = null } = {}) {
	const cfg = config || loadTaskCardsConfig(root);
	const targets = problems.filter(p => p.wakeKey);
	const state = loadWaitWakeState(root, cfg);
	const active = new Set(targets.map(p => p.wakeKey));
	// Reconcile only observed roles, including direct edits, deleted cards and changed schedules.
	for (const [key, receipt] of Object.entries(state.sent)) {
		if ((!roles || roles.includes(receipt.role)) && !active.has(key)) delete state.sent[key];
	}
	const groups = new Map();
	for (const p of targets) {
		if (state.sent[p.wakeKey]) continue;
		if (!groups.has(p.role)) groups.set(p.role, []);
		groups.get(p.role).push(p);
	}
	const created = [];
	let seq = 0;
	for (const [role, batch] of groups) {
		const file = path.join(resolveRoleWakeDir(root, role, cfg), `${timestampKey(new Date(now + seq++))}-task-card-${safeWakeSlug(batch[0].id)}-route-${role}.md`);
		const body = ["# 업무 카드 다시 보기 깨움", "", `- 시각: ${nowIso(now)}`, `- 역할: ${role}`,
			...batch.map(p => `- 카드: ${p.id} [${KIND_KO[p.kind]}] — ${p.reason}`), "",
			`정해진 네 가지 대기 까닭(${WAIT_REASONS.join(" / ")}), --recheck-at(시간대 필수, 최대 지금+${cfg.maxRecheckHours}시간), 승인 요청 --request-ref를 채우십시오.`,
			"이미 지시가 있고 되돌릴 수 있는 일은 대기에 넣지 않고 진행(--status doing). 끝났거나 넘긴 일은 done <id> --result <주소>, 날짜 지정 미룸은 defer <id> --reason <사유> --revisit <YYYY-MM-DD>. 다시 볼 날이 지나면 한 번 깨웁니다.", ""].join("\n");
		writeAtomic(file, body);
		for (const p of batch) state.sent[p.wakeKey] = { at: nowIso(now), role, id: p.id, kind: p.kind, wakeFile: path.relative(root, file) };
		created.push({ role, file, count: batch.length });
	}
	if (targets.length || Object.keys(state.sent).length || fs.existsSync(waitWakeStateFile(root, cfg))) saveWaitWakeState(root, state, cfg);
	return created;
}

// id 로 역할 폴더들을 뒤져 카드 자리를 찾는다. 둘 이상이면 그대로 멈춘다.
export function findCard(root, id) {
	const base = checkId(id);
	const dir = path.join(root, "docs", "common", "team", "cards");
	let entries = [];
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { entries = []; }
	const hits = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !ROLE_RE.test(entry.name)) continue;
		const file = path.join(dir, entry.name, `${base}.md`);
		let stat = null;
		try { stat = fs.statSync(file); } catch { continue; }
		if (stat.isFile()) hits.push({ role: entry.name, file });
	}
	if (hits.length === 0) fail(`카드가 없습니다: ${base}`);
	if (hits.length > 1) fail(`카드가 둘 이상 있습니다(${hits.map((h) => `${h.role}/${base}`).join(", ")}) — 하나를 지우거나 id를 고치세요`);
	return { ...hits[0], id: base };
}

export function loadCard(file) {
	return { ...parseCard(fs.readFileSync(file, "utf8")), file };
}

// 끝난 카드까지 전부. 파일이 깨졌으면 건너뛰지 않고 멈춘다(조용히 놓치는 쪽이 더 해롭다).
// 옛 카드(wait_reason·recheck_at 없는 대기)도 읽기는 그대로 된다.
export function loadRoleCards(root, role, cardsBaseDir = null) {
	checkRole(role);
	const dir = cardsBaseDir ? path.join(cardsBaseDir, role) : cardsDir(root, role);
	let names = [];
	try { names = fs.readdirSync(dir); } catch { return []; }
	const cards = [];
	for (const name of names.sort()) {
		if (!name.endsWith(".md")) continue;
		const id = name.slice(0, -3);
		try { checkId(id); } catch { continue; }
		cards.push({ role, id, ...loadCard(path.join(dir, name)) });
	}
	return cards;
}

export function discoverRoles(root, cardsBaseDir = null) {
	const roles = new Set();
	for (const sub of ["docs/common/team/cards", ".agents/work/l4/role-inbox"]) {
		let entries = [];
		try { entries = fs.readdirSync(cardsBaseDir && sub === "docs/common/team/cards" ? cardsBaseDir : path.join(root, sub), { withFileTypes: true }); } catch { continue; }
		for (const entry of entries) {
			if (entry.isDirectory() && ROLE_RE.test(entry.name)) roles.add(entry.name);
		}
	}
	return [...roles].sort();
}

export function appendLedger(root, entry) {
	const file = ledgerFile(root);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

export function readLedger(root) {
	let text = "";
	try { text = fs.readFileSync(ledgerFile(root), "utf8"); } catch { return []; }
	const out = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try { out.push(JSON.parse(line)); } catch { continue; }
	}
	return out;
}

export function statusKo(status) {
	return STATUS_KO[status] || status;
}

function compareDue(a, b) {
	const am = tryDueMs(a.due), bm = tryDueMs(b.due);
	if (am === null && bm === null) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	if (am === null) return 1;
	if (bm === null) return -1;
	return am - bm || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function listLines(cards) {
	return cards
		.filter((c) => c.status !== "done")
		.sort(compareDue)
		.map((c) => {
			const base = `- [${statusKo(c.status)}] ${c.id} | 예상 완료: ${c.due || "없음"} | 다음 행동: ${c.next || "없음"} | 마지막 움직임: ${c.moved || "없음"}`;
			if (isWaitingStatus(c.status) && (c.wait_reason || c.recheck_at)) {
				return `${base} | 대기 까닭: ${c.wait_reason || "없음"} | 다시 볼 시각: ${c.recheck_at || "없음"}`;
			}
			return base;
		});
}

// ── 점검 ─────────────────────────────────────────────

function escapeRegExp(text) {
	return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 받은편지함에서 대표님(소유자) 글 판별: 머리 "- 보낸 사람:" 줄의 괄호 안 작성자 아이디만 본다.
// 다른 사람이 본문에서 멘션(<@id> 등)한 글은 지시로 잡지 않는다.
export function isOwnerMail(text, ownerSenderIds = []) {
	if (!Array.isArray(ownerSenderIds) || ownerSenderIds.length === 0) return false;
	const src = String(text || "");
	return ownerSenderIds.some((id) => {
		const clean = String(id || "").trim();
		if (!clean) return false;
		const re = new RegExp(`^-\\s*보낸 사람:\\s*.*\\(${escapeRegExp(clean)}\\)`, "m");
		return re.test(src);
	});
}



// 카드와 받은편지를 잇는 고리: 글 번호(메시지 아이디)와 사건(evt) 번호만 쓴다.
const EVT_RE = /\bevt-[0-9a-f]{4,}\b/g;
const MSGID_RE = /\b\d{17,20}\b/g;

function inboxLinkRefs(text, name) {
	const refs = new Set();
	const src = String(text || "");
	for (const m of src.matchAll(EVT_RE)) refs.add(m[0]);
	for (const m of String(name || "").matchAll(EVT_RE)) refs.add(m[0]);
	for (const line of src.split("\n")) {
		if (!/^-\s*원문 글\s*:/.test(line)) continue;
		for (const m of line.matchAll(EVT_RE)) refs.add(m[0]);
		for (const m of line.matchAll(MSGID_RE)) refs.add(m[0]);
	}
	return [...refs];
}

function sourceLinkRefs(source) {
	const refs = new Set();
	const src = String(source || "");
	for (const m of src.matchAll(EVT_RE)) refs.add(m[0]);
	for (const m of src.matchAll(MSGID_RE)) refs.add(m[0]);
	return refs;
}

function inboxFiles(root, role) {
	const seen = new Set();
	const out = [];
	for (const sub of ["", "read"]) {
		let names = [];
		try {
			names = fs.readdirSync(path.join(inboxDir(root, role), sub)).filter((n) => n.endsWith(".md")).sort();
		} catch { continue; }
		for (const name of names) {
			if (seen.has(name)) continue;
			seen.add(name);
			out.push({ sub, name });
		}
	}
	return out;
}

// 점검 항목 + 대기 카드(recheckAt 경과·옛 카드) 점검 및 깨움 생성.
export function runCheck(root, roles, { now = Date.now(), sinceHours = 72, staleHours = 24, wake = true, config = null, cardsBaseDir = null } = {}) {
	const cfg = config || loadTaskCardsConfig(root);
	const problems = [];
	const ledger = readLedger(root);
	const acksByRole = new Map();
	for (const entry of ledger) {
		if (entry.cmd !== "ack" || !entry.role) continue;
		if (!acksByRole.has(entry.role)) acksByRole.set(entry.role, new Set());
		if (entry.ref) acksByRole.get(entry.role).add(String(entry.ref));
		if (entry.id) acksByRole.get(entry.role).add(String(entry.id));
	}
	// 사라진 카드 — 장부엔 있는데 파일이 없다. ack 줄은 파일이 아니라서 뺀다.
	const seenMissing = new Set();
	for (const entry of ledger) {
		if (!["new", "move", "wait", "defer", "done"].includes(entry.cmd) || !entry.role || !entry.id) continue;
		let id = null;
		try { id = checkId(entry.id); } catch { continue; }
		const key = `${entry.role}/${id}`;
		if (seenMissing.has(key)) continue;
		seenMissing.add(key);
		let stat = null;
		try { stat = fs.statSync(cardsBaseDir ? path.join(cardsBaseDir, entry.role, `${id}.md`) : cardFile(root, entry.role, id)); } catch { stat = null; }
		if (!stat || !stat.isFile()) {
			problems.push({ kind: "vanished", role: entry.role, id, reason: `장부(${entry.cmd})에는 있는데 파일이 없습니다` });
		}
	}
	for (const role of roles) {
		const cards = loadRoleCards(root, role, cardsBaseDir);
		for (const card of cards) {
			const open = card.status !== "done";
			if (!isKnownStatus(card.status)) {
				problems.push({ kind: "missing-field", role, id: card.id, wakeKey: `invalid-status:${role}/${card.id}@${card.status}`, reason: `알 수 없는 상태 ${JSON.stringify(card.status ?? "")} — doing·waiting·deferred·done 중 하나로 고치십시오` });
			}
			const due = tryDueMs(card.due || "");
			if (card.due && due === null) problems.push({ kind: "missing-field", role, id: card.id, reason: "잘못된 due 날짜" });
			// 1. 기한 지남
			if (open && due !== null && due < now) {
				problems.push({ kind: "overdue", role, id: card.id, reason: `예상 완료 ${card.due} 가 지났습니다` });
			}
			// 2. 멈춤 — 진행인데 움직임이 staleHours 넘게 없음
			const moved = card.moved ? Date.parse(card.moved) : NaN;
			if (card.status === "doing") {
				if (!Number.isFinite(moved)) {
					problems.push({ kind: "missing-field", role, id: card.id, reason: "마지막 움직임이 비었습니다" });
				} else if (now - moved > staleHours * 3600_000) {
					problems.push({ kind: "stale", role, id: card.id, reason: `마지막 움직임 ${card.moved} 뒤 움직임이 없습니다` });
				}
			}
			// 대기 카드(waiting/blocked/대기/보류) 점검:
			// - 옛 카드(필드 없는 대기 또는 넷 밖 까닭·승인 요청 주소 누락) → "까닭·시각 없는 대기"로 한 번 깨움
			// - 정상 대기 카드인데 recheckAt 이 지남 → 한 카드·한 시각당 한 번 깨움
			if (isWaitingStatus(card.status)) {
				const canonicalReason = normalizeWaitReason(card.wait_reason);
				const recheck = tryRecheckMs(card.recheck_at);
				const needsRef = canonicalReason && HUMAN_APPROVAL_WAIT_REASONS.includes(canonicalReason);
				const hasRef = !needsRef || validRequestRef(card.request_ref);
				const tooFar = recheck !== null && recheck > now + cfg.maxRecheckHours * 3600_000;
				if (!canonicalReason || recheck === null || tooFar || !hasRef) {
					const missingParts = [];
					if (!canonicalReason) missingParts.push("waitReason");
					if (recheck === null || tooFar) missingParts.push("recheckAt");
					if (!hasRef) missingParts.push("requestRef");
					problems.push({
						kind: "legacy-waiting",
						role,
						id: card.id,
						title: card.title || card.id,
						reason: `까닭·시각 없는 대기(${missingParts.join(", ")} 누락) — 대기 까닭·다시 볼 시각을 채우거나 진행으로 바꾸십시오`,
						wakeKey: `legacy-waiting:${role}/${card.id}`,
					});
				} else if (now >= recheck) {
					problems.push({
						kind: "wait-recheck",
						role,
						id: card.id,
						title: card.title || card.id,
						waitReason: canonicalReason,
						recheckAt: card.recheck_at,
						requestRef: card.request_ref || "",
						reason: `다시 볼 시각 ${card.recheck_at} 가 지났습니다(까닭: ${canonicalReason}${card.request_ref ? `, 요청: ${card.request_ref}` : ""})`,
						wakeKey: `wait-recheck:${role}/${card.id}@${card.recheck_at}`,
					});
				}
			}
			// 3. 다시 볼 날 지남
			if (card.status === "deferred" && card.revisit) {
				const revisit = tryDueMs(card.revisit);
				if (revisit !== null && revisit < now) {
					problems.push({ kind: "revisit", role, id: card.id, wakeKey: `revisit:${role}/${card.id}@${card.revisit}`, reason: `다시 볼 날 ${card.revisit} 가 지났습니다(사유: ${card.defer_reason || "없음"})` });
				}
			}
			// 4. 빠진 칸 — 끝인데 결과 없음, 미룸인데 사유·날짜 없음
			if (card.status === "done" && !card.result) {
				problems.push({ kind: "missing-field", role, id: card.id, reason: "끝냈는데 결과 주소가 없습니다" });
			}
			const revisitMs = /^\d{4}-\d{2}-\d{2}$/.test(card.revisit || "") ? tryDueMs(card.revisit) : null;
			if (card.status === "deferred" && (!meaningful(card.defer_reason) || revisitMs === null || revisitMs > now + DEFER_MAX_MS)) {
				problems.push({ kind: "missing-field", role, id: card.id, wakeKey: `invalid-deferred:${role}/${card.id}`, reason: "미룸인데 사유·다시 볼 날이 비었습니다" });
			}
			// 7. 캘린더 안 올림 — 예상 완료가 있는데 회사 캘린더에 안 올림
			if (open && card.due && card.calendar !== "yes") {
				problems.push({ kind: "no-calendar", role, id: card.id, reason: `예상 완료 ${card.due} 인데 캘린더 등록이 없습니다` });
			}
			// 8. 계속 밀리는 일 — 두 번 이상 미룸, 또는 기한을 이틀 넘게 넘김
			if (open && (card.defer_count >= 2 || (due !== null && now - due > 48 * 3600_000))) {
				const why = card.defer_count >= 2 ? `미룸 ${card.defer_count}번` : `기한 ${card.due}를 이틀 넘게 넘김`;
				problems.push({ kind: "repeat", role, id: card.id, reason: `${why} — 다른 역할 투입·넘김을 검토하세요` });
			}
		}
		// 6. 카드 없는 대표님 지시 — 최근 받은편지 중 소유자 글인데 카드 source·ack 어디에도 없음
		const acks = acksByRole.get(role) || new Set();
		for (const { sub, name } of inboxFiles(root, role)) {
			const file = path.join(inboxDir(root, role), sub, name);
			let stat = null;
			try { stat = fs.statSync(file); } catch { continue; }
			if (!stat.isFile() || now - stat.mtimeMs > sinceHours * 3600_000) continue;
			let text = "";
			try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
			if (!isOwnerMail(text, cfg.ownerSenderIds)) continue;
			const refs = inboxLinkRefs(text, name);
			const linked = refs.length > 0 && refs.some((ref) =>
				cards.some((c) => sourceLinkRefs(c.source).has(ref)) || acks.has(ref));
			if (!linked) {
				const hint = refs.length > 0 ? refs[0] : "연결 고리 없음";
				problems.push({ kind: "unlinked-inbox", role, id: name.replace(/\.md$/, ""), reason: `대표님 지시(${hint})에 연결된 카드·ack가 없습니다` });
			}
		}
	}
	const rank = new Map(CHECK_ORDER.map((k, i) => [k, i]));
	problems.sort((a, b) => (rank.get(a.kind) ?? 99) - (rank.get(b.kind) ?? 99) || (a.role < b.role ? -1 : a.role > b.role ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	if (wake) {
		emitWaitWakes(root, problems, { now, config: cfg, roles });
	}
	return problems;
}

export function formatProblems(problems) {
	if (problems.length === 0) return ["놓친 일 없음"];
	return problems.map((p) => `[${KIND_KO[p.kind] || p.kind}] ${p.role}/${p.id} — ${p.reason}`);
}

export function repeatProblems(problems) {
	return problems.filter((p) => p.kind === "repeat");
}

// 업무 카드 폴더를 session-health 호환 작업 원장(JSON)으로 내보내고 대기 카드 깨움을 함께 점검한다.
export function cardsToLedger(root, cardsDirPath, outFilePath, { now = Date.now(), wake = true, config = null } = {}) {
	const STATUS_MAP = {
		doing: "진행 중",
		waiting: "대기",
		deferred: "대기",
		blocked: "막힘",
		대기: "대기",
		보류: "대기",
		done: "끝",
	};
	const iso = strictIso;
	const work = [];
	let roleDirs = [];
	try { roleDirs = fs.readdirSync(cardsDirPath); } catch { roleDirs = []; }
	for (const role of roleDirs.sort()) {
		const dir = path.join(cardsDirPath, role);
		let st = null;
		try { st = fs.statSync(dir); } catch { continue; }
		if (!st || !st.isDirectory()) continue;
		for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
			const p = path.join(dir, f);
			let c = null;
			try { c = parseCard(fs.readFileSync(p, "utf8")); } catch { continue; }
			if (!c?.id) continue;
			const status = STATUS_MAP[c.status] ?? "막힘";
			const clamp = (v) => (v && Date.parse(v) > now ? new Date(now).toISOString() : v);
			const updated = clamp(iso(c.moved) ?? new Date(fs.statSync(p).mtimeMs).toISOString());
			let requested = clamp(iso(c.received) ?? updated);
			if (Date.parse(requested) > Date.parse(updated)) requested = updated;
			const cardRef = `${role}/${f}`;
			const recheck = tryRecheckMs(c.recheck_at);
			work.push({
				id: c.id,
				role: c.owner || role,
				task: c.title || c.id,
				status,
				requested_at: requested,
				due_at: isWaitingStatus(c.status) ? (recheck === null ? null : new Date(recheck).toISOString()) : iso(c.status === "deferred" ? c.revisit : c.due),
				evidence: c.source || cardRef,
				result: c.result || (status === "끝" ? cardRef : null),
				updated_at: updated,
				...(c.wait_reason ? { wait_reason: c.wait_reason } : {}),
				...(c.request_ref ? { request_ref: c.request_ref } : {}),
			});
		}
	}
	writeAtomic(outFilePath, `${JSON.stringify({ version: 1, work }, null, 2)}\n`);
	if (wake) {
		const roles = discoverRoles(root, cardsDirPath);
		runCheck(root, roles, { now, wake: true, config, cardsBaseDir: cardsDirPath });
	}
	return work;
}

// ── 명령 ─────────────────────────────────────────────

function need(flags, key, label) {
	const value = flags[key];
	if (value === undefined || value === null || String(value).trim() === "") fail(`${label} 필요합니다(--${key})`);
	return String(value);
}

let currentMs = Date.now();
let currentConfig = null;

function checkCalendar(value) {
	if (value === undefined) return null;
	if (value !== "yes" && value !== "no") fail("캘린더는 yes 또는 no입니다");
	return value;
}

function flagValue(flags, ...keys) {
	for (const k of keys) {
		if (flags[k] !== undefined) return flags[k];
	}
	return undefined;
}

function cmdNew(root, ms, flags, config) {
	const role = checkRole(flags.role || fail("역할이 필요합니다(--role)"));
	const title = need(flags, "title", "제목이");
	const source = need(flags, "source", "원문 주소가");
	const next = need(flags, "next", "다음 행동이");
	const dueRaw = flags.due === undefined ? "" : String(flags.due);
	if (dueRaw) dueMs(dueRaw);
	const calendar = checkCalendar(flags.calendar) || "no";
	const status = flags.status !== undefined ? normalizeMoveStatus(flags.status) : "doing";
	let waitFields = { wait_reason: "", recheck_at: "", request_ref: "" };
	if (status === "waiting") {
		waitFields = validateWaitCardFields({
			waitReason: flagValue(flags, "wait-reason", "waitReason", "wait_reason"),
			recheckAt: flagValue(flags, "recheck-at", "recheckAt", "recheck_at"),
			requestRef: flagValue(flags, "request-ref", "requestRef", "request_ref"),
			now: ms,
			maxRecheckHours: config.maxRecheckHours,
		});
	}
	const stamp = nowIso(ms);
	const dir = cardsDir(root, role);
	fs.mkdirSync(dir, { recursive: true });
	const slug = slugify(title);
	let id = `${datePrefix(ms)}-${slug}`;
	let file = path.join(dir, `${id}.md`);
	for (let n = 2; fs.existsSync(file); n++) {
		id = `${datePrefix(ms)}-${slug}-${n}`;
		checkId(id);
		file = path.join(dir, `${id}.md`);
	}
	const card = {
		id,
		title,
		owner: role,
		status,
		source,
		received: stamp,
		due: dueRaw,
		next,
		moved: stamp,
		calendar,
		progress: flags.progress ? String(flags.progress) : "",
		wait_reason: waitFields.wait_reason,
		recheck_at: waitFields.recheck_at,
		request_ref: waitFields.request_ref,
		defer_reason: "",
		revisit: "",
		defer_count: "0",
		result: "",
	};
	fs.writeFileSync(file, serializeCard(card));
	const changes = { status, due: dueRaw, next, calendar };
	if (status === "waiting") Object.assign(changes, waitFields);
	appendLedger(root, { at: stamp, cmd: "new", role, id, changes });
	return `만듦 ${role}/${id}`;
}

function cmdMove(root, ms, flags, positional, config) {
	const id = checkId(positional[0] || flags.id || fail("카드 id가 필요합니다"));
	const found = findCard(root, id);
	const card = loadCard(found.file);
	const changes = {};

	const rawWaitReason = flagValue(flags, "wait-reason", "waitReason", "wait_reason");
	const rawRecheckAt = flagValue(flags, "recheck-at", "recheckAt", "recheck_at");
	const rawRequestRef = flagValue(flags, "request-ref", "requestRef", "request_ref");

	let targetStatus = card.status;
	if (flags.status !== undefined) {
		targetStatus = normalizeMoveStatus(flags.status);
		card.status = targetStatus;
		changes.status = targetStatus;
	} else if (isWaitingStatus(card.status)) {
		targetStatus = "waiting";
		card.status = "waiting";
	}

	if (targetStatus === "waiting") {
		const switchingToWait = flags.status !== undefined;
		const effectiveReason = rawWaitReason !== undefined ? rawWaitReason : (switchingToWait ? "" : card.wait_reason);
		const effectiveRecheck = rawRecheckAt !== undefined ? rawRecheckAt : (switchingToWait ? "" : card.recheck_at);
		const effectiveRef = rawRequestRef !== undefined ? rawRequestRef : (switchingToWait ? "" : card.request_ref);
		const validated = validateWaitCardFields({
			waitReason: effectiveReason,
			recheckAt: effectiveRecheck,
			requestRef: effectiveRef,
			now: ms,
			maxRecheckHours: config.maxRecheckHours,
		});
		card.wait_reason = validated.wait_reason;
		card.recheck_at = validated.recheck_at;
		card.request_ref = validated.request_ref;
		changes.wait_reason = card.wait_reason;
		changes.recheck_at = card.recheck_at;
		if (card.request_ref) changes.request_ref = card.request_ref;
	} else if (targetStatus === "doing") {
		if (card.wait_reason || card.recheck_at || card.request_ref) {
			card.wait_reason = "";
			card.recheck_at = "";
			card.request_ref = "";
			changes.wait_reason = "";
			changes.recheck_at = "";
			changes.request_ref = "";
		}
	}

	if (flags.next !== undefined) { card.next = String(flags.next); changes.next = card.next; }
	if (flags.due !== undefined) { dueMs(String(flags.due)); card.due = String(flags.due); changes.due = card.due; }
	if (flags.calendar !== undefined) { card.calendar = checkCalendar(flags.calendar); changes.calendar = card.calendar; }
	if (flags.progress !== undefined) { card.progress = String(flags.progress); changes.progress = card.progress; }
	card.moved = nowIso(ms);
	changes.moved = card.moved;
	fs.writeFileSync(found.file, serializeCard(card));
	runCheck(root, [found.role], { now: ms, wake: false, config });
	appendLedger(root, { at: card.moved, cmd: "move", role: found.role, id: found.id, changes });
	return `바꿈 ${found.role}/${found.id}`;
}

function cmdWait(root, ms, flags, positional, config) {
	return cmdMove(root, ms, { ...flags, status: "waiting" }, positional, config);
}

function cmdDefer(root, ms, flags, positional, config) {
	const id = checkId(positional[0] || flags.id || fail("카드 id가 필요합니다"));
	// 미룸은 사유·다시 볼 날 둘 다 필수. 하나라도 비면 장부·카드를 건드리기 전에 멈춘다.
	const reason = flags.reason === undefined ? "" : String(flags.reason).trim();
	const revisit = flags.revisit === undefined ? "" : String(flags.revisit).trim();
	if (!reason || !revisit) {
		fail("미룸은 사유(--reason)·다시 볼 날(--revisit)이 필요합니다");
	}
	if (!/^\d{4}-\d{2}-\d{2}$/.test(revisit) || !meaningful(reason)) fail("미룸은 사유와 YYYY-MM-DD 다시 볼 날이 필요합니다");
	const revisitMs = dueMs(revisit);
	const today = Date.parse(`${new Date(ms).toISOString().slice(0, 10)}T00:00:00Z`);
	const limit = new Date(today);
	limit.setUTCFullYear(limit.getUTCFullYear() + 1);
	if (revisitMs < today || Date.parse(`${revisit}T00:00:00Z`) > limit.getTime()) fail("다시 볼 날은 오늘부터 1년 이내여야 합니다");
	const found = findCard(root, id);
	const card = loadCard(found.file);
	card.defer_reason = reason;
	card.revisit = revisit;
	card.status = "deferred";
	card.wait_reason = "";
	card.recheck_at = "";
	card.request_ref = "";
	card.defer_count = (Number.parseInt(card.defer_count, 10) || 0) + 1;
	card.moved = nowIso(ms);
	fs.writeFileSync(found.file, serializeCard(card));
	runCheck(root, [found.role], { now: ms, wake: false, config });
	appendLedger(root, {
		at: card.moved, cmd: "defer", role: found.role, id: found.id,
		changes: { status: "deferred", defer_reason: card.defer_reason, revisit: card.revisit, defer_count: card.defer_count, moved: card.moved },
	});
	return `미룸 ${found.role}/${found.id} (다시 볼 날 ${card.revisit || "없음"})`;
}

function cmdDone(root, ms, flags, positional, config) {
	const id = checkId(positional[0] || flags.id || fail("카드 id가 필요합니다"));
	const result = need(flags, "result", "결과 주소가");
	const found = findCard(root, id);
	const card = loadCard(found.file);
	card.status = "done";
	card.wait_reason = "";
	card.recheck_at = "";
	card.request_ref = "";
	card.result = result;
	card.moved = nowIso(ms);
	fs.writeFileSync(found.file, serializeCard(card));
	runCheck(root, [found.role], { now: ms, wake: false, config });
	appendLedger(root, { at: card.moved, cmd: "done", role: found.role, id: found.id, changes: { status: "done", result, moved: card.moved } });
	const rest = listLines(loadRoleCards(root, found.role));
	const checks = formatProblems(runCheck(root, [found.role], { now: ms, wake: false, config }));
	const out = [`끝냄 ${found.role}/${found.id}`, "다음 일(기한 순):", ...(rest.length > 0 ? rest : ["(남은 카드 없음)"]), "점검:", ...checks];
	return out.join("\n");
}

function cmdAck(root, ms, flags) {
	const role = checkRole(flags.role || fail("역할이 필요합니다(--role)"));
	const ref = need(flags, "ref", "원문 고리(evt 번호 또는 글 번호)가");
	const reason = need(flags, "reason", "왜 카드가 아닌지가");
	appendLedger(root, { at: nowIso(ms), cmd: "ack", role, id: ref, ref, reason });
	return `적음 ${role} 장부에 카드 아닌 지시(${ref})`;
}

function cmdList(root, flags) {
	const role = checkRole(flags.role || fail("역할이 필요합니다(--role)"));
	const lines = listLines(loadRoleCards(root, role));
	if (lines.length === 0) console.error("[알림] 남은 카드 없음");
	return lines.join("\n");
}

function cmdCheck(root, flags, config) {
	const roles = flags.role ? [checkRole(flags.role)] : discoverRoles(root);
	const sinceHours = flags["since-hours"] === undefined ? 72 : Number(flags["since-hours"]);
	const staleHours = flags["stale-hours"] === undefined ? 24 : Number(flags["stale-hours"]);
	if (!Number.isFinite(sinceHours) || !Number.isFinite(staleHours)) fail("시간(--since-hours, --stale-hours)은 숫자입니다");
	// 깨움·영수증은 to-ledger(session-health-run.sh) 한 곳만 쓴다. 손으로 돌리는 check·board 는 --wake 를 줄 때만.
	const wake = flags.wake !== undefined && flags["no-wake"] === undefined;
	const problems = runCheck(root, roles, { now: currentMs, sinceHours, staleHours, wake, config });
	if (flags.json !== undefined) return JSON.stringify(problems, null, 2);
	return formatProblems(problems).join("\n");
}

function cmdBoard(root, flags, config) {
	const roles = discoverRoles(root);
	const nowDir = path.join(root, "docs", "common", "team", "now");
	const lines = ["# 업무 카드판", "", `갱신: ${nowIso(currentMs)}`, ""];
	for (const role of roles) {
		const nowFile = path.join(nowDir, `${role}.md`);
		if (fs.existsSync(nowFile)) lines.push(`- [${role} 지금 하는 일](../now/${role}.md)`);
		else lines.push(`- ${role}`);
	}
	if (roles.length > 0) lines.push("");
	// 깨움·영수증은 to-ledger(session-health-run.sh) 한 곳만 쓴다. 손으로 돌리는 check·board 는 --wake 를 줄 때만.
	const wake = flags.wake !== undefined && flags["no-wake"] === undefined;
	// 점검은 한 번만 돌리고 표·두 절이 같이 쓴다(같은 입력 → 같은 출력 유지).
	const problems = runCheck(root, roles, { now: currentMs, wake, config });
	const marks = new Map();
	for (const p of problems) {
		const tag = p.kind === "overdue"
			? "기한 지남"
			: p.kind === "stale"
				? "멈춤"
				: p.kind === "revisit"
					? "다시 볼 날 지남"
					: p.kind === "wait-recheck"
						? "다시 볼 시각 지남"
						: p.kind === "legacy-waiting"
							? "까닭·시각 없는 대기"
							: null;
		if (!tag) continue;
		const key = `${p.role}/${p.id}`;
		if (!marks.has(key)) marks.set(key, []);
		if (!marks.get(key).includes(tag)) marks.get(key).push(tag);
	}
	for (const role of roles) {
		lines.push(`## ${role}`, "", "| 상태 | 카드 | 예상 완료 | 다음 행동 | 마지막 움직임 |", "|---|---|---|---|---|");
		const cards = loadRoleCards(root, role).sort(compareDue);
		const weekAgo = currentMs - 7 * 24 * 3600_000;
		for (const card of cards) {
			if (card.status === "done") {
				const moved = Date.parse(card.moved || "");
				if (!Number.isFinite(moved) || moved < weekAgo) continue;
			}
			const cell = (v) => String(v || "없음").replace(/\|/g, "｜").replace(/\n/g, " ");
			const tag = marks.get(`${role}/${card.id}`);
			const statusCell = tag ? `${statusKo(card.status)} [${tag.join("·")}]` : statusKo(card.status);
			lines.push(`| ${statusCell} | ${cell(card.title)} (${cell(card.id)}) | ${cell(card.due)} | ${cell(card.next)} | ${cell(card.moved)} |`);
		}
		lines.push("");
	}
	lines.push("## 놓친 일·밀리는 일", "");
	lines.push(...formatProblems(problems), "");
	lines.push("## 계속 밀리는 일", "");
	const repeats = repeatProblems(problems);
	if (repeats.length === 0) {
		lines.push("계속 밀리는 일 없음.", "");
	} else {
		lines.push(...formatProblems(repeats), "");
		lines.push("두 번 넘게 밀린 일은 다른 역할을 추가로 투입하거나 다른 역할로 넘기는 요청 줄을 쓰세요(22시 회고).", "");
	}
	const file = boardFile(root);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${lines.join("\n").replace(/\n+$/, "\n")}`);
	return "씀 docs/common/team/cards/index.md";
}

function cmdTick(root, ms, flags, config) {
	// 훅이 세션을 막지 않게 이 안의 오류는 전부 삼킨다.
	try {
		const role = flags.role ? String(flags.role) : "";
		const session = flags.session ? String(flags.session) : "";
		if (!ROLE_RE.test(role)) return "";
		if (!/^[A-Za-z0-9._-]{1,128}$/.test(session) || session === "." || session === "..") return "";
		const everyMin = flags["every-min"] === undefined ? 60 : Number(flags["every-min"]);
		if (!Number.isFinite(everyMin) || everyMin <= 0) return "";
		const file = tickFile(root, session);
		let last = NaN;
		try { last = Date.parse(JSON.parse(fs.readFileSync(file, "utf8")).last); } catch { last = NaN; }
		if (Number.isFinite(last) && ms - last < everyMin * 60_000) return "";
		const cards = loadRoleCards(root, role);
		const list = listLines(cards).slice(0, 8);
		const checks = formatProblems(runCheck(root, [role], { now: ms, wake: flags.wake !== undefined && flags["no-wake"] === undefined, config })).slice(0, 6);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `${JSON.stringify({ last: nowIso(ms) })}\n`);
		return ["[업무 카드 정기 점검]", ...list, ...checks].join("\n");
	} catch {
		return "";
	}
}

function cmdToLedger(root, ms, flags, positional, config) {
	const cardsDirArg = positional.length >= 2 ? positional[0] : path.join(root, "docs", "common", "team", "cards");
	const outFileArg = positional.length >= 2 ? positional[1] : positional[0] || flags.out;
	if (!outFileArg) fail("출력 파일 경로가 필요합니다(to-ledger [<카드 폴더>] <출력 파일>)");
	const rows = cardsToLedger(root, path.resolve(root, cardsDirArg), path.resolve(root, outFileArg), {
		now: ms,
		wake: flags["no-wake"] === undefined,
		config,
	});
	return `cards-to-ledger: ${rows.length} rows`;
}

// ── 진입 ─────────────────────────────────────────────

function main(argv) {
	const { global, rest } = parseCli(argv);
	const root = path.resolve(global.root);
	currentMs = nowMs(global.now);
	currentConfig = loadTaskCardsConfig(root, {
		configPath: global.configPath,
		ownerIds: global.ownerIds,
		maxRecheckHours: global.maxRecheckHours,
	});
	if (rest.length === 0) fail("명령이 필요합니다(new/move/wait/defer/done/ack/list/check/board/tick/to-ledger)");
	const [cmd, ...args] = rest;
	const { flags, positional } = parseFlags(args);
	switch (cmd) {
		case "new": return cmdNew(root, currentMs, flags, currentConfig);
		case "move": return cmdMove(root, currentMs, flags, positional, currentConfig);
		case "wait": return cmdWait(root, currentMs, flags, positional, currentConfig);
		case "defer": return cmdDefer(root, currentMs, flags, positional, currentConfig);
		case "done": return cmdDone(root, currentMs, flags, positional, currentConfig);
		case "ack": return cmdAck(root, currentMs, flags);
		case "list": return cmdList(root, flags);
		case "check": return cmdCheck(root, flags, currentConfig);
		case "board": return cmdBoard(root, flags, currentConfig);
		case "tick": return cmdTick(root, currentMs, flags, currentConfig);
		case "to-ledger": return cmdToLedger(root, currentMs, flags, positional, currentConfig);
		default: fail(`알 수 없는 명령입니다: ${cmd}`);
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const out = main(process.argv.slice(2));
		if (out) process.stdout.write(`${out}\n`);
	} catch (err) {
		console.error(`[오류] ${err.message}`);
		process.exit(2);
	}
}
