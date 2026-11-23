"use strict";
// Plan gate responsibility: admission.
const path = require("path");
const { commandHash } = require("./deploy-human-approval.js");
const fs = require("fs");
const { resolveRepoRoot, readPlanSnapshot, ROOT, sha256 } = require("./deploy-plan-common.js");
const { knownApprovalSession, withStateLock, loadState, activeApproval, approvalScope, saveState } = require("./deploy-plan-approval-state.js");
const { formProblems, CRITERIA, formWarnings } = require("./deploy-plan-schema.js");
const { reviewProblems } = require("./deploy-plan-review-results.js");
const { registeredReviewProfiles, gateConfigView: gateConfigContext } = require("./deploy-plan-context.js");
const { renderReport, incidentVerdict } = require("./deploy-plan-evidence.js");
const { plansForCommand, plansCarryingCommand, referencedFiles } = require("./deploy-plan-commands.js");
const { verifyTargetPreconditions } = require("./deploy-plan-targets.js");
const { approvalFlow } = require("./deploy-plan-flow.js");

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
	if (!knownApprovalSession(sessionId)) return { ok: false, why: "승인 세션 ID가 필요합니다" };
	const snapshot = readPlanSnapshot(abs);
	if (!snapshot) return { ok: false, why: "계획서를 읽지 못함" };
	const { plan, sha } = snapshot;
	const form = formProblems(plan);
	if (form.length) return { ok: false, why: "양식: " + form[0] };
	if (plan.approval_mode !== "preapprove_steps") return { ok: false, why: 'approval_mode "preapprove_steps" 없음' };
	const review = reviewProblems(gatesDir, sha, base);
	if (!review.ok) return { ok: false, why: "리뷰: " + review.problems[0] };
	const manifest = review.input_manifest_sha256;
	const made = await withStateLock(env, () => {
		if (readPlanSnapshot(abs)?.sha !== sha) return { ok: false, why: "발급 중 계획서가 변경되었습니다" };
		if (registeredReviewProfiles(base).length) {
			const current = reviewProblems(gatesDir, sha, base);
			if (!current.ok || current.input_manifest_sha256 !== manifest) return { ok: false, why: "Registered gate review changed while issuing approval codes" };
		}
		const state = loadState(env);
		const request = { root: base, file: abs, plan, sha, manifest, sessionId };
		const planCh = activeApproval(state, approvalScope(request), plan, now);
		const steps = plan.scenario.map((step) => {
			const row = activeApproval(state, approvalScope(request, step), plan, now, { preapproveCommands: step.commands });
			return { step: step.id, code: row.code };
		});
		saveState(env, state);
		return { ok: true, plan: planCh.plan, plan_sha256: sha, plan_code: planCh.code, steps, input_manifest_sha256: manifest, review, report: renderReport(plan, sha, review) };
	});
	return made || { ok: false, why: "상태 잠금 실패" };
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
		// 계획서 단계 명령에 글자를 덧붙인 꼴은 "계획 밖"이 아니라 글자 불일치로 알린다(같은 단계를 글자 그대로 다시 내면 된다).
		let carried = [];
		try { carried = plansCarryingCommand(ctx.command, ctx.root, ctx.cwd || ctx.root, now); } catch {}
		if (carried.length) {
			const c = carried[0];
			const where = c.step ? `단계 ${c.step.id}` : `장애 선조치 ${c.action.id}`;
			return { allow: false, audit: { event: "blocked-command-byte-mismatch", plan: path.relative(ctx.root, c.file), ...(c.step ? { step: c.step.id } : { action: c.action.id }), command_sha256: h, decorated: true }, reason: [
				"[Harness] 계획서 단계 명령에 다른 글자가 붙어 있어 막습니다.",
				`계획서: ${path.relative(ctx.root, c.file)} / ${where}`,
				"계획서 commands 에 적힌 문자열과 바이트 단위로 똑같이 실행하십시오:",
				`  ${c.carried}`,
				"앞뒤에 cd … &&, 2>&1, | tail, > 파일, timeout 을 붙이거나 bash -c 로 감싸면 승인된 명령이 아닙니다. 단계 승인과 실행 기록(executed)이 남지 않아 다음 단계도 막힙니다.",
			].join("\n") };
		}
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
	const fileBase = ctx.root || ctx.cwd || ROOT;
	const { canonicalTargetPath } = require("./deploy-readiness.js");
	const pinned = new Map();
	const pinnedCanonical = new Map();
	let targets;
	try { targets = verifyTargetPreconditions(f.plan, fileBase, entry); } catch (e) {
		return { allow: false, audit: { event: "blocked-plan-file-unpinned", plan: rel }, reason: `대상 파일 검사 실패: ${e.message}` };
	}
	for (const [p, h] of Object.entries(entry.files || {})) {
		const abs = path.resolve(fileBase, p);
		const low = String(h).toLowerCase();
		pinned.set(abs, low);
		pinnedCanonical.set(canonicalTargetPath(abs, fileBase), low);
	}
	const refs = typeof ctx.fileRefs === "function" ? ctx.fileRefs() : referencedFiles(ctx.command, ctx.cwd || ctx.root);
	const unpinned = refs.filter((r) => {
		const abs = path.resolve(r.path);
		const can = canonicalTargetPath(abs, ctx.cwd || fileBase);
		if (targets.has(can)) return abs !== can || pinned.get(abs) !== r.sha;
		return pinned.get(abs) !== r.sha && pinnedCanonical.get(can) !== r.sha;
	});
	// 글자에 나타나지 않는 도움 파일도 전부 실물과 대조한다. 같은 해시의 다른 경로는 대신할 수 없다.
	for (const [p, h] of pinned) {
		let actual = null;
		try { actual = sha256(fs.readFileSync(p)); } catch {}
		const pCan = canonicalTargetPath(p, fileBase);
		if (actual !== h && !unpinned.some((r) => path.resolve(r.path) === p || canonicalTargetPath(r.path, ctx.cwd || fileBase) === pCan)) {
			unpinned.push({ path: p, sha: actual || "읽기 실패" });
		}
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
	const verdictEarly = f.action ? incidentVerdict(f.gatesDir, f.sha, ctx.sessionId, now, ctx.root) : { ok: false };
	let facts = [];
	let readOnlyNoCode = false;
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
		readOnlyNoCode = !!(r && r.readOnlyNoCode === true) && ![...targets.keys()].some(file => pinned.has(file))
			&& !gateConfigContext.getStore()?.profiles?.some(profile => profile.strictDefaults);
	}
	const factLines = facts.length ? ["", "배포 준비 기록에서 확인한 사실:", ...facts.map((x) => `  ${x}`)] : [];
	const hostNote = ctx.transcriptPath ? [] : ["", "이 호스트는 대화 기록을 읽을 수 없어 대화창 승인을 확인할 수 없습니다. 디스코드 승인 경로(gates/deploy-approval-discord.json)를 쓰십시오. 승인자에게 붙여 넣을 명령을 넘기지 마십시오."];
	if (!knownApprovalSession(ctx.sessionId)) return { allow: false, audit: { event: "blocked-approval-session", plan: rel }, reason: "[Harness] 승인 요청을 이 실행에 연결할 세션 ID가 필요합니다." };

	const warnings = formWarnings(f.plan);
	const locked = await withStateLock(env, async () => {
		const state = loadState(env);
		const { expiresAt, ...decision } = await approvalFlow({ ctx, state, now, h, f, rel, review, factLines, hostNote, verdictEarly, readOnlyNoCode });
		if (readPlanSnapshot(f.file)?.sha !== f.sha) return { allow: false, audit: { event: "blocked-plan-changed", plan: rel }, reason: "[Harness] 승인 확인 중 계획서가 변경되었습니다. 현재 계획서로 다시 요청하십시오." };
		if (decision.allow) {
			// Discord and prior-step checks can take time. Commit the dispatch only
			// while the reviewed inputs and the human authorizations are still valid.
			const checked = reviewProblems(f.gatesDir, f.sha, ctx.root);
			if (!checked.ok || checked.input_manifest_sha256 !== review.input_manifest_sha256) return { allow: false, audit: { event: "blocked-plan-review", plan: rel }, reason: "[Harness] 승인 확인 중 검수 입력이 변경되었습니다. 현재 계획서를 다시 검수하십시오." };
			if (readOnlyNoCode) {
				const ready = ctx.readiness({ plan: f.plan, entry, command: ctx.command, cwd: ctx.cwd || ctx.root, gatesDir: f.gatesDir });
				if (!ready?.ok || ready.readOnlyNoCode !== true) return { allow: false, audit: { event: "blocked-not-ready", plan: rel }, reason: "[Harness] 읽기 전용 대본의 승인 예외를 다시 확인할 수 없습니다." };
			}
			if (f.plan.file_pins !== undefined) {
				try {
					verifyTargetPreconditions(f.plan, fileBase, entry);
					if (decision.audit.event === "incident-action-executed" && f.action !== entry) {
						verifyTargetPreconditions(f.plan, fileBase, f.action);
					}
				} catch (error) {
					return { allow: false, audit: { event: "blocked-plan-file-unpinned", plan: rel }, reason: error.message };
				}
			}
			if (expiresAt !== undefined && (ctx.now ?? Date.now()) >= expiresAt) return { allow: false, audit: { event: "blocked-approval-expired", plan: rel }, reason: "[Harness] 승인 확인 중 코드가 만료되었습니다. 새 코드로 다시 승인받으십시오." };
		}
		saveState(env, state);
		return decision;
	});
	if (locked) {
		if (warnings.length) {
			locked.audit = { ...(locked.audit || {}), warnings };
			if (locked.allow) locked.notice = [locked.notice, ...warnings].filter(Boolean).join("\n");
		}
		return locked;
	}
	return { allow: false, audit: { event: "blocked-state-lock", plan: rel }, reason: "[Harness] 승인 상태 파일 잠금을 잡지 못해 막습니다(다른 운영 명령 판정이 진행 중). 잠시 뒤 다시 실행하십시오." };
}

module.exports = {
	preapproveStepCodes,
	evaluate,
};
