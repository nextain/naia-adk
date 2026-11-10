"use strict";
/**
 * 운영 배포 계획서(승인 보고 양식) 관문. deploy-guard 가 운영 변경 명령마다 부른다.
 *
 * 절차 문서: docs/guides/approval-plan-gate.md
 *
 * 흐름(명령 하나가 들어올 때):
 * 1. 계획서 찾기: .agents/progress/<작업>/gates/deploy-plan.json 가운데 24시간 안에 만든 것 중, 이 명령의
 *    정규화 sha 가 단계(scenario[].commands)나 장애 선조치(incident.actions[].commands)에 든 것. 없으면 계획 밖 → 차단.
 * 2. 단계 명령 바이트 대조: 계획서에 적힌 명령 문자열과 실행 명령 바이트가 정확히 일치해야 함.
 * 3. 양식 검사: 칸 하나라도 비면 차단(승인 코드 없음).
 * 4. 고정 파일 sha 대조: 명령이 참조·실행하는 파일과 단계의 files 사전에 적힌 sha256 이 디스크 실물과 일치해야 함.
 * 5. 기준별 적대 리뷰 기록(gates/deploy-plan-review.json → 결과 파일) 검사: 기준 전부 PASS, 남은 지적 0,
 *    결과 파일이 이 계획서 sha 를 검수한 review-run 출력이고 영수증(input_manifest_sha256 포함)이 맞아야 함.
 * 6. 장애 선조치 명령이고 독립 판정 기록(gates/deploy-incident/*.json, 판정자 세션 ≠ 실행 세션, 30분 안,
 *    증거 sha 일치, 판정 장애)이 있고 계획이 승인돼 있으면 통과 + 보고 의무 기록.
 * 7. 단계 명령: 전체 계획 승인(PLAN 코드) → 앞 단계 성공 확인 기록 → 단계 승인(STEP 코드, 그 단계 명령에만,
 *    명령마다 한 번) 순서로만 통과.
 *
 * 사람 승인 = 대화창에 사람이 친 코드(deploy-human-approval.humanTyped) 또는 승인자 본인 디스코드 글(디스코드 REST 로
 * 직접 받아 작성자 번호를 인스턴스 설정 approver.discordUserId 와 대조, 봇·웹훅·앱 글 불인정).
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { humanTyped, commandHash, statePath } = require("./deploy-human-approval.js");

const ROOT = path.resolve(__dirname, "../../..");
const PLAN_FILE = "deploy-plan.json";
const REVIEW_FILE = "deploy-plan-review.json";
const DISCORD_FILE = "deploy-approval-discord.json";
const PLAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PLAN_APPROVAL_TTL_MS = 12 * 60 * 60 * 1000;
const STEP_CODE_TTL_MS = 2 * 60 * 60 * 1000;
// 사전승인 단계 코드 유효 기간: 발급 시각부터 12시간(PLAN TTL과 동일). 일반 단계 코드는 2시간 유지.
const PREAPPROVE_STEP_TTL_MS = 12 * 60 * 60 * 1000;
const INCIDENT_VERDICT_TTL_MS = 30 * 60 * 1000;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// 적대 리뷰 기준. 기준마다 결과 파일에 "<id>: PASS" 줄이 있어야 한다.
const CRITERIA = [
	["correctness", "정확성: 명령이 의도대로 그 대상만 바꾸는가"],
	["disconnect", "끊김: 터미널·세션이 끊겨도 작업 상태 확인, 명시 runID로 재접속 확인, 보존된 이전 판으로 사람이 수동 복귀하는 경로가 있는가. 자동 복구 장치는 요구하지 않는다"],
	["rerun", "재실행·중복: 계획서에 적은 재실행 안전(잠금, 실행마다 고유 폴더, 가장 최근 폴더 자동 선택 없음)이 명령·스크립트 실제 동작과 맞고, 중복 실행으로 남는 위험이 숨겨지지 않았는가. 새 잠금·감시 장치는 요구하지 않는다"],
	["rollback", "되돌리기: 사람이 실행하는 이전 판 복귀 한 단계와 걸리는 시간이 적혀 있고, 그 명령이 실제로 보존된 이전 판으로 돌아가면 충족한다. 경로가 없거나 틀리면(이전 판이 남지 않음, 명령이 다른 것을 바꿈 등) FAIL. 자동 되돌리기·추가 백업 사본은 요구하지 않는다"],
	["irreversible", "되돌릴 수 없는 변경·데이터가 빠짐없이 적혔는가"],
	["security", "보안·비밀 노출이 없는가"],
	["impact", "운영 영향(중단 시간·사용자 영향)이 정확한가"],
	["honesty", "양식 정직성: 위험을 축소하거나 숨기지 않았는가"],
	["incident_safety", "장애 시 선조치(incident.actions)가 있으면 그것이 상황을 더 나쁘게 만들 수 없는가. 비어 있으면([]) 위반이 아니다(선조치를 새로 요구하지 않는다)"],
];
// read_only 계획(양식 검사가 모든 명령을 읽기 갈래로 확인함)의 기준 문구. read_only 가 아니면 CRITERIA 그대로.
const READ_ONLY_CRITERIA = Object.freeze({
	disconnect: "끊김: read_only 계획은 끊기면 결과를 버리고 다시 실행한다고 적혀 있으면 충족한다",
	rollback: "되돌리기: 계획서가 read_only 이고 바꾸는 것이 없으면, 복귀 단계 없음과 그 근거가 적혀 있는 것으로 충족한다",
});
function criteriaFor(plan) {
	return plan?.read_only === true ? CRITERIA.map(([id, text]) => [id, READ_ONLY_CRITERIA[id] || text]) : CRITERIA;
}
// 지적 분류. 차단 지적만 FAIL·남은 지적에 센다. 계획에 없는 새 장치를 더하라는 요구는 참고로만 남긴다.
const BLOCKING_KINDS = [
	"불일치: 계획 문구와 명령·스크립트 실제 동작이 다름",
	"되돌리기: 되돌리기 경로가 없거나 틀림",
	"비밀: 비밀·인증 정보 노출",
	"위험숨김: 위험을 숨기거나 축소함(장치가 없어 생기는 위험이 계획서 위험·영향·남은 위험 칸에 적히지 않은 경우 포함)",
	"선조치악화: 적힌 장애 선조치가 상황을 더 나쁘게 만듦",
];
const ADVISORY_EXAMPLES = "자동 복구·자동 되돌리기, 추가 백업 사본, 임시 검증 컨테이너, 라우팅 통제, 새 잠금·감시 장치, 범위 밖 스크립트 개조, 승인 없이 도는 선조치 추가";

function sha256(buf) {
	return crypto.createHash("sha256").update(buf).digest("hex");
}

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

const str = (v, min = 1) => typeof v === "string" && v.trim().length >= min;
const strList = (v, min = 1) => Array.isArray(v) && v.length > 0 && v.every((x) => str(x, min));

// 승인자 위험 수용: security 기준 하나만, 이미 공개된 같은 값, 승인자 결정 글 주소, 끝나는 날이 있을 때만. 다른 기준 FAIL 은 그대로 막는다.
const RISK_ACCEPTANCE_MAX_DAYS = 7;
function riskAcceptanceProblems(plan) {
	const a = plan?.risk_acceptance;
	if (a === undefined) return [];
	if (!a || typeof a !== "object" || Array.isArray(a)) return ["risk_acceptance 는 객체여야 함"];
	const p = [];
	const allowed = ["criterion", "accepted_by", "decision_url", "same_value_as", "no_new_exposure", "expires_at", "reason"];
	for (const k of Object.keys(a)) if (!allowed.includes(k)) p.push(`risk_acceptance 에 모르는 칸 ${k}`);
	if (a.criterion !== "security") p.push('risk_acceptance.criterion 은 "security" 만 쓸 수 있음(다른 기준은 위험 수용 불가)');
	if (!str(a.accepted_by, 2)) p.push("risk_acceptance.accepted_by(위험을 받아들인 승인자) 없음");
	if (!/^https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+$/.test(String(a.decision_url || ""))) p.push("risk_acceptance.decision_url 은 승인자 결정 디스코드 글 주소");
	if (!str(a.same_value_as, 10)) p.push("risk_acceptance.same_value_as(같은 값이 이미 나간 앞 계획서·지문) 없음");
	if (a.no_new_exposure !== true) p.push("risk_acceptance.no_new_exposure 는 true 여야 함(새 노출이면 위험 수용 불가)");
	if (!str(a.reason, 10)) p.push("risk_acceptance.reason 없음");
	const created = Date.parse(plan.createdAt || "");
	const until = Date.parse(a.expires_at || "");
	if (!Number.isFinite(until)) p.push("risk_acceptance.expires_at(ISO 시각) 없음");
	else if (!Number.isFinite(created) || until <= created || until - created > RISK_ACCEPTANCE_MAX_DAYS * 86400000) p.push(`risk_acceptance.expires_at 은 createdAt 뒤 ${RISK_ACCEPTANCE_MAX_DAYS}일 안`);
	return p;
}
function riskAcceptanceActive(plan, now = Date.now()) {
	return plan?.risk_acceptance !== undefined && riskAcceptanceProblems(plan).length === 0 && Date.parse(plan.risk_acceptance.expires_at) > now;
}

// 리뷰 배치: author muse → planReview 설정에 따라 argon 또는 codex 1명. 옛 author(sol|argon)의 2인 기록은 재리뷰까지만 구 기록으로 인정한다.
const REVIEW_MODELS = Object.freeze({
	sol: { model: "gpt-6.1-sol", effort: "high" },
	muse: { model: "muse-spark-1.3", effort: "xhigh" },
	argon: { model: "gemini-4-argon-medium", effort: "medium" },
	codex: { model: "gpt-6.1-terra", effort: "high" },
});
const AUTHOR_IDS = ["sol", "muse", "argon"];
// 리뷰 차례(번갈아): ROTATION 순서대로 작성자 다음 모델이 먼저 리뷰하고, 한도에 걸리면 나머지 하나로 넘어간다. 작성자 자신은 절대 리뷰하지 않는다.
const ROTATION = Object.freeze(["argon", "codex", "muse"]);
// 새 모양 작성자(차례 셋)와 옛 모양 작성자(sol 포함)를 함께 받는다. 옛 sol·argon 2인 기록은 그대로 읽는다.
const AUTHOR_MODELS = Object.freeze(["sol", "muse", "argon", "codex"]);
// 한도 실패 판별식: 종료 코드가 0이 아니고 실행기 진단(stderr·실행 오류)이 이 식과 맞을 때만 다음 후보로 넘어간다. 리뷰 본문(stdout)은 계획서 낱말을 되풀이할 수 있어 보지 않는다.
const LIMIT_RE = /rate.?limit|quota|usage limit|\b429\b|RESOURCE_EXHAUSTED|\bexhausted\b/i;
function reviewerIdsFor(author, root = ROOT, at = Date.now()) {
	if (author !== "muse") return AUTHOR_IDS.filter((id) => id !== author);
	const file = path.join(root, ".claude/deploy/config.json");
	const started = typeof at === "number" ? at : Date.parse(at);
	let config;
	try { config = JSON.parse(fs.readFileSync(file, "utf8"))?.planReview; }
	catch (error) { if (error.code === "ENOENT") return ["argon"]; throw error; }
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
function rotationOrder(author) {
	const i = ROTATION.indexOf(author);
	if (i < 0) return [];
	return [ROTATION[(i + 1) % ROTATION.length], ROTATION[(i + 2) % ROTATION.length]];
}

// 차례 후보 둘(먼저 쓸 리뷰어, 한도 실패 때 넘어갈 리뷰어). 고정 planReview 가 기한 안이고 작성자와 다르면 맨 앞에 두고, 지났거나 until 이 없거나 작성자 자신이면 차례만 쓴다. 설정 JSON 깨짐·형식 틀림(차례 밖 리뷰어, 읽을 수 없는 until)은 던진다.
function orderedReviewers(author, root = ROOT, at = Date.now()) {
	if (!ROTATION.includes(author)) return reviewerIdsFor(author, root, at);
	const base = rotationOrder(author);
	const file = path.join(root, ".claude/deploy/config.json");
	const started = typeof at === "number" ? at : Date.parse(at);
	if (!Number.isFinite(started)) throw new Error("리뷰 시각을 읽지 못함");
	let config;
	try { config = JSON.parse(fs.readFileSync(file, "utf8"))?.planReview; }
	catch (error) { if (error.code === "ENOENT") return base; throw error; }
	if (config === undefined) return base;
	if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("planReview 형식이 틀림(객체여야 함)");
	if (!ROTATION.includes(config.reviewer)) throw new Error("planReview.reviewer 는 argon·codex·muse 중 하나여야 함");
	const until = config.until;
	if (until === undefined) return base;
	const date = typeof until === "string" ? /^(\d{4})-(\d{2})-(\d{2})T/.exec(until) : null;
	const validDate = date && Number(date[2]) >= 1 && Number(date[2]) <= 12 && Number(date[3]) >= 1 && Number(date[3]) <= new Date(Date.UTC(Number(date[1]), Number(date[2]), 0)).getUTCDate();
	if (!validDate || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(until) || !Number.isFinite(Date.parse(until))) throw new Error("planReview.until 형식이 틀림(ISO 시각)");
	if (started >= Date.parse(until) || config.reviewer === author) return base;
	if (config.reviewer === base[0]) return base;
	return [config.reviewer, ...base.filter((id) => id !== config.reviewer)];
}

// 한도 실패인가: 종료 코드가 0이 아니고 실행기 진단(stderr·실행 오류문)이 LIMIT_RE 와 맞을 때만 참이다.
// 신호로 끝난 실행(종료 코드 null)은 한도로 보지 않는다. 관문의 skipped exit_code 검사(0 아닌 정수)와 같은 기준이다.
function isLimitFailure(exitCode, text) {
	return Number.isInteger(exitCode) && exitCode !== 0 && LIMIT_RE.test(String(text || ""));
}

// 차례 도입 시각. 옛 모양(rotation 칸 없음) 기록은 이보다 앞선 것만 받는다. 새 기록에서 rotation 칸 하나를 지워 차례 대조를 건너뛰는 길을 막는다.
const LEGACY_REVIEW_CUTOFF = "2026-11-10T10:00:00Z";

function isoMs(value) {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ? Date.parse(value) : NaN;
}

// 새 모양 기록인가(명시 칸 rotation:true). 작성자만으로 가르면 argon 작성자의 옛 2인 기록과 새 1인 기록이 충돌하므로, 옛 영수증과 부딪히지 않는 명시 칸으로 가른다.
function isRotationRecord(rec) {
	return !!rec && rec.rotation === true;
}

/**
 * read_only 계획 검사: 바꾸는 것이 없음을 기계로 확인한다. 모든 단계·선조치 명령이 읽기 갈래(deploy-readiness readOnlyProblem,
 * ops 판정의 조회 갈래)이고, 되돌리기 단계(branch rollback)와 rollback.step_ids 가 없어야 한다. 판정기를 못 읽으면 막는다.
 */
