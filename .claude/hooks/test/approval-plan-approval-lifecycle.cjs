"use strict";
// Approval gate tests: approval-lifecycle.
const { test, makeWorkspace, writeGateConfig, createValidPlan, writePassingReviewReceipt, runDeployGuardHook, assert, appendHumanTurn, deployPlan, fs, sha256, path, spawnSync, SCRIPT_PATH } = require("./approval-plan-fixtures.cjs");

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
	const planCodeMatch = d1.reason.match(/승인 코드:\s*(PLAN-[0-9A-F]{64})/);
	assert.ok(planCodeMatch, "PLAN 승인 코드가 발급되어야 함");

	// 2) PLAN 코드만 입력하고 STEP 코드가 없을 때: 단계 승인 필요로 차단되고 STEP 코드 발급
	appendHumanTurn(transcriptPath, `계획 승인합니다 ${planCodeMatch[1]}`);
	const d2 = runDeployGuardHook(step1Cmd, { cwd: root, root, stateDir, transcriptPath });
	assert.ok(d2);
	assert.equal(d2.decision, "block");
	assert.match(d2.reason, /단계 승인 필요/);
	assert.match(d2.reason, /단계 승인 코드:\s*STEP-[0-9A-F]{64}/);
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
	assert.match(pre.plan_code, /^PLAN-[0-9A-F]{64}$/);
	const s1Code = pre.steps.find((s) => s.step === "s1")?.code;
	assert.ok(s1Code && /^STEP-[0-9A-F]{64}$/.test(s1Code));

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

test("issued approvals verify only against their live plan, session and exact command scope", async (t) => {
	const { root, stateDir } = makeWorkspace(t);
	const { planFile, plan } = createValidPlan(root);
	const { planSha, manifestSha } = writePassingReviewReceipt(root, planFile);
	const env = { DEPLOY_APPROVAL_STATE_DIR: stateDir };
	const sessionId = "scope-session";
	const now = Date.now();
	const request = { root, file: planFile, plan, sha: planSha, manifest: manifestSha, sessionId };
	const step = plan.scenario[0];
	const scope = deployPlan.approvalScope(request, step);
	const issue = () => deployPlan.preapproveStepCodes(planFile, root, sessionId, env, now);
	const first = await issue();
	assert.ok(first.ok, first.why);
	const { containsApprovalCode } = require("../lib/deploy-human-approval.js");
	assert.ok(containsApprovalCode(`${first.plan_code} ${first.steps[0].code}`, first.steps[0].code));
	assert.equal(containsApprovalCode(`${first.plan_code}0`, first.plan_code), false);
	assert.equal(containsApprovalCode(first.plan_code, first.plan_code.slice(0, 11)), false);
	const file = deployPlan.stateFile(env);
	const state = JSON.parse(fs.readFileSync(file, "utf8"));
	const row = state.challenges.find((item) => item.code === first.steps[0].code);
	assert.ok(deployPlan.matchesIssuedApproval(row, scope));
	for (const other of [
		deployPlan.approvalScope(request),
		deployPlan.approvalScope(request, plan.scenario[1]),
		deployPlan.approvalScope({ ...request, sessionId: "next-session" }, step),
		deployPlan.approvalScope({ ...request, sha: sha256("revised plan bytes") }, step),
		deployPlan.approvalScope({ ...request, manifest: sha256("updated review inputs") }, step),
		deployPlan.approvalScope({ ...request, file: path.join(root, "other", "gates", deployPlan.PLAN_FILE) }, step),
		deployPlan.approvalScope({ ...request, root: stateDir }, step),
		deployPlan.approvalScope(request, { ...step, commands: step.commands.map((cmd) => cmd + " ") }),
	]) assert.equal(deployPlan.matchesIssuedApproval({ ...row, ...other }, other), false);
	for (const changed of [
		{ nonce: (row.nonce[0] === "0" ? "1" : "0") + row.nonce.slice(1) }, { createdAt: new Date(now - 1).toISOString() }, { preapprove: undefined },
	]) assert.equal(deployPlan.matchesIssuedApproval({ ...row, ...changed }, scope), false);

	assert.deepEqual((await issue()).steps, first.steps);
	const renewed = await deployPlan.preapproveStepCodes(planFile, root, sessionId, env, now + deployPlan.PLAN_APPROVAL_TTL_MS);
	assert.notEqual(renewed.plan_code, first.plan_code);
	assert.ok(renewed.steps.every((item, index) => item.code !== first.steps[index].code));
	// An old pending request can be loaded for recovery, but needs a new human reply.
	state.challenges = [{ kind: "plan", code: "PLAN-ABC123", planSha, sessionId, createdAt: row.createdAt }];
	fs.writeFileSync(file, JSON.stringify(state));
	const migrated = await issue();
	assert.notEqual(migrated.plan_code, first.plan_code);
	assert.match(migrated.plan_code, /^PLAN-[0-9A-F]{64}$/);
	assert.equal((await deployPlan.preapproveStepCodes(planFile, root, "unknown", env, now)).ok, false);
});

