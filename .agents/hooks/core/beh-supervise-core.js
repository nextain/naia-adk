/**
 * beh-supervise-core — Behavior Enforcement Harness §3.3 core (tool-agnostic SoT).
 *
 * Plan: .agents/progress/behavior-enforcement-harness-plan-2026-06-11.md (§3.3, §6.3).
 *
 * Pure supervisor decision logic for long-running background tool processes.
 * NO process control, NO fs — the wrapper (beh-supervise.js) does spawn/kill/
 * probe-read and feeds the measured series + timing here.
 *
 * Status machine (plan §3.3): RUNNING | STALL | TIMEOUT | DONE | FAIL |
 * UNSUPERVISED-DEGRADED. LLM may only READ status.
 *
 * Anti-false-positive (plan §3.3):
 *   - grace period (first 10% of wall, min 5 min): no STALL during startup.
 *   - monotonic probe: only a STRICT increase counts as progress; a decrease
 *     (non-monotonic / probe insanity) does NOT reset the stall clock.
 *   - degraded (no cgroup/systemd): UNSUPERVISED-DEGRADED + shorter forced wall
 *     unless explicitly accepted by the operator (an execution-safety opt-in,
 *     not a conversational or per-turn approval gate).
 *
 * Threat model (plan §0): sincere drift (a build/migration that silently hangs
 * forever because the agent thinks "it's still going"). NOT probe forgery.
 */

const FIVE_MIN_MS = 5 * 60 * 1000;

// probe-type allowlist — free-form probes FORBIDDEN (plan §3.3). Each kind is a
// monotonic numeric reader the wrapper knows how to evaluate.
const ALLOWED_PROBES = new Set([
	"file_lines", //  line count of a file (output grows)
	"file_bytes", //  byte size of a file
	"file_mtime", //  mtime epoch seconds (advances on writes)
	"path_count", //  number of files matching a glob (artifacts produced)
	"log_match_count", //  lines matching a pattern in a log
]);

const STATUS = {
	RUNNING: "RUNNING",
	STALL: "STALL",
	TIMEOUT: "TIMEOUT",
	DONE: "DONE",
	FAIL: "FAIL",
	DEGRADED: "UNSUPERVISED-DEGRADED",
};

function validateProbeType(t) {
	return ALLOWED_PROBES.has(t);
}

function graceMsFor(maxWallMs, override) {
	if (override != null) return override;
	return Math.max(Math.floor(maxWallMs * 0.1), FIVE_MIN_MS);
}

/**
 * Last timestamp at which the probe STRICTLY increased over its running max
 * (monotonic progress). Decreases/flats do not count. Returns startTs if no
 * strict increase has occurred yet.
 */
function lastProgressTs(probeSeries, startTs) {
	let runMax = -Infinity;
	let lastTs = startTs;
	let sawAny = false;
	for (const p of probeSeries || []) {
		if (p.value == null || typeof p.value !== "number") continue;
		if (!sawAny) {
			runMax = p.value;
			lastTs = p.ts;
			sawAny = true;
			continue;
		}
		if (p.value > runMax) {
			runMax = p.value;
			lastTs = p.ts;
		}
	}
	return lastTs;
}

/**
 * @param {object} state
 *   now, startTs            ms
 *   exit                    null | number  (process exit code, if finished)
 *   probeSeries             [{ts, value}]  monotonic numeric series (wrapper-read)
 *   config {
 *     maxWallMs, maxStallMs,
 *     graceMs?,             // default max(10% wall, 5min)
 *     probeType,            // must be allowlisted (else FAIL)
 *     degraded?:bool,       // no cgroup/systemd scope available
 *     approvedDegraded?:bool,
 *     degradedMaxWallMs?    // forced shorter wall when degraded+unapproved
 *   }
 * @returns {{status:string, action:"none"|"kill", reason:string}}
 */
function evaluateSupervisor(state) {
	const { now, startTs, exit } = state;
	const c = state.config || {};
	const elapsed = now - startTs;

	// finished — report terminal status, no kill.
	if (exit != null) {
		return exit === 0
			? { status: STATUS.DONE, action: "none", reason: "exit 0" }
			: { status: STATUS.FAIL, action: "none", reason: `exit ${exit}` };
	}

	// invalid/free-form probe → fail-closed (can't supervise progress safely).
	if (!validateProbeType(c.probeType)) {
		return { status: STATUS.FAIL, action: "kill", reason: `probe-type 미허용(free-form 금지): ${c.probeType}` };
	}

	// degraded (no scope): shorter forced wall unless execution-safety opt-in is set.
	if (c.degraded && !c.approvedDegraded) {
		const dwall = c.degradedMaxWallMs != null ? c.degradedMaxWallMs : Math.min(c.maxWallMs, 10 * FIVE_MIN_MS);
		if (elapsed >= dwall) {
			return { status: STATUS.DEGRADED, action: "kill", reason: `degraded 강제 wall 초과(${dwall}ms) — 감시 확장 opt-in 미설정` };
		}
		// still report DEGRADED so the LLM can't treat it as fully supervised.
		return { status: STATUS.DEGRADED, action: "none", reason: "cgroup/systemd 미사용 — degraded 감시(짧은 wall)" };
	}

	// hard wall.
	if (elapsed >= c.maxWallMs) {
		return { status: STATUS.TIMEOUT, action: "kill", reason: `wall 초과(${c.maxWallMs}ms)` };
	}

	// stall — only after grace period.
	const grace = graceMsFor(c.maxWallMs, c.graceMs);
	if (elapsed >= grace) {
		const lastTs = lastProgressTs(state.probeSeries, startTs);
		if (now - lastTs >= c.maxStallMs) {
			return { status: STATUS.STALL, action: "kill", reason: `probe 정체(${c.maxStallMs}ms 진전 없음)` };
		}
	}
	return { status: STATUS.RUNNING, action: "none", reason: "정상 진행" };
}

// ── lease (single-writer / single-instance; acquire + stale recovery) ──────
/**
 * @param {object|null} current  existing lease {owner, ts} or null
 * @param {{owner:string, now:number, ttlMs:number}} req
 * @returns {{granted:boolean, lease:(object|null), reason:string}}
 */
function acquireLease(current, req) {
	if (!current) return { granted: true, lease: { owner: req.owner, ts: req.now }, reason: "신규 획득" };
	if (current.owner === req.owner) return { granted: true, lease: { owner: req.owner, ts: req.now }, reason: "갱신" };
	if (req.now - current.ts >= req.ttlMs) {
		return { granted: true, lease: { owner: req.owner, ts: req.now }, reason: "stale 회수" };
	}
	return { granted: false, lease: current, reason: `보유중(owner=${current.owner})` };
}

module.exports = {
	ALLOWED_PROBES,
	STATUS,
	FIVE_MIN_MS,
	validateProbeType,
	graceMsFor,
	lastProgressTs,
	evaluateSupervisor,
	acquireLease,
};
