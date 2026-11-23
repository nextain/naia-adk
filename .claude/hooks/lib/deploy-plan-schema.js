"use strict";
// Plan gate responsibility: schema.
const { commandHash } = require("./deploy-human-approval.js");
const { str, strList } = require("./deploy-plan-common.js");
const { AUTHOR_MODELS } = require("./deploy-plan-review-policy.js");

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
	["architecture_fit", "상위 구조·최초 요구 적합성: architecture_fit(original_request, parent_structure, acceptance_rationale)이 최초 요구 원문, 붙는 플랫폼·ADK·제품 구조(단일 서버·파일명 나열 아님), 수용 근거와 실제 맞고 일시 땜빵이 아닌가"],
];

// 지적 분류. 차단 지적만 FAIL·남은 지적에 센다. 계획에 없는 새 장치를 더하라는 요구는 참고로만 남긴다.
const BLOCKING_KINDS = [
	"불일치: 계획 문구와 명령·스크립트 실제 동작이 다름",
	"되돌리기: 되돌리기 경로가 없거나 틀림",
	"비밀: 비밀·인증 정보 노출",
	"위험숨김: 위험을 숨기거나 축소함(장치가 없어 생기는 위험이 계획서 위험·영향·남은 위험 칸에 적히지 않은 경우 포함)",
	"선조치악화: 적힌 장애 선조치가 상황을 더 나쁘게 만듦",
	"구조이탈: 단일 카드·서버·파일만 고치는 일시 땜빵이거나 architecture_fit 이 최초 요구·상위 구조와 어긋남",
];

const ADVISORY_EXAMPLES = "자동 복구·자동 되돌리기, 추가 백업 사본, 임시 검증 컨테이너, 라우팅 통제, 새 잠금·감시 장치, 범위 밖 스크립트 개조, 승인 없이 도는 선조치 추가";

const NARROW_WRAPPER_WORDS = new Set([
	"서버", "호스트", "노드", "인스턴스", "기기", "장비", "머신", "서비스", "유닛", "컨테이너",
	"파일", "스크립트", "대본", "설정", "문서", "경로", "특정", "개별", "단독", "단일",
	"한", "하나", "해당", "이", "그", "것", "만", "뿐", "쪽", "수정", "고침", "변경",
	"패치", "재시작", "배포", "점검", "확인", "추가", "삭제", "및", "와", "과", "의",
	"server", "servers", "host", "hosts", "node", "nodes", "instance", "vm", "container",
	"service", "services", "unit", "units", "file", "files", "script", "scripts",
	"config", "cfg", "path", "only", "single", "just", "one", "this", "that", "the",
	"a", "an", "in", "on", "at", "of", "to", "for", "and", "fix", "patch", "edit",
	"update", "restart", "deploy", "check", "specific", "individual",
]);

const KOREAN_PARTICLES_RE = /(?:에서만|에서는|에서도|에서|으로|까지|부터|처럼|조차|밖에|만|뿐|의|에|로|을|를|은|는|이|가|와|과|도)$/;

