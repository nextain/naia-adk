"use strict";
// Approval gate tests: readonly-authorization.
const { test, runDeployGuardHook, assert, fs, gitRun, path, deployPlan, spawnSync, verifiedPlanBinding, writePassingReviewReceipt, appendHumanTurn } = require("./approval-plan-fixtures.cjs");
const { setupReadOnlyOpsWorkspace } = require("./approval-plan-readonly-fixtures.cjs");

test("읽기 전용 ops 대본: 리뷰 PASS + 커밋된 readOnlyScripts(sha·path·service) 일치 시 승인 코드 없이 반복 실행 및 readonly-no-code 감사", (t) => {
	// 1. az vm run-command invoke --scripts @<상대 경로> (+ 허용 옵션)
	const fAz = setupReadOnlyOpsWorkspace(t, {
		commandKind: "az",
		customCommand: "az vm run-command invoke --subscription sub-1 --resource-group sample-rg --name sample-vm --command-id RunShellScript --scripts @.agents/progress/sample-ro-work/gates/ops/ro-check.sh --query 'value[0].message' --output tsv --only-show-errors",
	});
	for (let i = 0; i < 3; i++) {
		const res = runDeployGuardHook(fAz.command, { cwd: fAz.root, root: fAz.root, stateDir: fAz.stateDir, transcriptPath: fAz.transcriptPath, sessionId: `sess-ro-az-${i}` });
		assert.equal(res, null, `${i + 1}회차 읽기 전용 az 실행은 승인 코드 없이 통과해야 함`);
	}
	const auditsAz = fAz.readAudit().filter((a) => a.event === "executed");
	assert.equal(auditsAz.length, 3);
	for (const a of auditsAz) {
		assert.equal(a.approved_by, "readonly-no-code");
	}

	// 2. 정확히 2토큰 bash / sh <script>
	const sshScript = "#!/usr/bin/env bash\nset -euo pipefail\nssh sample-vm 'uptime && df -h /'\n";
	for (const shKind of ["bash", "sh"]) {
		const fSh = setupReadOnlyOpsWorkspace(t, {
			commandKind: shKind,
			service: "ssh:sample-vm",
			scriptRel: "scripts/ro-ssh-check.sh",
			scriptBody: sshScript,
		});
		assert.equal(runDeployGuardHook(fSh.command, { cwd: fSh.root, root: fSh.root, stateDir: fSh.stateDir, transcriptPath: fSh.transcriptPath, sessionId: `sess-ro-${shKind}` }), null, `${shKind} 1회차 통과`);
		assert.equal(runDeployGuardHook(fSh.command, { cwd: fSh.root, root: fSh.root, stateDir: fSh.stateDir, transcriptPath: fSh.transcriptPath, sessionId: `sess-ro-${shKind}` }), null, `${shKind} 2회차 반복 통과`);
		const auditsSh = fSh.readAudit().filter((a) => a.event === "executed");
		assert.equal(auditsSh.length, 2);
		assert.ok(auditsSh.every((a) => a.approved_by === "readonly-no-code"));
	}
});

test("읽기 전용 ops 우회: 설정에 없는 sha 는 막히고 allowCustomCommands 여도 승인 코드 생략 불가", (t) => {
	const wrongSha = "0".repeat(64);
	const f1 = setupReadOnlyOpsWorkspace(t, {
		readOnlyScripts: [{ sha256: wrongSha, path: ".agents/progress/sample-ro-work/gates/ops/ro-check.sh", service: "azure:vm:sample-vm", note: "다른 대본" }],
	});
	const d1 = runDeployGuardHook(f1.command, { cwd: f1.root, root: f1.root, stateDir: f1.stateDir, transcriptPath: f1.transcriptPath });
	assert.equal(d1?.decision, "block");
	assert.ok(!f1.readAudit().some((a) => a.approved_by === "readonly-no-code"));

	const f2 = setupReadOnlyOpsWorkspace(t, {
		configServices: { "azure:vm:sample-vm": { label: "샘플 VM", allowOps: true, allowCustomCommands: true } },
		readOnlyScripts: [],
	});
	const d2 = runDeployGuardHook(f2.command, { cwd: f2.root, root: f2.root, stateDir: f2.stateDir, transcriptPath: f2.transcriptPath });
	assert.equal(d2?.decision, "block", "설정에 없는 sha 는 allowCustomCommands 여도 승인 코드 없이 통과 불가");
	assert.match(d2.reason, /PLAN-/);
});

