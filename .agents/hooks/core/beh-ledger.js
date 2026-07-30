/**
 * beh-ledger — Behavior Enforcement Harness §3.1 core (tool-agnostic SoT).
 *
 * Plan: .agents/progress/behavior-enforcement-harness-plan-2026-06-11.md (§3.1, §6.1).
 *
 * Deterministic foreground sincere-drift detection. NO host I/O envelope —
 * host adapters (.claude/hooks/*, future .pi/extensions/*) translate their
 * event/stdin into these calls and wrap the returned data.
 *
 * Design model (plan §3.1):
 *   - ledger = append-only FACTS (harness-recorded; agent does not edit).
 *       entry: {turn, ts, tool?, target_canon, outcome, tool_less,
 *               scope_item?, matched_milestone?, marker?}
 *   - progress = pre-declared PLAN + dispositions (the external anchor, v5):
 *       scope_items[] each with milestones[] (pre-declared acceptance),
 *       deps[], state, disposition; phase_usage (cumulative, no reset).
 *   - evaluateDrift(state) = PURE function: ledger + progress + clock + config
 *       → decisions (injects / hardStop / blockTermination / next barrier).
 *
 * Threat model (plan §0): IN-SCOPE = sincere drift (activity≠progress,
 * unnoticed stall, stopping with work left, self-judgment error). NOT
 * adversarial self-evasion (ledger forgery, milestone spoofing) — that is
 * backstopped by external authority (user) + escalation, not crypto here.
 *
 * Testability (plan §4): drift is reproduced by FAULT INJECTION — feed
 * evaluateDrift synthetic ledger+progress states, assert the decision. We
 * test "does the harness react to drift SIGNALS", not "does an LLM drift".
 */

const fs = require("fs");
const path = require("path");

// ── Defaults (overridable via state.config) ──────────────────────────────
const DEFAULT_CONFIG = {
	stallTurns: 6, //  running item: turns since last NEW milestone → stall
	stallMs: 15 * 60 * 1000, //  …or wall ms
	starvationTurns: 12, //  ready-but-unscheduled item starvation cap (turns)
	starvationMs: 30 * 60 * 1000,
	newValueWindowTurns: 6, //  global: zero new milestone across all running → drift
	newValueWindowMs: 15 * 60 * 1000,
	escalationK: 3, //  same invariant ignored K times after inject → hard-stop
	// per-phase cumulative dwell ceiling (total, NOT per-window; no reset on
	// re-entry). Tool-less phases (plan/understand/...) legitimately have no
	// commits, so they are bounded by total dwell, not by new-value.
	phaseCeilings: {
		understand: { turns: 30, ms: 60 * 60 * 1000 },
		scope: { turns: 30, ms: 60 * 60 * 1000 },
		investigate: { turns: 60, ms: 2 * 60 * 60 * 1000 },
		plan: { turns: 40, ms: 90 * 60 * 1000 },
	},
};

// Item lifecycle states (plan §3.1 scheduler taxonomy).
const RUNNING = "running";
const READY = "ready"; //  schedulable (deps met) but not currently running
const DEP_BLOCKED = "dep_blocked"; //  has unmet deps → starvation-exempt
const DONE = "done";
const DEFERRED = "deferred"; //  user-dispositioned: explicitly set aside
const ABANDONED = "abandoned"; //  user-dispositioned: dropped
const DISPOSED = new Set([DONE, DEFERRED, ABANDONED]);

const INVARIANTS = {
	ACTIVE_STALL: "active_stall",
	STARVATION: "starvation",
	PHASE_CEILING: "phase_ceiling",
	NEW_VALUE_ZERO: "new_value_zero",
	SCOPE_UNDECLARED: "scope_undeclared",
	BLOCKED_TERMINATION: "blocked_termination",
};

