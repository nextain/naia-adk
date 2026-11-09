require("../../../scripts/test-signal-safety.cjs");
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const HOOK_PATH = path.join(REPO_ROOT, ".claude/hooks/deploy-guard.js");
const deployPlan = require("../lib/deploy-plan.js");

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function makeWorkspace(t) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-source-cov-test-"));
	t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
	const root = path.join(tmp, "workspace");
	const stateDir = path.join(tmp, "state");
	const transcriptPath = path.join(tmp, "transcript.jsonl");
	fs.mkdirSync(path.join(root, ".git"), { recursive: true });
	fs.mkdirSync(stateDir, { recursive: true });
	fs.writeFileSync(transcriptPath, "");

	for (const rel of deployPlan.REVIEW_EXECUTOR_FILES) {
		const src = path.join(REPO_ROOT, rel);
		const dst = path.join(root, rel);
		fs.mkdirSync(path.dirname(dst), { recursive: true });
		fs.copyFileSync(src, dst);
	}
	return { tmp, root, stateDir, transcriptPath };
}

function writeGateConfig(root) {
	const cfgPath = path.join(root, "config", "deploy-gate.json");
	fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
	const cfg = {
		schema: "deploy-gate/v1",
		services: {
			"azure:containerapp:sample-web-prod": {
				label: "샘플 웹 운영 앱",
				requireDeployGate: false,
				allowOps: true,
				allowRollback: true,
				commandMustContain: ["sample-web-prod"],
			},
		},
	};
	fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
	return cfgPath;
}

function createW004SourceDoc(root) {
	const docRel = "docs/work/W-004-rollout.md";
	const docAbs = path.join(root, docRel);
	fs.mkdirSync(path.dirname(docAbs), { recursive: true });
	const content = [
		"# W-004 운영 반영 작업 정본",
		"",
		"## 운영 반영 단계",
		"(1) 사전 백업 및 리비전 상태 기록",
		"(2) DB 스키마 변경 반영",
		"(3) 결제 모듈 컨테이너 이미지 빌드 및 태그 고정",
		"(4) 운영 컨테이너 앱 새 리비전 배포",
		"(5) 헬스 엔드포인트 및 기본 화면 확인",
		"(6) 시험 키 설정 주입",
		"",
		"## 사후 확인",
		"- [ ] 결제 3단계 화면에 시험 결제창이 뜸",
		"",
	].join("\n");
	fs.writeFileSync(docAbs, content);
	const docSha = sha256(fs.readFileSync(docAbs));
	const steps = [
		{ id: "1", text: "사전 백업 및 리비전 상태 기록" },
		{ id: "2", text: "DB 스키마 변경 반영" },
		{ id: "3", text: "결제 모듈 컨테이너 이미지 빌드 및 태그 고정" },
		{ id: "4", text: "운영 컨테이너 앱 새 리비전 배포" },
		{ id: "5", text: "헬스 엔드포인트 및 기본 화면 확인" },
		{ id: "6", text: "시험 키 설정 주입" },
	];
	const acceptance = [
		{ id: "1", text: "결제 3단계 화면에 시험 결제창이 뜸" },
	];
	return { docRel, docAbs, docSha, steps, acceptance };
}

