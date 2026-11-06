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
const SCRIPT_PATH = path.join(REPO_ROOT, ".agents/scripts/approval-plan.mjs");
const deployPlan = require("../lib/deploy-plan.js");
const { assessReadiness } = require("../lib/deploy-readiness.js");
const { classifyProdMutations } = require("../lib/deploy-command-classifier.js");

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function makeWorkspace(t) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "approval-plan-gate-test-"));
	t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
	const root = path.join(tmp, "workspace");
	const stateDir = path.join(tmp, "state");
	const transcriptPath = path.join(tmp, "transcript.jsonl");
	fs.mkdirSync(path.join(root, ".git"), { recursive: true });
	fs.mkdirSync(stateDir, { recursive: true });
	fs.writeFileSync(transcriptPath, "");

	// Copy executor files into workspace so reviewInputManifest(planFile, root) binds to them
	for (const rel of deployPlan.REVIEW_EXECUTOR_FILES) {
		const src = path.join(REPO_ROOT, rel);
		const dst = path.join(root, rel);
		fs.mkdirSync(path.dirname(dst), { recursive: true });
		fs.copyFileSync(src, dst);
	}
	return { tmp, root, stateDir, transcriptPath };
}

function writeGateConfig(root, extra = {}) {
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
		...extra,
	};
	fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
	return cfgPath;
}

