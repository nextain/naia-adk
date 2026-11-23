"use strict";
// Plan gate responsibility: evidence.
const path = require("path");
const fs = require("fs");
const { readJson, sha256, resolveRepoRoot, PLAN_FILE, INCIDENT_VERDICT_TTL_MS, str } = require("./deploy-plan-common.js");
const { reviewModelsFor } = require("./deploy-plan-review-policy.js");
const { planReadOnlyScriptsBinding } = require("./deploy-plan-readonly-binding.js");
const { reviewInputManifest } = require("./deploy-plan-review-input.js");
const { CRITERIA, formWarnings } = require("./deploy-plan-schema.js");
const { targetDeclarations } = require("./deploy-plan-targets.js");

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

/** 독립 장애 판정 기록. 판정자 세션은 실행 세션과 달라야 하며, 판정 모델·강도·manifest 가 지금 설정과 맞아야 한다. */
function incidentVerdict(gatesDir, sha, sessionId, now = Date.now(), root) {
	const base = root ? path.resolve(root) : resolveRepoRoot(gatesDir);
	let museCfg;
	try { museCfg = reviewModelsFor(base).muse; }
	catch (error) {
		return { ok: false, why: `review_models 설정을 읽지 못함: ${error.message}` };
	}
	if (!museCfg || (museCfg.runner && museCfg.runner !== "muse")) return { ok: false, why: "장애 판정자는 muse 실행기여야 함" };
	let currentManifest = null;
	try {
		const plan = readJson(path.join(gatesDir, PLAN_FILE));
		const roBind = plan ? planReadOnlyScriptsBinding(plan, base) : { ok: false, items: [] };
		if (roBind.ok) currentManifest = reviewInputManifest(path.join(gatesDir, PLAN_FILE), base, { readOnlyScripts: roBind.items });
	} catch { currentManifest = null; }
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
		if (judge.model !== museCfg.model || judge.effort !== museCfg.effort) { last = `판정 기록 ${f} 의 판정자 모델·강도(${judge.model || "없음"}/${judge.effort || "없음"})가 지금 설정(${museCfg.model}/${museCfg.effort})과 다름`; continue; }
		if (typeof r.input_manifest_sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(r.input_manifest_sha256) || !currentManifest || r.input_manifest_sha256.toLowerCase() !== currentManifest) { last = `판정 기록 ${f} 의 input_manifest_sha256 이 없거나 지금 설정·계획서와 다름`; continue; }
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

const CRITERIA_TEXT = Object.fromEntries(CRITERIA);

/** 승인 보고 양식 그대로, 짧게. */
function renderReport(plan, sha, review) {
	const L = [];
	L.push(`[운영 배포 승인 요청] ${plan.planId}  (계획서 sha ${sha})`);
	L.push(`무엇을 왜: ${plan.what_why}`);
	if (plan.architecture_fit && typeof plan.architecture_fit === "object") {
		L.push(`최초 요구: ${plan.architecture_fit.original_request || ""}`);
		L.push(`붙는 상위 구조: ${plan.architecture_fit.parent_structure || ""}`);
		L.push(`수용 방식: ${plan.architecture_fit.acceptance_rationale || ""}`);
	} else {
		for (const w of formWarnings(plan)) L.push(w);
	}
	L.push(`서비스: ${(plan.services || []).join(", ")}`);
	L.push("바뀌는 것:", ...(plan.changes || []).map((c) => `  - ${c}`));
	L.push("시나리오:");
	for (const s of plan.scenario || []) {
		L.push(`  ${s.id}${s.branch ? " (되돌리기 갈림길)" : ""}. ${s.title}`);
		for (const c of s.commands || []) L.push(`     명령 sha ${sha256(c).slice(0, 12)}: ${JSON.stringify(c)}`);
		for (const [p, h] of Object.entries(s.files || {})) L.push(`     고정 파일 ${p} sha ${String(h).slice(0, 12)}`);
		for (const pin of targetDeclarations(plan)) {
			const transition = pin?.transitions?.[s.id];
			if (!transition) continue;
			L.push(`     대상 ${pin.path} 시작 지문 ${pin[transition.to === "after" ? "before" : "after"]} → 완료 지문 ${pin[transition.to]}`);
		}
		L.push(`     성공 확인: ${s.success_check}`, `     실패 시: ${s.on_failure}`);
	}
	L.push(`위험: ${(plan.risks?.items || []).join(" / ")}`, `최악의 경우: ${plan.risks?.worst_case}`);
	L.push(`되돌릴 수 없는 것: ${(plan.irreversible || []).join(" / ")}`);
	L.push(`끊김 안전: ${plan.disconnect_safety}`);
	L.push(`재실행 안전: 잠금 ${plan.rerun_safety?.lock} / 실행 폴더 ${plan.rerun_safety?.run_dir} / 최근 폴더 자동 선택 ${plan.rerun_safety?.no_latest_pick}`);
	L.push(`성공 확인: ${plan.success_verification}`);
	L.push(`되돌리기: ${plan.rollback?.method} (소요 ${plan.rollback?.duration})`);
	L.push(`장애 판단 기준: ${(plan.incident?.criteria || []).join(" / ")}`);
	for (const a of plan.incident?.actions || []) L.push(`장애 시 선조치 ${a.id}: ${a.why_safe}`, ...(a.commands || []).map((c) => `     명령 sha ${sha256(c).slice(0, 12)}: ${JSON.stringify(c)}`));
	L.push("남은 위험(승인하면 책임지는 것):", ...(plan.residual_risks || []).map((r) => `  - ${r}`));
	if (review) L.push(`적대 리뷰: ${review.summary.map((s) => `${s.reviewer}/${s.id} ${s.verdict}`).join(", ")}; 남은 지적 0; 참고 지적 ${(review.reviewers || []).reduce((n, r) => n + (r.advisoryFindings || 0), 0)}건(차단 아님, ${(review.findings || ["gates/deploy-plan-review-findings.md"]).join(", ")})`);
	return L.join("\n");
}

module.exports = {
	stepSuccessProblem,
	stepSuccessSummary,
	incidentVerdict,
	reportPending,
	CRITERIA_TEXT,
	renderReport,
};