function readOnlyProblems(plan) {
	let readOnlyProblem;
	try { ({ readOnlyProblem } = require("./deploy-readiness.js")); }
	catch { return ["read_only 판정기(deploy-readiness.js)를 읽지 못함"]; }
	const p = [];
	const check = (owner, commands) => {
		for (const c of Array.isArray(commands) ? commands : []) {
			const bad = readOnlyProblem(c);
			if (bad) p.push(`read_only 계획의 ${owner} 명령이 읽기 갈래가 아님: ${bad}`);
		}
	};
	for (const [i, s] of (Array.isArray(plan.scenario) ? plan.scenario : []).entries()) {
		if (!s || typeof s !== "object") continue;
		if (s.branch === "rollback") p.push(`read_only 계획에 되돌리기 단계가 있음: scenario[${i}](${s.id}). 바꾸는 것이 없으면 되돌리기 단계를 두지 않음`);
		check(`단계 ${s.id}`, s.commands);
	}
	for (const a of Array.isArray(plan.incident?.actions) ? plan.incident.actions : []) if (a) check(`장애 선조치 ${a.id}`, a.commands);
	const stepIds = plan.rollback?.step_ids;
	if (stepIds !== undefined && (!Array.isArray(stepIds) || stepIds.length > 0)) p.push("read_only 계획의 rollback.step_ids 는 비어 있어야 함([])");
	return p;
}

/** 양식 검사. 빈 칸마다 한 줄. */
function formProblems(plan) {
	const p = [];
	if (!plan || typeof plan !== "object") return ["계획서를 JSON 으로 읽지 못함"];
	if (plan.schema !== "deploy-plan/v1") p.push('schema 가 "deploy-plan/v1" 이 아님');
	if (!AUTHOR_MODELS.includes(plan.author_model)) p.push("author_model(sol|muse|argon|codex) 필수");
	p.push(...riskAcceptanceProblems(plan));
	if (plan.approval_mode !== undefined && plan.approval_mode !== "preapprove_steps") p.push('approval_mode 는 "preapprove_steps" 만 쓸 수 있음');
	if (!str(plan.planId, 3)) p.push("planId(계획 이름) 없음");
	const at = Date.parse(plan.createdAt || "");
	if (!Number.isFinite(at)) p.push("createdAt(ISO 시각) 없음");
	if (!strList(plan.services)) p.push("services(운영 서비스 키 목록) 없음");
	if (!str(plan.what_why, 10)) p.push("what_why(무엇을 왜 배포하나) 없음");
	if (!strList(plan.changes, 3)) p.push("changes(바뀌는 것 목록) 없음");
	const steps = Array.isArray(plan.scenario) ? plan.scenario : [];
	if (steps.length === 0) p.push("scenario(단계 목록) 없음");
	const ids = new Set();
	const stepHashes = new Map();
	for (const [i, s] of steps.entries()) {
		const tag = `scenario[${i}]`;
		if (!s || typeof s !== "object") { p.push(`${tag} 모양이 틀림`); continue; }
		if (!/^[A-Za-z0-9_-]{1,40}$/.test(String(s.id || ""))) p.push(`${tag}.id(영문·숫자·-·_) 없음`);
		else if (ids.has(s.id)) p.push(`${tag}.id 중복: ${s.id}`);
		else ids.add(s.id);
		if (!str(s.title, 3)) p.push(`${tag}.title 없음`);
		if (!strList(s.commands)) p.push(`${tag}.commands(실행할 명령 전문 목록) 없음`);
		if (!str(s.success_check, 5)) p.push(`${tag}.success_check(이 단계 성공 확인 방법) 없음`);
		if (!str(s.on_failure, 5)) p.push(`${tag}.on_failure(실패 시 갈림길) 없음`);
		if (s.branch !== undefined && s.branch !== "rollback") p.push(`${tag}.branch 는 "rollback" 만 쓸 수 있음`);
		for (const c of Array.isArray(s.commands) ? s.commands : []) {
			const h = commandHash(c);
			if (stepHashes.has(h) && stepHashes.get(h) !== s.id) p.push(`같은 명령이 두 단계(${stepHashes.get(h)}, ${s.id})에 있음. 단계마다 명령을 구별할 것`);
			stepHashes.set(h, s.id);
		}
	}
	if (steps.length && !steps.some((s) => s && s.branch !== "rollback")) p.push("본 단계(branch 없는 단계)가 하나도 없음");
	const risks = plan.risks || {};
	if (!strList(risks.items, 3)) p.push("risks.items(위험 목록) 없음");
	if (!str(risks.worst_case, 5)) p.push("risks.worst_case(최악의 경우) 없음");
	if (!strList(plan.irreversible, 2)) p.push('irreversible(되돌릴 수 없는 것 목록, 없으면 "없음: 이유") 없음');
	if (!str(plan.disconnect_safety, 10)) p.push("disconnect_safety(끊김 안전: 상태 확인·runID 재접속·이전 판 수동 복귀 경로 등) 없음");
	const rr = plan.rerun_safety || {};
	if (!str(rr.lock, 5)) p.push("rerun_safety.lock(중복 실행 거절 잠금) 없음");
	if (!str(rr.run_dir, 5)) p.push("rerun_safety.run_dir(실행마다 고유 폴더, 앞 기록 안 덮음) 없음");
	if (!str(rr.no_latest_pick, 5)) p.push("rerun_safety.no_latest_pick(가장 최근 폴더 자동 선택 안 함) 없음");
	if (!str(plan.success_verification, 5)) p.push("success_verification(전체 성공 확인 방법) 없음");
	const rb = plan.rollback || {};
	if (!str(rb.method, 5)) p.push("rollback.method(되돌리기 방법) 없음");
	if (!str(rb.duration, 2)) p.push("rollback.duration(되돌리기 소요 시간) 없음");
	for (const id of Array.isArray(rb.step_ids) ? rb.step_ids : []) if (!ids.has(id)) p.push(`rollback.step_ids 의 단계 ${id} 가 scenario 에 없음`);
	if (plan.read_only !== undefined && typeof plan.read_only !== "boolean") p.push("read_only 는 true 또는 false 여야 함");
	if (plan.read_only === true) p.push(...readOnlyProblems(plan));
	if (!strList(plan.residual_risks, 3)) p.push("residual_risks(남은 위험, 승인자가 책임지는 것) 없음");
	const inc = plan.incident || {};
	if (!strList(inc.criteria, 3)) p.push("incident.criteria(장애 판단 기준) 없음");
	if (!Array.isArray(inc.actions)) p.push("incident.actions(장애 시 선조치 명령, 없으면 []) 없음");
	for (const [i, a] of (Array.isArray(inc.actions) ? inc.actions : []).entries()) {
		for (const c of a && Array.isArray(a.commands) ? a.commands : []) if (stepHashes.has(commandHash(c))) p.push(`incident.actions[${i}] 명령이 단계 ${stepHashes.get(commandHash(c))} 명령과 같음. 선조치 명령은 단계 명령과 구별할 것`);
		if (!a || !/^[A-Za-z0-9_-]{1,40}$/.test(String(a.id || ""))) p.push(`incident.actions[${i}].id(영문·숫자·-·_) 없음`);
		if (!a || !strList(a.commands)) p.push(`incident.actions[${i}].commands 없음`);
		if (!a || !str(a.why_safe, 5)) p.push(`incident.actions[${i}].why_safe(상황을 더 나쁘게 만들 수 없는 이유) 없음`);
	}
	return p;
}

function planSha(file) {
	return sha256(fs.readFileSync(file));
}

/** 명령의 sha 가 든 계획서들. 24시간 안의 것만. */
function plansForCommand(command, root, now = Date.now()) {
	const h = commandHash(command);
	const base = path.join(root, ".agents", "progress");
	let dirs = [];
	try {
		dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("_"));
	} catch {
		return [];
	}
	const out = [];
	for (const d of dirs) {
		const file = path.join(base, d.name, "gates", PLAN_FILE);
		if (!fs.existsSync(file)) continue;
		const plan = readJson(file);
		if (!plan) continue;
		const at = Date.parse(plan.createdAt || "");
		if (!Number.isFinite(at) || now - at > PLAN_MAX_AGE_MS || at - now > 5 * 60 * 1000) continue;
		const steps = Array.isArray(plan.scenario) ? plan.scenario : [];
		const step = steps.find((s) => s && Array.isArray(s.commands) && s.commands.some((c) => typeof c === "string" && commandHash(c) === h));
		const actions = plan.incident && Array.isArray(plan.incident.actions) ? plan.incident.actions : [];
		const action = actions.find((a) => a && Array.isArray(a.commands) && a.commands.some((c) => typeof c === "string" && commandHash(c) === h));
		if (step || action) out.push({ file, gatesDir: path.dirname(file), plan, step: step || null, action: action || null, sha: planSha(file) });
	}
	return out;
}

/** review-run 결과 파일 끝줄: review-run: target_sha256=… prompt_sha256=… stdout_sha256=… */
function reviewTrailer(text) {
	const lines = text.split("\n");
	while (lines.length && lines[lines.length - 1] === "") lines.pop();
	const last = lines[lines.length - 1] || "";
	const m = last.match(/^review-run: target_sha256=(\S+) prompt_sha256=([a-f0-9]{64}) stdout_sha256=([a-f0-9]{64})$/);
	if (!m) return null;
	const body = text.slice(0, text.lastIndexOf(last));
	return { targets: m[1].split(","), prompt: m[2], stdout: m[3], bodySha: sha256(Buffer.from(body, "utf8")), body };
}

/** 계획서 소속 저장소 root 기준. 모든 단계와 선조치의 고정 파일을 검사한다. */
function pinnedFileProblems(plan, root) {
	const base = root ? path.resolve(root) : ROOT;
	const problems = [];
	for (const entry of [...(Array.isArray(plan?.scenario) ? plan.scenario : []), ...(Array.isArray(plan?.incident?.actions) ? plan.incident.actions : [])]) {
		if (!entry || entry.files === undefined) continue;
		if (!entry.files || typeof entry.files !== "object" || Array.isArray(entry.files)) { problems.push(`${entry.id}: files 는 경로와 sha256 사전이어야 함`); continue; }
		for (const [file, want] of Object.entries(entry.files)) {
			try {
				const abs = path.isAbsolute(file) ? file : path.join(base, file);
				if (!/^[a-f0-9]{64}$/i.test(String(want)) || !fs.statSync(abs).isFile() || sha256(fs.readFileSync(abs)) !== String(want).toLowerCase()) problems.push(`${entry.id}: 고정 파일 sha256 불일치: ${file}`);
			} catch { problems.push(`${entry.id}: 고정 파일을 읽지 못함: ${file}`); }
		}
	}
	return problems;
}

/** gatesDir 안 일반 파일만 허용한다. 새 출력은 부모 realpath 부터 검사한다. */
function resultFile(gatesDir, result, allowMissing = false) {
	if (typeof result !== "string" || !result || path.isAbsolute(result)) throw new Error("결과는 gatesDir 기준 상대 경로여야 함");
	const gates = fs.realpathSync(gatesDir), file = path.resolve(gatesDir, result);
	const inside = (base, target) => { const rel = path.relative(base, target); return rel && !rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel); };
	if (!inside(path.resolve(gatesDir), file)) throw new Error("결과 경로가 gatesDir 밖임");
	let parent;
	try { parent = fs.realpathSync(path.dirname(file)); }
	catch (e) { if (e.code === "ENOENT") throw new Error("결과 하위 폴더를 먼저 만드십시오"); throw e; }
	const real = path.join(parent, path.basename(file));
	if (!inside(gates, real)) throw new Error("결과 realpath 가 gatesDir 밖임");
	try {
		if (!fs.lstatSync(file).isFile() || !inside(gates, fs.realpathSync(file))) throw new Error("결과는 gatesDir 안 일반 파일이어야 함");
	} catch (e) { if (!allowMissing || e.code !== "ENOENT") throw e; }
	return real;
}

