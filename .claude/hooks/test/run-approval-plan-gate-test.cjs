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
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sample-approval-plan-gate-test-"));
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

function writePassingReviewReceipt(root, planFile, options = {}) {
	const gatesDir = path.dirname(planFile);
	const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
	const planSha = sha256(fs.readFileSync(planFile));
	const prompt = deployPlan.reviewPrompt(plan, planSha, root);
	const promptSha = sha256(prompt);
	const manifestSha = deployPlan.reviewInputManifest(planFile, root);

	const fail = options.fail || [];
	const bodyLines = [
		fail.length ? "판정: FAIL" : "판정: PASS",
		...deployPlan.CRITERIA.map(([id]) => (fail.includes(id) ? `${id}: FAIL — 차단 지적 있음` : `${id}: PASS — 계획서 및 고정 스크립트 확인 통과`)),
		...(options.extra || []),
		`참고 지적: 0${options.bodyMarker || ""}`,
		`남은 지적: ${options.open ?? 0}`,
		"",
	];
	const body = bodyLines.join("\n");
	const stdoutSha = sha256(body);
	const finalText = `${body}review-run: target_sha256=${planSha} prompt_sha256=${promptSha} stdout_sha256=${stdoutSha}\n`;
	const reviewer = options.reviewer || "argon";
	const resultRel = `deploy-plan-review-${reviewer}.md`;
	fs.writeFileSync(path.join(gatesDir, resultRel), finalText);

	// 옛 모양(rotation 칸 없음) 기록은 차례 도입 시각 앞선 것만 받으므로 그 앞 시각으로 쓴다.
	const legacyEnd = Date.parse(deployPlan.LEGACY_REVIEW_CUTOFF) - 60_000;
	const startedAt = options.startedAt || new Date(legacyEnd - 2000).toISOString();
	const endedAt = new Date(legacyEnd).toISOString();
	const reviewRecord = {
		plan_sha256: planSha,
		plan: path.relative(root, planFile),
		author_model: plan.author_model,
		prompt_sha256: promptSha,
		reviewedAt: endedAt,
		reviewers: [
			{
				model: deployPlan.REVIEW_MODELS[reviewer].model,
				effort: deployPlan.REVIEW_MODELS[reviewer].effort,
				result: resultRel,
				result_sha256: sha256(finalText),
				target_sha256: planSha,
				receipt: {
					model: deployPlan.REVIEW_MODELS[reviewer].model,
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





test("중첩 대본: 4단계 감싼 운영 변경과 1MB 넘는 안쪽 대본은 확인 불가로 막힘 (#95 검수)", (t) => {
	const { root, stateDir, transcriptPath } = makeWorkspace(t);
	writeGateConfig(root);
	const prodCmd = "az containerapp update -n sample-web-prod -g sample-rg --image sample/web:v1";
	const write = (name, body) => {
		const f = path.join(root, name);
		fs.writeFileSync(f, `#!/usr/bin/env bash\n${body}\n`);
		fs.chmodSync(f, 0o755);
		return f;
	};

	// 대조: 직접·2단계는 운영 변경으로 잡힌다
	write("l1.sh", prodCmd);
	write("l2.sh", "bash ./l1.sh");
	assert.ok(classifyProdMutations("bash ./l2.sh", root).some((h) => !h.unclassified), "2단계 감싸기는 운영 변경으로 잡혀야 함");

	// 4단계: 안을 못 읽으면 빈 결과가 아니라 확인 불가
	write("l3.sh", "bash ./l2.sh");
	write("l4.sh", "bash ./l3.sh");
	const deepHits = classifyProdMutations("bash ./l4.sh", root);
	assert.ok(deepHits.length > 0, "4단계 감싸기가 빈 결과로 통과하면 안 됨");
	const deepDecision = runDeployGuardHook("bash ./l4.sh", { cwd: root, root, stateDir, transcriptPath });
	assert.ok(deepDecision && deepDecision.decision === "block", `4단계 감싸기는 막혀야 함: ${JSON.stringify(deepDecision)}`);

	// 1MB 넘는 대본을 작은 대본 한 겹으로 부름
	write("big.sh", `${prodCmd}\n${"# pad\n".repeat(200000)}`);
	assert.ok(fs.statSync(path.join(root, "big.sh")).size > 1024 * 1024);
	write("small.sh", "bash ./big.sh");
	const bigHits = classifyProdMutations("bash ./small.sh", root);
	assert.ok(bigHits.some((h) => h.unclassified && h.service === "unclassified:script-too-large"), `큰 안쪽 대본은 확인 불가여야 함: ${JSON.stringify(bigHits)}`);
	const bigDecision = runDeployGuardHook("bash ./small.sh", { cwd: root, root, stateDir, transcriptPath });
	assert.ok(bigDecision && bigDecision.decision === "block", `작은 대본으로 감싼 큰 대본은 막혀야 함: ${JSON.stringify(bigDecision)}`);

	// 운영 변경 없는 얕은 대본은 그대로 통과
	write("plain.sh", "echo hi");
	assert.deepEqual(classifyProdMutations("bash ./plain.sh", root), []);
});

test("큰 실행 파일: 셸 대본인지 볼 때 앞부분만 읽고 전체를 읽지 않음 (#98 PC 검수 P2)", (t) => {
	const { root } = makeWorkspace(t);
	writeGateConfig(root);
	const f = path.join(root, "big-tool");
	fs.writeFileSync(f, Buffer.alloc(2 * 1024 * 1024 + 10, 0x41));
	fs.chmodSync(f, 0o755);
	let maxRead = 0;
	const origRead = fs.readFileSync;
	const origReadSync = fs.readSync;
	fs.readFileSync = function (p, ...rest) {
		const out = origRead.call(fs, p, ...rest);
		if (String(p) === f) maxRead = Math.max(maxRead, out.length);
		return out;
	};
	fs.readSync = function (fd, buf, off, len, pos) {
		const n = origReadSync.call(fs, fd, buf, off, len, pos);
		maxRead = Math.max(maxRead, n);
		return n;
	};
	try {
		classifyProdMutations("./big-tool --run", root);
	} finally {
		fs.readFileSync = origRead;
		fs.readSync = origReadSync;
	}
	assert.ok(maxRead <= 4096, `큰 파일을 ${maxRead} 바이트 읽음`);
});

test("testHosts 설정: config/deploy-gate.json 의 시험 기기 목록 받음·막음 검증 (문서용 주소·example 이름만 사용)", (t) => {
	const { root, stateDir, transcriptPath } = makeWorkspace(t);
	writeGateConfig(root, {
		testHosts: ["192.0.2.10", "GPU-BOX.example.", "lab-node.example.com", "*.wildcard.example"],
	});

	// 1) 설정된 시험 기기로의 읽기·루프·복사·사용자 서비스 재시작은 비운영으로 통과
	const allowedCmds = [
		"ssh user@192.0.2.10 nvidia-smi",
		"ssh user@192.0.2.10 'podman ps --format \"{{.Names}}\"'",
		"ssh user@192.0.2.10 'for p in 1 2; do ps -p $p; done'",
		"ssh user@192.0.2.10. ls",
		"ssh -l user gpu-box.example ls",
		"ssh -l user GPU-BOX.EXAMPLE. ls",
		"ssh -l user lab-node.example.com systemctl --user restart sample-worker",
		"scp a.txt user@192.0.2.10:~/work/",
	];
	for (const cmd of allowedCmds) {
		assert.deepEqual(classifyProdMutations(cmd, root), [], `시험 기기 명령은 비운영으로 분류되어야 함: ${cmd}`);
		const decision = runDeployGuardHook(cmd, { cwd: root, root, stateDir, transcriptPath });
		assert.equal(decision, null, `시험 기기 명령은 관문을 통과해야 함: ${cmd}`);
	}

	// 2) 시험 기기 안이라도 원격 본문의 운영 변경(az vm delete 등)은 다시 분류해 차단
	const remoteProdCmd = "ssh user@192.0.2.10 az vm delete -n sample-vm -g sample-rg";
	const remoteProdHits = classifyProdMutations(remoteProdCmd, root);
	assert.ok(remoteProdHits.some((h) => h.service === "azure:vm:sample-vm"), `시험 기기 안 운영 변경은 잡혀야 함: ${JSON.stringify(remoteProdHits)}`);
	const remoteProdDecision = runDeployGuardHook(remoteProdCmd, { cwd: root, root, stateDir, transcriptPath });
	assert.ok(remoteProdDecision && remoteProdDecision.decision === "block", "시험 기기 안 az vm delete 는 막혀야 함");

	// 3) -F·-o HostName 덮어쓰기는 비운영 판정을 하지 않고 차단
	for (const overrideCmd of [
		"ssh -o HostName=192.0.2.20 user@192.0.2.10 sudo systemctl restart sample",
		"ssh -F /tmp/custom_ssh_config user@192.0.2.10 sudo systemctl restart sample",
	]) {
		const hits = classifyProdMutations(overrideCmd, root);
		assert.ok(hits.length > 0, `덮어쓰기 옵션 명령은 막아야 함: ${overrideCmd}`);
		const decision = runDeployGuardHook(overrideCmd, { cwd: root, root, stateDir, transcriptPath });
		assert.ok(decision && decision.decision === "block", `덮어쓰기 옵션 명령은 훅에서 막혀야 함: ${overrideCmd}`);
	}

	// 4) 목록 밖 호스트와 와일드카드 이름은 비운영으로 보지 않음
	for (const blockedCmd of [
		"ssh user@192.0.2.11 sudo systemctl restart sample",
		"ssh -l user prod-host.example sudo systemctl restart sample",
		"ssh -l user sub.gpu-box.example sudo systemctl restart sample",
		"ssh -l user host.wildcard.example sudo systemctl restart sample",
	]) {
		const hits = classifyProdMutations(blockedCmd, root);
		assert.ok(hits.length > 0, `목록 밖/와일드카드 호스트는 운영으로 분류되어야 함: ${blockedCmd}`);
	}

	// 5) 설정이 없거나 깨졌으면 빈 목록(기존 동작대로 막힘)
	const cfgPath = path.join(root, "config", "deploy-gate.json");
	fs.writeFileSync(cfgPath, "{ broken json");
	assert.ok(classifyProdMutations("ssh user@192.0.2.10 'for p in 1 2; do ps -p $p; done'", root).length > 0, "깨진 설정일 때는 시험 기기 예외가 적용되지 않아야 함");
	fs.rmSync(cfgPath, { force: true });
	assert.ok(classifyProdMutations("ssh user@192.0.2.10 'for p in 1 2; do ps -p $p; done'", root).length > 0, "설정 파일이 없을 때는 시험 기기 예외가 적용되지 않아야 함");
});


test("local systemd: configured mutations require a plan across shell forms", (t) => {
	const { root, stateDir, transcriptPath } = makeWorkspace(t);
	const service = "local:systemd:sample-web";
	writeGateConfig(root, { services: { [service]: { requireDeployGate: false, allowOps: true, paths: ["/opt/sample-web"] } } });
	const commands = [
		...["stop", "start", "restart", "reload", "enable", "disable", "mask", "kill"].map(v => `/usr/bin/sudo /usr/bin/env MODE=sample /usr/bin/systemctl ${v} sample-web.service sample-web.socket`),
		"sh -c 'systemctl stop sample-web'", "sudo sh -c 'systemctl stop sample-web'",
		"bash -c 'systemctl stop sample-web.socket'", "( systemctl restart sample-web )",
		"for unit in sample-web; do systemctl stop $unit; done",
		"for unit in 'sample-web'; do systemctl stop \"$unit\"; done",
		"echo ready && systemctl stop sample-web; echo done",
		"install source /etc/systemd/system/sample-web.service",
		"cp /tmp/sample-web.service /etc/systemd/system/", "install -t /etc/systemd/system /tmp/sample-web.service",
		"cp source /etc/systemd/system/sample-web.service.d/override.conf",
		"mv source /etc/systemd/system/sample-web.socket", "mv /tmp/sample-web.service /etc/systemd/system/",
		"rm -r /etc/systemd/system/sample-web.service.d",
		"echo data | tee /etc/systemd/system/sample-web.service.d/override.conf",
		"sed -i s/a/b/ /etc/systemd/system/sample-web.service",
		"rm /etc/systemd/system/sample-web.service", "ln -s source /etc/systemd/system/sample-web.service",
		"cp source /opt/sample-web/releases/current", "rm /opt/sample-web/old",
		"mv -t /tmp /opt/sample-web/current", "install -d /opt/sample-web /tmp/sample-dir",
	];
	for (const command of commands) {
		assert.equal(runDeployGuardHook(command, { cwd: root, root, stateDir, transcriptPath })?.decision, "block", command);
		const hits = classifyProdMutations(command, root, 0, false, root);
		assert.ok(hits.some(h => h.service === service), command);
	}
	for (const command of ["systemctl status sample-web", "systemctl status stop sample-web", "sed -i /opt/sample-web /tmp/unrelated", "systemctl show sample-web", "systemctl is-active sample-web", "systemctl cat sample-web", "systemctl list-units sample-web", "systemctl stop sample-other", "cp /opt/sample-web/readme /tmp/sample-copy", "cp source /opt/sample-web-other/file", "cat /etc/systemd/system/sample-web.service"]) {
		assert.deepEqual(classifyProdMutations(command, root, 0, false, root), [], command);
	}
});

test("local systemd: reviewed plan issues PLAN and STEP codes", (t) => {
	const { root, stateDir, transcriptPath } = makeWorkspace(t);
	const service = "local:systemd:sample-web";
	writeGateConfig(root, { services: { [service]: { requireDeployGate: false, allowOps: true } } });
	const command = "systemctl restart sample-web.service";
	const { planFile } = createValidPlan(root, { services: [service], scenario: [{ id: "s1", title: "Restart sample", commands: [command], success_check: "Check status", on_failure: "Report failure" }], rollback: { method: "Restart sample", duration: "1 minute", step_ids: ["s1"] } });
	writePassingReviewReceipt(root, planFile);
	const d1 = runDeployGuardHook(command, { cwd: root, root, stateDir, transcriptPath });
	const code = d1?.reason.match(/승인 코드:\s*(PLAN-[A-Z0-9]{6})/);
	assert.ok(code, JSON.stringify(d1));
	appendHumanTurn(transcriptPath, `계획 승인합니다 ${code[1]}`);
	const d2 = runDeployGuardHook(command, { cwd: root, root, stateDir, transcriptPath });
	assert.match(d2?.reason || "", /단계 승인 코드:\s*STEP-[A-Z0-9]{6}/);
	assert.equal(d2.decision, "block");
	const stepCode = d2.reason.match(/단계 승인 코드:\s*(STEP-[A-Z0-9]{6})/)[1];
	appendHumanTurn(transcriptPath, `단계 승인합니다 ${stepCode}`);
	assert.equal(runDeployGuardHook(command, { cwd: root, root, stateDir, transcriptPath }), null);

});

const localRegressionCases = {
 "F-1 redirection": ["printf x > /etc/systemd/system/sample-web.service", "echo x >> /etc/systemd/system/sample-web.service.d/override.conf", "cat /tmp/sample-source >| /opt/sample-web/app.conf", "echo x &> /opt/sample-web/app.conf"],
 "F-2 unresolved expansion": ["U=sample-web; systemctl stop $U", "U=sample-web systemctl stop $U", "systemctl stop ${U}", "for U in sample-other; do echo $U; done; U=sample-web; systemctl stop $U", "for U in sample-other $OTHER; do systemctl stop $U; done", "systemctl stop $(printf sample-web)", "systemctl stop `printf sample-web`"],
 "F-3 unit glob": ["systemctl stop 'sample-*'", "systemctl stop sample-web?", "systemctl stop 'sample-[w]eb.service'"],
 "F-4 global daemon reload": ["systemctl daemon-reload"],
 "F-5 stdin target": ["echo sample-web | xargs systemctl stop", "xargs -a /tmp/sample-units systemctl stop", "systemctl stop < /tmp/sample-units"],
 "F-6 service wrapper": ["service sample-web stop", "sudo service sample-web restart", "service $U restart"],
 "F-7 enablement": ["systemctl preset sample-web.service", "systemctl add-wants sample-other.target sample-web.service", "systemctl add-requires sample-other.target sample-web.service"],
 "F-8 write tools": ["dd if=/tmp/sample-source of=/etc/systemd/system/sample-web.service", "truncate -s0 /opt/sample-web/app.conf", "truncate --size 0 /opt/sample-web/app.conf", "rsync -a /tmp/sample-source/ /opt/sample-web/", "chmod 644 /etc/systemd/system/sample-web.service", "chmod -w /opt/sample-web/app.conf", "chmod --reference /tmp/sample-mode /opt/sample-web/app.conf", "chown --reference=/tmp/sample-owner /opt/sample-web/app.conf", "chown sample-user /opt/sample-web/app.conf", "install -m 644 /tmp/sample-source /opt/sample-web/app.conf"],
 "F-9 link path": ["systemctl link /tmp/sample-web.service"],
};
for (const [finding, commands] of Object.entries(localRegressionCases)) test(`local systemd regression: ${finding}`, t => {
 const {root, stateDir, transcriptPath} = makeWorkspace(t);
 const service = "local:systemd:sample-web";
 writeGateConfig(root, {services: {[service]: {paths: ["/opt/sample-web"]}}});
 for (const command of commands) {
  assert.ok(classifyProdMutations(command, root, 0, false, root).some(h => h.service === service), command);
  assert.equal(runDeployGuardHook(command, {cwd:root, root, stateDir, transcriptPath})?.decision, "block", command);
 }
});
test("local systemd regression: precise unrelated targets and reads stay open", t => {
 const {root,stateDir,transcriptPath} = makeWorkspace(t);
 writeGateConfig(root, {services: {"local:systemd:sample-web": {paths:["/opt/sample-web"]}}});
 for (const command of ["systemctl --user daemon-reload", "systemctl stop sample-other", "systemctl status sample-web", "service sample-web status", "cp sample-source /opt/sample-web2/file", "cat /etc/systemd/system/sample-web.service", "dd if=/opt/sample-web/app.conf of=/tmp/sample-output", "rsync /opt/sample-web/app.conf /tmp/sample-output", "chmod --reference /opt/sample-web/app.conf /tmp/sample-output", "chown --reference=/opt/sample-web/app.conf /tmp/sample-output"]) {
  assert.deepEqual(classifyProdMutations(command, root, 0, false, root), [], command);
  assert.equal(runDeployGuardHook(command,{cwd:root,root,stateDir,transcriptPath}),null,command);
 }
});

test("local systemd regression: globs select matching registered units", t => {
 const {root} = makeWorkspace(t);
 writeGateConfig(root, {services: {"local:systemd:sample-web": {}, "local:systemd:sample-api": {}}});
 assert.deepEqual(classifyProdMutations("systemctl stop 'sample-web*'",root,0,false,root).map(h => h.service), ["local:systemd:sample-web"]);
});
for (const changed of [false,true]) test(`local systemd approval: ${changed ? "changed plan invalidates codes" : "STEP is consumed once"}`, async t => {
 const {root,stateDir,transcriptPath} = makeWorkspace(t);
 const service = "local:systemd:sample-web", command = "systemctl restart sample-web.service", sessionId = "sample-local-approval";
 writeGateConfig(root, {services:{[service]:{requireDeployGate:false,allowOps:true}}});
 const {planFile,plan} = createValidPlan(root, {services:[service],scenario:[{id:"s1",title:"Restart sample",commands:[command],success_check:"Check status",on_failure:"Report failure"}],rollback:{method:"Restart sample",duration:"1 minute",step_ids:["s1"]}});
 writePassingReviewReceipt(root,planFile);
 const pre = await deployPlan.preapproveStepCodes(planFile,root,sessionId,{...process.env,DEPLOY_APPROVAL_STATE_DIR:stateDir},Date.now());
 assert.equal(pre.ok,true,pre.why);
 appendHumanTurn(transcriptPath,`승인 ${pre.plan_code} ${pre.steps.find(s=>s.step==="s1").code}`);
 if(changed) fs.writeFileSync(planFile,JSON.stringify({...plan,what_why:"Changed sample reason after approval"}));
 else assert.equal(runDeployGuardHook(command,{cwd:root,root,stateDir,transcriptPath,sessionId}),null);
 const decision=runDeployGuardHook(command,{cwd:root,root,stateDir,transcriptPath,sessionId});
 assert.equal(decision?.decision,"block");
 assert.match(decision.reason,changed ? /적대 리뷰를 통과하지 않아|지금 계획서가 아닌 판을 검수함/ : /단계 승인 필요/);
});
test("local systemd regression: unresolved write destinations fail closed", t => {
 const {root,stateDir,transcriptPath} = makeWorkspace(t);
 writeGateConfig(root,{services:{"local:systemd:sample-web":{paths:["/opt/sample-web"]}}});
 for(const command of ["echo x > $P","cp /tmp/sample-source $P","dd of=${P}","truncate -s0 /opt/sample-*/app.conf"]) {
  assert.ok(classifyProdMutations(command,root,0,false,root).some(h=>h.service==="local:systemd:sample-web"),command);
  assert.equal(runDeployGuardHook(command,{cwd:root,root,stateDir,transcriptPath})?.decision,"block",command);
 }
});

test("local systemd regression: comma separated negative chmod modes", t => {
 const {root,stateDir,transcriptPath} = makeWorkspace(t);
 writeGateConfig(root,{services:{"local:systemd:sample-web":{paths:["/opt/sample-web"]}}});
 for(const command of ["chmod -w,+x /opt/sample-web/app.conf", "chmod -w,u+x /opt/sample-web/app.conf"]) {
  assert.ok(classifyProdMutations(command,root,0,false,root).some(h=>h.service==="local:systemd:sample-web"),command);
  assert.equal(runDeployGuardHook(command,{cwd:root,root,stateDir,transcriptPath})?.decision,"block",command);
 }
});

test("temporary reviewer selection defaults safely and expires", (t) => {
 const { root } = makeWorkspace(t);
 const now = Date.now();
 const configPath = path.join(root, ".claude/deploy/config.json");
 const set = (planReview) => { fs.mkdirSync(path.dirname(configPath), { recursive: true }); fs.writeFileSync(configPath, JSON.stringify({ planReview })); fs.utimesSync(configPath, new Date(now - 1000), new Date(now - 1000)); };
 assert.deepEqual(deployPlan.reviewerIdsFor("muse", root, now), ["argon"]);
 set({ reviewer: "codex", until: new Date(now + 60000).toISOString(), reason: "temporary" });
 assert.deepEqual(deployPlan.reviewerIdsFor("muse", root, now), ["codex"]);
 set({ reviewer: "codex", until: new Date(now - 60000).toISOString(), reason: "temporary" });
 assert.deepEqual(deployPlan.reviewerIdsFor("muse", root, now), ["argon"]);
 set({ reviewer: "sol", until: new Date(now + 60000).toISOString(), reason: "temporary" });
 assert.deepEqual(deployPlan.reviewerIdsFor("muse", root, now), ["argon"]);
 for (const until of [undefined, "invalid"]) {
  set({ reviewer: "codex", until, reason: "temporary" });
  assert.deepEqual(deployPlan.reviewerIdsFor("muse", root, now), ["argon"]);
 }
 fs.writeFileSync(configPath, "{");
 assert.throws(() => deployPlan.reviewerIdsFor("muse", root, now));
 assert.ok(!deployPlan.formProblems({ schema: "deploy-plan/v1", author_model: "codex" }).some(p => p.includes("author_model")), "차례 셋(codex)은 새 작성자로 받는다");
 assert.ok(deployPlan.formProblems({ schema: "deploy-plan/v1", author_model: "gemini" }).some(p => p.includes("author_model")));
});

test("codex receipt remains valid after configuration changes", (t) => {
 const { root } = makeWorkspace(t);
 const { planFile, gatesDir } = createValidPlan(root);
 const { planSha } = writePassingReviewReceipt(root, planFile, { reviewer: "codex" });
 const result = deployPlan.reviewProblems(gatesDir, planSha, root);
 assert.equal(result.ok, true, result.problems.join("; "));
 const configPath = path.join(root, ".claude/deploy/config.json");
 fs.mkdirSync(path.dirname(configPath), { recursive: true });
 fs.writeFileSync(configPath, JSON.stringify({ planReview: { reviewer: "argon" } }));
 assert.equal(deployPlan.reviewProblems(gatesDir, planSha, root).ok, true);
});

test("same author and unregistered reviewer receipts are rejected", (t) => {
 const { root } = makeWorkspace(t);
 const { planFile, gatesDir } = createValidPlan(root);
 const { planSha } = writePassingReviewReceipt(root, planFile);
 const file = path.join(gatesDir, deployPlan.REVIEW_FILE);
 const record = JSON.parse(fs.readFileSync(file));
 for (const model of [deployPlan.REVIEW_MODELS.muse.model, "unregistered-model"]) {
  record.reviewers[0].model = model;
  record.reviewers[0].receipt.model = model;
  fs.writeFileSync(file, JSON.stringify(record));
  assert.equal(deployPlan.reviewProblems(gatesDir, planSha, root).ok, false);
 }
});

test("fake codex reviewer runs through the complete review flow", (t) => {
 const { root, tmp, stateDir } = makeWorkspace(t);
 const { planFile, gatesDir } = createValidPlan(root);
 const init = spawnSync("git", ["init", "-q", root], { encoding: "utf8" });
 assert.equal(init.status, 0, init.stderr);
 const configPath = path.join(root, ".claude/deploy/config.json");
 fs.mkdirSync(path.dirname(configPath), { recursive: true });
 fs.writeFileSync(configPath, JSON.stringify({ planReview: { reviewer: "codex", until: new Date(Date.now() + 60000).toISOString(), reason: "temporary" } }));
 const binDir = path.join(tmp, "bin"), fakeHome = path.join(tmp, "home");
 fs.mkdirSync(binDir); fs.mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
 const bwrap = path.join(binDir, "bwrap"), codex = path.join(binDir, "fake-codex");
 fs.writeFileSync(bwrap, '#!/bin/sh\nwhile [ "$1" != "--" ] && [ "$#" -gt 0 ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 });
 const body = ["판정: PASS", ...deployPlan.CRITERIA.map(([id]) => `${id}: PASS`), "남은 지적: 0"].join("\n");
 fs.writeFileSync(codex, `#!/bin/sh\n[ "$1" = exec ] || exit 19\nfor arg do last="$arg"; done\n[ "$last" = - ] || exit 20\ncat >/dev/null\nprintf 'codex\\n'\ncat <<'REVIEW_EOF'\n${body}\nREVIEW_EOF\nprintf 'tokens used\\n'\n`, { mode: 0o755 });
 const run = spawnSync(process.execPath, [path.join(root, ".agents/scripts/approval-plan.mjs"), "review", planFile, "--author", "muse"], {
  cwd: root, encoding: "utf8", timeout: 30000,
  env: { ...process.env, HOME: fakeHome, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, APPROVAL_PLAN_CODEX_BIN: codex, DEPLOY_APPROVAL_STATE_DIR: stateDir },
 });
 assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
 const record = JSON.parse(fs.readFileSync(path.join(gatesDir, deployPlan.REVIEW_FILE), "utf8"));
 assert.equal(record.reviewers[0].model, "gpt-6.1-terra");
 assert.equal(record.reviewers[0].receipt.isolation, "bwrap-ro-bind");
 assert.match(fs.readFileSync(path.join(gatesDir, record.reviewers[0].result), "utf8"), /review-run: .*\n$/);
});


test("reviewer configuration boundaries are fail closed", (t) => {
 const { root } = makeWorkspace(t);
 const now = Date.parse("2026-11-10T00:00:00Z");
 const file = path.join(root, ".claude/deploy/config.json");
 const set = (value) => { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, JSON.stringify(value)); };
 assert.deepEqual(deployPlan.reviewerIdsFor("muse", root, now), ["argon"]);
 for (const until of ["2026-11-09T23:59:59Z", "2026-11-10T00:00:00Z", "invalid", "2026-02-30T23:40:00Z", "2025-02-29T00:00:00Z", "2026-13-01T00:00:00Z", "2026-00-10T00:00:00Z", "2026-01-00T00:00:00Z", "2026-11-13", 123]) {
  set({planReview:{reviewer:"codex", until}});
  assert.deepEqual(deployPlan.reviewerIdsFor("muse", root, now), ["argon"], String(until));
 }
 for (const reviewer of ["sol", "argon", "CODEX", " codex"]) {
  set({planReview:{reviewer, until:"2026-11-13T00:00:00Z"}});
  assert.deepEqual(deployPlan.reviewerIdsFor("muse", root, now), ["argon"], reviewer);
 }
 for (const planReview of [undefined, "codex"]) {
  set({planReview}); assert.deepEqual(deployPlan.reviewerIdsFor("muse", root, now), ["argon"]);
 }
 for (const until of ["2026-11-13T23:40:00+09:00", "2026-11-13T23:40:00.123Z"]) {
  set({planReview:{reviewer:"codex", until}}); assert.deepEqual(deployPlan.reviewerIdsFor("muse", root, now), ["codex"]);
 }
 fs.writeFileSync(file, "{"); assert.throws(() => deployPlan.reviewerIdsFor("muse", root, now));
});

test("review gate enforces reviewer identity, count and effort", (t) => {
 const {root} = makeWorkspace(t);
 const {planFile, gatesDir} = createValidPlan(root);
 const file = path.join(gatesDir, deployPlan.REVIEW_FILE);
 for (const reviewer of ["argon", "codex"]) {
  const {planSha} = writePassingReviewReceipt(root, planFile, {reviewer});
  const valid = JSON.parse(fs.readFileSync(file));
  const check = (record, expected, label) => { fs.writeFileSync(file, JSON.stringify(record)); const result = deployPlan.reviewProblems(gatesDir, planSha, root); assert.equal(result.ok, expected, `${label}: ${result.problems.join('; ')}`); };
  check(valid, true, reviewer);
  for (const [label, change] of [
   ["zero", r => {r.reviewers=[];}],
   ["two", r => {r.reviewers.push(structuredClone(r.reviewers[0]));}],
   ["muse", r => {r.reviewers[0].model=deployPlan.REVIEW_MODELS.muse.model; r.reviewers[0].receipt.model=r.reviewers[0].model;}],
   ["sol", r => {r.reviewers[0].model=deployPlan.REVIEW_MODELS.sol.model; r.reviewers[0].receipt.model=r.reviewers[0].model;}],
   ["id mismatch", r => {r.reviewers[0].id=reviewer === "argon" ? "codex" : "argon";}],
   ["effort", r => {r.reviewers[0].effort="wrong";}],
  ]) { const rec=structuredClone(valid); change(rec); check(rec, false, `${reviewer} ${label}`); }
 }
});

test("legacy authors still require their two distinct reviewers", (t) => {
 for (const author of ["sol", "argon"]) {
  const {root} = makeWorkspace(t);
  const {planFile, gatesDir} = createValidPlan(root, {author_model:author});
  const file = path.join(gatesDir, deployPlan.REVIEW_FILE);
  const ids = deployPlan.reviewerIdsFor(author, root);
  const entries = [];
  let planSha;
  for (const reviewer of ids) {
   ({planSha} = writePassingReviewReceipt(root, planFile, {reviewer, bodyMarker:` ${reviewer}`}));
   entries.push(JSON.parse(fs.readFileSync(file)).reviewers[0]);
  }
  const record = JSON.parse(fs.readFileSync(file)); record.reviewers=entries;
  fs.writeFileSync(file, JSON.stringify(record));
  let result = deployPlan.reviewProblems(gatesDir, planSha, root);
  assert.equal(result.ok, true, `${author}: ${result.problems.join('; ')}`);
  record.reviewers.pop(); fs.writeFileSync(file, JSON.stringify(record));
  result = deployPlan.reviewProblems(gatesDir, planSha, root);
  assert.equal(result.ok, false, author);
 }
});

test("codex reviewer refuses to run without bwrap outside recovery mode", (t) => {
 const {root, tmp, stateDir} = makeWorkspace(t);
 const {planFile} = createValidPlan(root);
 assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
 const configPath = path.join(root, ".claude/deploy/config.json");
 fs.mkdirSync(path.dirname(configPath), {recursive:true});
 fs.writeFileSync(configPath, JSON.stringify({planReview:{reviewer:"codex", until:new Date(Date.now()+60000).toISOString()}}));
 const binDir=path.join(tmp,"bin"), fakeHome=path.join(tmp,"home"), marker=path.join(tmp,"ran"), codex=path.join(binDir,"fake-codex");
 fs.mkdirSync(binDir); fs.mkdirSync(fakeHome);
 fs.symlinkSync(process.platform === "win32" ? "git.exe" : "/usr/bin/git", path.join(binDir,"git"));
 fs.writeFileSync(codex, `#!/bin/sh\n : > "${marker}"\nexit 0\n`, {mode:0o755});
 const run=spawnSync(process.execPath,[path.join(root,".agents/scripts/approval-plan.mjs"),"review",planFile,"--author","muse"], {cwd:root, encoding:"utf8", timeout:30000, env:{...process.env, HOME:fakeHome, PATH:binDir, APPROVAL_PLAN_CODEX_BIN:codex, DEPLOY_APPROVAL_STATE_DIR:stateDir}});
 assert.notEqual(run.status, 0, `${run.stdout}\n${run.stderr}`);
 assert.match(`${run.stdout}\n${run.stderr}`, /sandbox-prepare/);
 assert.equal(fs.existsSync(marker), false);
});

test("위험 수용: security FAIL 하나만, 결정 글·같은 값·끝나는 날이 맞을 때만 리뷰 관문을 지남", (t) => {
	const goodRa = () => ({ criterion: "security", accepted_by: "approver", decision_url: "https://discord.com/channels/1/2/3", same_value_as: "앞 판 번들 같은 지문 0123456789ab", no_new_exposure: true, expires_at: new Date(Date.now() + 86400000).toISOString(), reason: "이미 공개된 같은 시연 값, 새 노출 없음" });
	const secLine = ["1. [차단: security] 공개 번들에 시연 값"];
	const cases = [
		{ desc: "맞는 위험 수용 + security FAIL 만", ra: goodRa(), fail: ["security"], open: 1, extra: secLine, pass: true },
		{ desc: "위험 수용 + correctness 도 FAIL", ra: goodRa(), fail: ["security", "correctness"], open: 1, extra: secLine, pass: false },
		{ desc: "위험 수용 + security 차단 지적 두 건(두 번째 새 비밀)", ra: goodRa(), fail: ["security"], open: 2, extra: [...secLine, "2. [차단: security] 새 열쇠가 번들에 들어감"], pass: false },
		{ desc: "위험 수용 + security 차단 지적 두 건, 남은 지적 1로 적음", ra: goodRa(), fail: ["security"], open: 1, extra: [...secLine, "2. [차단: security] 새 열쇠가 번들에 들어감"], pass: false },
		{ desc: "위험 수용 + security 아닌 차단 지적", ra: goodRa(), fail: ["security"], open: 2, extra: [...secLine, "2. [차단: 불일치] 명령이 다름"], pass: false },
		{ desc: "결정 글 주소 없음", ra: { ...goodRa(), decision_url: "" }, fail: ["security"], open: 1, extra: secLine, pass: false },
		{ desc: "새 노출", ra: { ...goodRa(), no_new_exposure: false }, fail: ["security"], open: 1, extra: secLine, pass: false },
		{ desc: "다른 기준 수용", ra: { ...goodRa(), criterion: "rollback" }, fail: ["rollback"], open: 0, extra: [], pass: false },
		{ desc: "끝나는 날 8일 뒤", ra: { ...goodRa(), expires_at: new Date(Date.now() + 8 * 86400000).toISOString() }, fail: ["security"], open: 1, extra: secLine, pass: false },
		{ desc: "끝나는 날 지남", ra: { ...goodRa(), expires_at: new Date(Date.now() - 1000).toISOString() }, fail: ["security"], open: 1, extra: secLine, pass: false, createdAt: new Date(Date.now() - 3600000).toISOString() },
		{ desc: "위험 수용 없음", ra: undefined, fail: ["security"], open: 1, extra: secLine, pass: false },
	];
	for (const c of cases) {
		const { root } = makeWorkspace(t);
		writeGateConfig(root);
		const overrides = {};
		if (c.ra) overrides.risk_acceptance = c.ra;
		if (c.createdAt) overrides.createdAt = c.createdAt;
		const { planFile, gatesDir } = createValidPlan(root, overrides);
		const { planSha } = writePassingReviewReceipt(root, planFile, { fail: c.fail, open: c.open, extra: c.extra });
		const review = deployPlan.reviewProblems(gatesDir, planSha, root);
		assert.equal(review.ok, c.pass, `${c.desc}: ${review.problems.join(" / ")}`);
	}
});
