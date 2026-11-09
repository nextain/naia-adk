"use strict";
/**
 * 한 글에 여러 역할이 함께 불렸을 때 맡는 역할 하나를 정하는 순수 판정 함수.
 *
 * 규칙:
 * - 한 글에 여러 역할이 불리면 요청 분류표(인스턴스 설정, 예: config/role-routing.example.json)로
 *   맡는 역할 하나를 정하고, 맡은 역할이 먼저 '맡음 + 끝낼 시각'을 남긴다.
 * - 분류표에 해당하지 않거나 분류표가 없으면 부른 순서의 첫 번째 역할이 맡는다.
 * - 다른 역할은 대신 전달하지 않고, 맡은 역할이 10분 안에 맡음을 안 남기면 그때 한 번만 깨운다.
 */

function escapeRegex(text) {
	return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRoleIndex(roles) {
	const byToken = new Map();
	if (!Array.isArray(roles)) return byToken;
	for (const r of roles) {
		if (!r || typeof r !== "object" || typeof r.id !== "string" || !r.id.trim()) continue;
		const canonical = r.id.trim();
		byToken.set(canonical.toLowerCase(), canonical);
		if (typeof r.botId === "string" && r.botId.trim()) {
			byToken.set(r.botId.trim().toLowerCase(), canonical);
		}
		for (const alias of Array.isArray(r.aliases) ? r.aliases : []) {
			if (typeof alias === "string" && alias.trim()) {
				byToken.set(alias.trim().toLowerCase(), canonical);
			}
		}
	}
	return byToken;
}

function normalizeRoleId(token, roleIndex) {
	if (token === undefined || token === null) return "";
	if (typeof token === "object") {
		const raw = token.id ?? token.roleId ?? token.botId ?? token.name ?? "";
		return normalizeRoleId(raw, roleIndex);
	}
	const raw = String(token).trim().replace(/^<@!?(\d+)>$/, "$1").replace(/^@/, "");
	if (!raw) return "";
	return roleIndex.get(raw.toLowerCase()) || raw;
}

/**
 * 글 본문에서 호출된 역할들을 등장 순서대로 뽑는다.
 */
function extractCalledRoles(text, roles = []) {
	const content = String(text ?? "");
	if (!content || !Array.isArray(roles) || roles.length === 0) return [];
	const hits = [];
	for (const role of roles) {
		if (!role || typeof role.id !== "string" || !role.id.trim()) continue;
		const candidates = [
			role.botId ? `<@${role.botId}>` : null,
			role.botId ? `<@!${role.botId}>` : null,
			`@${role.id}`,
			...(Array.isArray(role.aliases) ? role.aliases.flatMap((a) => [`@${a}`, `${a}에게`, `${a}께`]) : []),
		].filter(Boolean);
		let bestIdx = -1;
		for (const pat of candidates) {
			const idx = content.indexOf(pat);
			if (idx >= 0 && (bestIdx < 0 || idx < bestIdx)) bestIdx = idx;
		}
		if (bestIdx >= 0) hits.push({ id: role.id.trim(), index: bestIdx });
	}
	hits.sort((a, b) => a.index - b.index);
	const out = [];
	const seen = new Set();
	for (const h of hits) {
		if (!seen.has(h.id)) {
			seen.add(h.id);
			out.push(h.id);
		}
	}
	return out;
}

/**
 * 여러 역할이 호출되었을 때 요청 분류표(config)에 따라 맡는 역할 하나를 고른다.
 * 분류표가 없거나 어느 분류 규칙에도 해당하지 않으면 호출된 첫 번째 역할을 돌려준다.
 *
 * @param {object|Array<string>} input - { calledRoles, text, category } 또는 호출된 역할 배열
 * @param {object} [config] - 요청 분류표 설정 ({ roles, rules, claimTimeoutMinutes })
 * @param {string} [maybeText] - input 이 배열일 때 요청 본문 문자열
 */
function selectSingleOwnerRole(input, config = {}, maybeText = "") {
	let rawRoles = [];
	let text = "";
	let category = "";
	let cfg = config || {};

	if (Array.isArray(input)) {
		rawRoles = input;
		if (typeof config === "string") {
			text = config;
			cfg = typeof maybeText === "object" && maybeText ? maybeText : {};
		} else {
			text = typeof maybeText === "string" ? maybeText : String(cfg?.text ?? "");
		}
	} else if (input && typeof input === "object") {
		rawRoles = Array.isArray(input.calledRoles)
			? input.calledRoles
			: Array.isArray(input.roles)
				? input.roles
				: Array.isArray(input.mentions)
					? input.mentions
					: [];
		text = String(input.text ?? input.content ?? maybeText ?? "");
		category = String(input.category ?? input.kind ?? "").trim();
	}

	const roleIndex = buildRoleIndex(cfg?.roles);
	const calledRoles = [];
	const seen = new Set();
	for (const r of rawRoles) {
		const norm = normalizeRoleId(r, roleIndex);
		if (norm && !seen.has(norm)) {
			seen.add(norm);
			calledRoles.push(norm);
		}
	}
	if (calledRoles.length === 0 && text && Array.isArray(cfg?.roles)) {
		for (const r of extractCalledRoles(text, cfg.roles)) {
			if (!seen.has(r)) {
				seen.add(r);
				calledRoles.push(r);
			}
		}
	}

	const timeoutMinutes = Number.isFinite(cfg?.claimTimeoutMinutes) && cfg.claimTimeoutMinutes > 0
		? cfg.claimTimeoutMinutes
		: 10;
	const policy = {
		ownerMustPost: "맡음 + 끝낼 시각",
		otherRolesForward: false,
		unclaimedWakeAfterMinutes: timeoutMinutes,
		maxUnclaimedWakeCount: 1,
	};

	if (calledRoles.length === 0) {
		return {
			ownerRole: null,
			matchedRule: null,
			reason: "no-role-called",
			calledRoles: [],
			standbyRoles: [],
			policy,
		};
	}

	if (calledRoles.length === 1) {
		return {
			ownerRole: calledRoles[0],
			matchedRule: null,
			reason: "single-role-called",
			calledRoles,
			standbyRoles: [],
			policy,
		};
	}

	const rules = Array.isArray(cfg?.rules)
		? cfg.rules
		: Array.isArray(cfg?.classifications)
			? cfg.classifications
			: [];
	const lowerText = text.toLowerCase();
	const lowerCategory = category.toLowerCase();

	const candidates = [];
	for (const [idx, rule] of rules.entries()) {
		if (!rule || typeof rule !== "object") continue;
		const ruleOwner = normalizeRoleId(rule.ownerRole ?? rule.roleId ?? rule.role, roleIndex);
		if (!ruleOwner || !calledRoles.includes(ruleOwner)) continue;

		let score = 0;
		const ruleId = String(rule.id ?? "").trim();
		const ruleCat = String(rule.category ?? "").trim();
		if (lowerCategory && (ruleId.toLowerCase() === lowerCategory || ruleCat.toLowerCase() === lowerCategory)) {
			score += 100;
		}
		if (Array.isArray(rule.keywords)) {
			for (const kw of rule.keywords) {
				const k = String(kw ?? "").trim().toLowerCase();
				if (k && lowerText.includes(k)) score += 10;
			}
		}
		if (typeof rule.pattern === "string" && rule.pattern.trim()) {
			try {
				if (new RegExp(rule.pattern, "i").test(text)) score += 20;
			} catch {}
		}
		if (score > 0) {
			const priority = Number.isFinite(rule.priority) ? rule.priority : 100 + idx;
			candidates.push({
				ownerRole: ruleOwner,
				ruleId: ruleId || ruleCat || `rule-${idx}`,
				score,
				priority,
				callOrder: calledRoles.indexOf(ruleOwner),
			});
		}
	}

	if (candidates.length > 0) {
		candidates.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			if (a.priority !== b.priority) return a.priority - b.priority;
			return a.callOrder - b.callOrder;
		});
		const winner = candidates[0];
		return {
			ownerRole: winner.ownerRole,
			matchedRule: winner.ruleId,
			reason: "matched-classification-rule",
			calledRoles,
			standbyRoles: calledRoles.filter((r) => r !== winner.ownerRole),
			policy,
		};
	}

	const firstRole = calledRoles[0];
	return {
		ownerRole: firstRole,
		matchedRule: null,
		reason: "fallback-first-role",
		calledRoles,
		standbyRoles: calledRoles.slice(1),
		policy,
	};
}

