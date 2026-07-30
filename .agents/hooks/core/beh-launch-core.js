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

function directCommandWords(command) {
	const text = String(command || "");
	const words = [];
	let word = "", quote = null;
	for (const char of text) {
		if (quote) { if (char === quote) quote = null; else word += char; continue; }
		if (char === "'" || char === '"') { quote = char; continue; }
		if (/[&|;<>\r\n]/.test(char)) return null;
		if (/\s/.test(char)) { if (word) { words.push(word); word = ""; } continue; }
		word += char;
	}
	if (quote) return null;
	if (word) words.push(word);
	return words;
}

function directScript(command, executables, scripts, allowTrailingBackground = false) {
	let text = String(command || "").trim();
	if (allowTrailingBackground && /(^|[^&])&\s*$/.test(text)) text = text.replace(/&\s*$/, "").trim();
	const words = directCommandWords(text);
	if (!words || words.length < 2) return false;
	const executable = words[0].toLowerCase();
	const script = words[1].replace(/\\/g, "/").replace(/^\.\//, "");
	return executables.includes(executable) && scripts.includes(script);
}

/** Is this command a direct BEH supervise invocation? (allowed to background) */
function isSuperviseWrapper(command) {
	return directScript(command, ["node", "node.exe"], [".claude/hooks/beh-supervise.js"], true);
}

/** Is this command the external launcher? (always allowed, to establish handshake) */
function isLauncher(command) {
	return directScript(command, ["node", "node.exe"], [".claude/hooks/beh-launch.cjs"])
		|| directScript(command, ["bash", "bash.exe"], [".claude/hooks/beh-launch.sh"]);
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
	if (!p.handshake || !Number.isFinite(p.handshake.ts) || typeof p.handshake.settings_hash !== "string") {
		return { ok: false, reason: "session-start handshake missing or incomplete — external launcher required" };
	}
	if (typeof p.currentHash !== "string" || !p.currentHash) return { ok: false, reason: "current hook registration hash unavailable" };
	if (p.handshake.settings_hash !== p.currentHash) {
		return { ok: false, reason: "훅 등록(settings.json) 변경 — handshake 무효(드리프트)" };
	}
	if (p.maxAgeMs != null && p.now - p.handshake.ts >= p.maxAgeMs) {
		return { ok: false, reason: "handshake 만료(stale)" };
	}
	return { ok: true, reason: "유효" };
}

module.exports = { isBackgrounded, directCommandWords, isSuperviseWrapper, isLauncher, evaluateHandshake };