function createPlanWithSourceDocs(root, overrides = {}) {
	const gatesDir = path.join(root, ".agents", "progress", "w025-deploy", "gates");
	fs.mkdirSync(gatesDir, { recursive: true });
	const scriptRel = "scripts/rollout.sh";
	const scriptAbs = path.join(root, scriptRel);
	fs.mkdirSync(path.dirname(scriptAbs), { recursive: true });
	if (!fs.existsSync(scriptAbs)) {
		fs.writeFileSync(scriptAbs, "#!/usr/bin/env bash\naz containerapp update -n sample-web-prod -g sample-rg --image sample/web:v1\n");
	}
	const scriptSha = sha256(fs.readFileSync(scriptAbs));
	const step1Cmd = `bash ${scriptRel} prod`;
	const rollbackCmd = "az containerapp revision activate -n sample-web-prod -g sample-rg --revision sample-web-prod--prev";

	const plan = {
		schema: "deploy-plan/v1",
		author_model: "muse",
		approval_mode: "preapprove_steps",
		planId: "w025-morning-rollout",
		createdAt: new Date().toISOString(),
		services: ["azure:containerapp:sample-web-prod"],
		what_why: "정본 W-004 절차를 따라 샘플 웹 서비스를 운영 반영합니다.",
		changes: ["컨테이너 이미지 sample/web:v1 및 시험 키 설정 반영"],
		scenario: [
			{
				id: "s1",
				title: "운영 반영 실행",
				covers: ["1", "2", "3", "4", "5", "6"],
				commands: [step1Cmd],
				files: { [scriptRel]: scriptSha },
				success_check: "헬스체크 200 및 결제 3단계 시험 결제창 확인",
				on_failure: "r1 단계로 이전 리비전을 즉시 활성화하고 보고",
			},
			{
				id: "r1",
				branch: "rollback",
				title: "이전 리비전으로 복귀",
				commands: [rollbackCmd],
				success_check: "이전 리비전 트래픽 100% 및 헬스 200 확인",
				on_failure: "트래픽 차단 후 즉시 운영팀에 보고",
			},
		],
		risks: {
			items: ["신규 리비전 기동 지연 가능성"],
			worst_case: "신규 리비전 응답 실패로 최대 2분간 오류 발생",
		},
		irreversible: ["없음: 컨테이너 이미지 및 환경 변수만 변경"],
		disconnect_safety: "터미널이 끊겨도 az containerapp revision list 로 상태를 확인하고 r1 명령으로 수동 복귀 가능",
		rerun_safety: {
			lock: "동일 리비전 이름 고정으로 중복 실행 방지",
			run_dir: ".agents/progress/w025-deploy 고유 폴더 사용",
			no_latest_pick: "명시적 이미지 태그 sample/web:v1 지정",
		},
		success_verification: "결제 3단계 화면에 시험 결제창이 뜨는지 실측 확인",
		rollback: {
			method: "r1 단계의 az containerapp revision activate 명령으로 이전 리비전 복귀",
			duration: "1분",
			step_ids: ["r1"],
		},
		residual_risks: ["전환 순간 열린 연결 일부 재시도 발생 가능"],
		incident: {
			criteria: ["5xx 응답 비율 5% 초과 또는 헬스체크 3회 연속 실패"],
			actions: [],
		},
		...overrides,
	};

	const planFile = path.join(gatesDir, "deploy-plan.json");
	fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
	return { planFile, gatesDir, plan, scriptRel, scriptAbs, step1Cmd, rollbackCmd };
}

function writePassingReviewReceipt(root, planFile) {
	const gatesDir = path.dirname(planFile);
	const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
	const planSha = sha256(fs.readFileSync(planFile));
	const prompt = deployPlan.reviewPrompt(plan, planSha, root);
	const promptSha = sha256(prompt);
	const manifestSha = deployPlan.reviewInputManifest(planFile, root);

	const bodyLines = [
		"판정: PASS",
		...deployPlan.CRITERIA.map(([id]) => `${id}: PASS — 계획서 및 고정 스크립트 확인 통과`),
		"참고 지적: 0",
		"남은 지적: 0",
		"",
	];
	const body = bodyLines.join("\n");
	const stdoutSha = sha256(body);
	const finalText = `${body}review-run: target_sha256=${planSha} prompt_sha256=${promptSha} stdout_sha256=${stdoutSha}\n`;
	const resultRel = "deploy-plan-review-argon.md";
	fs.writeFileSync(path.join(gatesDir, resultRel), finalText);

	const startedAt = new Date(Date.now() - 2000).toISOString();
	const endedAt = new Date().toISOString();
	const reviewRecord = {
		plan_sha256: planSha,
		plan: path.relative(root, planFile),
		author_model: "muse",
		prompt_sha256: promptSha,
		reviewedAt: endedAt,
		reviewers: [
			{
				model: deployPlan.REVIEW_MODELS.argon.model,
				effort: deployPlan.REVIEW_MODELS.argon.effort,
				result: resultRel,
				result_sha256: sha256(finalText),
				target_sha256: planSha,
				receipt: {
					model: deployPlan.REVIEW_MODELS.argon.model,
					started_at: startedAt,
					ended_at: endedAt,
					exit_code: 0,
					prompt_sha256: promptSha,
					stdout_sha256: stdoutSha,
					input_manifest_sha256: manifestSha,
					isolation: "bwrap-ro-bind",
				},
			},
		],
	};
	fs.writeFileSync(path.join(gatesDir, deployPlan.REVIEW_FILE), JSON.stringify(reviewRecord, null, 2));
}

