"use strict";
// Plan gate responsibility: review-policy.
const { ROOT } = require("./deploy-plan-common.js");
const { trustedGateConfig } = require("./deploy-plan-context.js");

// 리뷰 배치: author muse → planReview 설정에 따라 argon 또는 codex 1명. 옛 author(sol|argon)의 2인 기록은 재리뷰까지만 구 기록으로 인정한다.
const REVIEW_MODELS = Object.freeze({
	sol: Object.freeze({ model: "gpt-6.1-sol", effort: "high" }),
	muse: Object.freeze({ model: "muse-spark-1.3", effort: "xhigh" }),
	argon: Object.freeze({ model: "gemini-4-argon-medium", effort: "medium" }),
	codex: Object.freeze({ model: "gpt-6.1-terra", effort: "high" }),
});

const REVIEW_MODEL_POLICY = Object.freeze({ efforts: Object.freeze(["medium", "high", "xhigh", "max"]), runners: Object.freeze(["agy", "muse", "codex", "claude"]) });

const DEFAULT_RUNNERS = Object.freeze({ sol: "codex", muse: "muse", argon: "agy", codex: "codex" });

function validateReviewModelEntry(id, v) {
	if (typeof id !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(id)) throw new Error(`review_models.${id}: 리뷰어 id 오류`);
	if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`review_models.${id}: 객체 필요`);
	for (const k of Object.keys(v)) if (!["model", "effort", "runner", "_comment"].includes(k)) throw new Error(`review_models.${id}: 알 수 없는 칸 ${k}`);
	if (typeof v.model !== "string" || !v.model || v.model.length > 512 || v.model.startsWith("-") || /[\x00-\x1f\x7f]/.test(v.model)) throw new Error(`review_models.${id}.model: 정확한 모델 이름 필요`);
	if (!REVIEW_MODEL_POLICY.efforts.includes(v.effort)) throw new Error(`review_models.${id}.effort: medium 이상 필요`);
	const runner = v.runner === undefined ? DEFAULT_RUNNERS[id] : v.runner;
	if (!REVIEW_MODEL_POLICY.runners.includes(runner)) throw new Error(`review_models.${id}.runner: 실행기 오류`);
	return Object.freeze({ model: v.model, effort: v.effort, runner });
}

function canonicalReviewModels(models) {
	return Object.keys(models).sort().map((id) => ({ id, model: models[id].model, effort: models[id].effort, runner: models[id].runner || DEFAULT_RUNNERS[id] }));
}

function resolveReviewModels(config) {
	const cfg = config?.review_models;
	if (cfg === undefined) return REVIEW_MODELS;
	if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error("review_models 형식이 틀림(객체여야 함)");
	const out = {};
	for (const [id, v] of Object.entries(cfg)) {
		if (id === "_comment") continue;
		if (!v || !Object.hasOwn(v, "runner")) throw new Error(`review_models.${id}.runner 필수`);
		out[id] = validateReviewModelEntry(id, v);
	}
	if (!Object.keys(out).length) throw new Error("review_models 에 리뷰어가 없음");
	if (new Set(Object.values(out).map((m) => m.model)).size !== Object.keys(out).length) throw new Error("review_models 의 모델 이름이 서로 겹침");
	return Object.freeze(out);
}

function reviewModelsFor(root = ROOT) { return resolveReviewModels(trustedGateConfig(root)); }

const AUTHOR_IDS = ["sol", "muse", "argon"];

// 리뷰 차례(번갈아): ROTATION 순서대로 작성자 다음 모델이 먼저 리뷰하고, 한도에 걸리면 나머지 하나로 넘어간다. 작성자 자신은 절대 리뷰하지 않는다.
const ROTATION = Object.freeze(["argon", "codex", "muse", "claude"]);

// 차례 작성자와 옛 모양 작성자(sol 포함)를 함께 받는다. 옛 sol·argon 2인 기록은 그대로 읽는다.
const AUTHOR_MODELS = Object.freeze(["sol", "muse", "argon", "codex", "claude"]);

function selfReview(author, id, models) {
	return id === author || (author === "claude" && models[id]?.runner === "claude") || (models[id]?.model && (models[id].model === models[author]?.model || models[id].model === REVIEW_MODELS[author]?.model));
}

// 한도 실패 판별식: 종료 코드가 0이 아니고 실행기 진단(stderr·실행 오류)이 이 식과 맞을 때만 다음 후보로 넘어간다. 리뷰 본문(stdout)은 계획서 낱말을 되풀이할 수 있어 보지 않는다.
const LIMIT_RE = /rate.?limit|quota|usage limit|\b429\b|RESOURCE_EXHAUSTED|\bexhausted\b/i;

function reviewerIdsFor(author, root = ROOT, at = Date.now()) {
	if (author !== "muse") return AUTHOR_IDS.filter((id) => id !== author);
	const started = typeof at === "number" ? at : Date.parse(at);
	const config = trustedGateConfig(root)?.planReview;
	const until = config?.until;
	const date = typeof until === "string" ? /^(\d{4})-(\d{2})-(\d{2})T/.exec(until) : null;
	const validDate = date && Number(date[2]) >= 1 && Number(date[2]) <= 12 && Number(date[3]) >= 1 && Number(date[3]) <= new Date(Date.UTC(Number(date[1]), Number(date[2]), 0)).getUTCDate();
	if (Number.isFinite(started) &&
		config?.reviewer === "codex" && validDate && typeof until === "string" &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(until) &&
		Number.isFinite(Date.parse(until)) && started < Date.parse(until)) return ["codex"];
	return ["argon"];
}