/**
 * 다른 역할은 대신 전달하지 않고, 맡은 역할이 10분(기본값) 안에 '맡음 + 끝낼 시각'을 안 남기면
 * 그때 한 번만 깨운다.
 */
function shouldWakeUnclaimedOwner({
	calledAtMs,
	nowMs,
	claimed = false,
	wakeCount = 0,
	timeoutMinutes = 10,
} = {}) {
	if (claimed) return { shouldWake: false, reason: "already-claimed" };
	if (wakeCount >= 1) return { shouldWake: false, reason: "already-woken-once" };
	const elapsedMs = Number(nowMs) - Number(calledAtMs);
	const thresholdMs = (Number.isFinite(timeoutMinutes) && timeoutMinutes > 0 ? timeoutMinutes : 10) * 60 * 1000;
	if (!Number.isFinite(elapsedMs) || elapsedMs < thresholdMs) {
		return { shouldWake: false, reason: "before-timeout" };
	}
	return { shouldWake: true, reason: "unclaimed-after-timeout" };
}

module.exports = {
	selectSingleOwnerRole,
	resolveSingleRoleOwner: selectSingleOwnerRole,
	pickOwnerRole: selectSingleOwnerRole,
	shouldWakeUnclaimedOwner,
	extractCalledRoles,
	escapeRegex,
};