// ── Ledger I/O (atomic append; agent-not-editable by convention/location) ─
function appendLedger(ledgerPath, entry) {
	const dir = path.dirname(ledgerPath);
	fs.mkdirSync(dir, { recursive: true });
	// jsonl append: a single write() of one line is atomic for small lines on
	// local fs (< PIPE_BUF). Each entry is one self-contained JSON object.
	fs.appendFileSync(ledgerPath, JSON.stringify(entry) + "\n");
}

function readLedger(ledgerPath) {
	let raw;
	try {
		raw = fs.readFileSync(ledgerPath, "utf8");
	} catch {
		return [];
	}
	const out = [];
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			out.push(JSON.parse(t));
		} catch {
			// skip a torn/partial trailing line — never throw on read
		}
	}
	return out;
}

// ── Target canonicalization (plan §3.1 target_canon) ──────────────────────
/**
 * Canonicalize a tool's target so churn over the same target (rename-only,
 * touch loops) maps to ONE identity. Pure.
 * @param {string} tool
 * @param {object} input  tool input (Claude tool_input shape)
 * @param {{cwd?:string}} [opts]
 * @returns {string}
 */
function canonTarget(tool, input, opts) {
	const cwd = (opts && opts.cwd) || process.cwd();
	const platform = (opts && opts.platform) || process.platform;
	const pathApi = platform === "win32" ? path.win32 : path.posix;
	input = input || {};
	const rel = (p) => {
		if (!p || typeof p !== "string") return "";
		try {
			const normalized = pathApi.isAbsolute(p) ? pathApi.relative(cwd, p) : pathApi.normalize(p);
			return platform === "win32" ? normalized.replace(/\\/g, "/") : normalized;
		} catch {
			return String(p);
		}
	};
	switch (tool) {
		case "Edit":
		case "Write":
		case "Read":
		case "NotebookEdit":
			return `file:${rel(input.file_path || input.notebook_path)}`;
		case "Bash": {
			// collapse whitespace; drop quoted literals so arg churn over the
			// same command shape coalesces.
			const c = String(input.command || "")
				.replace(/'[^']*'/g, "''")
				.replace(/"[^"]*"/g, '""')
				.replace(/\s+/g, " ")
				.trim();
			return `bash:${c.slice(0, 200)}`;
		}
		default: {
			let j = "";
			try {
				j = JSON.stringify(input);
			} catch {
				j = String(input);
			}
			return `${tool}:${j.slice(0, 200)}`;
		}
	}
}

// ── Milestone matching (append-time; recorded into the ledger) ────────────
function globToRe(glob) {
	const esc = String(glob).replace(/[.+^${}()|[\]\\]/g, "\\$&");
	const re = esc.replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
	return new RegExp("^" + re + "$");
}

/**
 * Does this tool outcome satisfy any UNCONSUMED milestone of the item?
 * Returns the milestone id or null. Deterministic — supported predicate
 * kinds only (free-form judgment is OUT, plan §3.1):
 *   {kind:"path", glob}        edit/write to a matching path, outcome ok
 *   {kind:"bash_ok", pattern}  Bash whose command matches /pattern/, ok
 *   {kind:"manual", marker}    explicit marker on the ledger entry
 * Unknown kinds never match (fail-closed for matching → no false new-value).
 * @param {object} item  scope item (milestones may carry consumed_turn)
 * @param {{tool?:string, target_canon:string, outcome:string, marker?:string}} ev
 */