function appendHumanTurn(transcriptPath, text) {
	const entry = {
		type: "user",
		timestamp: new Date(Date.now() + 1000).toISOString(),
		message: {
			role: "user",
			content: [{ type: "text", text }],
		},
	};
	fs.appendFileSync(transcriptPath, JSON.stringify(entry) + "\n");
}

function runDeployGuardHook(command, { cwd, root, stateDir, transcriptPath, sessionId = "sess-plancover" }) {
	const payload = JSON.stringify({
		tool_name: "Bash",
		tool_input: { command },
		cwd,
		session_id: sessionId,
		transcript_path: transcriptPath,
	});
	const res = spawnSync(process.execPath, [HOOK_PATH], {
		cwd,
		input: payload,
		encoding: "utf8",
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: cwd,
			DEPLOY_READINESS_ROOT: root,
			DEPLOY_APPROVAL_STATE_DIR: stateDir,
			DEPLOY_AUDIT_PATH: path.join(stateDir, "audit.jsonl"),
		},
	});
	assert.equal(res.status, 0, `deploy-guard exited ${res.status}: ${res.stderr}`);
	return res.stdout.trim() ? JSON.parse(res.stdout) : null;
}

test("① 이번 사고 재현 — 정본 6단계, 계획서가 1~5만 covers → 막힘(메시지에 '정본 단계 누락: 6 ...' 표시, 승인 코드 미발급)", async (t) => {
	const { root, stateDir, transcriptPath } = makeWorkspace(t);
	writeGateConfig(root);
	const { docRel, docSha, steps, acceptance } = createW004SourceDoc(root);

	const { planFile, step1Cmd } = createPlanWithSourceDocs(root, {
		sourceDocs: [{ path: docRel, section: "운영 반영 단계", acceptanceSection: "사후 확인", sha256: docSha, steps, acceptance }],
	});
	// scenario[0].covers 를 1~5로만 수정 (6단계 "시험 키 설정 주입" 누락)
	const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
	plan.scenario[0].covers = ["1", "2", "3", "4", "5"];
	fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
	writePassingReviewReceipt(root, planFile);

	const workspaceScript = path.join(root, ".agents/scripts/approval-plan.mjs");
	const env = { ...process.env, DEPLOY_APPROVAL_STATE_DIR: stateDir };

	// 1) approval-plan.mjs check 막힘 + 메시지에 6 표시
	const chk = spawnSync(process.execPath, [workspaceScript, "check", planFile], { cwd: root, env, encoding: "utf8" });
	assert.equal(chk.status, 1, "정본 6단계가 빠졌으면 check 는 실패(exit 1)해야 함");
	assert.match(chk.stdout, /정본 단계 누락:\s*6\s+시험 키 설정 주입/);

	// 2) preapprove 코드 발급 거부 (PLAN/STEP 코드 미발급)
	const pre = await deployPlan.preapproveStepCodes(planFile, root, "sess-missing-6", env, Date.now());
	assert.equal(pre.ok, false, "정본 단계 누락 시 preapprove 는 거부되어야 함");
	assert.match(pre.why, /정본 단계 누락:\s*6\s+시험 키 설정 주입/);
	assert.equal(pre.plan_code, undefined);

	// 3) deploy-guard 훅 실행 시 승인 코드(PLAN-xxxxxx)를 내주지 않고 막음
	const decision = runDeployGuardHook(step1Cmd, { cwd: root, root, stateDir, transcriptPath });
	assert.ok(decision);
	assert.equal(decision.decision, "block");
	assert.match(decision.reason, /정본 단계 누락:\s*6\s+시험 키 설정 주입/);
	assert.doesNotMatch(decision.reason, /PLAN-[A-Z0-9]{6}/, "승인 코드를 내주면 안 됨");
});

