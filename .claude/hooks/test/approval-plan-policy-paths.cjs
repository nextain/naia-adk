"use strict";
// Approval gate tests: policy-paths.
const { test, fs, path, os, spawnSync, HOOK_PATH, assert, sha256, writePassingReviewReceipt, ISSUED_APPROVAL_CODE, appendHumanTurn } = require("./approval-plan-fixtures.cjs");

test("교차 저장소·cwd 밖 대본 정책 선택: realpath·상대경로·cd·bash -c·심볼릭링크·..·없는경로·정책읽기오류·기본 sudo 차단 및 승인 통과 검증", (t) => {
	const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deploy-guard-cross-cwd-")));
	t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

	const runAutoRootHook = (command, { cwd, stateDir, transcriptPath, sessionId = "sess-cross-cwd" }) => {
		const env = { ...process.env };
		delete env.NAIA_ADK_ROOT;
		delete env.CLAUDE_PROJECT_DIR;
		delete env.DEPLOY_READINESS_ROOT;
		delete env.DEPLOY_GATE_CONFIG;
		env.DEPLOY_APPROVAL_STATE_DIR = stateDir;
		env.DEPLOY_AUDIT_PATH = path.join(stateDir, "audit.jsonl");
		const res = spawnSync(process.execPath, [HOOK_PATH], {
			cwd: cwd && fs.existsSync(cwd) ? cwd : tmp,
			input: JSON.stringify({
				tool_name: "Bash",
				tool_input: { command },
				cwd,
				session_id: sessionId,
				transcript_path: transcriptPath,
			}),
			encoding: "utf8",
			env,
		});
		assert.equal(res.status, 0, `deploy-guard exited ${res.status}: ${res.stderr}`);
		return res.stdout.trim() ? JSON.parse(res.stdout) : null;
	};

	const outside = path.join(tmp, "outside");
	const stateDir = path.join(tmp, "state");
	const transcriptPath = path.join(tmp, "transcript.jsonl");
	fs.mkdirSync(outside, { recursive: true });
	fs.mkdirSync(stateDir, { recursive: true });
	fs.writeFileSync(transcriptPath, "");

	// 1. repoB: config/deploy-gate.json(services.allowedCommands 고정 대본) + 미검수 deploy-plan.json
	const repoB = path.join(tmp, "repoB-ops");
	fs.mkdirSync(path.join(repoB, ".git"), { recursive: true });
	fs.mkdirSync(path.join(repoB, "config"), { recursive: true });
	fs.mkdirSync(path.join(repoB, "scripts"), { recursive: true });
	fs.mkdirSync(path.join(repoB, "sub"), { recursive: true });
	fs.mkdirSync(path.join(repoB, ".agents", "progress", "rollout-1", "gates"), { recursive: true });
	const opScript = path.join(repoB, "scripts", "op.sh");
	fs.writeFileSync(opScript, "#!/usr/bin/env bash\necho \"op $1\"\n", { mode: 0o755 });
	const opSha = sha256(fs.readFileSync(opScript));
	const opEsc = opScript.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const opSvc = "local:systemd:sample-op";
	fs.writeFileSync(path.join(repoB, "config", "deploy-gate.json"), JSON.stringify({
		schema: "deploy-gate/v1",
		services: {
			[opSvc]: {
				label: "샘플 운영 대본",
				allowOps: true,
				allowRollback: true,
				allowCustomCommands: true,
				allowedCommands: [`^bash ${opEsc} (?:s2|rollback)$`],
			},
		},
	}, null, 2));
	const repoBPlan = path.join(repoB, ".agents", "progress", "rollout-1", "gates", "deploy-plan.json");
	const validPlanBody = {
		schema: "deploy-plan/v1",
		author_model: "muse",
		planId: "rollout-1",
		createdAt: new Date().toISOString(),
		services: [opSvc],
		what_why: "외부 cwd 실행에서도 소속 저장소 정책으로 통제되는지 확인하는 배포 작업입니다.",
		architecture_fit: {
			original_request: "외부 작업 폴더 실행에서도 소속 저장소 승인 정책을 일관되게 강제해 달라는 요청",
			parent_structure: "naia-adk 저장소 경계 정책 및 승인 계획 게이트 계층",
			acceptance_rationale: "기존 deploy-guard 와 승인 계획 게이트의 루트 해석 계층을 그대로 써서 우회 예외를 두지 않음",
		},
		changes: ["scripts/op.sh s2 고정 대본 단계 실행"],
		scenario: [
			{
				id: "s2",
				title: "운영 대본 s2 실행",
				commands: [`bash ${opScript} s2`],
				files: { "scripts/op.sh": opSha },
				success_check: "출력 ok 확인",
				on_failure: "중단 후 r1 롤백 실행",
			},
			{
				id: "r1",
				branch: "rollback",
				title: "직전 상태로 복귀",
				commands: [`bash ${opScript} rollback`],
				files: { "scripts/op.sh": opSha },
				success_check: "복귀 상태 정상 확인",
				on_failure: "운영 변경 중단 후 보고",
			},
		],
		risks: {
			items: ["외부 작업 디렉터리에서 오호출될 위험"],
			worst_case: "의도하지 않은 서비스 상태 변경",
		},
		irreversible: ["없음: 상태 파일은 복원 가능"],
		disconnect_safety: "실행 중 연결이 끊겨도 상태 확인 명령으로 runID 를 조회해 재접속하거나 직전 상태로 수동 복귀",
		rerun_safety: {
			lock: "중복 실행 시 잠금 파일로 거절",
			run_dir: "실행마다 고유 runID 폴더에 기록",
			no_latest_pick: "최신 폴더 자동 선택 금지 및 runID 명시",
		},
		success_verification: "단계 s2 종료 코드 0 및 서비스 헬스체크 통과 확인",
		rollback: {
			method: "직전 상태로 복귀(r1 실행)",
			duration: "1분",
			step_ids: ["r1"],
		},
		residual_risks: ["수동 확인 지연 가능성"],
		incident: {
			criteria: ["종료 코드 0 이 아님 또는 헬스체크 실패"],
			actions: [],
		},
	};
	fs.writeFileSync(repoBPlan, JSON.stringify({ ...validPlanBody, what_why: "" }, null, 2));

	// repoA(빈 설정), repoAStrict(엄격 cwd 설정), safeRepo(정책 없는 일반 저장소)
	const repoA = path.join(tmp, "repoA-other");
	fs.mkdirSync(path.join(repoA, ".git"), { recursive: true });
	fs.mkdirSync(path.join(repoA, "config"), { recursive: true });
	fs.writeFileSync(path.join(repoA, "config", "deploy-gate.json"), JSON.stringify({ services: {} }, null, 2));

	const repoAStrict = path.join(tmp, "repoA-strict");
	fs.mkdirSync(path.join(repoAStrict, ".git"), { recursive: true });
	fs.mkdirSync(path.join(repoAStrict, "config"), { recursive: true });
	fs.writeFileSync(path.join(repoAStrict, "config", "deploy-gate.json"), JSON.stringify({
		services: { "custom:strict-cwd": { label: "strict cwd" } },
		prodPatterns: [{ pattern: "(?:helper|op)\\.sh", service: "custom:strict-cwd", label: "strict cwd rule" }],
	}, null, 2));

	const safeRepo = path.join(tmp, "safe-dev-repo");
	fs.mkdirSync(path.join(safeRepo, ".git"), { recursive: true });
	fs.mkdirSync(path.join(safeRepo, "scripts"), { recursive: true });
	const safeHelper = path.join(safeRepo, "scripts", "helper.sh");
	fs.writeFileSync(safeHelper, "#!/usr/bin/env bash\necho ok\n", { mode: 0o755 });

	// allowedCommands 만 있는 repoC (deploy-plan.json 없음)
	const repoC = path.join(tmp, "repoC-gate-only");
	fs.mkdirSync(path.join(repoC, ".git"), { recursive: true });
	fs.mkdirSync(path.join(repoC, "config"), { recursive: true });
	fs.mkdirSync(path.join(repoC, "scripts"), { recursive: true });
	const repoCScript = path.join(repoC, "scripts", "fixed.sh");
	fs.writeFileSync(repoCScript, "#!/usr/bin/env bash\necho fixed\n", { mode: 0o755 });
	fs.writeFileSync(path.join(repoC, "config", "deploy-gate.json"), JSON.stringify({
		services: {
			"local:systemd:fixed": {
				label: "고정 대본",
				allowedCommands: [`^sudo bash ${repoCScript.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} s2$`],
			},
		},
	}, null, 2));

	// 심볼릭 링크 준비
	const symScript = path.join(outside, "link-op.sh");
	fs.symlinkSync(opScript, symScript);
	const symRepoDir = path.join(outside, "linkdir");
	fs.symlinkSync(repoB, symRepoDir);
	const loopA = path.join(outside, "loop-a.sh");
	const loopB = path.join(outside, "loop-b.sh");
	fs.symlinkSync(loopB, loopA);
	fs.symlinkSync(loopA, loopB);

	// 1) cwd=outside / repoA / repoAStrict·safeRepo · cd / bash -c / 상대경로 / 심볼릭링크 / .. 경로 전부 차단
	const mustBlock = [
		["다른 저장소 대본, cwd=outside", `bash ${opScript} s2`, outside],
		["다른 저장소 대본(allowedCommands만), cwd=outside", `sudo bash ${repoCScript} s2`, outside],
		["다른 저장소 대본(sudo 없는 호출도), cwd=outside", `bash ${repoCScript} s2`, outside],
		["다른 저장소 대본, cwd=repoA", `bash ${opScript} s2`, repoA],
		["일반 저장소 대본 + 엄격 cwd=repoAStrict (둘 다 적용)", `bash ${safeHelper}`, repoAStrict],
		["cd X && 대본, cwd=outside", `cd ${repoB} && bash scripts/op.sh s2`, outside],
		["cd X/sub && ../scripts/op.sh, cwd=outside", `cd ${repoB}/sub && bash ../scripts/op.sh s2`, outside],
		["bash -c 감싼 다른 저장소 대본", `bash -c "bash ${opScript} s2"`, outside],
		["bash -c 'cd repoB && ./scripts/op.sh s2'", `bash -c "cd ${repoB} && ./scripts/op.sh s2"`, outside],
		["상대 경로(../repoB-ops/scripts/op.sh)", "bash ../repoB-ops/scripts/op.sh s2", outside],
		["심볼릭 파일 -> repoB/scripts/op.sh", `bash ${symScript} s2`, outside],
		["심볼릭 폴더 -> repoB", `bash ${symRepoDir}/scripts/op.sh s2`, outside],
		["심볼릭 순환(ELOOP)", `bash ${loopA}`, outside],
		[".. 경로 포함(실재 경로)", `bash ${outside}/../repoB-ops/sub/../scripts/op.sh s2`, outside],
		[".. 경로 포함(없는 중간 폴더 경유)", `bash ${repoB}/ghost/../scripts/op.sh s2`, outside],
		["없는 경로(규제 저장소 내부)", `bash ${repoB}/scripts/missing.sh s2`, outside],
		["없는 경로(저장소 밖 .. 경로 + sudo)", `sudo bash ${tmp}/fake-kit/../fake-adk/scripts/op.sh s2`, outside],
		["없는 경로(저장소 밖 일반 bash)", `bash ${tmp}/nowhere/missing.sh s2`, outside],
	];
	for (const [desc, cmd, cwd] of mustBlock) {
		const res = runAutoRootHook(cmd, { cwd, stateDir, transcriptPath });
		assert.equal(res?.decision, "block", `차단되어야 함 [${desc}]: ${cmd} -> ${JSON.stringify(res)}`);
	}

	// 2) 정책 파일·대본 파일 파싱/권한 오류 fail-closed
	const badGateRepo = path.join(tmp, "repo-bad-gate");
	fs.mkdirSync(path.join(badGateRepo, ".git"), { recursive: true });
	fs.mkdirSync(path.join(badGateRepo, "config"), { recursive: true });
	fs.mkdirSync(path.join(badGateRepo, "scripts"), { recursive: true });
	fs.writeFileSync(path.join(badGateRepo, "config", "deploy-gate.json"), "{ invalid json");
	fs.writeFileSync(path.join(badGateRepo, "scripts", "task.sh"), "#!/usr/bin/env bash\necho ok\n");
	assert.equal(runAutoRootHook(`bash ${path.join(badGateRepo, "scripts", "task.sh")}`, { cwd: outside, stateDir, transcriptPath })?.decision, "block", "깨진 deploy-gate.json 차단");

	const badPlanRepo = path.join(tmp, "repo-bad-plan");
	fs.mkdirSync(path.join(badPlanRepo, ".git"), { recursive: true });
	fs.mkdirSync(path.join(badPlanRepo, ".agents", "progress", "w", "gates"), { recursive: true });
	fs.mkdirSync(path.join(badPlanRepo, "scripts"), { recursive: true });
	fs.writeFileSync(path.join(badPlanRepo, ".agents", "progress", "w", "gates", "deploy-plan.json"), "{ bad plan");
	fs.writeFileSync(path.join(badPlanRepo, "scripts", "task.sh"), "#!/usr/bin/env bash\necho ok\n");
	assert.equal(runAutoRootHook(`bash ${path.join(badPlanRepo, "scripts", "task.sh")}`, { cwd: outside, stateDir, transcriptPath })?.decision, "block", "깨진 deploy-plan.json 차단");

	if (typeof process.getuid === "function" && process.getuid() !== 0) {
		const permGate = path.join(badGateRepo, "config", "deploy-gate.json");
		fs.writeFileSync(permGate, JSON.stringify({ services: {} }));
		fs.chmodSync(permGate, 0o000);
		try {
			const rPermGate = runAutoRootHook(`bash ${path.join(badGateRepo, "scripts", "task.sh")}`, { cwd: outside, stateDir, transcriptPath });
			assert.equal(rPermGate?.decision, "block", "읽기 권한 없는 deploy-gate.json 차단");
		} finally {
			fs.chmodSync(permGate, 0o644);
		}

		const permScript = path.join(safeRepo, "scripts", "secret.sh");
		fs.writeFileSync(permScript, "#!/usr/bin/env bash\necho secret\n", { mode: 0o000 });
		try {
			const rPermScript = runAutoRootHook(`bash ${permScript}`, { cwd: outside, stateDir, transcriptPath });
			assert.equal(rPermScript?.decision, "block", "읽기 권한 없는 대본 파일 차단");
		} finally {
			fs.chmodSync(permScript, 0o644);
		}
	}

	// 3) 저장소 없는 곳에서의 sudo 기본 차단 목록 및 모호한 sudo fail-closed
	const outsideSafeScript = path.join(outside, "local-script.sh");
	fs.writeFileSync(outsideSafeScript, "#!/usr/bin/env bash\necho local\n", { mode: 0o755 });
	for (const cmd of [
		`sudo bash ${outsideSafeScript}`,
		`sudo sh ${outsideSafeScript}`,
		"sudo bash -c 'echo hi'",
		"sudo systemctl restart sample.service",
		"sudo touch /tmp/some-system-flag",
	]) {
		const rSudo = runAutoRootHook(cmd, { cwd: outside, stateDir, transcriptPath });
		assert.equal(rSudo?.decision, "block", `기본 sudo 차단 대상은 막혀야 함: ${cmd}`);
		assert.match(rSudo.reason, /sudo/i);
	}

	// 4) 정상 명령·비운영 스크립트·계획서 정식 승인 뒤 교차 cwd 정확 실행은 통과
	for (const [desc, cmd, cwd] of [
		["일반 git status (outside)", "git status", outside],
		["일반 ls -la (outside)", "ls -la", outside],
		["일반 git status (repoB)", "git status", repoB],
		["echo 안 sudo 문자열", "echo 'sudo systemctl restart sample'", outside],
		["정책 없는 저장소 일반 대본", `bash ${safeHelper}`, outside],
		["비운영(-dev) 배포", "gcloud run deploy sample-dev --image x", outside],
	]) {
		assert.equal(runAutoRootHook(cmd, { cwd, stateDir, transcriptPath }), null, `통과해야 함 [${desc}]: ${cmd}`);
	}

	// 정식 계획+리뷰+승인 뒤 exact 명령은 cwd=outside 에서도 통과, 단 엄격한 cwd=repoAStrict 에서는 여전히 막힘(더 엄격한 쪽)
	fs.writeFileSync(repoBPlan, JSON.stringify(validPlanBody, null, 2));
	writePassingReviewReceipt(repoB, repoBPlan);
	const exactCmd = `bash ${opScript} s2`;
	const sessApproved = "sess-cross-approved";
	const issueAndApprove = (session) => {
		for (let i = 0; i < 2; i++) {
			const ask = runAutoRootHook(exactCmd, { cwd: outside, stateDir, transcriptPath, sessionId: session });
			const codeMatch = ask && ask.reason.match(ISSUED_APPROVAL_CODE);
			assert.ok(codeMatch, `승인 코드 요청이 나와야 함(${i}): ${ask && ask.reason}`);
			appendHumanTurn(transcriptPath, `승인합니다 ${codeMatch[0]}`);
		}
	};
	issueAndApprove(sessApproved);
	assert.equal(
		runAutoRootHook(exactCmd, { cwd: outside, stateDir, transcriptPath, sessionId: sessApproved }),
		null,
		"리뷰·승인을 모두 마친 정확 명령은 cwd=outside 에서도 통과해야 함",
	);

	// 새 세션으로 PLAN·STEP 을 다시 발급·승인한 상태에서도 cwd=repoAStrict 이면 더 엄격한 쪽(cwd 정책)으로 막혀야 함
	const sessStrict = "sess-cross-strict";
	const askPlanStrict = runAutoRootHook(exactCmd, { cwd: outside, stateDir, transcriptPath, sessionId: sessStrict });
	const planCodeStrict = askPlanStrict?.reason.match(/\b(PLAN-[0-9A-F]{64})\b/);
	if (planCodeStrict) appendHumanTurn(transcriptPath, `승인합니다 ${planCodeStrict[1]}`);
	const askStepStrict = runAutoRootHook(exactCmd, { cwd: outside, stateDir, transcriptPath, sessionId: sessStrict });
	const stepCodeStrict = askStepStrict?.reason.match(/\b(STEP-[0-9A-F]{64})\b/);
	assert.ok(stepCodeStrict, `단계 승인 코드가 발급돼야 함: ${askStepStrict && askStepStrict.reason}`);
	appendHumanTurn(transcriptPath, `승인합니다 ${stepCodeStrict[1]}`);
	assert.equal(
		runAutoRootHook(exactCmd, { cwd: repoAStrict, stateDir, transcriptPath, sessionId: sessStrict })?.decision,
		"block",
		"repoB 가 승인돼도 cwd=repoAStrict 정책이 더 엄격하므로 막혀야 함",
	);
});
