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


