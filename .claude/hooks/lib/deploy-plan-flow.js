"use strict";
// Plan gate responsibility: flow.
const path = require("path");
const { approvalScope, sameScope, matchesIssuedApproval, activeApproval, approvalExpiresAt } = require("./deploy-plan-approval-state.js");
const { sha256, DISCORD_FILE } = require("./deploy-plan-common.js");
const { humanConfirmed } = require("./deploy-plan-human-confirmation.js");
const { renderReport, reportPending, incidentVerdict, stepSuccessProblem, stepSuccessSummary } = require("./deploy-plan-evidence.js");

function stillReadOnly(request, entry, command, cwd) {
	if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return false;
	const { classifyProdMutations } = require("./deploy-command-classifier.js");
	const { assessReadiness } = require("./deploy-readiness.js");
	const hits = classifyProdMutations(command, cwd, 0, false, request.root);
	if (hits.some((hit) => hit.unclassified)) return false;
	const services = hits.length ? [...new Set(hits.map((hit) => hit.service))] : request.plan.services;
	const planBinding = { plan: request.plan, entry, command, cwd, gatesDir: path.dirname(request.file) };
	const result = assessReadiness(services, { root: request.root, command, cwd, planBinding });
	return result.ok && result.readOnlyNoCode === true;
}

// Historical bookkeeping only counts for the current scope. Recheck the human
// evidence for writes and the reviewed read-only exemption for each read.
async function stepCommandsComplete(state, request, step, evidence, current) {
	const scope = approvalScope(request, step);
	const missing = new Map(step.commands.map((command) => [sha256(command), command]));
	for (const row of state.challenges) {
		if (!sameScope(row, scope) || !Array.isArray(row.executed)) continue;
		const included = new Set(row.executed.filter((hash) => missing.has(hash)));
		if (!included.size) continue;
		if (row.readonly === true && row.code === null) {
			for (const hash of included) {
				if (stillReadOnly(request, step, missing.get(hash), row.cwd)) missing.delete(hash);
			}
		} else if (row === current || (matchesIssuedApproval(row, scope) && (await humanConfirmed(row, request.plan, evidence)).ok)) {
			for (const hash of included) missing.delete(hash);
		}
		if (!missing.size) return true;
	}
	return false;
}