function matchMilestone(item, ev) {
	const ok = ev.outcome === "ok" || ev.outcome === "success" || ev.outcome === undefined;
	for (const m of item.milestones || []) {
		if (m.consumed_turn != null) continue; //  one-shot: already consumed
		const k = m.accept || {};
		if (k.kind === "manual") {
			if (ev.marker && ev.marker === k.marker) return m.id;
		} else if (k.kind === "path") {
			if (!ok) continue;
			if (ev.tool !== "Edit" && ev.tool !== "Write" && ev.tool !== "NotebookEdit") continue;
			const fp = ev.target_canon.startsWith("file:") ? ev.target_canon.slice(5) : "";
			if (fp && globToRe(k.glob).test(fp)) return m.id;
		} else if (k.kind === "bash_ok") {
			if (!ok) continue;
			if (ev.tool !== "Bash") continue;
			const cmd = ev.target_canon.startsWith("bash:") ? ev.target_canon.slice(5) : "";
			try {
				if (new RegExp(k.pattern).test(cmd)) return m.id;
			} catch {
				/* bad pattern never matches */
			}
		}
	}
	return null;
}

// ── Derivation from ledger (one-shot milestone consumption) ───────────────
/**
 * For each item, the turn/ts of its LAST *new* milestone consumption. One-shot:
 * the first ledger entry to match a given milestone counts; later re-matches of
 * the same milestone do NOT (prevents repeat-execution masking, plan §3.1).
 */
function deriveProgressMarks(ledger, items) {
	const marks = {}; //  item_id → {lastTurn, lastTs, consumed:Set}
	for (const it of items) marks[it.id] = { lastTurn: -1, lastTs: -1, consumed: new Set() };
	for (const e of ledger) {
		if (!e.scope_item || !e.matched_milestone) continue;
		const m = marks[e.scope_item];
		if (!m) continue;
		const key = e.matched_milestone;
		if (m.consumed.has(key)) continue; //  one-shot
		m.consumed.add(key);
		if ((e.turn ?? -1) > m.lastTurn) m.lastTurn = e.turn ?? -1;
		if ((e.ts ?? -1) > m.lastTs) m.lastTs = e.ts ?? -1;
	}
	return marks;
}

// ── The evaluator (PURE) ──────────────────────────────────────────────────
/**
 * @param {object} state
 *   state.now            number ms (clock)
 *   state.turn           number (current turn counter)
 *   state.config         partial override of DEFAULT_CONFIG
 *   state.ledger         array of ledger entries (this session)
 *   state.progress       {
 *       current_phase,
 *       autonomous?:bool,           // true = no user-directed task bound
 *       termination_requested?:bool,// agent wants to stop / Stop event fired
 *       phase_usage: {<phase>:{turns,firstTs,lastTs}},  // cumulative
 *       phase_ceiling_extended: {<phase>:bool},         // bounded-scope internal recheck completed
 *       scope_items: [ {
 *          id, phase, state, deps:[id], disposition?,
 *          started_turn?, started_ts?,    // when it entered RUNNING
 *          ready_since_turn?, ready_since_ts?,  // when it became READY
 *          milestones:[{id, accept, consumed_turn?}]
 *       } ]
 *   }
 *   state.barrier        { lastInjectTurn:{<inv>:turn}, ignored:{<inv>:n} }
 * @returns {{
 *   injects: Array<{invariant:string, item?:string, message:string}>,
 *   hardStop: boolean, hardStopReason: (string|null),
 *   blockTermination: boolean,
 *   barrier: object   // next barrier state (adapter persists)
 * }}
 */
