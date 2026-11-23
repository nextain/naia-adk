"use strict";
// Plan gate responsibility: readonly-binding.
const path = require("path");
const fs = require("fs");
const { ROOT, sha256 } = require("./deploy-plan-common.js");
const { validateReadOnlyScriptsConfig, verifyRepoFileGitClean, canonicalReadOnlyBinding } = require("./deploy-plan-readonly-policy.js");
const { gateConfigView: gateConfigContext } = require("./deploy-plan-context.js");

/** 계획서의 services·고정 files 와 git HEAD 일치 config/deploy-gate.json readOnlyScripts 를 대조해 리뷰 시점 바인딩 목록을 만든다. */
function planReadOnlyScriptsBinding(plan, root) {
	const base = root ? path.resolve(root) : ROOT;
	const cfgPath = path.join(base, "config", "deploy-gate.json");
	if (!fs.existsSync(cfgPath)) return { ok: true, items: [] };
	let cfg;
	try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); }
	catch (e) { return { ok: false, why: `config/deploy-gate.json 파싱 실패: ${e.message}`, items: [] }; }
	const valid = validateReadOnlyScriptsConfig(cfg);
	if (!valid.ok) return { ok: false, why: valid.why, items: [] };
	if (valid.items.length === 0) return { ok: true, items: [] };
	const cleanCfg = verifyRepoFileGitClean(cfgPath, null, "config/deploy-gate.json");
	if (!cleanCfg.ok) return { ok: true, items: [] };
	const planServices = new Set(Array.isArray(plan?.services) ? plan.services.map((s) => String(s || "").trim()) : []);
	const pinnedAbsToSha = new Map();
	for (const step of Array.isArray(plan?.scenario) ? plan.scenario : []) {
		if (!step || !step.files || typeof step.files !== "object" || Array.isArray(step.files)) continue;
		for (const [f, want] of Object.entries(step.files)) {
			if (!/^[a-f0-9]{64}$/i.test(String(want))) continue;
			const abs = path.isAbsolute(f) ? path.resolve(f) : path.resolve(base, f);
			try {
				if (!fs.statSync(abs).isFile()) continue;
				const actual = sha256(fs.readFileSync(abs));
				if (actual === String(want).toLowerCase()) pinnedAbsToSha.set(abs, actual);
			} catch {}
		}
	}
	const bound = [];
	for (const item of valid.items) {
		if (!planServices.has(item.service)) continue;
		const absScript = path.join(cleanCfg.realTop, item.path);
		if (pinnedAbsToSha.get(absScript) !== item.sha256) continue;
		const cleanScript = verifyRepoFileGitClean(absScript, cleanCfg.realTop, item.path);
		if (!cleanScript.ok || cleanScript.rel !== item.path || cleanScript.sha256 !== item.sha256) continue;
		bound.push({ sha256: item.sha256, path: item.path, service: item.service, script_sha256: cleanScript.sha256 });
	}
	const profile = gateConfigContext.getStore()?.selected;
	const permitted = profile ? bound.filter(row => profile.allowlist.items.some(rule =>
		rule.path === row.path && rule.service === row.service && rule.sha256 === row.sha256)) : bound;
	return { ok: true, items: canonicalReadOnlyBinding(permitted) };
}

module.exports = {
	planReadOnlyScriptsBinding,
};