// ── 리뷰 회차 ───────────────────────────────────────────────────
// 리뷰마다 gates/review-rounds/round-<NNN>.json 을 쌓는다(덮어쓰지 않음). deploy-plan-review.json 은 최신 판으로 계속 쓴다.
// 다음 리뷰 요청문에 직전 회차의 기준별 판정과 차단 지적을 붙이고, 같은 계획서가 연속 3회 FAIL 이면 4회차 리뷰를 돌리지 않는다.
const ROUNDS_DIR = "review-rounds";
const ROUND_FAIL_LIMIT = 3;
const BLOCKING_LINE = (line) => /^\s*(?:\d+[.)]|[-*])\s*\**\s*\[\s*차단/.test(line) || /^\s*\|.*\[\s*차단\s*:/.test(line);

function blockingLinesOf(body) {
	return String(body || "").split(/\r?\n/).filter(BLOCKING_LINE);
}
function firstVerdictLine(body) {
	return String(body || "").trim().split(/\r?\n/).find((line) => !/^(?:codex|tokens used|\d[\d,]*)\s*$/i.test(line.trim())) || "";
}

/** 회차 파일 목록(회차 오름차순). */
function roundFiles(gatesDir) {
	let names = [];
	try { names = fs.readdirSync(path.join(gatesDir, ROUNDS_DIR)); } catch { return []; }
	return names.map((name) => ({ name, m: /^round-(\d{3,})\.json$/.exec(name) })).filter((x) => x.m)
		.map((x) => ({ round: Number(x.m[1]), rel: `${ROUNDS_DIR}/${x.name}` })).sort((a, b) => a.round - b.round);
}
function readRound(gatesDir, rel) {
	try {
		const file = resultFile(gatesDir, rel);
		const buf = fs.readFileSync(file);
		const data = JSON.parse(buf.toString("utf8"));
		if (!data || typeof data !== "object" || !data.outcome || !Array.isArray(data.outcome.criteria) || !Array.isArray(data.outcome.blocking)) return null;
		return { rel, sha256: sha256(buf), data };
	} catch { return null; }
}

/**
 * reviewProblems 결과로 한 회차의 판정을 만든다. PASS 는 관문을 통과한(review.ok) 리뷰만이다.
 * 관문이 막았는데 본문에 FAIL 신호가 있으면 FAIL, 그 밖(본문 없음·무효 영수증의 본문 PASS)은 판정 "없음"과 실패 이유(reasons).
 * "없음"은 직전 회차로 쓰지 않고 FAIL 연속을 끊지도 않는다.
 */
function roundOutcome(review) {
	const rows = (review?.reviewers || []).filter((r) => r && r.body);
	const reasons = () => (review?.problems || []).map((p) => String(p).slice(0, 400)).slice(0, 20);
	if (!rows.length) return { verdict: "없음", criteria: [], blocking: [], reasons: review?.ok ? ["리뷰 본문 없음"] : reasons() };
	const criteria = CRITERIA.map(([id]) => {
		const v = rows.map((r) => (r.summary || []).find((s) => s.id === id)?.verdict || "없음");
		return { id, verdict: v.includes("FAIL") ? "FAIL" : v.every((x) => x === "PASS") ? "PASS" : "없음" };
	});
	const blocking = rows.flatMap((r) => blockingLinesOf(r.body)).map((l) => l.trim().slice(0, 400)).slice(0, 50);
	const firsts = rows.map((r) => firstVerdictLine(r.body));
	if (review.ok) return { verdict: "PASS", criteria, blocking };
	if (firsts.some((l) => /^판정:\s*FAIL\b/i.test(l)) || criteria.some((c) => c.verdict === "FAIL") || blocking.length) return { verdict: "FAIL", criteria, blocking };
	return { verdict: "없음", criteria, blocking, reasons: reasons() };
}

/** 회차 하나를 새 파일로 남긴다(wx: 있던 파일은 덮지 않음). 돌려줌: { round, rel, sha256 } */
function writeRound(gatesDir, { plan_sha256, plan, record, outcome, legacy = false }) {
	const dir = path.join(gatesDir, ROUNDS_DIR);
	fs.mkdirSync(dir, { recursive: true });
	const round = (roundFiles(gatesDir).pop()?.round || 0) + 1;
	const rel = `${ROUNDS_DIR}/round-${String(round).padStart(3, "0")}.json`;
	const text = `${JSON.stringify({ schema: "deploy-plan-review-round/v1", round, recordedAt: new Date().toISOString(), ...(legacy ? { legacy: true } : {}), plan_sha256, plan: plan ?? null, outcome, record }, null, 2)}\n`;
	fs.writeFileSync(path.join(gatesDir, rel), text, { flag: "wx" });
	return { round, rel, sha256: sha256(Buffer.from(text, "utf8")) };
}

// 회차 확정 표지: review 명령은 회차 파일 → 최신 영수증 → round-NNN.ok(wx, 방금 쓴 영수증 바이트의 sha256 한 줄) 순서로 쓴다.
// 표지가 없거나 표지 sha 가 회차 안 record 의 영수증 바이트 sha 와 다르면 그 회차 판정은 "없음"으로 본다(연속을 끊지도 더하지도 않음).
const recordBytes = (record) => Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
const markRel = (rel) => rel.replace(/\.json$/, ".ok");
function readRoundMark(gatesDir, rel) {
	try { return fs.readFileSync(resultFile(gatesDir, markRel(rel)), "utf8").trim(); } catch { return null; }
}
/** 회차 확정 표지: 임시 파일에 다 쓴 뒤 link 로 표지 이름을 만든다(이미 있으면 실패). link 가 확정 시점이라,
 * 그 전 어느 오류든 표지가 없고(관문 닫힘), 그 뒤 임시 파일 지우기 오류는 확정에 영향이 없어 무시한다.
 * 디스크 상태가 정본이다: link 가 오류를 내도 표지가 이 임시 파일과 같은 파일(inode)로 생겼으면 확정된 것으로 보고 성공한다. */
function markRound(gatesDir, rel, receiptSha) {
	const mark = path.join(gatesDir, markRel(rel));
	const tmp = `${mark}.tmp-${process.pid}`;
	try {
		fs.writeFileSync(tmp, `${receiptSha}\n`, { flag: "wx" });
		try { fs.linkSync(tmp, mark); }
		catch (error) {
			let committed = false;
			try { const a = fs.statSync(tmp), b = fs.statSync(mark); committed = a.ino === b.ino && a.dev === b.dev; } catch {}
			if (!committed) throw error;
		}
	} finally {
		try { fs.unlinkSync(tmp); } catch {}
	}
}
/** 최신 영수증을 쓴다. 돌려줌: 쓴 바이트의 sha256. */
function writeReviewRecord(gatesDir, record) {
	const buf = recordBytes(record);
	fs.writeFileSync(path.join(gatesDir, REVIEW_FILE), buf);
	return sha256(buf);
}
/** 확정된 회차만 판정을 갖는다. 확정 안 된 회차는 판정 "없음"으로 바꿔 돌려준다(unconfirmed: true). */
function confirmedRound(gatesDir, rel) {
	const r = readRound(gatesDir, rel);
	if (!r) return null;
	const mark = readRoundMark(gatesDir, rel);
	if (mark !== null && r.data.record !== undefined && mark === sha256(recordBytes(r.data.record))) return r;
	return { ...r, data: { ...r.data, outcome: { ...r.data.outcome, verdict: "없음" } }, unconfirmed: true };
}
/** 관문: 회차 폴더가 있으면 가장 최근 회차의 확정 표지가 지금 디스크 영수증 바이트 sha 와 같아야 한다. 폴더가 없으면(옛 기록) null. */
function roundConfirmProblem(gatesDir) {
	if (!fs.existsSync(path.join(gatesDir, ROUNDS_DIR))) return null;
	const last = roundFiles(gatesDir).pop();
	let disk = null;
	try { disk = sha256(fs.readFileSync(path.join(gatesDir, REVIEW_FILE))); } catch { disk = null; }
	const mark = last ? readRoundMark(gatesDir, last.rel) : null;
	if (last && mark !== null && disk !== null && mark === disk) return null;
	return `리뷰 회차 확정 안 됨: 가장 최근 회차(${last ? `gates/${last.rel}` : "없음"})의 확정 표지가 없거나 지금 ${REVIEW_FILE} 와 다름. 다시 리뷰할 것`;
}

/** 직전 회차(판정 PASS 또는 FAIL 인 가장 최근 확정 회차). 없으면 null. 회차 파일의 PASS 는 roundOutcome 이 관문 통과 때만 적는다. */
function priorRound(gatesDir) {
	for (const f of roundFiles(gatesDir).reverse()) {
		const r = confirmedRound(gatesDir, f.rel);
		if (r && ["PASS", "FAIL"].includes(r.data.outcome.verdict)) return r;
	}
	return null;
}
/** 최근부터 센 연속 FAIL 회차. 판정 "없음"(실행 실패·확정 안 됨)은 건너뛰고, PASS 에서 멈춘다. */
function failStreak(gatesDir) {
	const rounds = [];
	for (const f of roundFiles(gatesDir).reverse()) {
		const r = confirmedRound(gatesDir, f.rel);
		if (!r) continue;
		if (r.data.outcome.verdict === "PASS") break;
		if (r.data.outcome.verdict === "FAIL") rounds.push(r);
	}
	return { count: rounds.length, rounds };
}
/** 기록의 prior_round({round, file, sha256})가 가리키는 확정 회차를 다시 읽는다. sha 가 다르거나 확정 안 됐으면 null. */
function loadPriorRound(gatesDir, ref) {
	if (!ref || typeof ref !== "object" || typeof ref.file !== "string") return null;
	const r = confirmedRound(gatesDir, ref.file);
	return r && !r.unconfirmed && r.sha256 === ref.sha256 && r.data.round === ref.round ? r : null;
}

/** 직전 회차 계획서와 지금 계획서에서 달라진 최상위 칸(scenario 는 단계 id 별). 직전 사본이 없으면 null. */
function changedFields(before, after) {
	if (!before || typeof before !== "object" || !after || typeof after !== "object") return null;
	const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
	const out = [];
	for (const k of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
		if (same(before[k], after[k])) continue;
		if (k === "scenario" && Array.isArray(before.scenario) && Array.isArray(after.scenario)) {
			const find = (list, id) => list.find((s) => s && s.id === id);
			const ids = [...new Set([...before.scenario, ...after.scenario].map((s) => s && s.id))];
			const steps = ids.filter((id) => !same(find(before.scenario, id), find(after.scenario, id))).map((id) => `scenario[${id}]`);
			out.push(...(steps.length ? steps : ["scenario(순서)"]));
		} else out.push(k);
	}
	return out;
}

function priorRoundLines(prior, plan) {
	if (!prior) return [];
	const d = prior.data;
	const changed = changedFields(d.plan, plan);
	return [
		`직전 회차 리뷰(회차 ${d.round}, 계획서 sha256 ${d.plan_sha256}, 판정 ${d.outcome.verdict}, 기록 gates/${prior.rel}):`,
		"기준별 판정:",
		...d.outcome.criteria.map((c) => `- ${c.id}: ${c.verdict}`),
		"차단 지적:",
		...(d.outcome.blocking.length ? d.outcome.blocking.map((l) => `- ${l}`) : ["- 없음"]),
		`직전 회차 뒤 바뀐 칸: ${changed === null ? "알 수 없음(직전 계획서 사본 없음)" : changed.length ? changed.join(", ") : "없음(계획서가 같음)"}`,
		"규칙: 바뀌지 않은 부분에서 이전에 PASS 한 기준을 FAIL 로 바꾸려면 이전 판정이 틀린 이유를 적을 것. 새 차단은 이번에 바뀐 부분에서 찾을 것.",
		"",
	];
}

/** 연속 FAIL 상한에 걸렸을 때 리뷰 대신 내는 사람 판정 요청문. */
function humanDecisionRequest(planRel, streak) {
	const last = streak.rounds[0];
	return [
		`사람 판정 요청: 같은 계획서(${planRel})의 적대 리뷰가 연속 ${streak.count}회 FAIL 이라 ${ROUND_FAIL_LIMIT + 1}회차 리뷰를 돌리지 않습니다.`,
		`FAIL 회차: ${streak.rounds.map((r) => r.data.round).reverse().join(", ")} (gates/${ROUNDS_DIR}/)`,
		`남은 차단 지적(회차 ${last.data.round}):`,
		...(last.data.outcome.blocking.length ? last.data.outcome.blocking.map((l) => `- ${l}`) : ["- (차단 지적 줄 없음) 기준별 FAIL: " + last.data.outcome.criteria.filter((c) => c.verdict !== "PASS").map((c) => c.id).join(", ")]),
		"",
		"승인자가 지적마다 수용·수정을 판정합니다. 위험 수용은 이미 있는 risk_acceptance 칸(security 기준 하나만, docs/guides/approval-plan-gate.md)으로만 받습니다.",
	].join("\n");
}

function reviewPrompt(plan, sha, root, prior = null) {
	const criteria = criteriaFor(plan);
	const rollbackRule = plan?.read_only === true
		? ["- 이 계획서는 read_only 입니다(양식 검사가 모든 명령을 읽기 갈래로 기계 확인함). 복귀 단계 없음과 그 근거가 적혀 있으면 rollback 기준을 충족하고, 끊기면 결과를 버리고 다시 실행한다고 적혀 있으면 disconnect 기준을 충족합니다."]
		: ["- 되돌리기는 \"사람이 실행하는 이전 판 복귀 한 단계와 걸리는 시간\"이 적혀 있고 그 명령이 실제로 보존된 이전 판으로 돌아가면 rollback 기준을 충족합니다."];
	return [
		"당신은 운영 배포 계획서(승인 보고 양식)의 적대적 검수자입니다. 이 계획을 승인하면 승인자가 결과에 책임을 집니다.",
		"계획서를 깨뜨릴 방법을 찾으십시오. 아래 기준마다 PASS 또는 FAIL 을 판정하고, FAIL 이면 구체적 지적(어느 칸, 무엇이 왜 틀림, 고칠 방향)을 적으십시오.",
		"추측으로 PASS 하지 마십시오. 계획서에 적힌 것만 근거로 삼고, 적히지 않은 안전장치는 없는 것으로 봅니다. 다만 없는 장치를 새로 더하라는 요구는 차단 지적이 아니라 참고 지적입니다.",
		"",
		"지적 분류(판정은 이 분류를 따릅니다):",
		"- 차단 지적으로 셀 수 있는 것은 다음 다섯 가지뿐입니다:",
		...BLOCKING_KINDS.map((k) => `  - ${k}`),
		`- 차단 지적이 아닌 것(참고로만 남김): 계획에 없는 새 장치를 더하라는 요구. 예: ${ADVISORY_EXAMPLES}.`,
		...rollbackRule,
		"- incident.actions 가 비어 있는 것([])은 incident_safety 위반이 아닙니다.",
		"- 새 장치가 없어서 생기는 위험이 계획서(risks·impact·residual_risks 등)에 적히지 않았거나 축소돼 있으면 그것은 \"위험숨김\" 차단 지적입니다. 적혀 있으면 장치 추가 요구는 참고입니다.",
		"- 기준 판정은 차단 지적만으로 정합니다. 참고 지적만 있는 기준은 PASS 입니다.",
		"",
		"기준:",
		...criteria.map(([id, text]) => `- ${id}: ${text}`),
		"",
		...priorRoundLines(prior, plan),
		"출력 형식(정확히):",
		"첫 줄: 판정: PASS 또는 판정: FAIL (기준 하나라도 FAIL 이면 FAIL)",
		...CRITERIA.map(([id]) => `${id}: PASS|FAIL — 한 줄 근거`),
		"지적 목록: 한 줄에 하나, \"<번호>. [차단:<분류>] <기준 id> — 내용\" 또는 \"<번호>. [참고] <기준 id> — 내용\". 분류는 불일치·되돌리기·비밀·위험숨김·선조치악화 중 하나",
		"참고 지적: <참고 지적 수>",
		"마지막 줄: 남은 지적: <차단 지적 수>",
		"",
		`계획서 sha256: ${sha}`,
		"계획서 원문:",
		"```json",
		JSON.stringify(plan, null, 2),
		"```",
		"",
		"명령별 정규화 sha256(훅이 이 값으로 계획 안/밖을 가립니다):",
		...(plan.scenario || []).flatMap((s) => (s.commands || []).map((c) => `- ${s.id}: ${commandHash(c)}`)),
		...((plan.incident && plan.incident.actions) || []).flatMap((a) => (a.commands || []).map((c) => `- 장애 ${a.id}: ${commandHash(c)}`)),
		"",
		...pinnedFilesText(plan, root),
	].join("\n");
}

/** 가장 가까운 저장소 루트(.git 보유). 시작 경로는 심볼릭 링크를 먼저 푼다. 없으면 모듈 ROOT. */
function resolveRepoRoot(startDir) {
	let dir = path.resolve(startDir);
	for (;;) {
		try { dir = fs.realpathSync(dir); break; }
		catch { const parent = path.dirname(dir); if (parent === dir) return ROOT; dir = parent; }
	}
	try { if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir); } catch { return ROOT; }
	for (;;) {
		try { if (fs.existsSync(path.join(dir, ".git"))) return fs.realpathSync(dir); } catch {}
		const parent = path.dirname(dir);
		if (parent === dir) return ROOT;
		dir = parent;
	}
}
/** 리뷰 입력 고정 목록(계획서·핀·실행기)의 내용 해시. 전후 대조와 영수증 결박에 쓴다. */
const REVIEW_EXECUTOR_FILES = [
	".agents/scripts/approval-plan.mjs",
	".claude/hooks/lib/deploy-plan.js",
	".claude/hooks/lib/deploy-human-approval.js",
];
/**
 * 계획서 소속 저장소 root 기준으로 항목을 읽는다. root 미지정 시 planFile에서 역산.
 * 핀 실물이 계획서 want와 다르면 problems에 적는다(호출자는 digest 대신 무효 처리).
 */
function reviewInputEntries(planFile, root) {
	const base = root ? path.resolve(root) : resolveRepoRoot(path.dirname(path.resolve(planFile)));
	const plan = readJson(planFile);
	if (!plan) throw new Error("계획서를 읽지 못함");
	const planAbs = path.resolve(planFile);
	const planBytes = fs.readFileSync(planAbs);
	const planSha256 = sha256(planBytes);
	const entries = [{ file: "\0plan", sha256: planSha256 }];
	const problems = [];
	const seen = new Set(["\0plan"]);
	const pins = [];
	for (const entry of [...(Array.isArray(plan.scenario) ? plan.scenario : []), ...(Array.isArray(plan.incident?.actions) ? plan.incident.actions : [])]) {
		if (!entry || !entry.files || typeof entry.files !== "object" || Array.isArray(entry.files)) continue;
		for (const [f, want] of Object.entries(entry.files)) pins.push([entry.id, f, want]);
	}
	for (const [id, f, want] of [...new Map(pins.map((p) => [path.normalize(p[1]), p])).values()].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))) {
		if (seen.has(f)) continue;
		seen.add(f);
		const abs = path.isAbsolute(f) ? f : path.join(base, f);
		let actual = null;
		try { actual = sha256(fs.readFileSync(abs)); } catch { problems.push(`${id}: 고정 파일을 읽지 못함: ${f}`); continue; }
		if (!/^[a-f0-9]{64}$/i.test(String(want)) || actual !== String(want).toLowerCase()) { problems.push(`${id}: 고정 파일 sha256 불일치: ${f}`); continue; }
		entries.push({ file: f, sha256: actual });
	}
	for (const rel of REVIEW_EXECUTOR_FILES) {
		try { entries.push({ file: rel, sha256: sha256(fs.readFileSync(path.join(base, rel))) }); }
		catch { problems.push(`실행기를 읽지 못함: ${rel}`); }
	}
	entries.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
	return { base, planSha256, entries, problems, digest: problems.length ? null : sha256(JSON.stringify(entries)) };
}
function reviewInputManifest(planFile, root) {
	const r = reviewInputEntries(planFile, root);
	if (r.problems.length) throw new Error(r.problems[0]);
	return r.digest;
}