async function approvalFlow({ ctx, state, now, h, f, rel, review, factLines, hostNote, verdictEarly, readOnlyNoCode = false }) {
	const request = { root: ctx.root, file: f.file, plan: f.plan, sha: f.sha, manifest: review.input_manifest_sha256, sessionId: ctx.sessionId };
	const ctxH = { transcriptPath: ctx.transcriptPath, sessionId: ctx.sessionId, gatesDir: f.gatesDir, repoRoot: ctx.root, approverId: ctx.approverId, fetchImpl: ctx.fetchImpl, discordToken: ctx.discordToken, messages: new Map() };

	// 전체 계획 승인 (검수 통과한 읽기 전용 고정 ops 대본은 사람 승인 코드 단계를 건너뜀)
	let planCh = null;
	let planOk = null;
	if (!readOnlyNoCode) {
		planCh = activeApproval(state, approvalScope(request), f.plan, now);
		planOk = await humanConfirmed(planCh, f.plan, ctxH);
		if (!planOk.ok) {
			return { allow: false, audit: { event: "plan-approval-requested", plan: rel, plan_sha256: f.sha }, reason: [
				"[Harness] 전체 계획 승인이 아직 없습니다. 아래 승인 보고 양식을 그대로 승인자에게 올리십시오(대화창 또는 디스코드).",
				"",
				renderReport(f.plan, f.sha, review),
				`승인 세션: ${ctx.sessionId} / 계획서: ${f.file}`,
				...factLines,
				"",
				`승인 코드: ${planCh.code}  — 승인자가 대화창에 직접 치거나, 디스코드에 본인 글로 남기면(글 위치를 gates/${DISCORD_FILE} 에 적음) 이 계획 전체가 승인됩니다. 승인은 책임 수용입니다.`,
				"승인 뒤에도 각 단계는 실행 직전에 단계 승인을 받습니다. AI 가 코드를 대신 입력하거나 파일·봇 글로 승인을 만들 수 없습니다.",
				...hostNote,
			].join("\n") };
		}
	}

	// 앞 장애 선조치 보고가 없으면 다음 선조치도 다음 단계도 못 한다.
	const pending = reportPending(state, f.sha, f.gatesDir);
	if (pending) {
		return { allow: false, audit: { event: "blocked-incident-report-pending", plan: rel }, reason: `[Harness] 장애 선조치(${pending.action}, ${pending.at}) 보고가 아직 없습니다. gates/deploy-incident-report-*.md 를 먼저 쓰고 승인자에게 보고하십시오.` };
	}

	// 장애 선조치: 계획 승인 + 독립 판정
	if (f.action) {
		const v = verdictEarly.ok ? verdictEarly : incidentVerdict(f.gatesDir, f.sha, ctx.sessionId, now, ctx.root);
		if (v.ok) {
			state.incidents.push({ planSha: f.sha, plan: rel, action: f.action.id, command_sha256: h, at: new Date(now).toISOString(), judge: v.judge });
			return { allow: true, expiresAt: approvalExpiresAt(planCh, f.plan), audit: { event: "incident-action-executed", plan: rel, plan_sha256: f.sha, action: f.action.id, judge: v.judge, verdict_file: v.file, approved_by: "plan-approval+independent-incident-verdict" }, notice: `장애 선조치 ${f.action.id} 실행. 실행 직후 gates/deploy-incident-report-*.md 로 보고(무슨 일·한 조치·지금 상태·다음 선택지)하십시오. 보고 전에는 다음 단계 승인을 받을 수 없습니다.` };
		}
		if (!f.step) return { allow: false, audit: { event: "blocked-incident-unverified", plan: rel, why: v.why }, reason: ["[Harness] 장애 선조치 명령이지만 독립 장애 판정이 없습니다.", `- ${v.why}`, "", "실행 세션이 스스로 장애라고 판단할 수 없습니다. node .agents/scripts/approval-plan.mjs judge <계획서> --evidence <확인 결과·헬스·오류 로그> 로 다른 세션 판정을 받으십시오. 개발로 판정되면 멈추고 보고하십시오."].join("\n") };
	}

	// 단계 실행
	const steps = f.plan.scenario;
	const idx = steps.indexOf(f.step);
	const scope = approvalScope(request, f.step);
	const commandSha = sha256(ctx.command);
	if (f.step.branch !== "rollback") {
		for (const prev of steps.slice(0, idx).filter((s) => s.branch !== "rollback")) {
			if (!await stepCommandsComplete(state, request, prev, ctxH)) {
				const why = `${prev.id} 단계가 실제 실행(executed)되지 않음`;
				return { allow: false, audit: { event: "blocked-step-order", plan: rel, step: f.step.id, why }, reason: ["[Harness] 앞 단계가 실제 실행(executed)되지 않아 다음 단계로 넘어갈 수 없습니다.", `- ${why}`, "", `앞 단계(${prev.id}) 명령을 계획서에 적힌 글자 그대로 먼저 실행하고(단계 승인을 거쳐야 실행 기록이 남습니다) 성공 확인(step-ok) 증거를 남기십시오.`, "글자를 덧붙여 돌린 실행이나 step-ok 기록만으로는 실행한 것으로 치지 않습니다."].join("\n") };
			}
			const bad = stepSuccessProblem(f.gatesDir, f.sha, prev.id);
			if (bad) return { allow: false, audit: { event: "blocked-step-order", plan: rel, step: f.step.id, why: bad }, reason: ["[Harness] 앞 단계 성공 확인 전에는 다음 단계 승인을 요청할 수 없습니다.", `- ${bad}`, "", "앞 단계의 성공 확인을 실행해 증거를 남기십시오: node .agents/scripts/approval-plan.mjs step-ok <계획서> <단계> --evidence <확인 출력 파일>. 확인이 실패했으면 계획의 실패 갈림길대로 하고 보고하십시오."].join("\n") };
		}
	}

	if (readOnlyNoCode) {
		const isoNow = new Date(now).toISOString();
		const cwd = ctx.cwd || ctx.root;
		let roCh = state.challenges.find((row) => sameScope(row, scope) && row.readonly === true && row.code === null && row.cwd === cwd && Array.isArray(row.executed));
		if (!roCh) {
			roCh = { ...scope, readonly: true, code: null, cwd, createdAt: isoNow, approvedAt: isoNow, approvedVia: "readonly-no-code", status: "executed", executed: [], closed: isoNow };
			state.challenges.push(roCh);
		}
		if (!roCh.executed.includes(commandSha)) roCh.executed.push(commandSha);
		roCh.executedAt = isoNow;
		return { allow: true, audit: { event: "executed", plan: rel, plan_sha256: f.sha, step: f.step.id, approved_by: "readonly-no-code", readonly: true } };
	}

	const stepCh = activeApproval(state, scope, f.plan, now, { commandSha });
	// 단계 승인은 상태 파일에 적힌 approvedAt 을 믿지 않고 실행할 때마다 사람 입력(대화 기록·디스코드)을 다시 확인한다.
	{
		const ok = await humanConfirmed(stepCh, f.plan, ctxH);
		if (!ok.ok) {
			const prev = steps.slice(0, idx).filter((s) => s.branch !== "rollback").pop();
			const prevOut = prev ? stepSuccessSummary(f.gatesDir, prev.id) : null;
			return { allow: false, audit: { event: "step-approval-requested", plan: rel, step: f.step.id }, reason: [
				`[Harness] 단계 승인 필요: ${f.plan.planId} / ${f.step.id}${f.step.branch ? " (되돌리기 갈림길)" : ""}. ${f.step.title}`,
				`승인 세션: ${ctx.sessionId} / 계획서: ${f.file} / sha ${f.sha}`,
				...(prev ? [`앞 단계 ${prev.id} 성공 확인:`, ...(prevOut ? prevOut.split("\n").map((l) => `  ${l}`) : ["  (증거 요약 없음)"])] : []),
				"이 단계 명령:",
				...f.step.commands.map((c) => `  sha ${sha256(c).slice(0, 12)}: ${JSON.stringify(c)}`),
				`성공 확인: ${f.step.success_check}`,
				`실패 시: ${f.step.on_failure}`,
				"",
				...factLines,
				"",
				`단계 승인 코드: ${stepCh.code}  — 승인자가 대화창에 치거나 디스코드 본인 글로 남기면 이 단계 명령이 각각 한 번 통과합니다.`,
				...hostNote,
			].join("\n") };
		}
		stepCh.approvedAt = ok.at;
		stepCh.approvedVia = ok.via;
	}
	stepCh.executed.push(commandSha);
	if (await stepCommandsComplete(state, request, f.step, ctxH, stepCh)) {
		stepCh.status = "executed";
		stepCh.executedAt = new Date(now).toISOString();
	}
	const expiresAt = Math.min(approvalExpiresAt(planCh, f.plan), approvalExpiresAt(stepCh, f.plan));
	return { allow: true, expiresAt, audit: { event: "executed", plan: rel, plan_sha256: f.sha, step: f.step.id, plan_code_sha256_12: sha256(planCh.code).slice(0, 12), step_code_sha256_12: sha256(stepCh.code).slice(0, 12), approved_by: `plan(${planOk.via})+step(${stepCh.approvedVia})` } };
}

module.exports = {
	stillReadOnly,
	stepCommandsComplete,
	approvalFlow,
};