test("읽기 전용 ops B1: 리뷰 뒤 readOnlyScripts 자가 커밋 시 무코드 불가(승인 코드 필요) + 영수증 위조 차단 + 리뷰어 대본 본문 고정", (t) => {
	// 1. 리뷰 시점에는 readOnlyScripts: [] → 리뷰 통과 뒤 config/deploy-gate.json 에 항목을 추가 커밋 → 무코드 거부, PLAN- 코드 필요
	const fSelfCommit = setupReadOnlyOpsWorkspace(t, {
		configServices: { "azure:vm:sample-vm": { label: "샘플 VM", allowOps: true, allowCustomCommands: true } },
		readOnlyScripts: [],
	});
	const cfgAfter = JSON.parse(fs.readFileSync(fSelfCommit.cfgPath, "utf8"));
	cfgAfter.readOnlyScripts = [{ sha256: fSelfCommit.scriptSha, path: fSelfCommit.scriptRel, service: "azure:vm:sample-vm", note: "리뷰 뒤 자가 추가" }];
	fs.writeFileSync(fSelfCommit.cfgPath, JSON.stringify(cfgAfter, null, 2));
	gitRun(fSelfCommit.root, ["add", "config/deploy-gate.json"]);
	gitRun(fSelfCommit.root, ["commit", "-m", "self commit readOnlyScripts after review"]);

	const dAfter = runDeployGuardHook(fSelfCommit.command, { cwd: fSelfCommit.root, root: fSelfCommit.root, stateDir: fSelfCommit.stateDir, transcriptPath: fSelfCommit.transcriptPath, sessionId: "sess-b1" });
	assert.equal(dAfter?.decision, "block", "리뷰 뒤 설정 커밋은 무코드 통과 불가");
	assert.match(dAfter.reason, /PLAN-/, "기존 승인 코드 경로로 떨어져야 함");
	assert.ok(!fSelfCommit.readAudit().some((a) => a.approved_by === "readonly-no-code"));

	// 2. 영수증 read_only_scripts 를 사후 위조하면 reviewProblems 에서 즉시 차단
	const revFile = path.join(fSelfCommit.gatesDir, "deploy-plan-review.json");
	const revTampered = JSON.parse(fs.readFileSync(revFile, "utf8"));
	revTampered.read_only_scripts = [{ sha256: fSelfCommit.scriptSha, path: fSelfCommit.scriptRel, service: "azure:vm:sample-vm", script_sha256: fSelfCommit.scriptSha }];
	fs.writeFileSync(revFile, JSON.stringify(revTampered, null, 2));
	const dTampered = runDeployGuardHook(fSelfCommit.command, { cwd: fSelfCommit.root, root: fSelfCommit.root, stateDir: fSelfCommit.stateDir, transcriptPath: fSelfCommit.transcriptPath, sessionId: "sess-b1-tamper" });
	assert.equal(dTampered?.decision, "block");
	assert.match(dTampered.reason, /적대 리뷰를 통과하지 않아/);

	// 3. 계획서 files 에 대본을 고정하지 않으면 리뷰 전 pinnedFileProblems 가 거부하고 훅도 차단함
	const fNoPin = setupReadOnlyOpsWorkspace(t, { pinFiles: false, withReview: false });
	const planNoPin = JSON.parse(fs.readFileSync(fNoPin.planFile, "utf8"));
	const pinProbs = deployPlan.pinnedFileProblems(planNoPin, fNoPin.root);
	assert.ok(pinProbs.some((p) => p.includes("실행 대본이 files 에 고정되지 않음")), pinProbs.join("; "));
	const promptOut = spawnSync(process.execPath, [path.join(fSelfCommit.root, ".agents/scripts/approval-plan.mjs"), "review-prompt", path.relative(fSelfCommit.root, fSelfCommit.planFile)], { cwd: fSelfCommit.root, encoding: "utf8" });
	assert.equal(promptOut.status, 0, promptOut.stderr);
	assert.ok(promptOut.stdout.includes(fSelfCommit.scriptSha), "review-prompt 에 대본 sha256 포함");
	assert.ok(promptOut.stdout.includes("docker inspect sample-app"), "review-prompt 에 대본 본문 포함");
});