function evaluateDrift(state) {
	const cfg = { ...DEFAULT_CONFIG, ...(state.config || {}) };
	cfg.phaseCeilings = { ...DEFAULT_CONFIG.phaseCeilings, ...((state.config || {}).phaseCeilings || {}) };
	const now = state.now;
	const turn = state.turn;
	const prog = state.progress || {};
	const items = prog.scope_items || [];
	const ledger = state.ledger || [];
	const marks = deriveProgressMarks(ledger, items);

	const injects = [];
	const violated = new Set(); //  invariants violated THIS evaluation

	// 1. scope undeclared (autonomous + no items) — silent no-op forbidden.
	if (prog.autonomous && items.length === 0) {
		violated.add(INVARIANTS.SCOPE_UNDECLARED);
		injects.push({
			invariant: INVARIANTS.SCOPE_UNDECLARED,
			message:
				"[BEH] 자율 진행인데 스코프(scope_items)가 미선언입니다. 항목별 사전 수용기준을 " +
				"progress 파일에 선언하기 전에는 진행/완료를 인정하지 않습니다 (plan §3.1).",
		});
	}

	// 2. per-item active stall (running) + starvation (ready) + dep exemption.
	for (const it of items) {
		if (DISPOSED.has(it.state)) continue;
		if (it.state === RUNNING) {
			const mk = marks[it.id] || {};
			const baseTurn = mk.lastTurn >= 0 ? mk.lastTurn : it.started_turn ?? turn;
			const baseTs = mk.lastTs >= 0 ? mk.lastTs : it.started_ts ?? now;
			const stalledTurns = turn - baseTurn >= cfg.stallTurns;
			const stalledMs = now - baseTs >= cfg.stallMs;
			if (stalledTurns || stalledMs) {
				violated.add(INVARIANTS.ACTIVE_STALL + ":" + it.id);
				injects.push({
					invariant: INVARIANTS.ACTIVE_STALL,
					item: it.id,
					message:
						`[BEH] 활성 항목 "${it.id}" 정체: 사전선언 마일스톤 신규 충족이 ` +
						`${turn - baseTurn}턴/${Math.round((now - baseTs) / 60000)}분간 0. ` +
						`접근을 바꾸거나(막혔으면 사용자 보고) 다음 마일스톤을 진전시키세요 (plan §3.1).`,
				});
			}
		} else if (it.state === READY) {
			// ready but not scheduled → starvation cap. dep_blocked is exempt.
			const rt = it.ready_since_turn ?? turn;
			const rs = it.ready_since_ts ?? now;
			if (turn - rt >= cfg.starvationTurns || now - rs >= cfg.starvationMs) {
				violated.add(INVARIANTS.STARVATION + ":" + it.id);
				injects.push({
					invariant: INVARIANTS.STARVATION,
					item: it.id,
					message:
						`[BEH] 실행가능 항목 "${it.id}"이 ${turn - rt}턴간 스케줄되지 않아 기아(starvation). ` +
						`착수하거나 명시적으로 보류(disposition)하세요 (plan §3.1).`,
				});
			}
		}
		// DEP_BLOCKED: exempt — bound to predecessor deadline (plan §3.1 R18).
	}

	// 3. global new-value-zero across all RUNNING items in the window.
	const runningItems = items.filter((it) => it.state === RUNNING);
	if (runningItems.length > 0) {
		let anyRecentNewValue = false;
		for (const it of runningItems) {
			const mk = marks[it.id] || {};
			if (mk.lastTurn < 0 && mk.lastTs < 0) continue;
			const withinTurns = turn - mk.lastTurn < cfg.newValueWindowTurns;
			const withinMs = now - mk.lastTs < cfg.newValueWindowMs;
			if (withinTurns || withinMs) {
				anyRecentNewValue = true;
				break;
			}
		}
		// only fire if at least one running item has been active long enough to
		// have had a chance (its start is older than the window) — avoids
		// false-positive at the very first turn of a fresh item.
		const anyMature = runningItems.some((it) => {
			const startT = it.started_turn ?? turn;
			const startS = it.started_ts ?? now;
			return turn - startT >= cfg.newValueWindowTurns || now - startS >= cfg.newValueWindowMs;
		});
		if (!anyRecentNewValue && anyMature) {
			violated.add(INVARIANTS.NEW_VALUE_ZERO);
			injects.push({
				invariant: INVARIANTS.NEW_VALUE_ZERO,
				message:
					"[BEH] 모든 실행 항목에서 신규 진척(사전기준 충족)이 윈도 내 0입니다. " +
					"활동(재시도·무관 출력)은 진척이 아닙니다 — 막힌 접근을 버리고 재평가하세요 (plan §3.1).",
			});
		}
	}

	// 4. phase cumulative dwell ceiling (total, no reset on re-entry).
	const phase = prog.current_phase;
	const ceil = cfg.phaseCeilings[phase];
	const usage = (prog.phase_usage || {})[phase];
	if (ceil && usage && !((prog.phase_ceiling_extended || {})[phase])) {
		const overTurns = ceil.turns != null && usage.turns >= ceil.turns;
		const overMs = ceil.ms != null && usage.firstTs != null && now - usage.firstTs >= ceil.ms;
		if (overTurns || overMs) {
			violated.add(INVARIANTS.PHASE_CEILING + ":" + phase);
			injects.push({
				invariant: INVARIANTS.PHASE_CEILING,
				message:
					`[BEH] 페이즈 "${phase}" 누적 체류 한도 도달(turns=${usage.turns}). ` +
					`현재 목표·scope_items·예외 경계가 그대로인지 내부 재검하세요. 동일한 bounded scope이면 ` +
					`phase_ceiling_extended.${phase}=true를 기록하고 재승인 없이 계속하며, 실제 scope expansion이나 ` +
					`비가역·외부영향 예외가 발견된 경우에만 사용자에게 물으세요 ` +
					`(자동 reset 없음; 누적 유지 — plan §3.1).`,
			});
		}
	}

	// 5. termination gate (blocked disposition): cannot end with live items.
	let blockTermination = false;
	if (prog.termination_requested) {
		const undisposed = items.filter((it) => !DISPOSED.has(it.state));
		if (undisposed.length > 0) {
			blockTermination = true;
			violated.add(INVARIANTS.BLOCKED_TERMINATION);
			injects.push({
				invariant: INVARIANTS.BLOCKED_TERMINATION,
				message:
					`[BEH] 종료 차단: 미처리 항목 ${undisposed.length}개 잔존 ` +
					`(${undisposed.map((i) => i.id).join(", ")}). 각 항목을 done 처리하거나 ` +
					`사용자가 명시적으로 보류/포기(disposition)해야 종료됩니다 (plan §3.1).`,
			});
		}
	}

	// 6. inject barrier + escalation. K counts only AFTER an inject for that
	//    invariant was delivered (turn > lastInjectTurn) — avoids counting the
	//    queued-tool-call race (plan §3.1 inject barrier).
	const prevBarrier = state.barrier || { lastInjectTurn: {}, ignored: {} };
	const nextBarrier = {
		lastInjectTurn: { ...(prevBarrier.lastInjectTurn || {}) },
		ignored: { ...(prevBarrier.ignored || {}) },
	};
	let hardStop = false;
	let hardStopReason = null;

	for (const invKey of violated) {
		const prevInjectTurn = nextBarrier.lastInjectTurn[invKey];
		if (prevInjectTurn != null && turn > prevInjectTurn) {
			// still violated on a turn after we already injected → an ignore.
			nextBarrier.ignored[invKey] = (nextBarrier.ignored[invKey] || 0) + 1;
			if (nextBarrier.ignored[invKey] >= cfg.escalationK) {
				hardStop = true;
				hardStopReason =
					`[BEH] HARD-STOP: invariant "${invKey}" 연속 ${nextBarrier.ignored[invKey]}회 무시. ` +
					`완료/정상종료를 차단합니다. 사용자 인증 reset(beh-reset) 전까지 진행 불가 (plan §3.1).`;
			}
		}
		// record/refresh the inject turn for this invariant.
		nextBarrier.lastInjectTurn[invKey] = turn;
	}
	// clear barrier entries for invariants no longer violated (resolved).
	for (const invKey of Object.keys(nextBarrier.lastInjectTurn)) {
		if (!violated.has(invKey)) {
			delete nextBarrier.lastInjectTurn[invKey];
			delete nextBarrier.ignored[invKey];
		}
	}

	return {
		injects,
		hardStop,
		hardStopReason,
		blockTermination,
		barrier: nextBarrier,
	};
}

