"use strict";

const fs = require("node:fs");
const { createHash } = require("node:crypto");
const TIER_PROFILE_REL = "config/tier-profile.json";
const PLACEHOLDER_RE = /<(?:CLI|TIER|MODEL|EFFORT|FAMILY|WORKER)[^>]*>|\{\{[^}]*\}\}|^(?:MODEL_ID|CLI_ID)$/i;
const SAFE_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;

function validTierToken(val) {
	if (typeof val !== "string") return false;
	const s = val.trim();
	return s.length > 0 && !/[\0\r\n]/.test(val) && val === s && !PLACEHOLDER_RE.test(s);
}

function safeProfileId(val) {
	return typeof val === "string" && SAFE_ID_RE.test(val) && validTierToken(val) && !/secret|token|password|apikey|api_key/i.test(val);
}

function parseTier3Fallback(fallback) {
	if (!fallback || typeof fallback !== "object" || Array.isArray(fallback)) return undefined;
	const names = [];
	const addName = (value) => { if (safeProfileId(value) && !names.includes(value)) names.push(value); };
	if (fallback.accounts !== undefined) {
		if (!Array.isArray(fallback.accounts)) return { error: "tiers.3.fallback.accounts 형식 오류" };
		for (const account of fallback.accounts) {
			if (typeof account === "string") addName(account);
			else if (account && typeof account === "object" && !Array.isArray(account)) addName(account.name);
			else if (account !== undefined) return { error: "tiers.3.fallback.accounts 식별자 형식 오류" };
		}
	}
	if (fallback.accountNames !== undefined) {
		if (!Array.isArray(fallback.accountNames) || !fallback.accountNames.every((name) => safeProfileId(name))) return { error: "tiers.3.fallback.accountNames 형식 오류" };
		fallback.accountNames.forEach(addName);
	}
	const result = { accountNames: names };
	if (fallback.quota_policy !== undefined) {
		const q = fallback.quota_policy;
		if (!q || typeof q !== "object" || Array.isArray(q)) return { error: "tiers.3.fallback.quota_policy 형식 오류" };
		const pct = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;
		if (q.min_remaining_pct !== undefined && !pct(q.min_remaining_pct) || q.switch_threshold_pct !== undefined && !pct(q.switch_threshold_pct) || q.recovery_check_interval_sec !== undefined && !(Number.isSafeInteger(q.recovery_check_interval_sec) && q.recovery_check_interval_sec >= 60)) return { error: "tiers.3.fallback.quota_policy 값 오류" };
		result.quotaPolicy = { ...(q.min_remaining_pct !== undefined ? { minRemainingPct: q.min_remaining_pct } : {}), ...(q.switch_threshold_pct !== undefined ? { switchThresholdPct: q.switch_threshold_pct } : {}), ...(q.recovery_check_interval_sec !== undefined ? { recoveryCheckIntervalSec: q.recovery_check_interval_sec } : {}) };
	}
	if (fallback.recovery !== undefined) {
		const signals = fallback.recovery && typeof fallback.recovery === "object" && !Array.isArray(fallback.recovery) ? fallback.recovery.accept_any_of : undefined;
		if (!Array.isArray(signals) || !signals.every(safeProfileId)) return { error: "tiers.3.fallback.recovery.accept_any_of 형식 오류" };
		result.recoverySignals = [...new Set(signals)];
	}
	return result;
}

/**
 * 인스턴스 층 프로파일(config/tier-profile.json)을 읽고 검증한다. 모델 이름 기본값은 절대 두지 않는다.
 * 반환: { status: "ok", configRel, path, priority, tier2 } | { status: "missing", configRel, path } | { status: "broken", configRel, path, reason }
 */
function loadTierProfileFile(targetPath) {
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
	const tier3Fallback = parsed.tiers["3"]?.fallback === undefined ? undefined : parseTier3Fallback(parsed.tiers["3"].fallback);
	if (tier3Fallback?.error) return broken(tier3Fallback.error);
	const candidates = [];
	for (let i = 0; i < tier2.candidates.length; i++) {
		const c = tier2.candidates[i];
		const cli = c.cli.trim();
		const model = c.model.trim();
		const effort = c.effort !== undefined ? c.effort.trim() : undefined;
		if (c.argv !== undefined) {
			if (!validWorkerArgv(c)) return broken(`tiers.2.candidates[${i}].argv: invalid profile command`);
			candidates.push({ cli, model, ...(effort ? { effort } : {}), argv: c.argv });
			continue;
		}
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
		document: parsed,
		sha256: createHash("sha256").update(raw).digest("hex"),
		priority,
		tier2: {
			maxParallel: tier2.max_parallel ?? null,
			candidates,
		},
		...(tier3Fallback ? { tier3Fallback } : {}),
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
	if (candidate.argv) return expandWorkerArgv(candidate, map).map(shellQuote).join(" ");
	return String(candidate.commandTemplate || "").replace(
		/\{(cli|model|effort|prompt_file|work_dir|result_file)\}/g,
		(_, key) => map[key],
	);
}

function validWorkerArgv(candidate) {
	const args = candidate.argv;
	if (!Array.isArray(args) || args[0] !== "{cli}" || !args.every(validTierToken)) return false;
	const fields = args.flatMap(arg => [...arg.matchAll(/\{([A-Za-z_]\w*)\}/g)].map(match => match[1]));
	return fields.every(name => ["cli", "model", "effort", "prompt_file", "work_dir", "result_file"].includes(name)) &&
		fields.includes("model") && (candidate.effort ? fields.includes("effort") : !fields.includes("effort"));
}

function expandWorkerArgv(candidate, paths) {
	const values = { ...paths, cli: candidate.cli, model: candidate.model, effort: candidate.effort };
	return candidate.argv.map(arg => arg.replace(/\{([A-Za-z_]\w*)\}/g, (_, key) => values[key]));
}

function shellQuote(arg) {
	return /^[a-zA-Z0-9_/.=:-]+$/.test(arg) ? arg : "'" + arg.replaceAll("'", "'\\''") + "'";
}

module.exports = { TIER_PROFILE_REL, loadTierProfileFile, renderTier2Command, validTierToken, validWorkerArgv, expandWorkerArgv };