test("읽기 전용 ops 우회: config/deploy-gate.json 미커밋 변경·스테이징·미추적 시 모두 막힘", (t) => {
	// 미커밋 작업 트리 변경 (allowCustomCommands 로도 우회 불가 검증 포함)
	const fDirty = setupReadOnlyOpsWorkspace(t, {
		configServices: { "azure:vm:sample-vm": { label: "샘플 VM", allowOps: true, allowCustomCommands: true } },
	});
	const cur = JSON.parse(fs.readFileSync(fDirty.cfgPath, "utf8"));
	cur.readOnlyScripts[0].note = "작업 트리에서 고침";
	fs.writeFileSync(fDirty.cfgPath, JSON.stringify(cur, null, 2));
	const dDirty = runDeployGuardHook(fDirty.command, { cwd: fDirty.root, root: fDirty.root, stateDir: fDirty.stateDir, transcriptPath: fDirty.transcriptPath });
	assert.equal(dDirty?.decision, "block", "작업 트리 미커밋 변경은 막혀야 함");

	// git add 만 하고 커밋 안 함
	const fStaged = setupReadOnlyOpsWorkspace(t);
	const stagedCur = JSON.parse(fs.readFileSync(fStaged.cfgPath, "utf8"));
	stagedCur.readOnlyScripts[0].note = "스테이징만 함";
	fs.writeFileSync(fStaged.cfgPath, JSON.stringify(stagedCur, null, 2));
	gitRun(fStaged.root, ["add", "config/deploy-gate.json"]);
	const dStaged = runDeployGuardHook(fStaged.command, { cwd: fStaged.root, root: fStaged.root, stateDir: fStaged.stateDir, transcriptPath: fStaged.transcriptPath });
	assert.equal(dStaged?.decision, "block", "스테이징 미커밋 변경은 막혀야 함");

	// git 미추적
	const fUntracked = setupReadOnlyOpsWorkspace(t, { commitConfig: false });
	const dUntracked = runDeployGuardHook(fUntracked.command, { cwd: fUntracked.root, root: fUntracked.root, stateDir: fUntracked.stateDir, transcriptPath: fUntracked.transcriptPath });
	assert.equal(dUntracked?.decision, "block", "git 미추적 config/deploy-gate.json 은 막혀야 함");
});

test("읽기 전용 ops 우회: 대본 실행 직전 바뀜 및 계획서 변경 시 리뷰 무효화", (t) => {
	const fEditScript = setupReadOnlyOpsWorkspace(t);
	fs.appendFileSync(fEditScript.scriptAbs, "# tampered right before run\n");
	const d1 = runDeployGuardHook(fEditScript.command, { cwd: fEditScript.root, root: fEditScript.root, stateDir: fEditScript.stateDir, transcriptPath: fEditScript.transcriptPath });
	assert.equal(d1?.decision, "block");
	assert.match(d1.reason, /고정되지 않았거나, 고정한 뒤 바뀌었습니다/);

	const fEditPlan = setupReadOnlyOpsWorkspace(t);
	const p = JSON.parse(fs.readFileSync(fEditPlan.planFile, "utf8"));
	p.what_why = "리뷰 뒤 계획서 수정";
	fs.writeFileSync(fEditPlan.planFile, JSON.stringify(p, null, 2));
	const d2 = runDeployGuardHook(fEditPlan.command, { cwd: fEditPlan.root, root: fEditPlan.root, stateDir: fEditPlan.stateDir, transcriptPath: fEditPlan.transcriptPath });
	assert.equal(d2?.decision, "block");
	assert.match(d2.reason, /적대 리뷰를 통과하지 않아/);
});