/** 단계·선조치의 files 에 고정한 파일(감싼 스크립트 등)의 글. 검수자가 명령 바깥 글만 보고 PASS 하지 않게 한다. */
function pinnedFilesText(plan, root) {
	const base = root ? path.resolve(root) : ROOT;
	const entries = [...(plan.scenario || []), ...((plan.incident && plan.incident.actions) || [])].filter((x) => x && x.files && typeof x.files === "object");
	if (!entries.length) return [];
	const L = ["고정 파일(명령이 읽거나 실행하는 파일, 훅이 sha 로 대조):"];
	const shown = new Set();
	for (const x of entries) {
		for (const [p, want] of Object.entries(x.files)) {
			const key = `${p}\0${String(want).toLowerCase()}`;
			if (shown.has(key)) {
				L.push(`- ${x.id} ${p} (sha ${want}): 위에 같은 sha 로 이미 실음`);
				continue;
			}
			shown.add(key);
			const abs = path.resolve(base, p);
			let body = null;
			try {
				body = fs.readFileSync(abs);
			} catch {}
			if (!body) L.push(`- ${x.id} ${p}: 파일 없음(이 상태로는 PASS 하지 마십시오)`);
			else if (sha256(body) !== String(want).toLowerCase()) L.push(`- ${x.id} ${p}: sha 다름(계획서 ${want}, 실제 ${sha256(body)}). PASS 하지 마십시오`);
			else L.push(`- ${x.id} ${p} (sha ${want}):`, "```", body.length > 200 * 1024 ? `${body.subarray(0, 200 * 1024).toString("utf8")}\n…(200KB 넘어 잘림: 잘린 파일은 FAIL)` : body.toString("utf8"), "```");
		}
	}
	return L;
}

function reviewBodyProblems(text, sha, acceptSecurity = false) {
	const problems = [];
	const tr = reviewTrailer(text);
	if (!tr) problems.push("적대 리뷰 결과 끝줄이 review-run: 줄이 아님");
	else {
		if (tr.targets.length !== 1 || tr.targets[0] !== sha) problems.push("적대 리뷰 결과의 target_sha256 에 이 계획서 sha 가 없음");
		if (tr.bodySha !== tr.stdout) problems.push("적대 리뷰 결과 본문이 review-run 기록(stdout_sha256)과 다름");
	}
	const body = tr ? tr.body : text;
	const summary = [];
	for (const [id] of CRITERIA) {
		const re = new RegExp(`^[\\s>*#|\\-]*(?:기준\\s*)?\`?${id}\`?\\b[^\\n]*?[:：|=]\\s*\\**\\s*(PASS|FAIL)\\b(.*)$`, "gim");
		const hits = [...body.matchAll(re)];
		if (hits.length === 0) { problems.push(`적대 리뷰 결과에 기준 ${id} 판정 줄이 없음("${id}: PASS" 또는 "${id}: FAIL")`); summary.push({ id, verdict: "없음" }); continue; }
		const verdicts = hits.map((h) => h[1].toUpperCase());
		const verdict = verdicts.includes("FAIL") ? "FAIL" : "PASS";
		if (verdict !== "PASS" && !(acceptSecurity && id === "security")) problems.push(`적대 리뷰 기준 ${id} 미통과`);
		summary.push({ id, verdict, note: (hits[0][2] || "").replace(/^[\s*|—-]+/, "").trim().slice(0, 160) });
	}
	// 마지막 줄을 본다. 앞 회차 요약의 "남은 지적: 0" 뒤에 새 지적이 붙어도 통과하지 않게.
	const open = [...body.matchAll(/(?:남은\s*지적|open[_ ]findings)\s*[:：=]\s*(\d+)/gi)].pop();
	if (!open) problems.push("적대 리뷰 결과에 \"남은 지적: <수>\" 줄이 없음");
	// 남은 지적은 차단 지적 수다. 참고 지적은 세지 않는다. 다만 목록에 [차단] 줄이 하나라도 있으면 남은 지적 숫자와 관계없이 미통과.
	const blockingLines = blockingLinesOf(body);
	// 위험 수용 중에는 security 를 적은 차단 지적 하나만 뺀다(승인자는 값 하나를 받아들였다). 두 번째 security 지적은 새 노출로 보고 막는다.
	// 남은 지적 수도 1 이어야 한다.
	const securityFailed = summary.some((s) => s.id === "security" && s.verdict === "FAIL");
	const accepted = acceptSecurity && securityFailed ? blockingLines.filter((line) => /\bsecurity\b/i.test(line)).slice(0, 1) : [];
	if (blockingLines.length > accepted.length) problems.push(`적대 리뷰 목록에 차단 지적 ${blockingLines.length - accepted.length}건${accepted.length ? "(security 위험 수용분 제외)" : ""}`);
	if (open && Number(open[1]) !== accepted.length) problems.push(`적대 리뷰 남은 지적 ${open[1]}건${accepted.length ? `(security 위험 수용 ${accepted.length}건만 남아야 함)` : ""}`);
	const advisoryLines = body.split(/\r?\n/).filter((line) => /^\s*(?:\d+[.)]|[-*])\s*\**\s*\[\s*참고/.test(line));
	const advisory = [...body.matchAll(/참고\s*지적\s*[:：=]\s*(\d+)/g)].pop();
	const first = firstVerdictLine(body);
	if (!/^판정:\s*PASS\s*$/i.test(first) && !(accepted.length && /^판정:\s*FAIL\s*$/i.test(first))) problems.push("적대 리뷰 전체 판정이 PASS 가 아님");
	return { ok: problems.length === 0, riskAccepted: accepted.length > 0, problems, summary, openFindings: open ? Number(open[1]) : null, advisoryFindings: advisory ? Number(advisory[1]) : advisoryLines.length, body, prompt_sha256: tr?.prompt };
}