test("② 6까지 covers → 통과 (check·preapprove·관문 실행 통과)", async (t) => {
	const { root, stateDir, transcriptPath } = makeWorkspace(t);
	writeGateConfig(root);
	const { docRel, docSha, steps, acceptance } = createW004SourceDoc(root);

	const { planFile, step1Cmd } = createPlanWithSourceDocs(root, {
		sourceDocs: [{ path: docRel, section: "운영 반영 단계", acceptanceSection: "사후 확인", sha256: docSha, steps, acceptance }],
	});
	writePassingReviewReceipt(root, planFile);

	const workspaceScript = path.join(root, ".agents/scripts/approval-plan.mjs");
	const sessionId = "sess-cover-all-6";
	const env = { ...process.env, DEPLOY_APPROVAL_STATE_DIR: stateDir };

	const chk = spawnSync(process.execPath, [workspaceScript, "check", planFile], { cwd: root, env, encoding: "utf8" });
	assert.equal(chk.status, 0, chk.stdout + chk.stderr);
	assert.match(chk.stdout, /근거 정본: 통과/);

	const pre = await deployPlan.preapproveStepCodes(planFile, root, sessionId, env, Date.now());
	assert.equal(pre.ok, true, pre.why);
	const s1Code = pre.steps.find((s) => s.step === "s1").code;
	appendHumanTurn(transcriptPath, `승인 ${pre.plan_code} ${s1Code}`);

	const decision = runDeployGuardHook(step1Cmd, { cwd: root, root, stateDir, transcriptPath, sessionId });
	assert.equal(decision, null, "1~6 모두 covers 하면 정상 통과해야 함");
});

test("③ 6을 excludedSourceSteps 이유와 함께 → 통과 (이유가 비면 막힘)", async (t) => {
	const { root, stateDir, transcriptPath } = makeWorkspace(t);
	writeGateConfig(root);
	const { docRel, docSha, steps, acceptance } = createW004SourceDoc(root);

	const { planFile, step1Cmd } = createPlanWithSourceDocs(root, {
		sourceDocs: [{ path: docRel, section: "운영 반영 단계", acceptanceSection: "사후 확인", sha256: docSha, steps, acceptance }],
		excludedSourceSteps: [
			{ id: "6", reason: "시험 키 설정은 이미 전날 운영 환경변수에 주입됨" },
		],
	});
	const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
	plan.scenario[0].covers = ["1", "2", "3", "4", "5"];
	fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
	writePassingReviewReceipt(root, planFile);

	const workspaceScript = path.join(root, ".agents/scripts/approval-plan.mjs");
	const sessionId = "sess-excluded-6";
	const env = { ...process.env, DEPLOY_APPROVAL_STATE_DIR: stateDir };

	const chk = spawnSync(process.execPath, [workspaceScript, "check", planFile], { cwd: root, env, encoding: "utf8" });
	assert.equal(chk.status, 0, chk.stdout + chk.stderr);
	assert.match(chk.stdout, /근거 정본: 통과/);

	const pre = await deployPlan.preapproveStepCodes(planFile, root, sessionId, env, Date.now());
	assert.equal(pre.ok, true, pre.why);
	const s1Code = pre.steps.find((s) => s.step === "s1").code;
	appendHumanTurn(transcriptPath, `승인 ${pre.plan_code} ${s1Code}`);

	const decision = runDeployGuardHook(step1Cmd, { cwd: root, root, stateDir, transcriptPath, sessionId });
	assert.equal(decision, null, "excludedSourceSteps 에 이유와 함께 적으면 통과해야 함");

	// 이유가 빈 문자열이면 통과하지 않고 막혀야 함
	const noReasonPlan = { ...plan, excludedSourceSteps: [{ id: "6", reason: "   " }] };
	const checkNoReason = deployPlan.sourceDocsCheck(noReasonPlan, root);
	assert.equal(checkNoReason.ok, false);
	assert.ok(checkNoReason.problems.some((p) => /정본 단계 누락:\s*6/.test(p)));
});