test("읽기 전용 ops 우회: kind=feature 는 readOnlyScripts 에 있는 대본이어도 막히고 readonly-no-code 불가", (t) => {
	const f = setupReadOnlyOpsWorkspace(t, {
		kind: "feature",
		candidate: "abc1234",
		configServices: { "azure:vm:sample-vm": { label: "샘플 VM", allowOps: true, allowCustomCommands: true } },
	});
	const d = runDeployGuardHook(f.command, { cwd: f.root, root: f.root, stateDir: f.stateDir, transcriptPath: f.transcriptPath });
	assert.equal(d?.decision, "block");
	assert.match(d.reason, /운영 변경 준비 안 됨/);
	assert.ok(!f.readAudit().some((a) => a.approved_by === "readonly-no-code"));

	const plan = JSON.parse(fs.readFileSync(f.planFile, "utf8"));
	const bind = verifiedPlanBinding(
		{ plan, entry: plan.scenario[0], command: f.command, cwd: f.root, gatesDir: f.gatesDir },
		"abc1234",
		"feature",
		["azure:vm:sample-vm"],
		f.root
	);
	assert.ok(!bind.readOnlyNoCode, "kind=feature 는 readOnlyNoCode 가 켜질 수 없음");
});

test("읽기 전용 ops 우회: 적대 리뷰 없음·FAIL 이면 막힘", (t) => {
	const fNoRev = setupReadOnlyOpsWorkspace(t, { withReview: false });
	const d1 = runDeployGuardHook(fNoRev.command, { cwd: fNoRev.root, root: fNoRev.root, stateDir: fNoRev.stateDir, transcriptPath: fNoRev.transcriptPath });
	assert.equal(d1?.decision, "block");
	assert.match(d1.reason, /적대 리뷰를 통과하지 않아/);

	const fFailRev = setupReadOnlyOpsWorkspace(t, { withReview: true, reviewFail: ["a1"] });
	const d2 = runDeployGuardHook(fFailRev.command, { cwd: fFailRev.root, root: fFailRev.root, stateDir: fFailRev.stateDir, transcriptPath: fFailRev.transcriptPath });
	assert.equal(d2?.decision, "block");
	assert.match(d2.reason, /적대 리뷰를 통과하지 않아/);
});