// ── Session state + binding I/O (used by host adapters; tool-agnostic) ────
function atomicWriteJson(filePath, value) {
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
	fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
	fs.renameSync(tmp, filePath);
}

/** Per-session BEH file paths under .agents/harness/. */
function behPaths(cwd, sessionId) {
	const sid = String(sessionId || "no-session").replace(/[^A-Za-z0-9_.-]/g, "_");
	const dir = path.join(cwd, ".agents", "harness");
	return {
		dir,
		ledger: path.join(dir, "ledger", `${sid}.jsonl`),
		state: path.join(dir, "state", `${sid}.json`),
	};
}

/** Session state: turn counter, per-phase cumulative usage, barrier. */
function loadState(statePath) {
	try {
		const s = JSON.parse(fs.readFileSync(statePath, "utf8"));
		return {
			turn: s.turn || 0,
			last_phase: s.last_phase || null,
			phase_usage: s.phase_usage || {},
			barrier: s.barrier || { lastInjectTurn: {}, ignored: {} },
		};
	} catch {
		return { turn: 0, last_phase: null, phase_usage: {}, barrier: { lastInjectTurn: {}, ignored: {} } };
	}
}

function saveState(statePath, state) {
	atomicWriteJson(statePath, state);
}

/**
 * Find the progress file bound to this session via embedded session_id (P0).
 * Scans root .agents/progress + immediate submodule children — mirrors
 * harness-core's collection so BEH binds to the SAME file the session harness
 * shows. Returns {path, progress} or null. (Binding is P0-only; the richer
 * P1/session-map resolution stays in harness-core's buildSessionInject.)
 */