test("one Discord decision covers the selected before, apply and restore steps across retries", async (t) => {
	const { root, stateDir } = makeWorkspace(t);
	const sessionId = "planned-restore";
	const env = { DEPLOY_APPROVAL_STATE_DIR: stateDir };
	const author = "123456789012345678", channel = "234567890123456789", message = "345678901234567890";
	writeGateConfig(root, { approver: { discordUserId: author } });
	const step = (id, commands, extra = {}) => ({
		id, title: `Sample ${id}`, commands, success_check: "Check sample result", on_failure: "Stop and report", ...extra,
	});
	const before = step("before", ["printf 'before state'"]);
	const apply = step("apply", ["printf 'apply  setting'", "printf 'apply setting'"]);
	const restore = step("restore", ["printf 'restore state'"], { branch: "rollback" });
	const { planFile, gatesDir, plan } = createValidPlan(root, {
		scenario: [before, apply, restore], rollback: { method: "Restore the recorded state", duration: "1 minute", step_ids: ["restore"] },
	});
	writePassingReviewReceipt(root, planFile);
	const now = Date.now();
	const batch = await deployPlan.preapproveStepCodes(planFile, root, sessionId, env, now);
	assert.ok(batch.ok, batch.why);
	assert.ok(batch.report.includes(JSON.stringify(apply.commands[0])));
	const codes = [batch.plan_code, ...batch.steps.map((entry) => entry.code)];
	fs.writeFileSync(path.join(gatesDir, deployPlan.DISCORD_FILE), JSON.stringify({
		approvals: codes.map((code) => ({ code, channelId: channel, messageId: message })),
	}));
	const decide = (command) => deployPlan.evaluate({
		command, root, env, sessionId, services: plan.services, now, discordToken: "fixture-token",
		// Each hook invocation retrieves the human reply from the simulated Discord API.
		fetchImpl: async (url) => {
			assert.equal(url, `https://discord.com/api/v10/channels/${channel}/messages/${message}`);
			return { ok: true, json: async () => ({ id: message, channel_id: channel, timestamp: new Date(now).toISOString(), author: { id: author }, content: codes.join(" ") }) };
		},
	});
	const recordSuccess = (id) => {
		const evidence = path.join(stateDir, `${id}.txt`);
		fs.writeFileSync(evidence, `Verified sample ${id}\n`);
		const cli = spawnSync(process.execPath, [SCRIPT_PATH, "step-ok", planFile, id, "--evidence", evidence], { env: { ...process.env, ...env }, encoding: "utf8" });
		assert.equal(cli.status, 0, cli.stderr);
	};
	assert.equal((await decide(before.commands[0])).allow, true);
	recordSuccess(before.id);
	for (const [index, command] of apply.commands.entries()) {
		assert.equal((await decide(command)).allow, true);
		const state = JSON.parse(fs.readFileSync(deployPlan.stateFile(env), "utf8"));
		const admitted = state.challenges.find((row) => row.step === apply.id);
		assert.deepEqual(admitted.executed, apply.commands.slice(0, index + 1).map(sha256));
		assert.equal(admitted.status === "executed", index + 1 === apply.commands.length);
	}
	recordSuccess(apply.id);
	assert.equal((await decide(restore.commands[0])).allow, true);
	const retry = await decide(restore.commands[0]);
	assert.equal(retry.audit.event, "step-approval-requested");
	assert.ok(!retry.reason.includes(batch.steps.find((entry) => entry.step === restore.id).code));
});

test("a live approval lock keeps ownership while a slow human confirmation is pending", async (t) => {
	const { stateDir } = makeWorkspace(t);
	const env = { DEPLOY_APPROVAL_STATE_DIR: stateDir };
	const result = await deployPlan.withStateLock(env, async () => {
		const old = new Date(Date.now() - 10 * 60 * 1000);
		fs.utimesSync(`${deployPlan.stateFile(env)}.lock`, old, old);
		return deployPlan.withStateLock(env, () => "unexpected second holder", 0);
	});
	assert.equal(result, null);
	assert.equal(await deployPlan.withStateLock(env, () => "next holder"), "next holder");
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
	assert.ok(tpl.architecture_fit && typeof tpl.architecture_fit === "object");
	assert.ok("original_request" in tpl.architecture_fit && "parent_structure" in tpl.architecture_fit && "acceptance_rationale" in tpl.architecture_fit);
	assert.ok(deployPlan.architectureFitProblems(tpl).length >= 3, "견본 <...> 자리표시자는 그대로 두면 막혀야 함");

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
	assert.match(preRes.stdout, /사전발급 코드\(사용자 본인이 한 메시지로 승인\): PLAN PLAN-[0-9A-F]{64} s1 STEP-[0-9A-F]{64} r1 STEP-[0-9A-F]{64}/);

	// step-ok
	const evFile = path.join(stateDir, "s1-ok.txt");
	fs.writeFileSync(evFile, "HTTP/1.1 200 OK\nhealth=ok\n");
	const stepOkRes = spawnSync(process.execPath, [workspaceScript, "step-ok", planFile, "s1", "--evidence", evFile], { cwd: root, env, encoding: "utf8" });
	assert.equal(stepOkRes.status, 0, stepOkRes.stderr);
	assert.match(stepOkRes.stdout, /단계 s1 성공 확인 기록/);
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
