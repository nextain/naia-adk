/**
 * beh-launch-core — BEH §3.4 pure predicates (tool-agnostic SoT).
 *
 * Plan: .agents/progress/behavior-enforcement-harness-plan-2026-06-11.md (§3.4, §6.4).
 *
 * Pure helpers for: (a) PreToolUse "unsupervised background → block" and
 * (b) external launcher session-start handshake (fail-CLOSED). NO fs/host I/O.
 */

// ── (a) unsupervised-background detection ─────────────────────────────────
/**
 * Does this shell command background / detach a process? Backgrounded work must
 * go through the supervise wrapper (§3.3) so it gets a wall+stall deadline.
 * Quote-blank first so a literal "&" inside a string isn't a false positive.
 */
function isBackgrounded(command) {
	const c = String(command || "")
		.replace(/'[^']*'/g, "''")
		.replace(/"[^"]*"/g, '""');
	// a single trailing & (job control), not the && operator
	if (/(^|[^&])&\s*$/.test(c.trim())) return true;
	if (/(^|[^&])&\s*[;\n]/.test(c)) return true; //  cmd & ; next
	if (/\bnohup\b/.test(c)) return true;
	if (/\bsetsid\b/.test(c)) return true;
	if (/\bdisown\b/.test(c)) return true;
	return false;
}

/** Is this command the BEH supervise wrapper itself? (allowed to background) */
function isSuperviseWrapper(command) {
	return /beh-supervise\.js\b/.test(String(command || ""));
}

/** Is this command the external launcher? (always allowed, to establish handshake) */
function isLauncher(command) {
	return /beh-launch\.sh\b/.test(String(command || ""));
}

// ── (b) session-start handshake (fail-CLOSED) ─────────────────────────────
/**
 * The external launcher verifies the required hooks are registered + responsive,
 * then writes a handshake bound to a hash of the host hook registration
 * (settings.json). A session whose handshake is missing, stale, or bound to a
 * DIFFERENT registration hash (hooks drifted / unregistered since) fails closed.
 *
 * Self-hosted limit (plan §0/§3.4): an unregistered hook can't block itself —
 * the LAUNCHER (external, before the agent starts) is the real enforcement.
 * This in-loop check is the complement: it catches drift after launch and
 * sessions not started via the launcher.
 *
 * @param {object} p
 *   p.handshake     {ts, settings_hash} | null
 *   p.currentHash   string (hash of current settings.json) | null
 *   p.now           ms
 *   p.maxAgeMs      handshake validity window
 * @returns {{ok:boolean, reason:string}}
 */
function evaluateHandshake(p) {
	if (!p.handshake) return { ok: false, reason: "session-start handshake 없음 — 외부 launcher 미경유" };
	if (p.currentHash && p.handshake.settings_hash !== p.currentHash) {
		return { ok: false, reason: "훅 등록(settings.json) 변경 — handshake 무효(드리프트)" };
	}
	if (p.maxAgeMs != null && p.handshake.ts != null && p.now - p.handshake.ts >= p.maxAgeMs) {
		return { ok: false, reason: "handshake 만료(stale)" };
	}
	return { ok: true, reason: "유효" };
}

module.exports = { isBackgrounded, isSuperviseWrapper, isLauncher, evaluateHandshake };
