"use strict";
// Approval gate tests: plan-schema.
const { test, makeWorkspace, writeGateConfig, createValidPlan, path, fs, assert, deployPlan, spawnSync, writePassingReviewReceipt, sha256 } = require("./approval-plan-fixtures.cjs");

test("architecture_fit(최초 요구·붙는 상위 구조·수용 방식) 통과·차단 및 CLI 검사", (t) => {
	const { root, stateDir } = makeWorkspace(t);
	writeGateConfig(root);
	const { planFile } = createValidPlan(root);
	const env = { ...process.env, DEPLOY_APPROVAL_STATE_DIR: stateDir };
	const workspaceScript = path.join(root, ".agents/scripts/approval-plan.mjs");
	const base = JSON.parse(fs.readFileSync(planFile, "utf8"));
	assert.deepEqual(deployPlan.formProblems(base), [], "기본 계획서는 architecture_fit 포함 시 양식 통과해야 함");
	assert.ok(deployPlan.CRITERIA.some(([id]) => id === "architecture_fit"), "적대 리뷰 기준에 architecture_fit 포함");

	const report = deployPlan.renderReport(base, "a".repeat(64));
	assert.match(report, /최초 요구:/);
	assert.match(report, /붙는 상위 구조:/);
	assert.match(report, /수용 방식:/);

	// 1. 누락·비객체·빈 칸·짧은 칸·견본 자리표시자 차단
	const missingPlan = { ...base };
	delete missingPlan.architecture_fit;
	assert.ok(deployPlan.formProblems(missingPlan).some((m) => m.includes("architecture_fit")), "architecture_fit 자체가 없으면 차단");

	for (const badFit of [null, [], "text"]) {
		assert.ok(deployPlan.formProblems({ ...base, architecture_fit: badFit }).some((m) => m.includes("architecture_fit")), "architecture_fit 이 객체가 아니면 차단");
	}

	const shortPlan = {
		...base,
		architecture_fit: { original_request: "짧음", parent_structure: "짧다", acceptance_rationale: "그냥 수정" },
	};
	const shortMsgs = deployPlan.formProblems(shortPlan);
	assert.equal(shortMsgs.filter((m) => m.startsWith("architecture_fit.")).length, 3, "세 칸 모두 최소 길이 미만이면 각각 차단");

	const placeholderPlan = {
		...base,
		architecture_fit: {
			original_request: "<누가 무엇을 바랐는지 최초 요구 원문 요지 (최소 10자)>",
			parent_structure: "<붙는 플랫폼·ADK 업스트림·제품 상위 구조>",
			acceptance_rationale: "<이 상위 구조가 기존 확장 또는 새 층으로 받아들이는 근거>",
		},
	};
	const phMsgs = deployPlan.formProblems(placeholderPlan);
	assert.ok(phMsgs.filter((m) => m.includes("견본 문구")).length === 3, "견본 <...> 문구 그대로면 세 칸 모두 차단");

	// 1-2. 참고-3: 부분 견본(<...> 섞임) 차단 및 디스코드 멘션(<@id>) 오탐 방지
	for (const partial of ["원문 <추가> 반영 요청", "<최초 요구> 를 정리한 문장", "기존 계층 <TODO> 확장 적용"]) {
		const probs = deployPlan.formProblems({
			...base,
			architecture_fit: { ...base.architecture_fit, original_request: partial },
		});
		assert.ok(probs.some((m) => m.includes("견본 문구")), `부분 견본 '${partial}' 는 차단돼야 함: ${JSON.stringify(probs)}`);
	}
	assert.deepEqual(
		deployPlan.formProblems({
			...base,
			architecture_fit: { ...base.architecture_fit, original_request: "<@123456> 님이 공통 배포 게이트 개선을 요청함" },
		}),
		[],
		"디스코드 멘션 <@id> 포함 원문은 부분 견본으로 오탐하지 않음",
	);

	// 2. (b)가 특정 서버·IP·서비스 키·단일 파일명뿐이면 차단 (띄어쓰기 없는 좁은 표현 포함)
	const narrowParents = [
		"prod-app-01",
		"prod-app-01 서버만 수정",
		"/etc/systemd/system/sample.service 파일만 수정",
		"deploy-plan.js 한 파일",
		"azure:containerapp:sample-web-prod",
		"azure:containerapp:sample-web-prod 서비스만",
		"192.0.2.40 호스트 재시작",
		"app-01.internal 호스트의 nginx.conf만 변경",
		"단일 VM 서비스 배포",
		"특정서버호스트만수정",
		"단일컨테이너재시작",
	];
	for (const narrow of narrowParents) {
		const probs = deployPlan.formProblems({
			...base,
			architecture_fit: { ...base.architecture_fit, parent_structure: narrow },
		});
		assert.ok(
			probs.some((m) => m.includes("특정 서버·서비스 키·단일 파일명만 가리킴")),
			`좁은 (b) '${narrow}' 는 차단돼야 함: ${JSON.stringify(probs)}`,
		);
	}

	// 3. 경로·서비스를 언급하더라도 붙는 상위 구조 설명이 함께 있거나 띄어쓰기 없는 정식 구조명이면 통과
	const validParents = [
		"naia-adk 승인 계획 게이트 및 azure 컨테이너 앱 공통 배포 계층",
		"naia-adk/.claude/hooks/lib/deploy-plan.js 승인 계획 게이트 공통 계층",
		"플랫폼 공통 systemd 배포 표준 및 승인 계획 게이트",
		"플랫폼공통배포계층표준",
		"공통인증게이트웨이구조",
	];
	for (const parent of validParents) {
		const probs = deployPlan.formProblems({
			...base,
			architecture_fit: { ...base.architecture_fit, parent_structure: parent },
		});
		assert.deepEqual(probs, [], `상위 구조 '${parent}' 는 통과해야 함`);
	}

	// 4. approval-plan.mjs CLI check 연동 확인(좁은 (b) 차단 → 정상 복구 시 통과) + 적대 리뷰 architecture_fit FAIL 차단
	const badGatesDir = path.join(root, ".agents", "progress", "bad-arch-fit", "gates");
	fs.mkdirSync(badGatesDir, { recursive: true });
	const badFile = path.join(badGatesDir, "deploy-plan.json");
	fs.writeFileSync(badFile, JSON.stringify({
		...base,
		architecture_fit: { ...base.architecture_fit, parent_structure: "/opt/sample/deploy.sh 스크립트 파일 수정" },
	}, null, 2));
	const badChk = spawnSync(process.execPath, [workspaceScript, "check", badFile], { cwd: root, env, encoding: "utf8" });
	assert.notEqual(badChk.status, 0, "좁은 parent_structure 계획서는 CLI check 에서 실패해야 함");
	assert.match(badChk.stdout, /특정 서버·서비스 키·단일 파일명만 가리킴/);

	writePassingReviewReceipt(root, planFile, { fail: ["architecture_fit"], open: 1 });
	const failRevChk = spawnSync(process.execPath, [workspaceScript, "check", planFile], { cwd: root, env, encoding: "utf8" });
	assert.notEqual(failRevChk.status, 0, "적대 리뷰 architecture_fit FAIL 시 check 통과 불가");

	writePassingReviewReceipt(root, planFile);
	const goodChk = spawnSync(process.execPath, [workspaceScript, "check", planFile], { cwd: root, env, encoding: "utf8" });
	assert.equal(goodChk.status, 0, `${goodChk.stdout}\n${goodChk.stderr}`);
	assert.match(goodChk.stdout, /양식: 통과/);
	assert.match(goodChk.stdout, /적대 리뷰: 통과/);
});