const COMMON_FILE_EXT_RE = /(?:^|[\s,.;:()[\]{}"'<>~·|/])[\w.-]+\.(?:js|cjs|mjs|ts|tsx|jsx|py|sh|bash|zsh|yaml|yml|json|toml|ini|conf|cfg|service|socket|timer|unit|env|sql|tf|md|txt|lock|log)(?=$|[\s,.;:()[\]{}"'<>~·|/\u3131-\uD7A3])/gi;

const NARROW_COMPOUND_PARTS_RE = /(?:서버|호스트|노드|인스턴스|기기|장비|머신|서비스|유닛|컨테이너|파일|스크립트|대본|설정|문서|경로|특정|개별|단독|단일|해당|수정|고침|변경|패치|재시작|배포|점검|확인|추가|삭제)/g;

function isTemplatePlaceholder(value) {
	if (typeof value !== "string") return false;
	return /^<[^<>]+>$/.test(value.trim()) || /<(?![@#:!\s])[^<>\n]{1,80}>/.test(value);
}

/** (b) 붙는 상위 구조가 특정 서버·서비스 키·단일 파일명만 가리키는지 검사한다. */
function isNarrowServerOrFileOnly(value, services = []) {
	if (typeof value !== "string") return true;
	const trimmed = value.trim();
	if (!trimmed) return true;
	const norm = trimmed.toLowerCase();
	if (Array.isArray(services) && services.some((s) => typeof s === "string" && s.trim() && s.trim().toLowerCase() === norm)) return true;

	let stripped = trimmed;
	for (const svc of Array.isArray(services) ? services : []) {
		if (typeof svc !== "string" || !svc.trim()) continue;
		const esc = svc.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		stripped = stripped.replace(new RegExp(esc, "gi"), " ");
	}
	stripped = stripped
		.replace(/https?:\/\/\S+/gi, " ")
		.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, " ")
		.replace(/\b[a-z0-9_-]+:[a-z0-9_.:-]+\b/gi, " ")
		.replace(/(?:~\/|\/|\.\.?\/|[a-zA-Z0-9_.-]+\/)[^\s,)"']+/g, " ")
		.replace(COMMON_FILE_EXT_RE, " ")
		.replace(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|internal|local|lan|example|svc|cluster|kr|ai|cloud)\b/gi, " ")
		.replace(/\b(?:prod|stg|staging|dev|test|srv|vm|node|host|db|web|app|api|worker|redis|pg)-[a-z0-9-]+\b/gi, " ")
		.replace(/\b[a-z][a-z-]*\d+(?:-[a-z0-9]+)*\b/gi, " ");

	const tokens = stripped
		.split(/[\s,.;:()[\]{}"'<>~·/+|=!?&]+/)
		.map((t) => t.replace(/^-+|-+$/g, "").trim().toLowerCase().replace(KOREAN_PARTICLES_RE, ""))
		.filter((t) => t.length > 0 && !/^\d+$/.test(t) && !NARROW_WRAPPER_WORDS.has(t));

	if (tokens.length === 1 && !/\s/.test(trimmed) && /[\uAC00-\uD7A3]/.test(tokens[0])) {
		const meaningful = tokens[0].replace(NARROW_COMPOUND_PARTS_RE, "").replace(KOREAN_PARTICLES_RE, "");
		return meaningful.length < 5;
	}

	const totalChars = tokens.reduce((sum, t) => sum + t.length, 0);
	return tokens.length < 2 || totalChars < 6;
}

/** (a) 최초 요구 원문, (b) 붙는 상위 구조, (c) 상위 구조 수용 방식을 모두 검사한다. */
function architectureFitProblems(plan) {
	const fit = plan?.architecture_fit;
	if (!fit || typeof fit !== "object" || Array.isArray(fit)) {
		return ["architecture_fit(최초 요구 원문·붙는 상위 구조·수용 방식) 없음"];
	}
	const p = [];
	if (!str(fit.original_request, 10) || isTemplatePlaceholder(fit.original_request)) {
		p.push("architecture_fit.original_request(최초 요구 원문, 최소 10자) 없음 또는 견본 문구 그대로임");
	}
	if (!str(fit.parent_structure, 8) || isTemplatePlaceholder(fit.parent_structure)) {
		p.push("architecture_fit.parent_structure(붙는 플랫폼·ADK·제품 상위 구조, 최소 8자) 없음 또는 견본 문구 그대로임");
	} else if (isNarrowServerOrFileOnly(fit.parent_structure, plan?.services)) {
		p.push("architecture_fit.parent_structure 가 특정 서버·서비스 키·단일 파일명만 가리킴(붙는 상위 플랫폼·ADK·제품 구조가 필요)");
	}
	if (!str(fit.acceptance_rationale, 10) || isTemplatePlaceholder(fit.acceptance_rationale)) {
		p.push("architecture_fit.acceptance_rationale(상위 구조 수용 방식·기존 확장/새 층·땜빵 아님 근거, 최소 10자) 없음 또는 견본 문구 그대로임");
	}
	return p;
}

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

// 상위 구조 적합(architecture_fit) 의무 기준 시각. 이 시각 앞선 옛 양식(version < 2) 계획서는 막지 않고 경고만 남긴다.
const ARCHITECTURE_FIT_CUTOFF = "2026-11-15T04:30:00Z";

function requiresArchitectureFit(plan) {
	if (!plan || typeof plan !== "object" || Array.isArray(plan)) return true;
	if (Number(plan.version) >= 2) return true;
	const at = Date.parse(plan.createdAt || "");
	if (!Number.isFinite(at)) return true;
	return at >= Date.parse(ARCHITECTURE_FIT_CUTOFF);
}

function formWarnings(plan) {
	if (!plan || typeof plan !== "object" || Array.isArray(plan) || requiresArchitectureFit(plan)) return [];
	const probs = architectureFitProblems(plan);
	if (!probs.length) return [];
	return probs.map((m) => `경고(기존 계획서 ${ARCHITECTURE_FIT_CUTOFF} 이전): ${m}`);
}

/** 양식 검사. 빈 칸마다 한 줄. */
function formProblems(plan) {
	const p = [];
	if (!plan || typeof plan !== "object") return ["계획서를 JSON 으로 읽지 못함"];
	if (plan.schema !== "deploy-plan/v1") p.push('schema 가 "deploy-plan/v1" 이 아님');
	if (!AUTHOR_MODELS.includes(plan.author_model)) p.push("author_model(sol|muse|argon|codex|claude) 필수");
	p.push(...riskAcceptanceProblems(plan));
	if (plan.approval_mode !== undefined && plan.approval_mode !== "preapprove_steps") p.push('approval_mode 는 "preapprove_steps" 만 쓸 수 있음');
	if (!str(plan.planId, 3)) p.push("planId(계획 이름) 없음");
	const at = Date.parse(plan.createdAt || "");
	if (!Number.isFinite(at)) p.push("createdAt(ISO 시각) 없음");
	if (!strList(plan.services)) p.push("services(운영 서비스 키 목록) 없음");
	if (!str(plan.what_why, 10)) p.push("what_why(무엇을 왜 배포하나) 없음");
	if (requiresArchitectureFit(plan)) p.push(...architectureFitProblems(plan));
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

const TEMPLATE = {
	schema: "deploy-plan/v1",
	version: 2,
	author_model: "<muse>",
	planId: "<짧은 이름, 예: app-web-20261016>",
	createdAt: "<ISO 시각>",
	services: ["<deploy-guard 가 알려 준 운영 서비스 키, 예: azure:containerapp:my-app-prod>"],
	what_why: "<무엇을 왜 배포하나 한두 줄>",
	architecture_fit: {
		original_request: "<누가 무엇을 바랐는지 최초 요구 원문 요지 (최소 10자)>",
		parent_structure: "<붙는 플랫폼·ADK 업스트림·제품 상위 구조, 예: naia-adk 승인 계획 게이트 및 공통 배포 계층>",
		acceptance_rationale: "<이 상위 구조가 기존 확장 또는 새 공통 층으로 이 변경을 받아들이는 이유, 일시 땜빵이 아닌 근거>",
	},
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

module.exports = {
	CRITERIA,
	BLOCKING_KINDS,
	ADVISORY_EXAMPLES,
	NARROW_WRAPPER_WORDS,
	KOREAN_PARTICLES_RE,
	COMMON_FILE_EXT_RE,
	NARROW_COMPOUND_PARTS_RE,
	isTemplatePlaceholder,
	isNarrowServerOrFileOnly,
	architectureFitProblems,
	RISK_ACCEPTANCE_MAX_DAYS,
	riskAcceptanceProblems,
	riskAcceptanceActive,
	ARCHITECTURE_FIT_CUTOFF,
	requiresArchitectureFit,
	formWarnings,
	formProblems,
	TEMPLATE,
};