/** 리뷰 결과의 무결성·대상·작성자 분리·아홉 기준을 모두 확인한다. 새 모양(rotation:true)은 차례 리뷰어 1명, 옛 모양은 예전 구성(muse→argon 또는 codex 1명, sol·argon→2명)과 다르면 거절한다. */
// opts.record: 디스크의 최신 영수증 대신 볼 기록. review 명령이 회차 파일을 먼저 확정하고 영수증을 나중에 쓰려고 쓴다.
function reviewProblems(gatesDir, sha, root, opts = {}) {
	const base = root ? path.resolve(root) : resolveRepoRoot(gatesDir);
	const rec = opts.record !== undefined ? opts.record : readJson(path.join(gatesDir, REVIEW_FILE));
	const plan = readJson(path.join(gatesDir, PLAN_FILE));
	const problems = [];
	const reviewers = [];
	const finish = () => {
		if (!isRotationRecord(rec)) {
			const author = rec?.author_model || plan?.author_model;
			if (AUTHOR_IDS.includes(author)) {
				for (const id of (author === "muse" ? [] : reviewerIdsFor(author))) {
					if (!reviewers.some((r) => r.id === id)) reviewers.push({ id, ...REVIEW_MODELS[id], ok: false, summary: [], openFindings: null, body: "", problems: ["리뷰어 결과 없음"] });
				}
			}
		}
		return { ok: problems.length === 0, problems, reviewers, summary: reviewers.flatMap((r) => r.summary.map((s) => ({ ...s, reviewer: r.id }))) };
	};
	if (!plan || !AUTHOR_MODELS.includes(plan.author_model)) problems.push("계획서 author_model(sol|muse|argon|codex) 필수");
	if (plan) problems.push(...riskAcceptanceProblems(plan));
	if (plan?.risk_acceptance !== undefined && riskAcceptanceProblems(plan).length === 0 && !riskAcceptanceActive(plan)) problems.push("risk_acceptance 끝남(expires_at 지남)");
	const acceptSecurity = riskAcceptanceActive(plan);
	problems.push(...pinnedFileProblems(plan, base));
	// 기록이 직전 회차를 요청문에 붙였으면(prior_round) 그 회차 파일을 sha 로 다시 읽어 같은 요청문을 만든다.
	const hasPrior = rec?.prior_round !== undefined && rec?.prior_round !== null;
	const prior = hasPrior ? loadPriorRound(gatesDir, rec.prior_round) : null;
	if (hasPrior && !prior) problems.push("기록 prior_round(직전 회차 영수증)를 읽지 못했거나 sha256 이 다름");
	let promptSha = null;
	try { if (plan) promptSha = sha256(reviewPrompt(plan, sha, base, prior)); } catch { problems.push("현재 요청문을 다시 만들지 못함"); }
	if (!rec) { problems.push("적대 리뷰 기록 없음: " + REVIEW_FILE); return finish(); }
	// 디스크를 읽는 관문은 회차 확정 표지까지 본다(review 명령이 메모리 기록을 넘기는 경우는 확정 전이라 빼고).
	if (opts.record === undefined) { const bad = roundConfirmProblem(gatesDir); if (bad) problems.push(bad); }
	if (rec.plan_sha256 !== sha) problems.push("적대 리뷰가 지금 계획서가 아닌 판을 검수함. 계획서를 고쳤으면 다시 검수받을 것");
	try {
		if (!plan || planSha(path.join(gatesDir, PLAN_FILE)) !== sha) problems.push("현재 계획서 sha256 이 검증 대상과 다름");
	} catch { problems.push("현재 계획서를 읽지 못함"); }
	if (!AUTHOR_MODELS.includes(rec.author_model)) problems.push("적대 리뷰 작성자 author_model 없음 또는 잘못됨");
	if (!plan || plan.author_model !== rec.author_model) problems.push("계획서 author_model 과 적대 리뷰 작성자가 다름");
	if (!isRotationRecord(rec)) {
		const cutoff = Date.parse(LEGACY_REVIEW_CUTOFF);
		const times = [rec.reviewedAt, ...(Array.isArray(rec.reviewers) ? rec.reviewers.map((r) => r?.receipt?.started_at) : [])].map(isoMs);
		if (!times.every((t) => Number.isFinite(t) && t < cutoff)) problems.push(`옛 모양 리뷰 기록(rotation 칸 없음)은 ${LEGACY_REVIEW_CUTOFF} 앞선 것만 받음(reviewedAt·영수증 시작 시각). 차례 리뷰로 다시 받을 것`);
	}
	if (isRotationRecord(rec)) {
		if (!ROTATION.includes(rec.author_model)) problems.push("차례 기록(rotation:true)의 작성자는 argon·codex·muse 중 하나여야 함");
		if (!Array.isArray(rec.reviewers) || rec.reviewers.length !== 1) problems.push("차례 기록(rotation:true)은 리뷰어 1명의 기록이 필요함");
		// 차례 대조: 리뷰 시각의 차례(고정 설정 포함)에서 skipped 는 앞에서부터 건너뛴 후보 그대로, 실제 리뷰어는 그 다음 후보여야 한다. 한도 실패 없이 뒤 후보를 쓰거나 모순된 skipped 는 막는다.
		// 차례를 다시 만들 시각(reviewedAt)은 실제 리뷰 시작보다 늦을 수 없고, 90분보다 앞설 수 없다(첫 후보 45분 제한 + 준비 여유). 시각을 미래로 옮겨 고정 리뷰어를 피하는 길을 막는다.
		const reviewedAtMs = isoMs(rec.reviewedAt);
		const firstStartMs = Date.parse(rec.reviewers?.[0]?.receipt?.started_at);
		let order = null;
		if (!Number.isFinite(reviewedAtMs)) problems.push("차례 기록의 reviewedAt(UTC ISO 시각)이 없거나 틀림");
		else if (!Number.isFinite(firstStartMs) || reviewedAtMs > firstStartMs || firstStartMs - reviewedAtMs > 90 * 60 * 1000) problems.push("차례 기록의 reviewedAt 이 리뷰어 영수증 시작 시각과 맞지 않음(시작 전 90분 안이어야 함)");
		else try { order = ROTATION.includes(rec.author_model) ? orderedReviewers(rec.author_model, base, reviewedAtMs) : null; }
		catch (error) { problems.push(`차례 기록의 리뷰 차례를 다시 만들지 못함: ${error.message}`); }
		if (!Array.isArray(rec.skipped)) problems.push("차례 기록의 skipped 는 배열이어야 함");
		else {
			if (rec.skipped.length > 1) problems.push("차례 기록의 skipped 는 최대 1개여야 함");
			for (const [i, s] of rec.skipped.entries()) {
				if (!s || typeof s !== "object") { problems.push(`차례 기록의 skipped[${i}] 모양이 틀림`); continue; }
				if (!ROTATION.includes(s.id)) problems.push(`차례 기록의 skipped[${i}] id 는 차례 셋 안이어야 함`);
				if (s.id === rec.author_model) problems.push(`차례 기록의 skipped[${i}] 가 작성자와 같음`);
				if (s.reason !== "limit") problems.push(`차례 기록의 skipped[${i}] reason 은 "limit" 이어야 함`);
				if (!Number.isInteger(s.exit_code) || s.exit_code === 0) problems.push(`차례 기록의 skipped[${i}] exit_code 는 0이 아닌 정수여야 함`);
				if (order && s.id !== order[i]) problems.push(`차례 기록의 skipped[${i}] 가 차례(${order[i]})와 다름`);
			}
			const reviewer = Array.isArray(rec.reviewers) && rec.reviewers.length === 1 ? Object.keys(REVIEW_MODELS).find((k) => REVIEW_MODELS[k].model === rec.reviewers[0]?.model) : undefined;
			if (order && reviewer !== undefined && reviewer !== order[rec.skipped.length]) problems.push(`차례 기록의 리뷰어가 차례(${order[rec.skipped.length] ?? "없음"})와 다름`);
		}
	} else if (rec.author_model === "codex") {
		problems.push("codex 작성 계획서는 차례 기록(rotation:true)이 필요함(옛 단일·2인 기록은 재리뷰 필요)");
	} else if (rec.author_model === "muse") {
		if (!Array.isArray(rec.reviewers) || rec.reviewers.length !== 1) problems.push("Muse 작성 계획서는 리뷰어 1명의 기록이 필요함(옛 2인·단일 기록은 재리뷰 필요)");
	} else if (!Array.isArray(rec.reviewers) || rec.reviewers.length !== 2) problems.push("서로 다른 리뷰어 두 명의 기록이 필요함(옛 단일 리뷰 기록 미통과)");
	if (!promptSha || rec.prompt_sha256 !== promptSha) problems.push("기록 prompt_sha256 이 현재 요청문과 다름");
	const entries = Array.isArray(rec.reviewers) ? rec.reviewers : [];
	if (entries.length === 2 && entries[0]?.result === entries[1]?.result) problems.push("리뷰어 결과 파일이 서로 같음");
	const expected = (isRotationRecord(rec) || rec.author_model === "muse" || rec.author_model === "codex") ? [] : reviewerIdsFor(rec.author_model);
	for (const id of expected) {
		const config = REVIEW_MODELS[id];
		const matches = entries.filter((r) => r && r.model === config.model);
		if (matches.length !== 1) problems.push(`[${id}] 리뷰어 기록 누락 또는 중복`);
	}
	const resultIdentities = new Set();
	const bodyHashes = new Set();
	for (const [i, r] of entries.entries()) {
		const id = Object.keys(REVIEW_MODELS).find((k) => REVIEW_MODELS[k].model === r?.model) || `unknown-${i}`;
		const own = [];
		if (r?.id !== undefined && r.id !== id) own.push("리뷰어 id 와 모델이 다름");
		if (!REVIEW_MODELS[id]) own.push("허용되지 않은 모델");
		else if (isRotationRecord(rec) && !ROTATION.includes(id)) own.push("허용되지 않은 모델");
		else if (!isRotationRecord(rec) && rec.author_model === "muse" && !["argon", "codex"].includes(id)) own.push("허용되지 않은 모델");
		else if (r.effort !== REVIEW_MODELS[id].effort) own.push("리뷰어 추론 강도가 다름");
		if (id === rec.author_model || id === plan?.author_model) own.push("작성자와 같은 모델이 리뷰함");
		if (entries.filter((x) => x?.model === r?.model).length !== 1) own.push("리뷰어 모델 기록 중복");
		if (r?.target_sha256 !== sha) own.push("리뷰어 target_sha256 이 지금 계획서와 다름");
		if (r?.execution_error) own.push("리뷰어 실행 실패: " + r.execution_error);
		let text = null;
		try {
			if (typeof r?.result === "string" && r.result) {
				const real = resultFile(gatesDir, r.result);
				const stat = fs.statSync(real);
				const identity = `${stat.dev}:${stat.ino}`;
				if (resultIdentities.has(identity)) own.push("리뷰어 결과 파일이 서로 같음(경로 별칭 포함)");
				resultIdentities.add(identity);
				text = fs.readFileSync(real, "utf8");
			}
		} catch {}
		let parsed = { summary: [], openFindings: null, body: "" };
		if (text === null) own.push("적대 리뷰 결과 파일을 읽지 못함");
		else {
			if (r.result_sha256 !== sha256(Buffer.from(text, "utf8"))) own.push("적대 리뷰 결과 파일의 sha256 이 기록과 다름");
			parsed = reviewBodyProblems(text, sha, acceptSecurity);
			own.push(...parsed.problems);
			if (!parsed.prompt_sha256 || parsed.prompt_sha256 !== rec.prompt_sha256 || parsed.prompt_sha256 !== promptSha) own.push("결과 prompt_sha256 이 기록 또는 현재 요청문과 다름");
			const receipt = r.receipt;
			if (!receipt || receipt.model !== r.model || receipt.prompt_sha256 !== promptSha || receipt.exit_code !== 0 || !Number.isFinite(Date.parse(receipt.started_at)) || !Number.isFinite(Date.parse(receipt.ended_at)) || Date.parse(receipt.started_at) > Date.parse(receipt.ended_at) || receipt.stdout_sha256 !== sha256(parsed.body)) own.push("리뷰어 실행 영수증(모델·시작·끝·종료 코드·요청문·본문 해시) 불일치");
			// 승인에 쓰는 영수증의 manifest는 필수다. 없거나 현재 값과 다르면 승인 불가(옛 기록은 재리뷰 필요).
			let current = null;
			try { current = reviewInputManifest(path.join(gatesDir, PLAN_FILE), base); } catch { current = null; }
			if (!receipt || typeof receipt.input_manifest_sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(receipt.input_manifest_sha256) || current === null || receipt.input_manifest_sha256.toLowerCase() !== current) own.push("리뷰어 실행 영수증(input manifest) 없음 또는 불일치(없는 옛 기록은 재리뷰 필요)");
			const bodyHash = sha256(parsed.body);
			if (bodyHashes.has(bodyHash)) own.push("두 리뷰어 결과 본문이 바이트로 같음(복사 바꿔치기)");
			bodyHashes.add(bodyHash);
		}
		const row = { id, model: r?.model, effort: r?.effort, result: r?.result, ...parsed, problems: own, ok: own.length === 0 };
		reviewers.push(row);
		problems.push(...own.map((p) => `[${id}] ${p}`));
	}
	if (new Set(reviewers.map((r) => r.prompt_sha256).filter(Boolean)).size > 1) problems.push("두 리뷰어가 서로 다른 요청문을 검수함(prompt_sha256 불일치)");
	return finish();
}

/** 각 리뷰어 결과의 지적 원문과 기준별 FAIL 을 합친다. 같은 문구만 중복으로 묶고 의미 중복은 추정하지 않는다. */
function renderMergedFindings(review, sha) {
	const groups = new Map();
	for (const r of review.reviewers || []) {
		const findings = r.body.split(/\r?\n/).filter((line) => /^\s*(?:\d+[.)]|[-*]\s*\[)/.test(line));
		for (const s of r.summary) if (s.verdict !== "PASS") findings.push(`${s.id}: ${s.verdict} — ${s.note || "판정 누락"}`);
		for (const finding of findings) {
			const key = finding.replace(/^\s*(?:\d+[.)]|[-*])\s*/, "").replace(/\s+/g, " ").trim();
			if (!groups.has(key)) groups.set(key, new Set());
			groups.get(key).add(r.id);
		}
	}
	return [`# 정식 계획서 리뷰 지적 통합`, `계획서 sha256: ${sha}`, "", ...((review.reviewers || []).map((r) => `- ${r.id}: ${r.body ? (r.ok ? "PASS" : "FAIL") : "결과 없음"}, 남은 지적(차단) ${r.openFindings ?? "확인 불가"}건, 참고 지적 ${r.advisoryFindings ?? 0}건(차단 아님)`)), "", ...review.problems.map((p) => `- 검증: ${p}`), "", ...[...groups].map(([f, ids]) => `- [${[...ids].join(", ")}${ids.size > 1 ? "; 중복" : ""}] ${f}`), "", "## 리뷰어 원문", ...((review.reviewers || []).flatMap((r) => [`### ${r.id}`, r.body || "(결과 없음)", ""]))].join("\n");
}

// ── 상태(저장소 밖) ─────────────────────────────────────────────
function stateFile(env) {
	return path.join(path.dirname(statePath(env)), "deploy-plan-state.json");
}
function loadState(env) {
	const d = readJson(stateFile(env));
	return { challenges: Array.isArray(d?.challenges) ? d.challenges : [], incidents: Array.isArray(d?.incidents) ? d.incidents : [] };
}
function saveState(env, data) {
	const file = stateFile(env);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
	fs.renameSync(tmp, file);
}
/**
 * 상태 파일 읽고-고치고-쓰기를 한 번에 하나만. 동시 훅 두 개가 같은 단계 코드를 각각 쓰는 일을 막는다.
 * 잠금을 못 잡으면 통과가 아니라 막음이다. 60초 넘은 잠금은 죽은 훅이 남긴 것으로 보고 치운다.
 */
async function withStateLock(env, fn, waitMs = 10000) {
	const lock = `${stateFile(env)}.lock`;
	fs.mkdirSync(path.dirname(lock), { recursive: true });
	const until = Date.now() + waitMs;
	for (;;) {
		try {
			fs.mkdirSync(lock);
			break;
		} catch (e) {
			if (e.code !== "EEXIST") throw e;
			try {
				if (Date.now() - fs.statSync(lock).mtimeMs > 60000) { fs.rmdirSync(lock); continue; }
			} catch {}
			if (Date.now() > until) return null;
			await new Promise((r) => setTimeout(r, 50));
		}
	}
	try {
		return await fn();
	} finally {
		try { fs.rmdirSync(lock); } catch {}
	}
}
function newCode(prefix) {
	let s = "";
	for (const b of crypto.randomBytes(6)) s += ALPHABET[b % ALPHABET.length];
	return `${prefix}-${s}`;
}

// ── 디스코드 승인자 확인 ──────────────────────────────────────────
const SNOWFLAKE = /^\d{17,20}$/;
/**
 * 승인자 본인 디스코드 글에 code 가 있는가. 메시지는 AI 가 준 파일이 아니라 디스코드 REST 에서 직접 받는다.
 * 작성자 번호 = approverId(인스턴스 설정값), 봇·웹훅·앱 글 불인정, 글 시각은 코드 발급 뒤.
 */
