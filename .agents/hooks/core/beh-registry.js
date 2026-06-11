/**
 * beh-registry — BEH §3.6 registry loader + validator (tool-agnostic SoT).
 *
 * Plan: .agents/progress/behavior-enforcement-harness-plan-2026-06-11.md (§3.6, §6.5).
 *
 * The registry (.agents/hooks/beh-registry.json) is the authoritative catalog
 * of every BEH enforcement point. This module:
 *   - validates the registry schema (every entry has the required fields),
 *   - cross-checks it against the host hook registration (settings.json): every
 *     `registered:true` entry's hook_file MUST appear in settings.json, and
 *     every BEH hook in settings.json MUST be in the registry — a REGISTRATION-
 *     DRIFT guard (a silently-unregistered enforcement point is exactly the
 *     §3.4 gap; an undocumented registered hook is unaccounted enforcement).
 *
 * Pure: callers pass the registry object + settings text. No fs here.
 */

const REQUIRED_FIELDS = ["name", "surface", "trigger", "check", "action", "fail_mode", "escalation", "recovery"];
const SURFACES = new Set(["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "SessionStart", "external"]);

/** @returns {{ok:boolean, errors:string[]}} */
function validateRegistry(registry) {
	const errors = [];
	if (!registry || !Array.isArray(registry.entries)) {
		return { ok: false, errors: ["registry.entries 가 배열이 아님"] };
	}
	const names = new Set();
	for (const e of registry.entries) {
		const id = e && e.name ? e.name : "(unnamed)";
		for (const f of REQUIRED_FIELDS) {
			if (e[f] == null || e[f] === "") errors.push(`${id}: 필수 필드 누락 '${f}'`);
		}
		if (e.surface && !SURFACES.has(e.surface)) errors.push(`${id}: 미허용 surface '${e.surface}'`);
		if (names.has(e.name)) errors.push(`중복 name '${e.name}'`);
		names.add(e.name);
		if (e.registered === true && !e.hook_file) errors.push(`${id}: registered=true 인데 hook_file 없음`);
	}
	return { ok: errors.length === 0, errors };
}

/**
 * Cross-check registry vs settings.json hook registration.
 * @param {object} registry
 * @param {string} settingsText  raw .claude/settings.json
 * @returns {{ok:boolean, errors:string[]}}
 */
function crossCheckSettings(registry, settingsText) {
	const errors = [];
	// hook files BEH expects to be registered.
	const expected = (registry.entries || []).filter((e) => e.registered === true).map((e) => e.hook_file);
	for (const f of expected) {
		if (!settingsText.includes(f)) errors.push(`레지스트리 registered hook '${f}' 가 settings.json 에 미등록 (등록 드리프트)`);
	}
	// any beh-*.js referenced in settings.json must be catalogued.
	const catalogued = new Set((registry.entries || []).map((e) => e.hook_file).filter(Boolean));
	const refRe = /beh-[a-z-]+\.js/g;
	let m;
	const seen = new Set();
	while ((m = refRe.exec(settingsText))) seen.add(m[0]);
	for (const f of seen) {
		if (!catalogued.has(f)) errors.push(`settings.json 의 BEH 훅 '${f}' 가 레지스트리에 미등재 (미문서화 강제점)`);
	}
	return { ok: errors.length === 0, errors };
}

module.exports = { REQUIRED_FIELDS, SURFACES, validateRegistry, crossCheckSettings };