test("참고-4: 기준 시각 이전 옛 계획서·기존 승인 영수증은 경고만 남기고 막지 않으며, 새 판(version 2·기준 이후)만 차단", async (t) => {
	const { root, stateDir } = makeWorkspace(t);
	writeGateConfig(root);
	const legacyGatesDir = path.join(root, ".agents", "progress", "legacy-work", "gates");
	const { planFile: tmpPlanFile, step1Cmd } = createValidPlan(root);
	const templatePlan = JSON.parse(fs.readFileSync(tmpPlanFile, "utf8"));
	fs.rmSync(path.dirname(path.dirname(tmpPlanFile)), { recursive: true, force: true });

	const legacyCreatedAt = "2026-11-15T04:00:00.000Z";
	const legacyPlan = { ...templatePlan, planId: "legacy-work-01", createdAt: legacyCreatedAt };
	delete legacyPlan.architecture_fit;
	delete legacyPlan.version;

	fs.mkdirSync(legacyGatesDir, { recursive: true });
	const legacyPlanFile = path.join(legacyGatesDir, "deploy-plan.json");
	fs.writeFileSync(legacyPlanFile, JSON.stringify(legacyPlan, null, 2));

	assert.equal(deployPlan.requiresArchitectureFit(legacyPlan), false, "기준 시각 이전 옛 계획서는 architecture_fit 의무 면제");
	assert.deepEqual(deployPlan.formProblems(legacyPlan), [], "옛 계획서는 architecture_fit 없어도 formProblems 통과");
	assert.ok(deployPlan.formWarnings(legacyPlan).length > 0, "옛 계획서는 경고 문구를 돌려주어야 함");

	// 옛 계획서는 구 9기준 적대 리뷰 영수증도 계속 유효해야 함
	const legacySha = sha256(fs.readFileSync(legacyPlanFile));
	const prompt = deployPlan.reviewPrompt(legacyPlan, legacySha, root);
	assert.ok(!prompt.includes("architecture_fit:"), "옛 계획서 리뷰 요청문에는 architecture_fit 미포함");
	const promptSha = sha256(prompt);
	const manifestSha = deployPlan.reviewInputManifest(legacyPlanFile, root);
	const legacyCriteria = deployPlan.CRITERIA.filter(([id]) => id !== "architecture_fit");
	const bodyLines = [
		"판정: PASS",
		...legacyCriteria.map(([id]) => `${id}: PASS — 기존 계획서 통과`),
		"참고 지적: 0",
		"남은 지적: 0",
		"",
	];
	const body = bodyLines.join("\n");
	const stdoutSha = sha256(body);
	const finalText = `${body}review-run: target_sha256=${legacySha} prompt_sha256=${promptSha} stdout_sha256=${stdoutSha}\n`;
	const resultRel = "deploy-plan-review-argon.md";
	fs.writeFileSync(path.join(legacyGatesDir, resultRel), finalText);
	const legacyReviewEnd = Date.parse(deployPlan.LEGACY_REVIEW_CUTOFF) - 60_000;
	fs.writeFileSync(path.join(legacyGatesDir, deployPlan.REVIEW_FILE), JSON.stringify({
		plan_sha256: legacySha,
		plan: path.relative(root, legacyPlanFile),
		author_model: legacyPlan.author_model,
		prompt_sha256: promptSha,
		reviewedAt: new Date(legacyReviewEnd).toISOString(),
		reviewers: [{
			model: deployPlan.REVIEW_MODELS.argon.model,
			effort: deployPlan.REVIEW_MODELS.argon.effort,
			result: resultRel,
			result_sha256: sha256(finalText),
			target_sha256: legacySha,
			receipt: {
				model: deployPlan.REVIEW_MODELS.argon.model,
				effort: deployPlan.REVIEW_MODELS.argon.effort,
				started_at: new Date(legacyReviewEnd - 2000).toISOString(),
				ended_at: new Date(legacyReviewEnd).toISOString(),
				exit_code: 0,
				prompt_sha256: promptSha,
				stdout_sha256: stdoutSha,
				input_manifest_sha256: manifestSha,
				isolation: "bwrap-ro-bind",
			},
		}],
	}, null, 2));

	const revStatus = deployPlan.reviewProblems(legacyGatesDir, legacySha, root);
	assert.equal(revStatus.ok, true, `옛 계획서 9기준 영수증 통과: ${revStatus.problems.join("; ")}`);

	const env = { ...process.env, DEPLOY_APPROVAL_STATE_DIR: stateDir };
	const workspaceScript = path.join(root, ".agents/scripts/approval-plan.mjs");
	const chk = spawnSync(process.execPath, [workspaceScript, "check", legacyPlanFile], { cwd: root, env, encoding: "utf8" });
	assert.equal(chk.status, 0, `${chk.stdout}\n${chk.stderr}`);
	assert.match(chk.stdout, /양식: 통과/);
	assert.match(chk.stdout, /경고/);
	assert.match(chk.stdout, /적대 리뷰: 통과/);

	// 승인된 옛 계획서 단계 실행 시 form 차단 없이 정상 동작(PLAN 승인 요청 단계로 진행)해야 함
	const transcriptPath = path.join(stateDir, "transcript.jsonl");
	fs.writeFileSync(transcriptPath, "");
	const evalRes = await deployPlan.evaluate({
		command: step1Cmd,
		cwd: root,
		root,
		services: ["azure:containerapp:sample-web-prod"],
		sessionId: "sess-legacy-ok",
		transcriptPath,
		env,
		now: Date.parse("2026-11-15T04:10:00.000Z"),
		readiness: () => ({ ok: true, problems: [], facts: [] }),
	});
	assert.equal(evalRes.allow, false);
	assert.equal(evalRes.audit?.event, "plan-approval-requested");
	assert.match(evalRes.reason, /승인 코드: PLAN-/);
	assert.match(evalRes.reason, /경고\(기존 계획서/);

	// version: 2 명시 또는 기준 시각 이후 createdAt (version: 1 위장 포함)은 반드시 architecture_fit 요구·차단
	const optedInOld = { ...legacyPlan, version: 2 };
	assert.equal(deployPlan.requiresArchitectureFit(optedInOld), true);
	assert.ok(deployPlan.formProblems(optedInOld).some((m) => m.includes("architecture_fit")));

	const newDatedV1 = { ...legacyPlan, version: 1, createdAt: "2026-11-15T05:00:00.000Z" };
	assert.equal(deployPlan.requiresArchitectureFit(newDatedV1), true);
	assert.ok(deployPlan.formProblems(newDatedV1).some((m) => m.includes("architecture_fit")));
});