test("읽기 전용 ops 우회: 인라인 명령·다른 service·덧붙인 명령·계획서 자체 읽기 선언·readOnlyScripts 없을 때 기존 동작", (t) => {
	// 1. service 불일치
	const fSvc = setupReadOnlyOpsWorkspace(t, {
		scriptBody: "#!/usr/bin/env bash\necho ok\n",
		readOnlyScripts: null,
	});
	const curSvc = JSON.parse(fs.readFileSync(fSvc.cfgPath, "utf8"));
	curSvc.readOnlyScripts = [{ sha256: fSvc.scriptSha, path: fSvc.scriptRel, service: "azure:vm:other-vm", note: "다른 VM" }];
	fs.writeFileSync(fSvc.cfgPath, JSON.stringify(curSvc, null, 2));
	gitRun(fSvc.root, ["add", "config/deploy-gate.json"]);
	gitRun(fSvc.root, ["commit", "-m", "other service"]);
	const dSvc = runDeployGuardHook(fSvc.command, { cwd: fSvc.root, root: fSvc.root, stateDir: fSvc.stateDir, transcriptPath: fSvc.transcriptPath });
	assert.equal(dSvc?.decision, "block", "service 불일치 막힘");

	// 2. 인라인 명령 (az --scripts "echo ok && df -h")
	const fInline = setupReadOnlyOpsWorkspace(t, {
		configServices: { "azure:vm:sample-vm": { label: "샘플 VM", allowOps: true } },
		readOnlyScripts: [],
	});
	const inlineCmd = "az vm run-command invoke --resource-group sample-rg --name sample-vm --command-id RunShellScript --scripts \"docker ps && df -h\"";
	const pIn = JSON.parse(fs.readFileSync(fInline.planFile, "utf8"));
	pIn.scenario[0].commands = [inlineCmd];
	pIn.scenario[0].files = {};
	fs.writeFileSync(fInline.planFile, JSON.stringify(pIn, null, 2));
	writePassingReviewReceipt(fInline.root, fInline.planFile);
	const dIn = runDeployGuardHook(inlineCmd, { cwd: fInline.root, root: fInline.root, stateDir: fInline.stateDir, transcriptPath: fInline.transcriptPath });
	assert.equal(dIn?.decision, "block", "인라인 명령은 기존처럼 막힘");

	// 3. 덧붙인 명령
	const fChain = setupReadOnlyOpsWorkspace(t);
	const dChain = runDeployGuardHook(`${fChain.command} && echo extra`, { cwd: fChain.root, root: fChain.root, stateDir: fChain.stateDir, transcriptPath: fChain.transcriptPath });
	assert.equal(dChain?.decision, "block", "덧붙인 명령 막힘");

	// 4. 계획서 자체 읽기 전용 주장(설정에 없는 대본 + planExtras.readOnly: true)
	const fProse = setupReadOnlyOpsWorkspace(t, {
		readOnlyScripts: [],
		planExtras: { readOnly: true, approval_mode: "readonly-no-code" },
	});
	const dProse = runDeployGuardHook(fProse.command, { cwd: fProse.root, root: fProse.root, stateDir: fProse.stateDir, transcriptPath: fProse.transcriptPath });
	assert.equal(dProse?.decision, "block", "계획서 글 자체 읽기 선언으로 우회 불가");

	// 5. readOnlyScripts 자체가 설정에 없을 때 기존 승인 코드 동작 유지
	const fNoRo = setupReadOnlyOpsWorkspace(t, {
		configServices: { "azure:vm:sample-vm": { label: "샘플 VM", allowOps: true, allowCustomCommands: true } },
		readOnlyScripts: [],
	});
	const cfgPlain = JSON.parse(fs.readFileSync(fNoRo.cfgPath, "utf8"));
	delete cfgPlain.readOnlyScripts;
	fs.writeFileSync(fNoRo.cfgPath, JSON.stringify(cfgPlain, null, 2));
	gitRun(fNoRo.root, ["add", "config/deploy-gate.json"]);
	gitRun(fNoRo.root, ["commit", "-m", "remove readOnlyScripts"]);
	const dPlanAsk = runDeployGuardHook(fNoRo.command, { cwd: fNoRo.root, root: fNoRo.root, stateDir: fNoRo.stateDir, transcriptPath: fNoRo.transcriptPath, sessionId: "sess-no-ro" });
	assert.equal(dPlanAsk?.decision, "block");
	assert.match(dPlanAsk.reason, /PLAN-/);
	appendHumanTurn(fNoRo.transcriptPath, `승인 ${dPlanAsk.reason.match(/PLAN-[0-9A-F]{64}/)[0]}`);
	const dStepAsk = runDeployGuardHook(fNoRo.command, { cwd: fNoRo.root, root: fNoRo.root, stateDir: fNoRo.stateDir, transcriptPath: fNoRo.transcriptPath, sessionId: "sess-no-ro" });
	assert.equal(dStepAsk?.decision, "block");
	assert.match(dStepAsk.reason, /STEP-/);
	appendHumanTurn(fNoRo.transcriptPath, `단계 승인 ${dStepAsk.reason.match(/STEP-[0-9A-F]{64}/)[0]}`);
	assert.equal(runDeployGuardHook(fNoRo.command, { cwd: fNoRo.root, root: fNoRo.root, stateDir: fNoRo.stateDir, transcriptPath: fNoRo.transcriptPath, sessionId: "sess-no-ro" }), null, "readOnlyScripts 없으면 기존 PLAN/STEP 승인으로 통과");
});