function findBoundProgress(cwd, sessionId) {
	if (!sessionId) return null;
	const dirs = [];
	const root = path.join(cwd, ".agents", "progress");
	if (fs.existsSync(root)) dirs.push(root);
	try {
		for (const e of fs.readdirSync(cwd, { withFileTypes: true })) {
			if (!e.isDirectory() || e.name.startsWith(".")) continue;
			const d = path.join(cwd, e.name, ".agents", "progress");
			if (fs.existsSync(d)) dirs.push(d);
		}
	} catch {
		/* ignore */
	}
	for (const dir of dirs) {
		let files;
		try {
			files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("."));
		} catch {
			continue;
		}
		for (const f of files) {
			const fp = path.join(dir, f);
			try {
				const prog = JSON.parse(fs.readFileSync(fp, "utf8"));
				if (prog && prog.session_id === sessionId) return { path: fp, progress: prog };
			} catch {
				/* skip */
			}
		}
	}
	return null;
}

const OFF_VALUES = new Set(["off", "0", "false", "no"]);
/**
 * BEH is OPT-IN per session (high-impact: a Stop gate can block stopping).
 * Enabled only when the `.claude/beh-on` marker exists AND not opted out via
 * env BEH=off or `.claude/no-harness`. Default = inert (returns false).
 */
function behEnabled(cwd, env, opts) {
	env = env || process.env;
	const cfgDir = (opts && opts.hostConfigDir) || ".claude";
	if (OFF_VALUES.has(String(env.BEH || "").trim().toLowerCase())) return false;
	if (fs.existsSync(path.join(cwd, cfgDir, "no-harness"))) return false;
	return fs.existsSync(path.join(cwd, cfgDir, "beh-on"));
}

module.exports = {
	DEFAULT_CONFIG,
	INVARIANTS,
	RUNNING,
	READY,
	DEP_BLOCKED,
	DONE,
	DEFERRED,
	ABANDONED,
	DISPOSED,
	appendLedger,
	readLedger,
	canonTarget,
	globToRe,
	matchMilestone,
	deriveProgressMarks,
	evaluateDrift,
	atomicWriteJson,
	behPaths,
	loadState,
	saveState,
	findBoundProgress,
	behEnabled,
};