async function discordConfirms({ code, sinceIso, refs, approverId, expectedApproverId, token, fetchImpl = globalThis.fetch }) {
	const configuredId = expectedApproverId !== undefined ? expectedApproverId : approverId;
	if (!SNOWFLAKE.test(String(approverId || "")) || !SNOWFLAKE.test(String(configuredId || ""))) {
		return { ok: false, why: "approver-id-unset" };
	}
	if (String(approverId) !== String(configuredId)) {
		return { ok: false, why: "approver-id-mismatch" };
	}
	if (typeof token !== "string" || !token) return { ok: false, why: "token-unavailable" };
	const since = Date.parse(sinceIso) || 0;
	for (const r of Array.isArray(refs) ? refs : []) {
		if (!r || r.code !== code || !SNOWFLAKE.test(String(r.channelId || "")) || !SNOWFLAKE.test(String(r.messageId || ""))) continue;
		let m;
		try {
			const res = await fetchImpl(`https://discord.com/api/v10/channels/${r.channelId}/messages/${r.messageId}`, { headers: { authorization: `Bot ${token}` }, signal: AbortSignal.timeout(8000) });
			if (!res || !res.ok) continue;
			m = await res.json();
		} catch {
			continue;
		}
		if (!m || String(m.id) !== String(r.messageId)) continue;
		if (m.channel_id !== undefined && String(m.channel_id) !== String(r.channelId)) continue;
		const a = m.author || {};
		if (String(a.id || "") !== String(approverId) || a.bot === true || a.system === true || m.webhook_id || m.application_id) continue;
		if (!String(m.content || "").includes(code)) continue;
		const at = Date.parse(m.timestamp || "");
		if (!Number.isFinite(at) || at < since) continue;
		return { ok: true, at: m.timestamp, via: `discord:${r.channelId}/${r.messageId}` };
	}
	return { ok: false, why: "no-discord-confirmation" };
}

/** 저장소 정본 설정에서 봇 열쇠를 읽는다. 실패하면 null. 값은 출력하지 않는다. */
async function loadDiscordToken(repoRoot) {
	try {
		const { pathToFileURL } = require("url");
		const gateCfg = readJson(path.join(repoRoot, "config", "deploy-gate.json")) || {};
		const configuredInstances = Array.isArray(gateCfg?.discord?.instances) ? gateCfg.discord.instances : [];
		const instances = [...new Set([process.env.NAIA_MESSENGER_INSTANCE, ...configuredInstances].filter(Boolean))];
		if (instances.length === 0) return null;
		const helperDir = path.join(repoRoot, ".agents", "skills", "manage-discord-sessions", "helper");
		const { loadMessengerConfig, FileCredentialResolver } = await import(pathToFileURL(path.join(helperDir, "discord-config.mjs")).href);
		const { messengerInstancePaths } = await import(pathToFileURL(path.join(helperDir, "instance-paths.mjs")).href);
		for (const inst of instances) {
			try {
				const paths = messengerInstancePaths(repoRoot, inst);
				const t = new FileCredentialResolver(paths.credentialsDirectory).resolve(loadMessengerConfig(paths.configPath).discord.credentialRef);
				if (t) return t;
			} catch {}
		}
		return null;
	} catch {
		return null;
	}
}

/** 사람 확인: 대화창 입력 또는 승인자 디스코드 글. */
async function humanConfirmed(code, sinceIso, ctx) {
	const typed = humanTyped(ctx.transcriptPath, code, sinceIso);
	if (typed.ok) return { ok: true, at: typed.at, via: "terminal" };
	const refsFile = path.join(ctx.gatesDir, DISCORD_FILE);
	const refs = readJson(refsFile);
	const list = Array.isArray(refs?.approvals) ? refs.approvals.filter((r) => r && r.code === code) : [];
	if (list.length === 0) return { ok: false, why: typed.why };
	const gateCfg = readJson(path.join(ctx.repoRoot || ROOT, "config", "deploy-gate.json")) || {};
	const expectedApproverId = gateCfg?.approver?.discordUserId !== undefined ? gateCfg.approver.discordUserId : ctx.approverId;
	const approverId = ctx.approverId !== undefined ? ctx.approverId : expectedApproverId;
	const token = ctx.discordToken !== undefined ? ctx.discordToken : await loadDiscordToken(ctx.repoRoot);
	const d = await discordConfirms({ code, sinceIso, refs: list, approverId, expectedApproverId, token, fetchImpl: ctx.fetchImpl });
	return d.ok ? d : { ok: false, why: d.why };
}

// ── 승인 흐름 ───────────────────────────────────────────────────
function stepSuccessProblem(gatesDir, sha, stepId) {
	const rec = readJson(path.join(gatesDir, "deploy-steps", `${stepId}.json`));
	if (!rec) return `앞 단계 ${stepId} 성공 확인 기록 없음(gates/deploy-steps/${stepId}.json: plan_sha256, step, verdict "pass", evidence, evidence_sha256)`;
	if (rec.plan_sha256 !== sha || rec.step !== stepId || rec.verdict !== "pass") return `앞 단계 ${stepId} 성공 확인 기록이 이 계획서·단계의 pass 가 아님`;
	const ev = typeof rec.evidence === "string" && rec.evidence ? (path.isAbsolute(rec.evidence) ? rec.evidence : path.join(gatesDir, "deploy-steps", rec.evidence)) : null;
	try {
		if (!ev || sha256(fs.readFileSync(ev)) !== rec.evidence_sha256) return `앞 단계 ${stepId} 성공 확인 증거 파일이 없거나 sha256 이 다름`;
	} catch {
		return `앞 단계 ${stepId} 성공 확인 증거 파일을 읽지 못함`;
	}
	return null;
}

function stepSuccessSummary(gatesDir, stepId) {
	const rec = readJson(path.join(gatesDir, "deploy-steps", `${stepId}.json`));
	if (!rec) return null;
	try {
		const ev = path.isAbsolute(rec.evidence) ? rec.evidence : path.join(gatesDir, "deploy-steps", rec.evidence);
		return fs.readFileSync(ev, "utf8").split("\n").filter(Boolean).slice(0, 8).join("\n");
	} catch {
		return null;
	}
}

/** 독립 장애 판정 기록. 판정자 세션은 실행 세션과 달라야 한다. */
function incidentVerdict(gatesDir, sha, sessionId, now = Date.now()) {
	const dir = path.join(gatesDir, "deploy-incident");
	let files = [];
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
	} catch {
		return { ok: false, why: "장애 판정 기록 없음(gates/deploy-incident/*.json). node .agents/scripts/approval-plan.mjs judge 로 독립 판정을 받을 것" };
	}
	let last = "장애 판정 기록 없음";
	for (const f of files) {
		const r = readJson(path.join(dir, f));
		if (!r) continue;
		if (r.plan_sha256 !== sha) { last = `판정 기록 ${f} 이 다른 계획서 판`; continue; }
		const at = Date.parse(r.decidedAt || "");
		if (!Number.isFinite(at) || now - at > INCIDENT_VERDICT_TTL_MS || at - now > 60 * 1000) { last = `판정 기록 ${f} 이 30분보다 오래됨`; continue; }
		const judge = r.judge || {};
		if (!str(judge.session, 3) || judge.session === sessionId || judge.session === r.executor_session) { last = `판정 기록 ${f} 의 판정자 세션이 비었거나 실행 세션과 같음`; continue; }
		if (r.executor_session !== sessionId) { last = `판정 기록 ${f} 의 실행 세션(${r.executor_session || "없음"})이 지금 세션과 다름`; continue; }
		const ev = Array.isArray(r.evidence) ? r.evidence : [];
		if (ev.length === 0 || ev.some((e) => { try { return sha256(fs.readFileSync(e.path)) !== e.sha256; } catch { return true; } })) { last = `판정 기록 ${f} 의 증거 파일이 없거나 sha256 이 다름`; continue; }
		if (r.verdict !== "incident") { last = `판정 기록 ${f}: ${r.verdict === "development" ? "개발(정상 작업 중 실패)로 판정됨 — 선조치 불가, 멈추고 보고" : "판정이 incident 가 아님"}`; continue; }
		return { ok: true, file: f, judge: judge.session, decidedAt: r.decidedAt };
	}
	return { ok: false, why: last };
}

function reportPending(state, sha, gatesDir) {
	// reportedAt 은 믿지 않고 매번 보고 파일을 다시 확인한다(상태 파일은 AI 가 쓸 수 있음).
	for (const inc of state.incidents.filter((i) => i.planSha === sha)) {
		let found = false;
		try {
			found = fs.readdirSync(gatesDir).some((f) => {
				if (!/^deploy-incident-report.*\.md$/.test(f)) return false;
				const file = path.join(gatesDir, f);
				if (fs.statSync(file).mtimeMs < Date.parse(inc.at)) return false;
				const body = fs.readFileSync(file, "utf8");
				return body.trim().length >= 40 && new RegExp(`(?:^|[^A-Za-z0-9_-])${String(inc.action).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^A-Za-z0-9_-])`).test(body);
			});
		} catch {}
		if (found) inc.reportedAt = new Date().toISOString();
		else return inc;
	}
	return null;
}

/**
 * 단계 코드 유효 기간: 사전발급 표시가 있고 현재 계획서 원본이 approval_mode
 * "preapprove_steps" 로 같은 sha 일 때만 12시간. 그 외(일반 계획·모드 변경·
 * sha 불일치)는 state 표시만으로 연장되지 않고 2시간 그대로다.
 */
function stepCodeTtlMs(challenge, plan) {
	if (challenge && challenge.preapprove && plan && plan.approval_mode === "preapprove_steps") return PREAPPROVE_STEP_TTL_MS;
	return STEP_CODE_TTL_MS;
}

/**
 * 사전승인 코드 발급: PLAN + 전부 단계(되돌리기 갈림 포함) challenge 를 미리 만든다.
 * 양식·정식 리뷰·핀/manifest 통과시에만 발급하며, 같은 sha/session/유효 TTL challenge 는 재사용한다.
 * 사람 승인 필드(approvedAt/approvedVia)·executed 기록·step-ok 증거는 만들지 않는다.
 * 이 호출 자체는 어떤 사람이 승인했다는 주장이 아니며 운영 명령·성공 증거를 생성하지 않는다.
 */
async function preapproveStepCodes(planFile, root, sessionId, env = process.env, now = Date.now()) {
	const abs = path.resolve(planFile);
	const base = root ? path.resolve(root) : resolveRepoRoot(path.dirname(abs));
	const gatesDir = path.dirname(abs);
	const plan = readJson(abs);
	if (!plan) return { ok: false, why: "계획서를 읽지 못함" };
	const sha = planSha(abs);
	const form = formProblems(plan);
	if (form.length) return { ok: false, why: "양식: " + form[0] };
	if (plan.approval_mode !== "preapprove_steps") return { ok: false, why: 'approval_mode "preapprove_steps" 없음' };
	const review = reviewProblems(gatesDir, sha, base);
	if (!review.ok) return { ok: false, why: "리뷰: " + review.problems[0] };
	let manifest = null;
	try { manifest = reviewInputManifest(abs, base); } catch (e) { return { ok: false, why: "핀: " + (e && e.message ? e.message : e) }; }
	const made = await withStateLock(env, () => {
		const state = loadState(env);
		const fresh = (c) => c && c.planSha === sha && c.sessionId === sessionId && !c.closed;
		let planCh = state.challenges.filter((c) => c.kind === "plan" && fresh(c) && now - Date.parse(c.createdAt) < PLAN_APPROVAL_TTL_MS).pop();
		if (!planCh) {
			planCh = { kind: "plan", code: newCode("PLAN"), planSha: sha, plan: path.relative(base, abs), sessionId, createdAt: new Date(now).toISOString() };
			state.challenges.push(planCh);
		}
		const steps = [];
		for (const s of plan.scenario || []) {
			let stepCh = state.challenges.filter((c) => c.kind === "step" && c.step === s.id && fresh(c) && now - Date.parse(c.createdAt) < stepCodeTtlMs(c, plan)).pop();
			if (!stepCh) {
				stepCh = { kind: "step", code: newCode("STEP"), planSha: sha, step: s.id, sessionId, createdAt: new Date(now).toISOString(), executed: [], preapprove: true };
				state.challenges.push(stepCh);
			}
			steps.push({ step: s.id, code: stepCh.code });
		}
		saveState(env, state);
		return { ok: true, plan: path.relative(base, abs), plan_sha256: sha, plan_code: planCh.code, steps, input_manifest_sha256: manifest, review };
	});
	return made || { ok: false, why: "상태 잠금 실패" };
}

const CRITERIA_TEXT = Object.fromEntries(CRITERIA);
// 보고문의 명령은 자르지 않는다. 앞부분만 보이고 뒤에 붙은 절이 승인자 눈에 안 띄는 일을 막는다.
// 줄바꿈만 " ⏎ " 로 보여 한 줄로 둔다(해시는 공백 정규화 전문에 걸림).
function fullCommand(c) {
	return String(c).replace(/\r?\n/g, " ⏎ ").replace(/[ \t]+/g, " ");
}

/** 승인 보고 양식 그대로, 짧게. */
function renderReport(plan, sha, review) {
	const L = [];
	L.push(`[운영 배포 승인 요청] ${plan.planId}  (계획서 sha ${sha.slice(0, 12)})`);
	L.push(`무엇을 왜: ${plan.what_why}`);
	L.push(`서비스: ${(plan.services || []).join(", ")}`);
	L.push("바뀌는 것:", ...(plan.changes || []).map((c) => `  - ${c}`));
	L.push("시나리오:");
	for (const s of plan.scenario || []) {
		L.push(`  ${s.id}${s.branch ? " (되돌리기 갈림길)" : ""}. ${s.title}`);
		for (const c of s.commands || []) L.push(`     명령 sha ${commandHash(c).slice(0, 12)}: ${fullCommand(c)}`);
		for (const [p, h] of Object.entries(s.files || {})) L.push(`     고정 파일 ${p} sha ${String(h).slice(0, 12)}`);
		L.push(`     성공 확인: ${s.success_check}`, `     실패 시: ${s.on_failure}`);
	}
	L.push(`위험: ${(plan.risks?.items || []).join(" / ")}`, `최악의 경우: ${plan.risks?.worst_case}`);
	L.push(`되돌릴 수 없는 것: ${(plan.irreversible || []).join(" / ")}`);
	L.push(`끊김 안전: ${plan.disconnect_safety}`);
	L.push(`재실행 안전: 잠금 ${plan.rerun_safety?.lock} / 실행 폴더 ${plan.rerun_safety?.run_dir} / 최근 폴더 자동 선택 ${plan.rerun_safety?.no_latest_pick}`);
	L.push(`성공 확인: ${plan.success_verification}`);
	L.push(`되돌리기: ${plan.rollback?.method} (소요 ${plan.rollback?.duration})`);
	L.push(`장애 판단 기준: ${(plan.incident?.criteria || []).join(" / ")}`);
	for (const a of plan.incident?.actions || []) L.push(`장애 시 선조치 ${a.id}: ${a.why_safe}`, ...(a.commands || []).map((c) => `     명령 sha ${commandHash(c).slice(0, 12)}: ${fullCommand(c)}`));
	L.push("남은 위험(승인하면 책임지는 것):", ...(plan.residual_risks || []).map((r) => `  - ${r}`));
	if (review) L.push(`적대 리뷰: ${review.summary.map((s) => `${s.reviewer}/${s.id} ${s.verdict}`).join(", ")}; 남은 지적 0; 참고 지적 ${(review.reviewers || []).reduce((n, r) => n + (r.advisoryFindings || 0), 0)}건(차단 아님, gates/deploy-plan-review-findings.md)`);
	return L.join("\n");
}