// 차례상 후보 순서(작성자 제외): 작성자 다음 모델이 먼저, 그 다음이 나머지 하나다. 옛 reviewerIdsFor 는 손대지 않고 새 review 흐름만 이 순서를 쓴다.
function rotationOrderForModels(author, models) {
	const reviewRotation = ROTATION.slice(0, 3);
	if (!ROTATION.includes(author)) return [];
	const i = reviewRotation.indexOf(author);
	const preferred = i < 0 ? reviewRotation : [reviewRotation[(i + 1) % 3], reviewRotation[(i + 2) % 3]];
	const extras = Object.keys(models).filter((id) => !reviewRotation.includes(id) && id !== "sol" && id !== author).sort();
	return [...preferred.filter((id) => Object.hasOwn(models, id) && !selfReview(author, id, models)), ...extras.filter((id) => !selfReview(author, id, models))].slice(0, 2);
}

function rotationOrder(author, root = ROOT) { return rotationOrderForModels(author, reviewModelsFor(root)); }

// 차례 후보 둘(먼저 쓸 리뷰어, 한도 실패 때 넘어갈 리뷰어). 고정 planReview 가 기한 안이고 작성자와 다르면 맨 앞에 두고, 지났거나 until 이 없거나 작성자 자신이면 차례만 쓴다. 설정 JSON 깨짐·형식 틀림(차례 밖 리뷰어, 읽을 수 없는 until)은 던진다.
function orderedReviewersForConfig(author, configData, at = Date.now()) {
	const models = resolveReviewModels(configData);
	const base = rotationOrderForModels(author, models);
	if (!base.length) throw new Error("작성자 외 승인된 리뷰어 없음");
	const started = typeof at === "number" ? at : Date.parse(at);
	if (!Number.isFinite(started)) throw new Error("리뷰 시각을 읽지 못함");
	const config = configData?.planReview;
	if (config === undefined) return base;
	if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("planReview 형식이 틀림(객체여야 함)");
	if (!Object.hasOwn(models, config.reviewer) || config.reviewer === "sol") throw new Error("planReview.reviewer 는 승인된 리뷰어여야 함");
	const until = config.until;
	if (until === undefined) return base;
	const date = typeof until === "string" ? /^(\d{4})-(\d{2})-(\d{2})T/.exec(until) : null;
	const validDate = date && Number(date[2]) >= 1 && Number(date[2]) <= 12 && Number(date[3]) >= 1 && Number(date[3]) <= new Date(Date.UTC(Number(date[1]), Number(date[2]), 0)).getUTCDate();
	if (!validDate || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(until) || !Number.isFinite(Date.parse(until))) throw new Error("planReview.until 형식이 틀림(ISO 시각)");
	if (started >= Date.parse(until) || selfReview(author, config.reviewer, models)) return base;
	if (config.reviewer === base[0]) return base;
	return [config.reviewer, ...base.filter((id) => id !== config.reviewer)];
}

function orderedReviewers(author, root = ROOT, at = Date.now()) {
	if (!ROTATION.includes(author)) return reviewerIdsFor(author, root, at);
	return orderedReviewersForConfig(author, trustedGateConfig(root), at);
}

// 한도 실패는 0이 아닌 정수 종료 코드와 실행기 진단으로만 판별한다.
function isLimitFailure(exitCode, text) {
	return Number.isInteger(exitCode) && exitCode !== 0 && LIMIT_RE.test(String(text || ""));
}

// 차례 도입 시각. 옛 모양(rotation 칸 없음) 기록은 이보다 앞선 것만 받는다. 새 기록에서 rotation 칸 하나를 지워 차례 대조를 건너뛰는 길을 막는다.
const LEGACY_REVIEW_CUTOFF = "2026-11-10T10:00:00Z";

// 새 모양 기록인가(명시 칸 rotation:true). 작성자만으로 가르면 argon 작성자의 옛 2인 기록과 새 1인 기록이 충돌하므로, 옛 영수증과 부딪히지 않는 명시 칸으로 가른다.
function isRotationRecord(rec) {
	return !!rec && rec.rotation === true;
}

module.exports = {
	REVIEW_MODELS,
	REVIEW_MODEL_POLICY,
	DEFAULT_RUNNERS,
	validateReviewModelEntry,
	canonicalReviewModels,
	resolveReviewModels,
	reviewModelsFor,
	AUTHOR_IDS,
	ROTATION,
	AUTHOR_MODELS,
	selfReview,
	LIMIT_RE,
	reviewerIdsFor,
	rotationOrderForModels,
	rotationOrder,
	orderedReviewersForConfig,
	orderedReviewers,
	isLimitFailure,
	LEGACY_REVIEW_CUTOFF,
	isRotationRecord,
};