test("④ 정본 파일이 바뀌어 sha 다름 → 막힘", async (t) => {
	const { root, stateDir, transcriptPath } = makeWorkspace(t);
	writeGateConfig(root);
	const { docRel, docAbs, docSha, steps, acceptance } = createW004SourceDoc(root);

	const { planFile, step1Cmd } = createPlanWithSourceDocs(root, {
		sourceDocs: [{ path: docRel, section: "운영 반영 단계", acceptanceSection: "사후 확인", sha256: docSha, steps, acceptance }],
	});
	writePassingReviewReceipt(root, planFile);

	// 정본 파일(W-004) 내용을 수정하여 sha256 변경
	fs.appendFileSync(docAbs, "\n(7) 추가된 정본 단계\n");

	const workspaceScript = path.join(root, ".agents/scripts/approval-plan.mjs");
	const env = { ...process.env, DEPLOY_APPROVAL_STATE_DIR: stateDir };

	const chk = spawnSync(process.execPath, [workspaceScript, "check", planFile], { cwd: root, env, encoding: "utf8" });
	assert.equal(chk.status, 1, "정본 파일 sha 가 바뀌면 check 는 막혀야 함");
	assert.match(chk.stdout, /정본 파일 sha256 불일치/);

	const pre = await deployPlan.preapproveStepCodes(planFile, root, "sess-sha-mismatch", env, Date.now());
	assert.equal(pre.ok, false);
	assert.match(pre.why, /정본 파일 sha256 불일치/);

	const decision = runDeployGuardHook(step1Cmd, { cwd: root, root, stateDir, transcriptPath });
	assert.ok(decision);
	assert.equal(decision.decision, "block");
	assert.match(decision.reason, /정본 파일 sha256 불일치/);
	assert.doesNotMatch(decision.reason, /PLAN-[A-Z0-9]{6}/);
});

test("⑤ acceptance 실측 없이 완료 보고 → 완료 불인정 (실측 있으면 완료 인정)", (t) => {
	const { root, stateDir } = makeWorkspace(t);
	writeGateConfig(root);
	const { docRel, docSha, steps, acceptance } = createW004SourceDoc(root);

	const { planFile, gatesDir, plan } = createPlanWithSourceDocs(root, {
		sourceDocs: [{ path: docRel, section: "운영 반영 단계", acceptanceSection: "사후 확인", sha256: docSha, steps, acceptance }],
	});
	const workspaceScript = path.join(root, ".agents/scripts/approval-plan.mjs");
	const env = { ...process.env, DEPLOY_APPROVAL_STATE_DIR: stateDir };

 const planSha = sha256(fs.readFileSync(planFile));
 const forward = plan.scenario.filter(step => !deployPlan.isRollbackStep(plan, step));
 const { commandHash } = require('../lib/deploy-human-approval.js');
 fs.writeFileSync(path.join(stateDir, 'deploy-plan-state.json'), JSON.stringify({challenges:forward.map(step => ({kind:'step',planSha,step:step.id,status:'executed',executed:step.commands.map(commandHash)}))}));
 fs.mkdirSync(path.join(gatesDir,'deploy-steps'),{recursive:true});
 for(const step of forward) {
  const evidence=path.join(gatesDir,'deploy-steps',`${step.id}-evidence.txt`);
  fs.writeFileSync(evidence,'sample execution observed at 12:00 UTC');
  fs.writeFileSync(path.join(gatesDir,'deploy-steps',`${step.id}.json`),JSON.stringify({plan_sha256:planSha,step:step.id,verdict:'pass',evidence:path.basename(evidence),evidence_sha256:sha256(fs.readFileSync(evidence))}));
 }

	// 1) 사고 재현: 1단계 화면 200 OK 만 적고 정본 acceptance(결제 3단계 화면 시험 결제창) 실측이 없는 완료 보고
	const badReportFile = path.join(gatesDir, "deploy-completion-bad.json");
	fs.writeFileSync(badReportFile, JSON.stringify({
		plan_sha256: sha256(fs.readFileSync(planFile)),
		summary: "1단계 화면 200 OK 확인 완료",
		acceptance: [{ id: "1", text: "결제 3단계 화면에 시험 결제창이 뜸", 실측: "" }],
	}, null, 2));

	const badRes = deployPlan.verifyCompletionReport(plan, badReportFile, { root, gatesDir });
	assert.equal(badRes.ok, false, "acceptance 실측 칸이 비어 있으면 완료 불인정이어야 함");
	assert.ok(badRes.problems.some((p) => /정본 인수 확인\(acceptance\) 실측 누락:\s*1\s+결제 3단계 화면에 시험 결제창이 뜸/.test(p)));

	const cliBad = spawnSync(process.execPath, [workspaceScript, "complete", planFile, "--report", badReportFile], { cwd: root, env, encoding: "utf8" });
	assert.equal(cliBad.status, 1);
	assert.match(cliBad.stderr, /완료 불인정/);
	assert.match(cliBad.stderr, /결제 3단계 화면에 시험 결제창이 뜸/);

	// 2) 실측 칸이 채워진 완료 보고 → 완료 인정
	const goodReportFile = path.join(gatesDir, "deploy-completion-good.json");
	fs.writeFileSync(goodReportFile, JSON.stringify({
		plan_sha256: sha256(fs.readFileSync(planFile)),
		summary: "전체 단계 및 사후 확인 완료",
		acceptance: [
			{ id: "1", text: "결제 3단계 화면에 시험 결제창이 뜸", 실측: "결제 3단계 진입 시 시험 결제창 모달 노출 및 200 응답 실측 완료" },
		],
	}, null, 2));

	const goodRes = deployPlan.verifyCompletionReport(plan, goodReportFile, { root, gatesDir });
	assert.equal(goodRes.ok, true, `실측이 있으면 통과해야 함: ${goodRes.problems.join(", ")}`);

	const cliGood = spawnSync(process.execPath, [workspaceScript, "complete", planFile, "--report", goodReportFile], { cwd: root, env, encoding: "utf8" });
	assert.equal(cliGood.status, 0, cliGood.stderr);
	assert.match(cliGood.stdout, /완료 인정/);
});