/**
 * 운영 변경 명령 하나를 판정한다.
 * ctx: { command, sessionId, transcriptPath, root, env, now, approverId, fetchImpl, discordToken, readiness(step) → {ok, problems, facts} }
 * 돌려줌: { allow:boolean, reason?:string, audit:object }
 */
async function evaluate(ctx) {
	const env = ctx.env || process.env;
	const now = ctx.now || Date.now();
	if (!(ctx.services || []).length) return { allow: false, audit: { event: "blocked-unclassified" }, reason: "[Harness] 운영 서비스 집합이 비어 있어 거부합니다." };
	const h = commandHash(ctx.command);
	const found = plansForCommand(ctx.command, ctx.root, now);
	const howTo = "승인 보고 양식(.agents/progress/<작업>/gates/deploy-plan.json, docs/guides/approval-plan-gate.md)을 만들고, 기준별 적대 리뷰를 통과한 뒤 승인을 요청하십시오. 승인자에게 붙여 넣을 명령을 넘기지 마십시오.";
	if (found.length === 0) {
		return { allow: false, audit: { event: "blocked-out-of-plan", command_sha256: h }, reason: [
			"[Harness] 계획 밖 운영 명령이라 막습니다.",
			`명령 sha256(공백 정규화): ${h}`,
			"이 명령이 바꾸는 운영 서비스:",
			...(ctx.services || []).map((sv) => `  "${sv}"`),
			"",
			"승인된 계획서의 단계·장애 선조치 명령 목록에 이 명령이 없습니다. 계획을 실행하던 중이라면 더 진행하지 말고 운영을 안전한 상태로 둔 채 무슨 일이 있었는지·지금 운영 상태·선택지를 바로 보고하십시오.",
			"새 배포라면: " + howTo,
		].join("\n") };
	}
	if (found.length > 1) {
		return { allow: false, audit: { event: "blocked-plan-ambiguous", command_sha256: h, plans: found.map((f) => f.file) }, reason: `[Harness] 같은 명령이 계획서 여러 개에 있어 어느 승인인지 정할 수 없습니다: ${found.map((f) => path.relative(ctx.root, f.file)).join(", ")}. 하나만 남기십시오.` };
	}
	const f = found[0];
	const rel = path.relative(ctx.root, f.file);
	const outside = (ctx.services || []).filter((sv) => !(f.plan.services || []).includes(sv));
	if (outside.length) {
		return { allow: false, audit: { event: "blocked-service-outside-plan", plan: rel, services: outside }, reason: `[Harness] 이 명령이 바꾸는 운영 서비스가 계획서 services 에 없습니다: ${outside.join(", ")}. 계획서 ${rel} 의 services 에 넣고 다시 검수·승인받으십시오.` };
	}
	const form = formProblems(f.plan);
	if (form.length) {
		return { allow: false, audit: { event: "blocked-plan-form", plan: rel, problems: form.slice(0, 20) }, reason: ["[Harness] 승인 보고 양식에 빈 칸이 있어 승인 요청을 낼 수 없습니다.", `계획서: ${rel}`, ...form.map((x) => `- ${x}`), "", "양식: docs/guides/approval-plan-gate.md (node .agents/scripts/approval-plan.mjs template)"].join("\n") };
	}
	const entry = f.step || f.action;
	// 단계 명령 바이트 대조: 정규화 sha 가 같더라도 실행 명령 바이트가 계획서 commands 원문과 다르면 차단한다.
	if (!Array.isArray(entry?.commands) || !entry.commands.includes(ctx.command)) {
		return { allow: false, audit: { event: "blocked-command-byte-mismatch", plan: rel, command_sha256: h }, reason: [
			"[Harness] 실행 명령 바이트가 계획서의 승인된 단계 명령과 다릅니다.",
			`계획서: ${rel} / ${f.step ? `단계 ${f.step.id}` : `장애 선조치 ${f.action.id}`}`,
			"계획서 commands 에 적힌 문자열과 바이트 단위로 똑같이 실행하십시오.",
		].join("\n") };
	}
	// 명령이 읽거나 실행하는 파일(감싼 스크립트, --yaml 파일, 내용 파일)은 계획서 단계의 files 에 sha 로 고정해야 한다.
	const pinned = new Map(Object.entries(entry.files || {}).map(([p, h]) => [path.resolve(ctx.cwd || ctx.root, p), String(h).toLowerCase()]));
	const refs = typeof ctx.fileRefs === "function" ? ctx.fileRefs() : referencedFiles(ctx.command, ctx.cwd || ctx.root);
	const unpinned = refs.filter((r) => pinned.get(path.resolve(r.path)) !== r.sha);
	// 글자에 나타나지 않는 도움 파일도 전부 실물과 대조한다. 같은 해시의 다른 경로는 대신할 수 없다.
	for (const [p, h] of pinned) {
		let actual = null;
		try { actual = sha256(fs.readFileSync(p)); } catch {}
		if (actual !== h && !unpinned.some((r) => path.resolve(r.path) === p)) unpinned.push({ path: p, sha: actual || "읽기 실패" });
	}
	if (unpinned.length) {
		return { allow: false, audit: { event: "blocked-plan-file-unpinned", plan: rel, files: unpinned.map((r) => ({ path: r.path, sha256: r.sha })) }, reason: [
			"[Harness] 이 명령이 읽거나 실행하는 파일이 계획서에 고정되지 않았거나, 고정한 뒤 바뀌었습니다.",
			`계획서: ${rel} / ${f.step ? `단계 ${f.step.id}` : `장애 선조치 ${f.action.id}`}`,
			"그 단계(또는 선조치)에 다음을 \"files\" 로 적고 다시 적대 리뷰를 받으십시오(리뷰 요청문에 파일 글이 실립니다):",
			...unpinned.map((r) => `  "${r.path}": "${r.sha}"`),
		].join("\n") };
	}
	const review = reviewProblems(f.gatesDir, f.sha, ctx.root);
	if (!review.ok) {
		return { allow: false, audit: { event: "blocked-plan-review", plan: rel, problems: review.problems.slice(0, 20) }, reason: ["[Harness] 기준별 적대 리뷰를 통과하지 않아 승인 요청을 낼 수 없습니다.", `계획서: ${rel} (sha ${f.sha.slice(0, 12)})`, ...review.problems.map((x) => `- ${x}`), "", `기준: ${CRITERIA.map(([id]) => id).join(", ")}. 검수 요청문: node .agents/scripts/approval-plan.mjs review-prompt ${rel}`].join("\n") };
	}

	// 배포 준비 기록(gates/deploy.json 및 인스턴스 설정 config/deploy-gate.json)은 승인 요청 전에 맞아야 한다.
	// 독립 판정된 장애 선조치만 뺀다.
	const verdictEarly = f.action ? incidentVerdict(f.gatesDir, f.sha, ctx.sessionId, now) : { ok: false };
	let facts = [];
	if (f.step && !verdictEarly.ok && typeof ctx.readiness === "function") {
		const r = ctx.readiness({ plan: f.plan, entry, command: ctx.command, cwd: ctx.cwd || ctx.root, gatesDir: f.gatesDir });
		if (r && !r.ok) return { allow: false, audit: { event: "blocked-not-ready", plan: rel, problems: r.problems.slice(0, 20) }, reason: [
			`[Harness] 운영 변경 준비 안 됨: ${(ctx.services || []).join(", ")}`,
			"",
			"승인 요청 전에 배포 준비 기록과 인스턴스 서비스 규칙(config/deploy-gate.json)이 맞아야 합니다. 승인 코드는 준비가 끝난 뒤에 나옵니다.",
			...r.problems.map((x) => `- ${x}`),
			"",
			"준비 기록 양식(.agents/progress/<작업>/gates/deploy.json):",
			JSON.stringify(ctx.readinessTemplate || {}, null, 2),
			"",
			"긴급 되돌리기는 kind rollback, 설정만 바꾸는 명령(환경 변수·복제 수·재시작·리비전 끄기)과 VM·컨테이너 안 조회·진단은 kind ops(reason 한 줄)로 적습니다. 배포 스크립트처럼 코드를 올리는 명령은 ops 가 될 수 없습니다. 승인자에게 붙여 넣을 명령을 넘기지 마십시오.",
		].join("\n") };
		facts = (r && r.facts) || [];
	}
	const factLines = facts.length ? ["", "배포 준비 기록에서 확인한 사실:", ...facts.map((x) => `  ${x}`)] : [];
	const hostNote = ctx.transcriptPath ? [] : ["", "이 호스트는 대화 기록을 읽을 수 없어 대화창 승인을 확인할 수 없습니다. 디스코드 승인 경로(gates/deploy-approval-discord.json)를 쓰십시오. 승인자에게 붙여 넣을 명령을 넘기지 마십시오."];

	const locked = await withStateLock(env, () => approvalFlow({ ctx, env, now, h, f, rel, review, factLines, hostNote, verdictEarly }));
	if (locked) return locked;
	return { allow: false, audit: { event: "blocked-state-lock", plan: rel }, reason: "[Harness] 승인 상태 파일 잠금을 잡지 못해 막습니다(다른 운영 명령 판정이 진행 중). 잠시 뒤 다시 실행하십시오." };
}