function createValidPlan(root, overrides = {}) {
	const gatesDir = path.join(root, ".agents", "progress", "sample-work", "gates");
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
		planId: "sample-web-rollout-01",
		createdAt: new Date().toISOString(),
		services: ["azure:containerapp:sample-web-prod"],
		what_why: "샘플 웹 서비스를 v1 이미지로 갱신하여 기능 개선을 반영합니다.",
		changes: ["컨테이너 이미지 sample/web:v1 반영"],
		scenario: [
			{
				id: "s1",
				title: "v1 이미지 배포",
				commands: [step1Cmd],
				files: { [scriptRel]: scriptSha },
				success_check: "헬스체크 200 응답 확인",
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
		irreversible: ["없음: 컨테이너 이미지 교체만 수행하며 스키마 변경 없음"],
		disconnect_safety: "터미널이 끊겨도 az containerapp revision list 로 상태를 확인하고 r1 명령으로 수동 복귀 가능",
		rerun_safety: {
			lock: "동일 리비전 이름 고정으로 중복 실행 방지",
			run_dir: ".agents/progress/sample-work 고유 폴더 사용",
			no_latest_pick: "명시적 이미지 태그 sample/web:v1 지정",
		},
		success_verification: "운영 헬스 엔드포인트 200 및 주요 화면 응답 확인",
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
	return { planSha, promptSha, manifestSha };
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

function runDeployGuardHook(command, { cwd, root, stateDir, transcriptPath, sessionId = "sess-test-1" }) {
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

test("1. 계획 없는 운영 명령 막힘 (Operational command without a plan is blocked)", (t) => {
	const { root, stateDir, transcriptPath } = makeWorkspace(t);
	writeGateConfig(root);

	const cmd = "az containerapp update -n sample-web-prod -g sample-rg --image sample/web:v1";
	const decision = runDeployGuardHook(cmd, { cwd: root, root, stateDir, transcriptPath });
	assert.ok(decision, "계획서 없는 운영 명령은 반드시 차단되어야 함");
	assert.equal(decision.decision, "block");
	assert.match(decision.reason, /계획 밖 운영 명령이라 막습니다/);
	assert.match(decision.reason, /azure:containerapp:sample-web-prod/);
});

test("2. 인스턴스 설정(config/deploy-gate.json) 없는 알 수 없는 운영 명령은 막힘 & 플러그인 확장 동작", async (t) => {
	const { root, stateDir, transcriptPath } = makeWorkspace(t);
	const { planFile, step1Cmd } = createValidPlan(root);
	writePassingReviewReceipt(root, planFile);

	// config/deploy-gate.json 이 없을 때: "알 수 없는 운영 명령은 막음"
	const noCfgDecision = runDeployGuardHook(step1Cmd, { cwd: root, root, stateDir, transcriptPath });
	assert.ok(noCfgDecision);
	assert.equal(noCfgDecision.decision, "block");
	assert.match(noCfgDecision.reason, /알 수 없는 운영 명령은 막음/);

	// 다른 미등록 서비스만 들어 있는 config/deploy-gate.json 일 때도 차단
	writeGateConfig(root, { services: { "azure:containerapp:other-prod": { allowOps: true } } });
	const unregDecision = runDeployGuardHook(step1Cmd, { cwd: root, root, stateDir, transcriptPath });
	assert.ok(unregDecision);
	assert.equal(unregDecision.decision, "block");
	assert.match(unregDecision.reason, /등록되지 않은 운영 서비스/);

	// 플러그인 모듈(plugin)을 통해 결합 규칙을 제공하면 준비 검사를 통과하고 승인 코드 단계로 진입
	const pluginRel = "config/custom-gate-plugin.cjs";
	fs.writeFileSync(
		path.join(root, pluginRel),
		`module.exports = {
			assessService(service, ctx) {
				if (service === "azure:containerapp:sample-web-prod") {
					return { ok: true, problems: [], facts: ["plugin verified " + service] };
				}
				return null;
			}
		};\n`
	);
	writeGateConfig(root, { plugin: pluginRel, services: {} });
	const withPluginDecision = runDeployGuardHook(step1Cmd, { cwd: root, root, stateDir, transcriptPath });
	assert.ok(withPluginDecision);
	assert.equal(withPluginDecision.decision, "block");
	assert.match(withPluginDecision.reason, /전체 계획 승인이 아직 없습니다/);
	assert.match(withPluginDecision.reason, /plugin verified azure:containerapp:sample-web-prod/);
});

test("3. 코드 없는 단계 막힘 (Reviewed plan without approval code is blocked and issues code)", (t) => {
	const { root, stateDir, transcriptPath } = makeWorkspace(t);
	writeGateConfig(root);
	const { planFile, step1Cmd } = createValidPlan(root);
	writePassingReviewReceipt(root, planFile);

	// 1) PLAN 코드도 없을 때 차단 및 PLAN 코드 발급 안내
	const d1 = runDeployGuardHook(step1Cmd, { cwd: root, root, stateDir, transcriptPath });
	assert.ok(d1);
	assert.equal(d1.decision, "block");
	assert.match(d1.reason, /전체 계획 승인이 아직 없습니다/);
	const planCodeMatch = d1.reason.match(/승인 코드:\s*(PLAN-[A-Z0-9]{6})/);
	assert.ok(planCodeMatch, "PLAN 승인 코드가 발급되어야 함");

	// 2) PLAN 코드만 입력하고 STEP 코드가 없을 때: 단계 승인 필요로 차단되고 STEP 코드 발급
	appendHumanTurn(transcriptPath, `계획 승인합니다 ${planCodeMatch[1]}`);
	const d2 = runDeployGuardHook(step1Cmd, { cwd: root, root, stateDir, transcriptPath });
	assert.ok(d2);
	assert.equal(d2.decision, "block");
	assert.match(d2.reason, /단계 승인 필요/);
	assert.match(d2.reason, /단계 승인 코드:\s*STEP-[A-Z0-9]{6}/);
});

test("4. 코드 맞는 단계 통과 (preapprove 발급 코드 + 사람 입력 시 통과 및 1회 소진)", async (t) => {
	const { root, stateDir, transcriptPath } = makeWorkspace(t);
	writeGateConfig(root);
	const { planFile, step1Cmd } = createValidPlan(root);
	writePassingReviewReceipt(root, planFile);

	const sessionId = "sess-preapprove-ok";
	const env = { ...process.env, DEPLOY_APPROVAL_STATE_DIR: stateDir };
	const pre = await deployPlan.preapproveStepCodes(planFile, root, sessionId, env, Date.now());
	assert.equal(pre.ok, true, `preapprove failed: ${pre.why}`);
	assert.match(pre.plan_code, /^PLAN-[A-Z0-9]{6}$/);
	const s1Code = pre.steps.find((s) => s.step === "s1")?.code;
	assert.ok(s1Code && /^STEP-[A-Z0-9]{6}$/.test(s1Code));

	// 사람이 대화창에 PLAN 코드와 s1 STEP 코드를 입력
	appendHumanTurn(transcriptPath, `승인: ${pre.plan_code} ${s1Code}`);

	// 정확한 단계 명령 실행 → 통과(null)
	const passDecision = runDeployGuardHook(step1Cmd, { cwd: root, root, stateDir, transcriptPath, sessionId });
	assert.equal(passDecision, null, `코드가 맞으면 통과해야 함: ${JSON.stringify(passDecision)}`);

	// 같은 명령을 한 번 더 실행하면 1회용 STEP 코드가 이미 소진되어 다시 막혀야 함
	const secondAttempt = runDeployGuardHook(step1Cmd, { cwd: root, root, stateDir, transcriptPath, sessionId });
	assert.ok(secondAttempt);
	assert.equal(secondAttempt.decision, "block");
	assert.match(secondAttempt.reason, /단계 승인 필요/);
});

test("5. 계획을 바꾸면 코드 무효 (Modifying the plan after code issuance invalidates code and blocks)", async (t) => {
	const { root, stateDir, transcriptPath } = makeWorkspace(t);
	writeGateConfig(root);
	const { planFile, plan, step1Cmd } = createValidPlan(root);
	writePassingReviewReceipt(root, planFile);

	const sessionId = "sess-plan-tamper";
	const env = { ...process.env, DEPLOY_APPROVAL_STATE_DIR: stateDir };
	const pre = await deployPlan.preapproveStepCodes(planFile, root, sessionId, env, Date.now());
	assert.equal(pre.ok, true);
	const s1Code = pre.steps.find((s) => s.step === "s1").code;
	appendHumanTurn(transcriptPath, `승인 ${pre.plan_code} ${s1Code}`);

	// 계획서 내용을 수정(예: what_why 문구 변경 → 계획서 sha256 변경)
	const tamperedPlan = { ...plan, what_why: "승인 뒤 몰래 바꾼 배포 사유와 범위입니다." };
	fs.writeFileSync(planFile, JSON.stringify(tamperedPlan, null, 2));

	const decision = runDeployGuardHook(step1Cmd, { cwd: root, root, stateDir, transcriptPath, sessionId });
	assert.ok(decision, "계획서가 바뀌면 이전 리뷰·승인 코드로 통과할 수 없어야 함");
	assert.equal(decision.decision, "block");
	assert.match(decision.reason, /적대 리뷰를 통과하지 않아|지금 계획서가 아닌 판을 검수함/);
});

test("6. 고정 파일 sha 다르면 막힘 & 단계 명령 바이트 다르면 막힘", async (t) => {
	const { root, stateDir, transcriptPath } = makeWorkspace(t);
	writeGateConfig(root);
	const { planFile, scriptAbs, step1Cmd } = createValidPlan(root);
	writePassingReviewReceipt(root, planFile);

	const sessionId = "sess-pin-and-byte";
	const env = { ...process.env, DEPLOY_APPROVAL_STATE_DIR: stateDir };
	const pre = await deployPlan.preapproveStepCodes(planFile, root, sessionId, env, Date.now());
	assert.equal(pre.ok, true);
	const s1Code = pre.steps.find((s) => s.step === "s1").code;
	appendHumanTurn(transcriptPath, `승인 ${pre.plan_code} ${s1Code}`);

	// 6-A) 정규화 sha256 은 같지만 공백 바이트가 다른 명령 실행 → 바이트 대조에서 즉시 차단
	const byteDifferentCmd = step1Cmd.replace("bash ", "bash   ");
	const byteDecision = runDeployGuardHook(byteDifferentCmd, { cwd: root, root, stateDir, transcriptPath, sessionId });
	assert.ok(byteDecision, "명령 바이트가 다르면 차단되어야 함");
	assert.equal(byteDecision.decision, "block");
	assert.match(byteDecision.reason, /실행 명령 바이트가 계획서의 승인된 단계 명령과 다릅니다/);

	// 6-B) 고정 파일(scripts/rollout.sh) 내용을 1바이트 수정 → 고정 파일 sha 대조에서 즉시 차단
	fs.appendFileSync(scriptAbs, "# tampered after approval\n");
	const pinDecision = runDeployGuardHook(step1Cmd, { cwd: root, root, stateDir, transcriptPath, sessionId });
	assert.ok(pinDecision, "고정 파일 sha가 다르면 차단되어야 함");
	assert.equal(pinDecision.decision, "block");
	assert.match(pinDecision.reason, /파일이 계획서에 고정되지 않았거나, 고정한 뒤 바뀌었습니다|고정 파일 sha256 불일치/);
});

test("7. approval-plan.mjs CLI (template, check, report, preapprove, step-ok) 동작 검증", (t) => {
	const { root, stateDir } = makeWorkspace(t);
	writeGateConfig(root);
	const { planFile } = createValidPlan(root);
	writePassingReviewReceipt(root, planFile);

	const env = { ...process.env, DEPLOY_APPROVAL_STATE_DIR: stateDir };
	const workspaceScript = path.join(root, ".agents/scripts/approval-plan.mjs");

	// template
	const tplRes = spawnSync(process.execPath, [workspaceScript, "template"], { cwd: root, env, encoding: "utf8" });
	assert.equal(tplRes.status, 0, tplRes.stderr);
	const tpl = JSON.parse(tplRes.stdout);
	assert.equal(tpl.schema, "deploy-plan/v1");

	// check
	const chkRes = spawnSync(process.execPath, [workspaceScript, "check", planFile], { cwd: root, env, encoding: "utf8" });
	assert.equal(chkRes.status, 0, chkRes.stderr);
	assert.match(chkRes.stdout, /양식: 통과/);
	assert.match(chkRes.stdout, /적대 리뷰: 통과/);

	// report
	const repRes = spawnSync(process.execPath, [workspaceScript, "report", planFile], { cwd: root, env, encoding: "utf8" });
	assert.equal(repRes.status, 0, repRes.stderr);
	assert.match(repRes.stdout, /\[운영 배포 승인 요청\] sample-web-rollout-01/);

	// preapprove
	const preRes = spawnSync(process.execPath, [workspaceScript, "preapprove", planFile, "--session", "cli-sess-1"], { cwd: root, env, encoding: "utf8" });
	assert.equal(preRes.status, 0, preRes.stderr);
	assert.match(preRes.stdout, /사전발급 코드\(사용자 본인이 한 메시지로 승인\): PLAN PLAN-[A-Z0-9]{6} s1 STEP-[A-Z0-9]{6} r1 STEP-[A-Z0-9]{6}/);

	// step-ok
	const evFile = path.join(stateDir, "s1-ok.txt");
	fs.writeFileSync(evFile, "HTTP/1.1 200 OK\nhealth=ok\n");
	const stepOkRes = spawnSync(process.execPath, [workspaceScript, "step-ok", planFile, "s1", "--evidence", evFile], { cwd: root, env, encoding: "utf8" });
	assert.equal(stepOkRes.status, 0, stepOkRes.stderr);
	assert.match(stepOkRes.stdout, /단계 s1 성공 확인 기록/);
});

test("8. 차단 1 재현: 옛 승인(approvals.json) 분기에서도 설정·계획서 없이 운영 명령(az/ssh 등) 실행 시 차단", async (t) => {
	const { root } = makeWorkspace(t);
	const P = require(path.join(REPO_ROOT, ".agents/hooks/policies/bash.js"));
	const deployDir = path.join(root, ".claude", "deploy");
	fs.mkdirSync(deployDir, { recursive: true });
	fs.writeFileSync(path.join(deployDir, "config.json"), JSON.stringify({ projects: {} }, null, 2));
	fs.writeFileSync(path.join(deployDir, "approvals.json"), JSON.stringify({ approvals: [] }, null, 2));

	const savedReadinessRoot = process.env.DEPLOY_READINESS_ROOT;
	const savedStateDir = process.env.DEPLOY_APPROVAL_STATE_DIR;
	const savedAuditPath = process.env.DEPLOY_AUDIT_PATH;
	delete process.env.DEPLOY_READINESS_ROOT;
	delete process.env.DEPLOY_APPROVAL_STATE_DIR;
	process.env.DEPLOY_AUDIT_PATH = path.join(deployDir, "audit.jsonl");
	t.after(() => {
		if (savedReadinessRoot === undefined) delete process.env.DEPLOY_READINESS_ROOT;
		else process.env.DEPLOY_READINESS_ROOT = savedReadinessRoot;
		if (savedStateDir === undefined) delete process.env.DEPLOY_APPROVAL_STATE_DIR;
		else process.env.DEPLOY_APPROVAL_STATE_DIR = savedStateDir;
		if (savedAuditPath === undefined) delete process.env.DEPLOY_AUDIT_PATH;
		else process.env.DEPLOY_AUDIT_PATH = savedAuditPath;
	});

	// approvals.json 만 있고 config/deploy-gate.json 및 계획서가 없는 상태에서 az 운영 명령 실행
	const cmd = "az containerapp update -n sample-web-prod -g rg --image x:v1";
	const res = await P.deploy(cmd, { cwd: root, session_id: "legacy-bypass-test" }, { deployDir });
	assert.ok(res && res.reason, "approvals.json 만 있는 레거시 상태에서도 az 운영 명령은 통과(null)하면 안 되고 차단되어야 함");
	assert.match(res.reason, /계획 밖 운영 명령이라 막습니다|알 수 없는 운영 명령은 막음/);
	assert.match(res.reason, /azure:containerapp:sample-web-prod/);
});

test("9. 차단 2 재현: classifyInstanceExtension 플러그인 로드 실패·정규식 오류 때 unclassified 차단 및 prodPatterns 적중 보존", (t) => {
	const { root, stateDir, transcriptPath } = makeWorkspace(t);

	// 9-A) prodPatterns 적중 + 깨진 plugin 경로 → prodPatterns 적중 보존 + unclassified 적중으로 blocked-unclassified 차단
	writeGateConfig(root, {
		prodPatterns: [
			{ pattern: "\\bcustom-deploy-cli\\s+--prod\\b", service: "custom:prod-svc", summary: "커스텀 운영 배포" },
		],
		plugin: "config/missing-plugin.cjs",
	});
	const cmd = "custom-deploy-cli --prod";
	const hits = classifyProdMutations(cmd, root);
	assert.ok(hits.some((h) => h.service === "custom:prod-svc"), "이미 모은 prodPatterns 적중을 버리지 않아야 함");
	assert.ok(hits.some((h) => h.unclassified), "플러그인 로드 실패 시 unclassified 적중을 내야 함");

	const d1 = runDeployGuardHook(cmd, { cwd: root, root, stateDir, transcriptPath });
	assert.ok(d1, "플러그인 로드 실패 시 통과(null)하면 안 되고 차단되어야 함");
	assert.equal(d1.decision, "block");
	assert.match(d1.reason, /운영 도구가 보이지만 대상을 분류하지 못해 차단합니다/);

	const auditLines = fs.readFileSync(path.join(stateDir, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.ok(auditLines.some((e) => e.event === "blocked-unclassified"), "blocked-unclassified 감사 로그가 남아야 함");

	// 9-B) 잘못된 prodPatterns 정규식 + 정상 prodPatterns → 정상 적중 보존 + 정규식 오류 unclassified 적중
	writeGateConfig(root, {
		prodPatterns: [
			{ pattern: "\\bcustom-deploy-cli\\s+--prod\\b", service: "custom:prod-svc", summary: "커스텀 운영 배포" },
			{ pattern: "[invalid-regex", service: "custom:bad-regex", summary: "잘못된 정규식" },
		],
	});
	const regexHits = classifyProdMutations(cmd, root);
	assert.ok(regexHits.some((h) => h.service === "custom:prod-svc"), "유효한 prodPatterns 적중은 보존되어야 함");
	assert.ok(regexHits.some((h) => h.unclassified), "정규식 오류 시 unclassified 적중을 내야 함");

	const d2 = runDeployGuardHook(cmd, { cwd: root, root, stateDir, transcriptPath });
	assert.ok(d2);
	assert.equal(d2.decision, "block");
	assert.match(d2.reason, /운영 도구가 보이지만 대상을 분류하지 못해 차단합니다/);
});

test("10. 유효한 옛 승인(approvals.json)과 프로젝트 설정이 있어도 vercel --prod·gcloud run deploy 및 우회 변형 차단", async (t) => {
	const { root, stateDir, transcriptPath } = makeWorkspace(t);
	const P = require(path.join(REPO_ROOT, ".agents/hooks/policies/bash.js"));
	const deployDir = path.join(root, ".claude", "deploy");
	fs.mkdirSync(deployDir, { recursive: true });
	const approvedAt = new Date().toISOString();
	const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
	fs.writeFileSync(
		path.join(deployDir, "config.json"),
		JSON.stringify(
			{
				projects: {
					"sample-web": {
						platform: "vercel",
						cwd: root,
					},
					"sample-svc": {
						platform: "gcloud",
						prod_command: "gcloud run deploy sample-svc --project sample-proj",
					},
				},
				default_ttl_minutes: 30,
			},
			null,
			2
		)
	);
	fs.writeFileSync(
		path.join(deployDir, "approvals.json"),
		JSON.stringify(
			{
				approvals: [
					{
						project: "sample-web",
						approved_by: "sample-owner",
						approved_at: approvedAt,
						expires_at: expiresAt,
						single_use: false,
					},
					{
						project: "sample-svc",
						approved_by: "sample-owner",
						approved_at: approvedAt,
						expires_at: expiresAt,
						single_use: false,
					},
				],
			},
			null,
			2
		)
	);

	const savedReadinessRoot = process.env.DEPLOY_READINESS_ROOT;
	const savedStateDir = process.env.DEPLOY_APPROVAL_STATE_DIR;
	const savedAuditPath = process.env.DEPLOY_AUDIT_PATH;
	delete process.env.DEPLOY_READINESS_ROOT;
	delete process.env.DEPLOY_APPROVAL_STATE_DIR;
	process.env.DEPLOY_AUDIT_PATH = path.join(deployDir, "audit.jsonl");
	t.after(() => {
		if (savedReadinessRoot === undefined) delete process.env.DEPLOY_READINESS_ROOT;
		else process.env.DEPLOY_READINESS_ROOT = savedReadinessRoot;
		if (savedStateDir === undefined) delete process.env.DEPLOY_APPROVAL_STATE_DIR;
		else process.env.DEPLOY_APPROVAL_STATE_DIR = savedStateDir;
		if (savedAuditPath === undefined) delete process.env.DEPLOY_AUDIT_PATH;
		else process.env.DEPLOY_AUDIT_PATH = savedAuditPath;
	});

	// 1) vercel --prod 차단 확인
	const vercelRes = await P.deploy("vercel --prod", { cwd: root, session_id: "legacy-overlap-test" }, { deployDir });
	assert.ok(vercelRes && vercelRes.reason, "유효한 옛 승인이 있어도 vercel --prod 는 차단되어야 함");
	assert.match(vercelRes.reason, /계획 밖 운영 명령이라 막습니다|알 수 없는 운영 명령은 막음/);
	assert.match(vercelRes.reason, /vercel:prod/);

	// 2) gcloud run deploy <서비스> --project <x> 차단 확인
	const gcloudCmd = "gcloud run deploy sample-svc --project sample-proj";
	const gcloudRes = await P.deploy(gcloudCmd, { cwd: root, session_id: "legacy-overlap-test" }, { deployDir });
	assert.ok(gcloudRes && gcloudRes.reason, "유효한 옛 승인이 있어도 gcloud run deploy 는 차단되어야 함");
	assert.match(gcloudRes.reason, /계획 밖 운영 명령이라 막습니다|알 수 없는 운영 명령은 막음/);
	assert.match(gcloudRes.reason, /gcloud:run:sample-svc/);

	// 3) 우회 변형 5종(cd 접두, bash -c '…', 환경 변수 접두, ; 묶음, 줄바꿈 묶음) 각 1건씩 차단 확인
	const bypassCases = [
		{ name: "cd 접두", cmd: `cd "${root}" && vercel --prod`, expectedService: /vercel:prod/ },
		{ name: "bash -c 인라인", cmd: "bash -c 'gcloud run deploy sample-svc --project sample-proj'", expectedService: /gcloud:run:sample-svc/ },
		{ name: "환경 변수 접두", cmd: "NODE_ENV=production vercel --prod", expectedService: /vercel:prod/ },
		{ name: "; 묶음", cmd: "pwd ; gcloud run deploy sample-svc --project sample-proj", expectedService: /gcloud:run:sample-svc/ },
		{ name: "줄바꿈 묶음", cmd: "pwd\nvercel --prod", expectedService: /vercel:prod/ },
	];

	for (const { name, cmd, expectedService } of bypassCases) {
		const legacyRes = await P.deploy(cmd, { cwd: root, session_id: "legacy-overlap-test" }, { deployDir });
		assert.ok(legacyRes && legacyRes.reason, `우회 변형(${name})은 옛 승인 상태에서 차단되어야 함`);
		assert.match(legacyRes.reason, /계획 밖 운영 명령이라 막습니다|알 수 없는 운영 명령은 막음/);
		assert.match(legacyRes.reason, expectedService);

		const hookDecision = runDeployGuardHook(cmd, { cwd: root, root, stateDir, transcriptPath });
		assert.ok(hookDecision, `우회 변형(${name})은 deploy-guard 훅에서도 차단되어야 함`);
		assert.equal(hookDecision.decision, "block");
		assert.match(hookDecision.reason, expectedService);
	}
});

test("11. P1-1 재현: Pi 어댑터(.pi/extensions/naia-harness.ts) tool_call 가드 루프가 async bash.deploy 결과를 await 하여 차단", async (t) => {
	const { root } = makeWorkspace(t);
	writeGateConfig(root);

	const harnessPath = path.join(REPO_ROOT, ".pi/extensions/naia-harness.ts");
	const prevFilename = globalThis.__filename;
	const prevDirname = globalThis.__dirname;
	globalThis.__filename = harnessPath;
	globalThis.__dirname = path.dirname(harnessPath);
	let registerPiHarness;
	try {
		delete require.cache[harnessPath];
		const mod = require(harnessPath);
		registerPiHarness = mod.default || mod;
	} finally {
		if (prevFilename === undefined) delete globalThis.__filename;
		else globalThis.__filename = prevFilename;
		if (prevDirname === undefined) delete globalThis.__dirname;
		else globalThis.__dirname = prevDirname;
	}

	const handlers = new Map();
	registerPiHarness({
		on(event, handler) {
			handlers.set(event, handler);
		},
	});
	const onToolCall = handlers.get("tool_call");
	assert.equal(typeof onToolCall, "function", "tool_call 핸들러가 등록되어야 함");

	const res1 = await onToolCall(
		{ toolName: "bash", input: { command: "vercel --prod" } },
		{ cwd: root }
	);
	assert.ok(res1 && res1.block === true, "Pi 어댑터에서 vercel --prod 배포 명령이 차단되어야 함");
	assert.match(res1.reason || "", /계획 밖 운영 명령이라 막습니다|알 수 없는 운영 명령은 막음|prod 배포/);

	const res2 = await onToolCall(
		{ toolName: "bash", input: { command: "az containerapp update -n sample-web-prod -g sample-rg --image sample/web:v1" } },
		{ cwd: root }
	);
	assert.ok(res2 && res2.block === true, "Pi 어댑터에서 az containerapp update 운영 명령이 차단되어야 함");
	assert.match(res2.reason || "", /azure:containerapp:sample-web-prod/);
});

test("12. P1-2 재현: 복합 명령 안 개발 서비스(gcloud run deploy sample-dev) 일치만으로 앞뒤 절의 운영 배포(vercel --prod 등)가 통과하지 않음", async (t) => {
	const { root, stateDir, transcriptPath } = makeWorkspace(t);
	const P = require(path.join(REPO_ROOT, ".agents/hooks/policies/bash.js"));
	const deployDir = path.join(root, ".claude", "deploy");
	fs.mkdirSync(deployDir, { recursive: true });
	fs.writeFileSync(
		path.join(deployDir, "config.json"),
		JSON.stringify(
			{
				projects: {
					"sample-web": { platform: "vercel", cwd: root },
					"sample-svc": { platform: "gcloud", dev_service: "sample-dev", prod_command: "gcloud run deploy sample-svc" },
					"custom-svc": { platform: "gcloud", dev_service: "custom-sandbox-svc", prod_command: "gcloud run deploy custom-svc" },
				},
			},
			null,
			2
		)
	);

	// 단독 개발 서비스 배포 절은 그대로 통과 (-dev 접미사 및 dev_service 지정 이름 모두)
	const devOnlyRes = await P.deploy("gcloud run deploy sample-dev", { cwd: root, session_id: "dev-clause-test" }, { deployDir });
	assert.equal(devOnlyRes, null, "단독 개발 서비스 배포 명령은 예외로 통과해야 함");
	const customDevOnlyRes = await P.deploy("gcloud run deploy custom-sandbox-svc", { cwd: root, session_id: "dev-clause-test" }, { deployDir });
	assert.equal(customDevOnlyRes, null, "config.json dev_service 에 등록된 단독 개발 서비스 배포 명령도 예외로 통과해야 함");

	// 첫 절이 vercel 운영 배포(--prod), 둘째 절이 gcloud run deploy sample-dev 인 복합 명령은 차단되어야 함
	const compoundCmd = "vercel --prod && gcloud run deploy sample-dev";
	const compoundRes = await P.deploy(compoundCmd, { cwd: root, session_id: "dev-clause-test" }, { deployDir });
	assert.ok(compoundRes && compoundRes.reason, "복합 명령 안 개발 서비스 절 때문에 vercel --prod 절이 통과하면 안 됨");
	assert.match(compoundRes.reason, /vercel:prod/);

	// dev_service 이름(custom-sandbox-svc)과 함께 묶인 복합 명령도 운영 절만 정확히 검출·차단되어야 함
	const customCompoundRes = await P.deploy("vercel --prod && gcloud run deploy custom-sandbox-svc", { cwd: root, session_id: "dev-clause-test" }, { deployDir });
	assert.ok(customCompoundRes && customCompoundRes.reason, "custom dev_service 절이 섞여 있어도 vercel --prod 절은 차단되어야 함");
	assert.match(customCompoundRes.reason, /vercel:prod/);
	assert.doesNotMatch(customCompoundRes.reason, /custom-sandbox-svc/);

	// 역순(첫 절이 sample-dev, 둘째 절이 vercel --prod) 및 레거시 패턴 복합 명령도 차단 확인
	const reverseCmd = "gcloud run deploy sample-dev && vercel --prod";
	const reverseRes = await P.deploy(reverseCmd, { cwd: root, session_id: "dev-clause-test" }, { deployDir });
	assert.ok(reverseRes && reverseRes.reason, "첫 절이 개발 서비스여도 둘째 절의 운영 배포는 차단되어야 함");
	assert.match(reverseRes.reason, /vercel:prod/);

	const legacyCompoundCmd = "gcloud run deploy sample-dev && gcloud run services update sample-prod";
	const legacyCompoundRes = await P.deploy(legacyCompoundCmd, { cwd: root, session_id: "dev-clause-test" }, { deployDir });
	assert.ok(legacyCompoundRes && legacyCompoundRes.reason, "첫 절이 개발 서비스여도 둘째 절의 gcloud run services update sample-prod 는 차단되어야 함");

	const hookDecision = runDeployGuardHook(compoundCmd, { cwd: root, root, stateDir, transcriptPath });
	assert.ok(hookDecision);
	assert.equal(hookDecision.decision, "block");
	assert.match(hookDecision.reason, /vercel:prod/);
});

test("13. P1-3 재현: 하위 폴더로 cd 한 뒤 사용자 정의 운영 패턴(release-control --live) 실행 시 관문 루트의 config/deploy-gate.json 에서 적중", async (t) => {
	const { root } = makeWorkspace(t);
	const P = require(path.join(REPO_ROOT, ".agents/hooks/policies/bash.js"));
	const deployDir = path.join(root, ".claude", "deploy");
	fs.mkdirSync(deployDir, { recursive: true });
	const subDir = path.join(root, "packages", "subapp");
	fs.mkdirSync(subDir, { recursive: true });

	writeGateConfig(root, {
		prodPatterns: [
			{
				pattern: "\\brelease-control\\b.*\\s--live\\b",
				service: "custom:release-control:live",
				summary: "release-control live 배포",
			},
		],
	});

	const savedReadinessRoot = process.env.DEPLOY_READINESS_ROOT;
	const savedAuditPath = process.env.DEPLOY_AUDIT_PATH;
	delete process.env.DEPLOY_READINESS_ROOT;
	process.env.DEPLOY_AUDIT_PATH = path.join(deployDir, "audit.jsonl");
	t.after(() => {
		if (savedReadinessRoot === undefined) delete process.env.DEPLOY_READINESS_ROOT;
		else process.env.DEPLOY_READINESS_ROOT = savedReadinessRoot;
		if (savedAuditPath === undefined) delete process.env.DEPLOY_AUDIT_PATH;
		else process.env.DEPLOY_AUDIT_PATH = savedAuditPath;
	});

	// 1) 루트에서 하위 폴더로 cd 한 뒤 release-control --live 실행
	const cdCmd = "cd packages/subapp && release-control --live";
	const hitsFromCd = classifyProdMutations(cdCmd, root);
	assert.ok(
		hitsFromCd.some((h) => h.service === "custom:release-control:live"),
		"하위 폴더로 cd 한 뒤에도 루트 config/deploy-gate.json 의 prodPatterns 가 적중해야 함"
	);
	const resFromCd = await P.deploy(cdCmd, { cwd: root, session_id: "subdir-ext-test" }, { deployDir });
	assert.ok(resFromCd && resFromCd.reason, "cd 뒤 사용자 정의 운영 패턴 명령은 차단되어야 함");
	assert.match(resFromCd.reason, /custom:release-control:live/);

	// 2) 하위 폴더 자체가 cwd 인 상태에서 release-control --live 실행
	const resFromSubCwd = await P.deploy("release-control --live", { cwd: subDir, session_id: "subdir-ext-test" }, { deployDir });
	assert.ok(resFromSubCwd && resFromSubCwd.reason, "하위 폴더 cwd 에서 실행한 사용자 정의 운영 패턴 명령도 관문 루트 설정으로 차단되어야 함");
	assert.match(resFromSubCwd.reason, /custom:release-control:live/);
});

test("14. P1-4 재현: bash scripts/rollout.sh 재귀 참조 파일 검사가 호출자 작업 디렉터리(e.dir)를 유지하고 스크립트 안 명시적 cd 만 반영", (t) => {
	const { root, stateDir, transcriptPath } = makeWorkspace(t);
	writeGateConfig(root);

	const scriptDir = path.join(root, "scripts");
	fs.mkdirSync(scriptDir, { recursive: true });
	const appYamlAbs = path.join(root, "app.yaml");
	fs.writeFileSync(appYamlAbs, "kind: containerapp\nimage: sample/web:v1\n");
	const appYamlSha = sha256(fs.readFileSync(appYamlAbs));

	const scriptAbs = path.join(scriptDir, "rollout.sh");
	fs.writeFileSync(
		scriptAbs,
		"#!/usr/bin/env bash\naz containerapp update -n sample-web-prod -g sample-rg --yaml app.yaml\n"
	);
	const scriptSha = sha256(fs.readFileSync(scriptAbs));

	// 1) referencedFiles("bash scripts/rollout.sh prod", root) 가 scripts/app.yaml 이 아니라 호출자 디렉터리의 <root>/app.yaml 을 찾아야 함
	const refs = deployPlan.referencedFiles("bash scripts/rollout.sh prod", root);
	const refPaths = refs.map((r) => r.path);
	assert.ok(refPaths.includes(scriptAbs), "실행 스크립트 자체가 참조 파일에 포함되어야 함");
	assert.ok(refPaths.includes(appYamlAbs), "스크립트 안 --yaml app.yaml 은 호출자 작업 디렉터리(root/app.yaml)에서 찾아야 함");

	// 2) 스크립트 안에 명시적 cd 가 있는 경우에는 그 cd 경로 기준으로 참조 파일을 찾아야 함
	const subCfgDir = path.join(root, "deploy-cfg");
	fs.mkdirSync(subCfgDir, { recursive: true });
	const subYamlAbs = path.join(subCfgDir, "sub-app.yaml");
	fs.writeFileSync(subYamlAbs, "kind: containerapp\nimage: sample/web:v2\n");
	const cdScriptAbs = path.join(scriptDir, "rollout-with-cd.sh");
	fs.writeFileSync(
		cdScriptAbs,
		"#!/usr/bin/env bash\ncd deploy-cfg && az containerapp update -n sample-web-prod -g sample-rg --yaml sub-app.yaml\n"
	);
	const cdRefs = deployPlan.referencedFiles("bash scripts/rollout-with-cd.sh", root);
	assert.ok(cdRefs.some((r) => r.path === subYamlAbs), "스크립트 안의 명시적 cd deploy-cfg 는 반영하여 deploy-cfg/sub-app.yaml 을 찾아야 함");

	// 3) 계획서에 scripts/rollout.sh 만 고정하고 app.yaml 을 고정하지 않으면 관문이 미고정 참조 파일로 차단해야 함
	const { planFile, step1Cmd } = createValidPlan(root, {
		scenario: [
			{
				id: "s1",
				title: "yaml 기반 배포",
				commands: ["bash scripts/rollout.sh prod"],
				files: { "scripts/rollout.sh": scriptSha },
				success_check: "헬스체크 200 응답 확인",
				on_failure: "r1 단계로 이전 리비전을 즉시 활성화하고 보고",
			},
			{
				id: "r1",
				branch: "rollback",
				title: "이전 리비전으로 복귀",
				commands: ["az containerapp revision activate -n sample-web-prod -g sample-rg --revision sample-web-prod--prev"],
				success_check: "이전 리비전 트래픽 100% 및 헬스 200 확인",
				on_failure: "트래픽 차단 후 즉시 운영팀에 보고",
			},
		],
	});
	writePassingReviewReceipt(root, planFile);
	const unpinnedDecision = runDeployGuardHook(step1Cmd, { cwd: root, root, stateDir, transcriptPath });
	assert.ok(unpinnedDecision);
	assert.equal(unpinnedDecision.decision, "block");
	assert.match(unpinnedDecision.reason, /파일이 계획서에 고정되지 않았거나/);
	assert.ok(unpinnedDecision.reason.includes(appYamlAbs), `미고정 파일 안내에 ${appYamlAbs} 가 포함되어야 함 (실제: ${unpinnedDecision.reason})`);
	assert.equal(appYamlSha.length, 64);
});

test("15. 2회차 지적 1 재현: 명령 앞 전역 옵션 우회 12종 + 미지 옵션 + 감싼 대본(bash release.sh) 차단", async (t) => {
	const { root, stateDir, transcriptPath } = makeWorkspace(t);
	writeGateConfig(root);
	const P = require(path.join(REPO_ROOT, ".agents/hooks/policies/bash.js"));
	const deployDir = path.join(root, ".claude", "deploy");
	fs.mkdirSync(deployDir, { recursive: true });

	const releaseSh = path.join(root, "release.sh");
	fs.writeFileSync(
		releaseSh,
		"#!/usr/bin/env bash\ngcloud run services update sample-svc --image gcr.io/sample/app:v1\n"
	);

	// 12가지 우회 모양
	const bypass12 = [
		{ name: "1. gcloud --project prod run deploy", cmd: "gcloud --project prod run deploy sample-svc", expectedService: /gcloud:run:sample-svc/ },
		{ name: "2. gcloud --quiet run services update", cmd: "gcloud --quiet run services update sample-svc --image gcr.io/sample/app:v1", expectedService: /gcloud:run:sample-svc/ },
		{ name: "3. gcloud --project prod run services replace", cmd: "gcloud --project prod run services replace service.yaml", expectedService: /gcloud:run:replace/ },
		{ name: "4. gcloud --project prod builds submit", cmd: "gcloud --project prod builds submit --tag gcr.io/sample/app:v1", expectedService: /gcloud:builds:submit/ },
		{ name: "5. bash release.sh (감싼 대본 안 gcloud run services update)", cmd: "bash release.sh", expectedService: /gcloud:run:sample-svc/ },
		{ name: "6. kubectl -n prod apply", cmd: "kubectl -n prod apply -f app.yaml", expectedService: /kubectl:apply/ },
		{ name: "7. helm -n prod upgrade", cmd: "helm -n prod upgrade sample-rel ./chart", expectedService: /helm:upgrade/ },
		{ name: "8. terraform -chdir=infra apply", cmd: "terraform -chdir=infra apply", expectedService: /terraform:apply/ },
		{ name: "9. fly -a app deploy", cmd: "fly -a app deploy", expectedService: /fly:deploy/ },
		{ name: "10. wrangler --env prod deploy", cmd: "wrangler --env prod deploy", expectedService: /cloudflare:workers/ },
		{ name: "11. railway -e prod up", cmd: "railway -e prod up", expectedService: /railway:up/ },
		{ name: "12. supabase --project-ref x db push", cmd: "supabase --project-ref x db push", expectedService: /supabase:db:push/ },
	];

	for (const { name, cmd, expectedService } of bypass12) {
		const hits = classifyProdMutations(cmd, root);
		assert.ok(
			hits.some((h) => expectedService.test(h.service)),
			`[${name}] 분류기가 운영 서비스를 잡아야 함 (실제: ${JSON.stringify(hits)})`
		);
		const res = await P.deploy(cmd, { cwd: root, session_id: "leading-opt-test" }, { deployDir });
		assert.ok(res && res.reason, `[${name}] P.deploy 에서 차단되어야 함`);
		assert.match(res.reason, expectedService);

		const hookDecision = runDeployGuardHook(cmd, { cwd: root, root, stateDir, transcriptPath });
		assert.ok(hookDecision, `[${name}] deploy-guard 훅에서 차단되어야 함`);
		assert.equal(hookDecision.decision, "block");
		assert.match(hookDecision.reason, expectedService);
	}

	// docker 는 분류기 밖(옛 PROD_PATTERNS)에서 막는다: 앞 전역 옵션·image 하위 명령도 같은 판정
	const dockerCases = [
		"docker --context prod push gcr.io/sample/app:v1",
		"docker --config /tmp/cfg push asia-docker.pkg.dev/sample/app:v1",
		"docker -H tcp://x:2375 --tls push gcr.io/sample/app:v1",
		"docker image push gcr.io/sample/app:v1",
	];
	for (const cmd of dockerCases) {
		const res = await P.deploy(cmd, { cwd: root, session_id: "docker-opt-test" }, { deployDir });
		assert.ok(res && res.reason, `docker 앞 옵션 명령(${cmd})은 P.deploy 에서 차단되어야 함`);
	}

	// 모르는 옵션이 앞에 오면 막는 쪽(승인 필요)으로 판정
	const unknownOptCases = [
		"gcloud --mystery-flag prod run deploy sample-svc",
		"kubectl --mystery-flag prod apply -f app.yaml",
		"helm --mystery-flag prod upgrade sample-rel ./chart",
		"terraform -mystery=infra apply",
		"fly --mystery-flag app deploy",
		"wrangler --mystery-flag prod deploy",
		"railway --mystery-flag prod up",
		"supabase --mystery-flag x db push",
	];
	for (const cmd of unknownOptCases) {
		const hits = classifyProdMutations(cmd, root);
		assert.ok(hits.length > 0, `모르는 앞 옵션 명령(${cmd})은 막는 쪽으로 분류되어야 함`);
		const res = await P.deploy(cmd, { cwd: root, session_id: "unknown-opt-test" }, { deployDir });
		assert.ok(res && res.reason, `모르는 앞 옵션 명령(${cmd})은 P.deploy 에서 차단되어야 함`);
	}

	// 비운영(-dev) 및 읽기 하위 명령은 앞 옵션이 있어도 정상 통과
	const safeCases = [
		"gcloud --project dev run deploy sample-dev",
		"gcloud --quiet run services update sample-dev --image gcr.io/sample/app:v1",
		"kubectl -n prod get pods",
		"helm -n prod list",
		"terraform -chdir=infra plan",
	];
	for (const cmd of safeCases) {
		const hits = classifyProdMutations(cmd, root);
		assert.equal(hits.length, 0, `읽기/비운영 명령(${cmd})은 오탐 없이 빈 배열이어야 함 (실제: ${JSON.stringify(hits)})`);
	}
});

test("16. 2회차 지적 2 재현: 사전승인(preapprove_steps)에서 s1 미실행 상태로 step-ok 만 부른 뒤 s2 실행 시 차단", async (t) => {
	const { root, stateDir, transcriptPath } = makeWorkspace(t);
	writeGateConfig(root);

	const script1Rel = "scripts/step1.sh";
	const script2Rel = "scripts/step2.sh";
	const script1Abs = path.join(root, script1Rel);
	const script2Abs = path.join(root, script2Rel);
	fs.mkdirSync(path.dirname(script1Abs), { recursive: true });
	fs.writeFileSync(script1Abs, "#!/usr/bin/env bash\naz containerapp update -n sample-web-prod -g sample-rg --image sample/web:v1-stage1\n");
	fs.writeFileSync(script2Abs, "#!/usr/bin/env bash\naz containerapp update -n sample-web-prod -g sample-rg --image sample/web:v1-stage2\n");
	const s1Sha = sha256(fs.readFileSync(script1Abs));
	const s2Sha = sha256(fs.readFileSync(script2Abs));
	const s1Cmd = `bash ${script1Rel} prod`;
	const s2Cmd = `bash ${script2Rel} prod`;

	const { planFile } = createValidPlan(root, {
		scenario: [
			{
				id: "s1",
				title: "1단계 카나리 이미지 반영",
				commands: [s1Cmd],
				files: { [script1Rel]: s1Sha },
				success_check: "카나리 헬스체크 200 확인",
				on_failure: "r1 단계로 즉시 롤백하고 보고",
			},
			{
				id: "s2",
				title: "2단계 본 트래픽 이미지 반영",
				commands: [s2Cmd],
				files: { [script2Rel]: s2Sha },
				success_check: "전체 헬스체크 200 확인",
				on_failure: "r1 단계로 즉시 롤백하고 보고",
			},
			{
				id: "r1",
				branch: "rollback",
				title: "이전 리비전으로 복귀",
				commands: ["az containerapp revision activate -n sample-web-prod -g sample-rg --revision sample-web-prod--prev"],
				success_check: "이전 리비전 트래픽 100% 및 헬스 200 확인",
				on_failure: "트래픽 차단 후 즉시 운영팀에 보고",
			},
		],
	});
	writePassingReviewReceipt(root, planFile);

	const sessionId = "sess-step-skip-test";
	const env = { ...process.env, DEPLOY_APPROVAL_STATE_DIR: stateDir };
	const pre = await deployPlan.preapproveStepCodes(planFile, root, sessionId, env, Date.now());
	assert.equal(pre.ok, true, `preapprove failed: ${pre.why}`);
	const s1Code = pre.steps.find((s) => s.step === "s1")?.code;
	const s2Code = pre.steps.find((s) => s.step === "s2")?.code;
	assert.ok(s1Code && s2Code);

	// 사람이 대화창에 PLAN + s1 + s2 코드를 한 번에 입력
	appendHumanTurn(transcriptPath, `승인: ${pre.plan_code} ${s1Code} ${s2Code}`);

	// s1 을 실제로 실행하지 않고 step-ok 만 먼저 호출해 s1.json 생성
	const workspaceScript = path.join(root, ".agents/scripts/approval-plan.mjs");
	const evFile = path.join(stateDir, "fake-s1-ok.txt");
	fs.writeFileSync(evFile, "HTTP/1.1 200 OK\ncanary=ok\n");
	const stepOkRes = spawnSync(process.execPath, [workspaceScript, "step-ok", planFile, "s1", "--evidence", evFile], { cwd: root, env, encoding: "utf8" });
	assert.equal(stepOkRes.status, 0, stepOkRes.stderr);

	// s1 미실행 상태에서 s2 실행 시도 → 반드시 차단되어야 함
	const skipDecision = runDeployGuardHook(s2Cmd, { cwd: root, root, stateDir, transcriptPath, sessionId });
	assert.ok(skipDecision, "s1 이 executed 되지 않았으면 s1.json 이 있어도 s2 는 차단되어야 함");
	assert.equal(skipDecision.decision, "block");
	assert.match(skipDecision.reason, /s1.*실행되지 않았|executed/i);

	// 이제 s1 을 실제로 실행 → 통과(null)
	const s1Decision = runDeployGuardHook(s1Cmd, { cwd: root, root, stateDir, transcriptPath, sessionId });
	assert.equal(s1Decision, null, `s1 실행은 통과해야 함: ${JSON.stringify(s1Decision)}`);

	// s1 이 executed 된 뒤에는 s2 실행 → 통과(null)
	const s2Decision = runDeployGuardHook(s2Cmd, { cwd: root, root, stateDir, transcriptPath, sessionId });
	assert.equal(s2Decision, null, `s1 실행 및 step-ok 후 s2 실행은 통과해야 함: ${JSON.stringify(s2Decision)}`);
});