test("⑥ sourceDocs 없는 옛 계획서 → 기존대로 통과(경고 한 줄) & source-steps 정본 추출 도우미", async (t) => {
	const { root, stateDir, transcriptPath } = makeWorkspace(t);
	writeGateConfig(root);
	const { docRel } = createW004SourceDoc(root);

	// sourceDocs 없는 옛 계획서
	const { planFile, step1Cmd } = createPlanWithSourceDocs(root);
	const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
	delete plan.sourceDocs;
	delete plan.scenario[0].covers;
	fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
	writePassingReviewReceipt(root, planFile);

	const workspaceScript = path.join(root, ".agents/scripts/approval-plan.mjs");
	const sessionId = "sess-legacy-no-sourcedocs";
	const env = { ...process.env, DEPLOY_APPROVAL_STATE_DIR: stateDir };

	const chk = spawnSync(process.execPath, [workspaceScript, "check", planFile], { cwd: root, env, encoding: "utf8" });
	assert.equal(chk.status, 0, chk.stdout + chk.stderr);
	const warningLines = chk.stdout.split(/\r?\n/).filter((l) => l.startsWith("경고: sourceDocs"));
	assert.equal(warningLines.length, 1, `경고 한 줄이 출력되어야 함: ${chk.stdout}`);

	const pre = await deployPlan.preapproveStepCodes(planFile, root, sessionId, env, Date.now());
	assert.equal(pre.ok, true, pre.why);
	assert.equal(pre.warnings.length, 1);
	const s1Code = pre.steps.find((s) => s.step === "s1").code;
	appendHumanTurn(transcriptPath, `승인 ${pre.plan_code} ${s1Code}`);

	const decision = runDeployGuardHook(step1Cmd, { cwd: root, root, stateDir, transcriptPath, sessionId });
	assert.equal(decision, null, "sourceDocs 없는 옛 계획서는 기존대로 통과해야 함");

	// source-steps 추출 도우미 검증: (1)~(6) 및 - [ ] 및 1. 형태 추출
	const extRes = spawnSync(
		process.execPath,
		[workspaceScript, "source-steps", docRel, "--section", "운영 반영 단계", "--acceptance-section", "사후 확인"],
		{ cwd: root, env, encoding: "utf8" }
	);
	assert.equal(extRes.status, 0, extRes.stderr);
	const draft = JSON.parse(extRes.stdout);
	assert.equal(draft.path, docRel);
	assert.equal(draft.steps.length, 6);
	assert.deepEqual(draft.steps[5], { id: "6", text: "시험 키 설정 주입" });
	assert.deepEqual(draft.acceptance, [{ id: "1", text: "결제 3단계 화면에 시험 결제창이 뜸" }]);
});
