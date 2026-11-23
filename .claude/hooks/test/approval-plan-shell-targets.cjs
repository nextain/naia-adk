"use strict";
// Approval gate tests: shell-targets.
const { test, makeWorkspace, path, REPO_ROOT, fs, assert, runDeployGuardHook, writeGateConfig, classifyProdMutations, sha256, deployPlan, createValidPlan, writePassingReviewReceipt } = require("./approval-plan-fixtures.cjs");

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
