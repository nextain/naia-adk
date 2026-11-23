"use strict";
// Approval gate tests: guard-basics.
const { test, makeWorkspace, writeGateConfig, runDeployGuardHook, assert, createValidPlan, writePassingReviewReceipt, fs, path, REPO_ROOT, classifyProdMutations } = require("./approval-plan-fixtures.cjs");

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

test("3a. 64KB 넘는 승인 양식도 잘리지 않고 JSON 으로 끝까지 나옴 (Long plan block output is not truncated on a pipe)", (t) => {
	// 파이프에 64KB 넘게 쓰고 바로 process.exit 하면 뒷부분이 잘려 판정 JSON 이 깨졌다(2026-11-11, 85KB 계획에서 승인 코드 줄이 사라짐).
	const { root, stateDir, transcriptPath } = makeWorkspace(t);
	writeGateConfig(root);
	const { planFile, step1Cmd } = createValidPlan(root, { what_why: "긴 설명 문장입니다. ".repeat(6000) });
	writePassingReviewReceipt(root, planFile);
	const d = runDeployGuardHook(step1Cmd, { cwd: root, root, stateDir, transcriptPath });
	assert.ok(Buffer.byteLength(JSON.stringify(d)) > 65536, "시험 출력이 64KB 를 넘어야 함");
	assert.equal(d.decision, "block");
	assert.match(d.reason, /승인 코드:\s*PLAN-[0-9A-F]{64}/);
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