async function approvalFlow({ ctx, env, now, h, f, rel, review, factLines, hostNote, verdictEarly }) {
	const state = loadState(env);
	const ctxH = { transcriptPath: ctx.transcriptPath, gatesDir: f.gatesDir, repoRoot: ctx.root, approverId: ctx.approverId, fetchImpl: ctx.fetchImpl, discordToken: ctx.discordToken };

	// 전체 계획 승인
	let planCh = state.challenges.filter((c) => c.kind === "plan" && c.planSha === f.sha && c.sessionId === ctx.sessionId && !c.riskAccepted && now - Date.parse(c.createdAt) < PLAN_APPROVAL_TTL_MS).pop();
	if (!planCh) {
		planCh = { kind: "plan", code: newCode("PLAN"), planSha: f.sha, plan: rel, sessionId: ctx.sessionId, createdAt: new Date(now).toISOString() };
		state.challenges.push(planCh);
		saveState(env, state);
	}
	const planOk = await humanConfirmed(planCh.code, planCh.createdAt, ctxH);
	if (!planOk.ok) {
		return { allow: false, audit: { event: "plan-approval-requested", plan: rel, plan_sha256: f.sha }, reason: [
			"[Harness] 전체 계획 승인이 아직 없습니다. 아래 승인 보고 양식을 그대로 승인자에게 올리십시오(대화창 또는 디스코드).",
			"",
			renderReport(f.plan, f.sha, review),
			...factLines,
			"",
			`승인 코드: ${planCh.code}  — 승인자가 대화창에 직접 치거나, 디스코드에 본인 글로 남기면(글 위치를 gates/${DISCORD_FILE} 에 적음) 이 계획 전체가 승인됩니다. 승인은 책임 수용입니다.`,
			"승인 뒤에도 각 단계는 실행 직전에 단계 승인을 받습니다. AI 가 코드를 대신 입력하거나 파일·봇 글로 승인을 만들 수 없습니다.",
			...hostNote,
		].join("\n") };
	}

	// 앞 장애 선조치 보고가 없으면 다음 선조치도 다음 단계도 못 한다.
	const pending = reportPending(state, f.sha, f.gatesDir);
	if (pending) {
		saveState(env, state);
		return { allow: false, audit: { event: "blocked-incident-report-pending", plan: rel }, reason: `[Harness] 장애 선조치(${pending.action}, ${pending.at}) 보고가 아직 없습니다. gates/deploy-incident-report-*.md 를 먼저 쓰고 승인자에게 보고하십시오.` };
	}

	// 장애 선조치: 계획 승인 + 독립 판정
	if (f.action) {
		const v = verdictEarly.ok ? verdictEarly : incidentVerdict(f.gatesDir, f.sha, ctx.sessionId, now);
		if (v.ok) {
			state.incidents.push({ planSha: f.sha, plan: rel, action: f.action.id, command_sha256: h, at: new Date(now).toISOString(), judge: v.judge });
			saveState(env, state);
			return { allow: true, audit: { event: "incident-action-executed", plan: rel, plan_sha256: f.sha, action: f.action.id, judge: v.judge, verdict_file: v.file, approved_by: "plan-approval+independent-incident-verdict" }, notice: `장애 선조치 ${f.action.id} 실행. 실행 직후 gates/deploy-incident-report-*.md 로 보고(무슨 일·한 조치·지금 상태·다음 선택지)하십시오. 보고 전에는 다음 단계 승인을 받을 수 없습니다.` };
		}
		if (!f.step) return { allow: false, audit: { event: "blocked-incident-unverified", plan: rel, why: v.why }, reason: ["[Harness] 장애 선조치 명령이지만 독립 장애 판정이 없습니다.", `- ${v.why}`, "", "실행 세션이 스스로 장애라고 판단할 수 없습니다. node .agents/scripts/approval-plan.mjs judge <계획서> --evidence <확인 결과·헬스·오류 로그> 로 다른 세션 판정을 받으십시오. 개발로 판정되면 멈추고 보고하십시오."].join("\n") };
	}

	// 단계 실행
	saveState(env, state);
	const steps = f.plan.scenario;
	const idx = steps.indexOf(f.step);
	const st2 = loadState(env);
	if (f.step.branch !== "rollback") {
		for (const prev of steps.slice(0, idx).filter((s) => s.branch !== "rollback")) {
			const prevCmdHashes = (prev.commands || []).map((c) => commandHash(c));
			const prevChallenges = st2.challenges.filter((c) => c.kind === "step" && c.planSha === f.sha && c.step === prev.id && c.sessionId === ctx.sessionId);
			const executedHashes = new Set();
			let prevStatusExecuted = false;
			for (const c of prevChallenges) {
				if (c.status === "executed") prevStatusExecuted = true;
				for (const eh of c.executed || []) executedHashes.add(eh);
			}
			const allPrevCommandsExecuted = prevCmdHashes.length > 0 && prevCmdHashes.every((ch) => executedHashes.has(ch));
			if (!prevStatusExecuted || !allPrevCommandsExecuted) {
				const why = `${prev.id} 단계가 실제 실행(executed)되지 않음`;
				return { allow: false, audit: { event: "blocked-step-order", plan: rel, step: f.step.id, why }, reason: ["[Harness] 앞 단계가 실제 실행(executed)되지 않아 다음 단계로 넘어갈 수 없습니다.", `- ${why}`, "", `앞 단계(${prev.id}) 명령을 먼저 실행하고 성공 확인(step-ok) 증거를 남기십시오.`].join("\n") };
			}
			const bad = stepSuccessProblem(f.gatesDir, f.sha, prev.id);
			if (bad) return { allow: false, audit: { event: "blocked-step-order", plan: rel, step: f.step.id, why: bad }, reason: ["[Harness] 앞 단계 성공 확인 전에는 다음 단계 승인을 요청할 수 없습니다.", `- ${bad}`, "", "앞 단계의 성공 확인을 실행해 증거를 남기십시오: node .agents/scripts/approval-plan.mjs step-ok <계획서> <단계> --evidence <확인 출력 파일>. 확인이 실패했으면 계획의 실패 갈림길대로 하고 보고하십시오."].join("\n") };
		}
	}

	let stepCh = st2.challenges.filter((c) => c.kind === "step" && c.planSha === f.sha && c.step === f.step.id && c.sessionId === ctx.sessionId && !c.closed).pop();
	if (stepCh && (stepCh.executed || []).includes(h)) {
		stepCh.closed = new Date(now).toISOString();
		stepCh = null;
	}
	const stepTtl = stepCodeTtlMs(stepCh, f.plan);
	if (stepCh && !stepCh.approvedAt && now - Date.parse(stepCh.createdAt) > stepTtl) { stepCh.closed = new Date(now).toISOString(); stepCh = null; }
	if (stepCh && stepCh.approvedAt && now - Date.parse(stepCh.approvedAt) > stepTtl) { stepCh.closed = new Date(now).toISOString(); stepCh = null; }
	if (!stepCh) {
		stepCh = { kind: "step", code: newCode("STEP"), planSha: f.sha, step: f.step.id, sessionId: ctx.sessionId, createdAt: new Date(now).toISOString(), executed: [] };
		st2.challenges.push(stepCh);
		saveState(env, st2);
	}
	// 단계 승인은 상태 파일에 적힌 approvedAt 을 믿지 않고 실행할 때마다 사람 입력(대화 기록·디스코드)을 다시 확인한다.
	{
		const ok = await humanConfirmed(stepCh.code, stepCh.createdAt, ctxH);
		if (!ok.ok) {
			const prev = steps.slice(0, idx).filter((s) => s.branch !== "rollback").pop();
			const prevOut = prev ? stepSuccessSummary(f.gatesDir, prev.id) : null;
			return { allow: false, audit: { event: "step-approval-requested", plan: rel, step: f.step.id }, reason: [
				`[Harness] 단계 승인 필요: ${f.plan.planId} / ${f.step.id}${f.step.branch ? " (되돌리기 갈림길)" : ""}. ${f.step.title}`,
				...(prev ? [`앞 단계 ${prev.id} 성공 확인:`, ...(prevOut ? prevOut.split("\n").map((l) => `  ${l}`) : ["  (증거 요약 없음)"])] : []),
				"이 단계 명령:",
				...f.step.commands.map((c) => `  sha ${commandHash(c).slice(0, 12)}: ${fullCommand(c)}`),
				`성공 확인: ${f.step.success_check}`,
				`실패 시: ${f.step.on_failure}`,
				"",
				...factLines,
				"",
				`단계 승인 코드: ${stepCh.code}  — 승인자가 대화창에 치거나 디스코드 본인 글로 남기면 이 단계 명령이 각각 한 번 통과합니다.`,
				...hostNote,
			].join("\n") };
		}
		if (!stepCh.approvedAt) stepCh.approvedAt = new Date(now).toISOString();
		stepCh.approvedVia = ok.via;
	}
	stepCh.executed = [...(stepCh.executed || []), h];
	const stepCmdHashes = (f.step.commands || []).map((c) => commandHash(c));
	const allExecutedForStep = new Set();
	for (const c of st2.challenges.filter((ch) => ch.kind === "step" && ch.planSha === f.sha && ch.step === f.step.id && ch.sessionId === ctx.sessionId)) {
		for (const eh of c.executed || []) allExecutedForStep.add(eh);
	}
	if (stepCmdHashes.length > 0 && stepCmdHashes.every((ch) => allExecutedForStep.has(ch))) {
		stepCh.status = "executed";
		stepCh.executedAt = new Date(now).toISOString();
	}
	saveState(env, st2);
	return { allow: true, audit: { event: "executed", plan: rel, plan_sha256: f.sha, step: f.step.id, plan_code_sha256_12: sha256(planCh.code).slice(0, 12), step_code_sha256_12: sha256(stepCh.code).slice(0, 12), approved_by: `plan(${planOk.via})+step(${stepCh.approvedVia})` } };
}

const TEMPLATE = {
	schema: "deploy-plan/v1",
	author_model: "<muse>",
	planId: "<짧은 이름, 예: app-web-20261016>",
	read_only: false,
	createdAt: "<ISO 시각>",
	services: ["<deploy-guard 가 알려 준 운영 서비스 키, 예: azure:containerapp:my-app-prod>"],
	what_why: "<무엇을 왜 배포하나 한두 줄>",
	changes: ["<바뀌는 것 하나씩: 코드 판, 설정, 방화벽 규칙 등>"],
	scenario: [
		{ id: "s1", title: "<단계 이름>", commands: ["<실행할 명령 전문. 이 글자 그대로 실행해야 통과>"], success_check: "<이 단계 성공 확인 방법과 기대값>", on_failure: "<실패 시 갈림길: 예) r1 로 되돌리고 보고>" },
		{ id: "r1", branch: "rollback", title: "<되돌리기>", commands: ["<되돌리기 명령>"], success_check: "<되돌리기 확인>", on_failure: "<되돌리기 실패 시: 운영 안전 상태와 보고>" },
	],
	risks: { items: ["<위험>"], worst_case: "<최악의 경우>" },
	irreversible: ["<되돌릴 수 없는 것. 없으면 \"없음: 이유\">"],
	disconnect_safety: "<끊김 시 작업 상태 확인 방법, 명시 runID 재접속 확인, 보존된 이전 판으로 사람이 수동 복귀하는 경로. 자동 복구 장치 불필요>",
	rerun_safety: { lock: "<중복 실행 거절 잠금>", run_dir: "<실행마다 고유 폴더, 앞 기록 안 덮음>", no_latest_pick: "<가장 최근 폴더 자동 선택 안 함, 실행 id 를 명시>" },
	success_verification: "<전체 성공 확인 방법>",
	rollback: { method: "<되돌리기 방법>", duration: "<소요 시간>", step_ids: ["r1"] },
	residual_risks: ["<남은 위험: 승인자가 책임지는 것>"],
	incident: { criteria: ["<장애 판단 기준: 확인 실패, 5xx 급증 등 수치>"], actions: [{ id: "a1", commands: ["<장애 시 승인 없이 실행할 되돌리기·완화 명령>"], why_safe: "<상황을 더 나쁘게 만들 수 없는 이유>" }] },
};

function pinSha(abs) {
	if (fs.statSync(abs).size > 64 * 1024 * 1024) return `unpinnable-too-big-${crypto.randomBytes(8).toString("hex")}`;
	return sha256(fs.readFileSync(abs));
}

function rootOwnedBinary(abs) {
	let fd;
	try {
		const safeChain = (name) => {
			let p = path.resolve(name);
			for (;;) {
				const st = fs.lstatSync(p);
				if (st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022)) return false;
				if (p === "/") return true;
				p = path.dirname(p);
			}
		};
		if (!safeChain(abs)) return false;
		const real = fs.realpathSync(abs);
		if (!safeChain(real)) return false;
		fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		const before = fs.fstatSync(fd);
		if (!before.isFile() || before.uid !== 0 || (before.mode & 0o022) || !(before.mode & 0o111)) return false;
		const magic = Buffer.alloc(20);
		if (fs.readSync(fd, magic, 0, 20, 0) !== 20) return false;
		if (!magic.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
			![1, 2].includes(magic[4]) || ![1, 2].includes(magic[5]) || magic[6] !== 1) return false;
		const elfType = magic[5] === 1 ? magic.readUInt16LE(16) : magic.readUInt16BE(16);
		if (elfType !== 2 && elfType !== 3) return false;
		const after = fs.statSync(real), end = fs.fstatSync(fd);
		return before.dev === after.dev && before.ino === after.ino && before.size === end.size &&
			before.mtimeMs === end.mtimeMs && before.ctimeMs === end.ctimeMs && safeChain(abs) &&
			fs.realpathSync(abs) === real && safeChain(real);
	} catch {
		return false;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function readSmallText(f, dir) {
	try {
		const abs = path.isAbsolute(f) ? f : path.resolve(dir || "/", f);
		const st = fs.statSync(abs);
		if (!st.isFile() || st.size > 1024 * 1024) return "";
		return fs.readFileSync(abs, "utf8");
	} catch {
		return "";
	}
}

function scriptFileOf(e, command) {
	const { executedShellFile } = require("./deploy-command-classifier.js");
	const argv = e.argv || [];
	const direct = executedShellFile(argv, e.dir, e.dirKnown !== false, command);
	if (direct) return direct;
	if (!/(?:^|\/)(?:ba|z|da)?sh$/.test(argv[0] || "")) return null;
	for (let i = 1; i < argv.length; i++) {
		const m = argv[i].match(/^0?<(.*)$/);
		if (!m) continue;
		const f = m[1] || argv[i + 1];
		if (!f) return null;
		const abs = path.isAbsolute(f) ? f : path.resolve(e.dir || "/", f);
		try {
			return fs.statSync(abs).isFile() ? abs : null;
		} catch {
			return null;
		}
	}
	return null;
}

/**
 * 운영 명령이 읽거나 실행하는 파일과 그 sha256. 감싼 셸 스크립트는 안까지 3단계 본다.
 * 계획서 단계의 files 에 이 sha 가 있어야 통과한다.
 */
function referencedFiles(command, cwd) {
	const { effectiveCommands, resolvePathWord } = require("./effective-argv.js");
	const out = new Map();
	const seen = new Set();
	const visit = (text, dir, depth) => {
		let entries = [];
		try {
			entries = effectiveCommands(text, dir);
		} catch {
			return;
		}
		for (const e of entries) {
			for (const t of (e.argv || []).map(String)) {
				for (const cand of new Set([t, t.replace(/^[^=]*=/, ""), t.replace(/^@/, ""), t.replace(/^\d*</, ""), t.replace(/^file:\/\//, "")])) {
					if (!cand || cand.length > 1024) continue;
					let resolved = null;
					try {
						resolved = resolvePathWord(cand, e.dir || dir || cwd || "/", text, e.dirKnown !== false);
					} catch {}
					const abs = resolved || (path.isAbsolute(cand) ? cand : path.resolve(e.dir || dir || cwd || "/", cand));
					if (out.has(abs)) continue;
					try {
						if (!fs.statSync(abs).isFile()) continue;
						if (rootOwnedBinary(abs)) continue;
						out.set(abs, pinSha(abs));
					} catch {}
				}
			}
			const script = depth < 3 ? scriptFileOf(e, text) : null;
			if (script && !out.has(script)) {
				try {
					out.set(script, pinSha(script));
				} catch {}
			}
			if (script && !seen.has(script)) {
				seen.add(script);
				const body = readSmallText(script, "/");
				if (body) visit(body, e.dir || dir || cwd || "/", depth + 1);
			}
		}
	};
	visit(command, cwd, 0);
	return [...out].map(([p, sha]) => ({ path: p, sha }));
}

module.exports = {
	criteriaFor, readOnlyProblems, roundFiles, readRound, roundOutcome, writeRound, markRound, writeReviewRecord, recordBytes, confirmedRound, roundConfirmProblem, priorRound, failStreak, loadPriorRound, changedFields, humanDecisionRequest, ROUNDS_DIR, ROUND_FAIL_LIMIT,
	withStateLock, evaluate, formProblems, reviewProblems, riskAcceptanceProblems, riskAcceptanceActive, reviewerIdsFor, rotationOrder, orderedReviewers, isLimitFailure, isRotationRecord, LEGACY_REVIEW_CUTOFF, plansForCommand, discordConfirms, incidentVerdict, renderReport, reviewPrompt, pinnedFileProblems, referencedFiles, resultFile, reviewTrailer, renderMergedFindings, reviewInputManifest, reviewInputEntries, resolveRepoRoot, preapproveStepCodes, stepCodeTtlMs, REVIEW_EXECUTOR_FILES, REVIEW_MODELS, ROTATION, AUTHOR_MODELS, LIMIT_RE, CRITERIA, CRITERIA_TEXT, TEMPLATE, PLAN_FILE, REVIEW_FILE, DISCORD_FILE, PREAPPROVE_STEP_TTL_MS, PLAN_APPROVAL_TTL_MS, STEP_CODE_TTL_MS, stateFile,
};
