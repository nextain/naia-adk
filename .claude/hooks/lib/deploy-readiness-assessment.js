// Existing readiness assessment responsibility; behavior is owned by the public facade.
const fs = require("fs");
const path = require("path");
const { sameCommit, readJson, resolveIn } = require("./deploy-readiness-io.js");
const { innerScripts, opsProblem } = require("./deploy-readiness-ops.js");
const { loadDeployGateConfig, matchServiceRule } = require("./deploy-readiness-policy.js");
const { KINDS, findReadiness, defectFact, openCriticalDefects, defectVersions, git, checkCodeGate, checkTestGate, lastExecutedFor, executedBefore, commandBinding } = require("./deploy-readiness-evidence.js");
const { verifiedPlanBinding } = require("./deploy-readiness-plan-binding.js");

/**
 * @returns {{ok:boolean, problems:string[], facts:string[], file?:string, kind?:string}}
 */
function assessReadinessWithBinding(services, { root, auditPath, command = "", cwd = "", now = Date.now(), planBinding = null } = {}, bindingValidator) {
	const baseRoot = root || process.env.DEPLOY_READINESS_ROOT || cwd || path.resolve(__dirname, "../../..");
	if (!Array.isArray(services) || services.length === 0) {
		return { ok: false, problems: ["운영 서비스 집합이 비어 있습니다."], facts: [] };
	}

	const cfg = loadDeployGateConfig(baseRoot);
	if (cfg) {
		const { validateReadOnlyScriptsConfig } = require("./deploy-plan.js");
		const roCfg = validateReadOnlyScriptsConfig(cfg);
		if (!roCfg.ok) return { ok: false, problems: [roCfg.why], facts: [] };
	}
	const found = findReadiness(services, baseRoot, now);

	if (!found) {
		if (!cfg) {
			return {
				ok: false,
				problems: [`알 수 없는 운영 명령은 막음: config/deploy-gate.json 설정 파일이 없습니다 (${services.join(", ")})`],
				facts: [],
			};
		}
		const rules = services.map((s) => matchServiceRule(s, cfg));
		const requiresReadiness = cfg.requireReadiness === true || rules.some((r) => r && r.requireReadiness === true);
		if (requiresReadiness || !planBinding) {
			return {
				ok: false,
				problems: [`배포 준비 기록이 없음: .agents/progress/<작업>/gates/deploy.json (12시간 안에 작성, services 에 다음 키를 그대로 적을 것)\n${services.map((s) => `  ${JSON.stringify(s)}`).join("\n")}`],
				facts: [],
			};
		}
		const planned = bindingValidator(planBinding, "", "plan", services, baseRoot);
		if (!planned.ok) return { ok: false, problems: [planned.why], facts: [] };
		return { ok: true, problems: [], facts: [planned.fact], kind: "plan" };
	}

	const rec = found.record;
	const problems = [];
	const facts = [];
	const rel = path.relative(baseRoot, found.file);
	if (!KINDS.has(rec.kind)) problems.push(`kind 는 feature, ops, rollback 가운데 하나여야 함(지금: ${rec.kind})`);
	const candidate = typeof rec.candidate === "string" ? rec.candidate.trim() : "";
	const planned = bindingValidator(planBinding, candidate, rec.kind, services, baseRoot);
	if (planned && !planned.ok) problems.push(planned.why);
	if (rec.kind !== "ops" && candidate.length < 7) problems.push("candidate(올릴 커밋 또는 이미지 태그)가 없음");

	if (rec.kind === "ops") {
		facts.push("시험 증거 없음 — 기능 공개가 아닌 운영 작업으로 신고됨");
		facts.push(`실제로 도는 명령: ${String(command).replace(/\s+/g, " ").slice(0, 1500)}`);
		if (!rec.reason || String(rec.reason).trim().length < 5) problems.push("ops 에는 reason(무엇을 왜 하는지 한 줄)이 필요함");
		else facts.push(`신고 사유: ${String(rec.reason).trim().slice(0, 200)}`);
	}

	if (rec.kind === "rollback" && candidate && !executedBefore(candidate, auditPath)) {
		let evidence = null;
		if (typeof rec.rollbackEvidence === "string" && rec.rollbackEvidence) {
			try {
				evidence = fs.readFileSync(resolveIn(baseRoot, rec.rollbackEvidence), "utf8");
			} catch {}
		}
		if (!evidence || !evidence.includes(candidate)) problems.push(`rollback 후보 ${candidate} 가 전에 운영에 올라간 증거가 없음(감사 기록이나 rollbackEvidence 파일, 예: az containerapp revision list 출력). 새 판이면 feature 로 신고해야 함`);
	}

	if (rec.kind === "ops") {
		if (planned?.ok && planned.readOnlyNoCode) {
			facts.push(planned.fact);
			const bad = opsProblem(command, { readOnlyTarget: planned.readOnlyTarget });
			if (bad) problems.push(bad);
			if (services.some((sv) => sv.startsWith("script:") || sv.startsWith("package:"))) problems.push("배포 스크립트는 코드를 올리므로 ops 로 신고할 수 없음");
		} else if (planned?.ok && planned.ops) {
			facts.push(planned.fact);
		} else {
			const opsCommand = planned?.opsCommand || command;
			const bad = opsProblem(opsCommand);
			if (bad) problems.push(bad);
			else if (innerScripts(opsCommand).length) facts.push("주의: VM·컨테이너 안에서 명령이 돈다. 위 실제 명령이 조회·진단·재시작뿐인지 확인할 것");
			if (services.some((sv) => sv.startsWith("script:") || sv.startsWith("package:"))) problems.push("배포 스크립트는 코드를 올리므로 ops 로 신고할 수 없음");
		}
	}
	if (KINDS.has(rec.kind) && rec.kind !== "ops" && candidate.length >= 7) {
		const bound = planBinding ? planned : commandBinding(command, candidate, services, cwd || baseRoot);
		if (!bound.ok) {
			if (!problems.includes(bound.why)) problems.push(bound.why);
		} else facts.push(bound.fact);
	}

	if (rec.kind === "feature" && candidate) {
		const receipts = Array.isArray(rec.et) ? rec.et : [];
		if (receipts.length === 0) problems.push("feature 에는 ET 영수증 경로(et)가 필요함");
		for (const p of receipts) {
			const f = resolveIn(baseRoot, p);
			let body = null;
			try {
				body = fs.readFileSync(f, "utf8");
			} catch {}
			if (body === null) {
				problems.push(`ET 영수증 파일이 없음: ${p}`);
				continue;
			}
			let et = null;
			try {
				et = JSON.parse(body);
			} catch {}
			const scenarios = et && Array.isArray(et.scenarios) ? et.scenarios : [];
			if (!et || et.kind !== "et") problems.push(`ET 영수증이 {"kind":"et","candidate":…,"scenarios":[{"id","verdict"}]} 모양의 JSON 이 아님: ${p}`);
			else if (!sameCommit(String(et.candidate || ""), candidate) && et.candidate !== candidate) problems.push(`ET 영수증의 candidate 가 후보 ${candidate} 와 다름: ${p}`);
			else if (scenarios.length === 0 || scenarios.some((sc) => !sc || typeof sc.id !== "string" || typeof sc.verdict !== "string")) problems.push(`ET 영수증에 시나리오(id, verdict)가 없거나 모양이 틀림: ${p}`);
			else {
				const failed = scenarios.filter((sc) => sc.verdict !== "pass");
				if (failed.length) problems.push(`ET 영수증에 통과 못 한 시나리오 ${failed.length}건(${failed.slice(0, 5).map((sc) => `${sc.id}=${sc.verdict}`).join(", ")}): ${p}. 결함을 고치거나 되돌리기·숨김을 먼저 할 것`);
				facts.push(`ET 영수증 ${p}: 시나리오 ${scenarios.length}건, 통과 ${scenarios.length - failed.length}건 (${scenarios.slice(0, 20).map((sc) => sc.id).join(", ")}${scenarios.length > 20 ? " …" : ""})`);
			}
		}
		if (!rec.testGate) problems.push("feature 에는 시험 검수 기록(testGate: gates/test.json 경로, ET 를 돌리지 않은 창이 통과시킨 것)이 필요함");
		else problems.push(...checkTestGate(resolveIn(baseRoot, rec.testGate), candidate));
		if (!rec.codeGate) problems.push("feature 에는 코드 검수 기록(codeGate: gates/code.json 경로)이 필요함");
		else {
			const cg = checkCodeGate(resolveIn(baseRoot, rec.codeGate), candidate, now);
			problems.push(...cg.problems);
			if (cg.reviewer) facts.push(`코드 검수자: ${cg.reviewer}`);
			if (cg.lintSummary) {
				const by = cg.lintSummary.byClass && typeof cg.lintSummary.byClass === "object" ? Object.entries(cg.lintSummary.byClass).map(([k, v]) => `${k} ${v}`).join(", ") : "";
				facts.push(`화면 문구 검사: 발견 ${cg.lintSummary.findings ?? "?"}건${by ? ` (${by})` : ""}. 발견마다 코드 검수 기록에 처리가 적혀 있어야 함`);
			}
		}
		if (rec.uiGate) {
			const ug = readJson(resolveIn(baseRoot, rec.uiGate));
			if (!ug || ug.stage !== "ui" || ug.verdict !== "pass") problems.push(`화면 검수 기록(uiGate)이 stage ui, verdict pass 가 아님: ${rec.uiGate}`);
			else facts.push(`화면 검수: 통과 (${rec.uiGate})`);
		} else facts.push("화면 검수 기록(uiGate) 없음 — 사용자 편의·상위기획 의도·내부 문구 판정을 받지 않은 배포");
		for (const s of services) {
			const open = openCriticalDefects(s, baseRoot);
			facts.push(defectFact(s, baseRoot, open));
			if (open.length) problems.push(`${s} 에 열린 치명 결함 ${open.length}건(${open.map((d) => d.id).join(", ")}). 기능 배포 전에 되돌리기(kind rollback)나 메뉴 숨김(kind ops)으로 먼저 막을 것`);
		}
	}

	if (rec.kind !== "feature") {
		for (const s of services) {
			const open = openCriticalDefects(s, baseRoot);
			facts.push(defectFact(s, baseRoot, open));
			if (rec.kind === "rollback" && candidate) {
				const hit = open.filter((d) => defectVersions(d).some((v) => v === candidate || sameCommit(v, candidate) || (v.length >= 7 && (v.includes(candidate) || candidate.includes(v)))));
				if (hit.length) problems.push(`rollback 후보 ${candidate} 에 열린 치명 결함이 있음(${hit.map((d) => d.id).join(", ")}). 결함 없는 판으로 되돌리거나 메뉴 숨김(kind ops)으로 먼저 막을 것`);
			}
		}
	}

	facts.unshift(`배포 종류: ${rec.kind}${candidate ? `, 후보 ${candidate}` : ""}${rec.currentProd ? `, 지금 운영 ${rec.currentProd}` : ""} (기록 ${rel})`);
	if (rec.currentProd) {
		for (const sv of services) {
			const last = lastExecutedFor(sv, auditPath);
			if (!last) facts.push(`${sv}: 지금 운영 ${rec.currentProd} 확인 안 됨(감사 기록에 이 서비스 배포가 없음). 직접 확인할 것`);
			else if (!String(last.command || "").includes(rec.currentProd)) facts.push(`${sv}: 지금 운영 ${rec.currentProd} 확인 안 됨. 감사 기록의 마지막 배포(${last.ts || "?"})는 다른 판: ${String(last.command || "").slice(0, 200)}`);
			else facts.push(`${sv}: 지금 운영 ${rec.currentProd} 는 감사 기록의 마지막 배포와 같음`);
		}
	}
	if (!rec.repo && rec.kind !== "ops") facts.push("변경 목록 없음(repo 가 기록에 없음). 무엇이 함께 올라가는지 계산하지 못했음");
	if (rec.repo && candidate) {
		const repo = resolveIn(baseRoot, rec.repo);
		try {
			const inMain = (() => {
				for (const m of ["origin/main", "main"]) {
					try {
						git(repo, ["merge-base", "--is-ancestor", candidate, m]);
						return m;
					} catch {}
				}
				return null;
			})();
			facts.push(inMain ? `후보는 ${inMain} 에 들어 있음` : "후보가 main 에 없음(가지에서 바로 올림)");
			if (rec.currentProd) {
				const stat = git(repo, ["diff", "--stat=100", `${rec.currentProd}`, candidate]).trim().split("\n");
				facts.push(`지금 운영 → 후보 변경 파일(${stat.length - 1}개):`);
				facts.push(...stat.slice(0, 40).map((l) => `  ${l}`));
				if (stat.length > 40) facts.push(`  … ${stat.length - 40}줄 더`);
			} else facts.push("currentProd 가 없어 변경 목록을 계산하지 못함");
		} catch (e) {
			facts.push(`변경 목록 계산 실패: ${String(e.message || e).split("\n")[0]}`);
		}
	}
	const readOnlyNoCode = problems.length === 0 && rec.kind === "ops" && !!(planned && planned.ok && planned.readOnlyNoCode === true);
	return { ok: problems.length === 0, problems, facts, file: found.file, kind: rec.kind, ...(readOnlyNoCode ? { readOnlyNoCode: true } : {}) };
}

function assessReadiness(services, options = {}) {
	return assessReadinessWithBinding(services, options, verifiedPlanBinding);
}

module.exports = { assessReadiness, assessReadinessWithBinding };
