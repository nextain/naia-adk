"use strict";
// Approval gate tests: target-transitions.
const { test, assert, writePassingReviewReceipt, deployPlan, fs, path, verifiedPlanBinding, assessReadiness, sha256, PIN_SERVICE, PIN_OPS_WHY, makeWorkspace, writeGateConfig, classifyProdMutations, createValidPlan, runDeployGuardHook, appendHumanTurn, spawnSync } = require("./approval-plan-fixtures.cjs");
const { transitionFixture, pinnedScriptFixture } = require("./approval-plan-target-fixtures.cjs");

test("target phases use the normal CLI review, human PLAN/STEP, exact preimage and postimage", async t => {
	const f = transitionFixture(t);
	assert.match(f.hook(f.step1Cmd).reason, /적대 리뷰/);
	const receipt = writePassingReviewReceipt(f.root, f.planFile);
	const prompt = deployPlan.reviewPrompt(f.plan, receipt.planSha, f.root);
	assert.ok(prompt.includes(f.before) && prompt.includes(f.after));
	assert.equal(f.cli("check").status, 0);
	const report = f.cli("report");
	assert.equal(report.status, 0);
	assert.ok(report.stdout.includes(`시작 지문 ${f.pin.before} → 완료 지문 ${f.pin.after}`));
	assert.match(f.hook(f.rollbackCmd).reason, /대상 시작 지문 불일치/);
	const pre = await deployPlan.preapproveStepCodes(f.planFile, f.root, f.sessionId, f.env);
	assert.equal(pre.ok, true, pre.why);
	assert.match(f.hook(f.step1Cmd).reason, /전체 계획 승인/);
	f.approve(pre.plan_code);
	assert.match(f.hook(f.step1Cmd).reason, /단계 승인 필요/);
	f.approve(pre.steps.find(s => s.step === "s1").code);
	assert.match(f.cli("step-ok", "s1", "--evidence", f.evidence).stderr, /target postimage mismatch/);
	assert.equal(fs.existsSync(path.join(f.gatesDir, "deploy-steps/s1.json")), false);
	f.run("s1");
	assert.equal(fs.readFileSync(f.live, "utf8"), f.after);
	assert.equal(fs.readFileSync(f.evidence, "utf8"), f.after);
	assert.equal(f.cli("check").status, 0);
	assert.equal(deployPlan.reviewPrompt(f.plan, receipt.planSha, f.root), prompt);
	assert.equal(deployPlan.reviewInputManifest(f.planFile, f.root), receipt.manifestSha);
	assert.equal(f.cli("step-ok", "s1", "--evidence", f.evidence).status, 0);
	assert.match(f.hook(f.step1Cmd).reason, /대상 시작 지문 불일치.*복구 계획/);
	assert.match(f.hook(f.step1Cmd, "different-session").reason, /대상 시작 지문 불일치/);
	assert.match(f.hook(f.rollbackCmd).reason, /단계 승인 필요/);
	f.approve(pre.steps.find(s => s.step === "r1").code);
	assert.match(f.cli("step-ok", "r1", "--evidence", f.evidence).stderr, /target postimage mismatch/);
	f.run("r1");
	assert.equal(fs.readFileSync(f.live, "utf8"), f.before);
	assert.equal(fs.readFileSync(f.evidence, "utf8"), f.before);
	assert.equal(f.cli("step-ok", "r1", "--evidence", f.evidence).status, 0);
	assert.match(f.hook(f.rollbackCmd).reason, /대상 시작 지문 불일치/);
	fs.writeFileSync(f.live, "unknown live image");
	assert.notEqual(f.cli("check").status, 0);
	assert.match(f.hook(f.step1Cmd).reason, /target sha256 mismatch/);
	assert.match(f.hook(f.rollbackCmd).reason, /target sha256 mismatch/);
});

test("an interrupted apply can retry from its original input with fresh STEP approval", async t => {
	const f = transitionFixture(t);
	writePassingReviewReceipt(f.root, f.planFile);
	const pre = await deployPlan.preapproveStepCodes(f.planFile, f.root, f.sessionId, f.env);
	assert.equal(pre.ok, true, pre.why);
	const first = pre.steps.find(s => s.step === "s1").code;
	f.approve(pre.plan_code + " " + first);
	// The host stopped between the pre-tool decision and launching its child.
	assert.equal(f.hook(f.step1Cmd), null);
	assert.equal(fs.readFileSync(f.live, "utf8"), f.before);
	assert.match(f.hook(f.rollbackCmd).reason, /대상 시작 지문 불일치/);
	const retry = f.hook(f.step1Cmd);
	assert.match(retry.reason, /단계 승인 필요/);
	const next = retry.reason.match(/단계 승인 코드:\s*(STEP-[0-9A-F]{64})(?![A-Za-z0-9_-])/)[1];
	assert.notEqual(next, first);
	f.approve(next);
	f.run("s1");
	assert.equal(fs.readFileSync(f.live, "utf8"), f.after);
});

test("a mixed set of registered target images needs a reviewed recovery plan", t => {
	const f = transitionFixture(t);
	const other = "scripts/second-setting.conf";
	fs.writeFileSync(path.join(f.root, other), f.after);
	f.plan.file_pins.push({ ...f.pin, path: other });
	f.plan.scenario[0].files[other] = f.pin.before;
	f.plan.scenario[1].files[other] = f.pin.after;
	f.writePlan();
	writePassingReviewReceipt(f.root, f.planFile);
	const check = f.cli("check");
	assert.equal(check.status, 0, check.stdout + check.stderr);
	for (const entry of f.plan.scenario) {
		const command = entry.commands[0];
		const binding = verifiedPlanBinding({ plan: f.plan, entry, command, cwd: f.root }, "", "plan", f.plan.services, f.root);
		assert.equal(binding.ok, false);
		assert.match(binding.why, /대상 시작 지문 불일치.*복구 계획/);
		assert.match(f.hook(command).reason, /대상 시작 지문 불일치.*복구 계획/);
	}
});

test("dispatch rechecks the input when another approved session finishes during readiness", async t => {
	const f = transitionFixture(t);
	writePassingReviewReceipt(f.root, f.planFile);
	const otherSession = "second-fixture-session";
	for (const session of [f.sessionId, otherSession]) {
		const pre = await deployPlan.preapproveStepCodes(f.planFile, f.root, session, f.env);
		assert.equal(pre.ok, true, pre.why);
		f.approve(pre.plan_code + " " + pre.steps.find(s => s.step === "s1").code);
	}
	const result = await deployPlan.evaluate({
		command: f.step1Cmd, services: f.plan.services, root: f.root, cwd: f.root,
		sessionId: otherSession, transcriptPath: f.transcriptPath, env: f.env,
		readiness(binding) {
			const ready = assessReadiness(f.plan.services, { root: f.root, command: f.step1Cmd, cwd: f.root, planBinding: binding });
			assert.equal(ready.ok, true, ready.problems.join(" / "));
			f.run("s1");
			return ready;
		},
	});
	assert.equal(fs.readFileSync(f.live, "utf8"), f.after);
	assert.equal(result.allow, false);
	assert.match(result.reason, /대상 시작 지문 불일치.*복구 계획/);
});

test("target bindings pin distinct phase hashes even without recovery options", t => {
	const f = pinnedScriptFixture(t);
	const before = fs.readFileSync(f.remote), after = Buffer.from("replacement setting\n");
	const beforeSource = path.join(f.planDir, "before-source"), afterSource = path.join(f.planDir, "after-source");
	fs.writeFileSync(beforeSource, before);
	fs.writeFileSync(afterSource, after);
	f.plan.file_pins = [{ path: f.remote, role: "target", before: sha256(before), after: sha256(after), before_source: beforeSource, after_source: afterSource }];
	f.plan.scenario[1].files[f.remote] = sha256(after);
	assert.equal(f.bind("s1", "plan").ok, true);
	assert.equal(f.bind("r1", "plan").ok, false);
	fs.writeFileSync(f.remote, after);
	assert.equal(f.bind("s1", "plan").ok, false);
	assert.equal(f.bind("r1", "plan").ok, true);
	fs.writeFileSync(f.remote, "third");
	assert.equal(f.bind("r1", "plan").ok, false);
	fs.writeFileSync(f.remote, after);
	fs.writeFileSync(afterSource, "tampered");
	assert.equal(f.bind("r1", "plan").ok, false);
});

test("unchanged inputs keep one manifest entry per normalized path and all step digests agree", t => {
	const f = transitionFixture(t);
	f.plan.scenario[1].files["./" + f.scriptRel] = f.plan.scenario[0].files[f.scriptRel];
	f.writePlan();
	const inspect = () => deployPlan.reviewInputEntries(f.planFile, f.root);
	const entries = inspect();
	assert.deepEqual(entries.problems, []);
	assert.equal(entries.entries.filter(e => path.normalize(e.file) === f.scriptRel).length, 1);
	f.plan.scenario[0].files[f.scriptRel] = "0".repeat(64);
	f.writePlan();
	assert.match(inspect().problems.join("\n"), /conflicting immutable pin/);
});

test("target snapshots and transition declarations fail closed", t => {
	const f = transitionFixture(t);
	const validate = () => deployPlan.pinnedFileProblems(f.plan, f.root);
	const relative = f.pin.before_source;
	f.pin.before_source = f.pin.path;
	assert.match(validate().join("\n"), /independent/);
	const alias = path.join(f.root, "scripts/alias");
	fs.linkSync(f.live, alias);
	f.pin.before_source = alias;
	assert.match(validate().join("\n"), /independent/);
	f.pin.before_source = relative;
	const link = path.join(f.root, "scripts/link");
	fs.symlinkSync(f.live, link);
	f.pin.path = link;
	assert.match(validate().join("\n"), /symlink/);
	f.pin.path = "scripts/setting.conf";
	f.pin.transitions.r1.partial_after = "r1";
	assert.match(validate().join("\n"), /invalid partial rollback/);
	f.pin.transitions.r1.partial_after = "s1";
	f.plan.scenario[1].files[f.pin.path] = f.pin.before;
	assert.match(validate().join("\n"), /exact preimage/);
});

test("계획 고정 대본: 준비 기록 없는 계획 승인으로는 지문이 맞으면 받고, 대본·files 지문이 바뀌면 막는다", (t) => {
	const f = pinnedScriptFixture(t);
	assert.deepEqual(f.services, [PIN_SERVICE]);
	for (const id of ["s1", "r1"]) {
		const res = f.assess(id);
		assert.equal(res.ok, true, `${id}: ${res.problems.join(" / ")}`);
		assert.equal(res.kind, "plan");
	}
	for (const target of ["script", "remote"]) {
		const g = pinnedScriptFixture(t);
		fs.appendFileSync(g[target], "#");
		const res = g.assess("s1");
		assert.equal(res.ok, false, `${target} 지문이 바뀌면 받히면 안 됨`);
		assert.ok(res.problems.some((x) => /고정 파일 sha256 불일치/.test(x)), res.problems.join(" / "));
	}
});

test("계획 고정 대본: 계획 승인에서도 서비스 허용 규칙(allowedCommands)은 그대로 따로 요구한다", (t) => {
	const f = pinnedScriptFixture(t);
	fs.writeFileSync(path.join(f.root, "config", "deploy-gate.json"), JSON.stringify({ schema: "deploy-gate/v1", services: { [PIN_SERVICE]: { label: "샘플 VM", allowedCommands: ["^az vm restart "] } } }));
	const r = f.bind("s1", "plan");
	assert.equal(r.ok, false);
	assert.match(r.why, /allowedCommands/);
});

test("계획 고정 대본: 정상 대본이라도 ops 준비 기록으로는 받지 않는다", (t) => {
	const f = pinnedScriptFixture(t);
	for (const id of ["s1", "r1"]) {
		const r = f.bind(id);
		assert.equal(r.ok, false, `${id}: ops 로 받히면 안 됨`);
		assert.match(r.why, PIN_OPS_WHY);
	}
	f.writeOps();
	const res = f.assess("s1");
	assert.equal(res.ok, false);
	assert.ok(res.problems.some((x) => PIN_OPS_WHY.test(x)), res.problems.join(" / "));
});

test("계획 고정 대본: kind=feature 는 ops 거부 문구 없이 기존 판정을 탄다", (t) => {
	const f = pinnedScriptFixture(t);
	const r = f.bind("s1", "feature");
	assert.equal(r.ok, false);
	assert.doesNotMatch(r.why, PIN_OPS_WHY);
	assert.match(r.why, /지원하지 않는 실행 형식/);
});

// 적대 리뷰 a5 우회 1~5 재현 입력 그대로: 분류기 서비스를 allowOps 로 등록하고 kind ops 준비 기록을 둬도 ops 로 받지 않는다.
test("계획 고정 대본: 리뷰 a5 우회 1~5 는 ops 로 통과하지 못한다", async (t) => {
	const vmCall = 'case "$1" in s1) az vm run-command invoke -g rg -n sample-vm --command-id RunShellScript --scripts @remote-s1.sh ;; esac\n';
	const cases = [
		{ desc: "1 원격 본문 docker pull/run", body: vmCall, remote: "docker pull reg/app:2\ndocker rm -f app; docker run -d --name app reg/app:2\n" },
		{ desc: "1 원격 본문 git pull·compose", body: vmCall, remote: "cd /srv/app && git pull && docker compose up -d --build\n" },
		{ desc: "1 인라인 --scripts docker", body: 'case "$1" in s1) az vm run-command invoke -g rg -n sample-vm --command-id RunShellScript --scripts "docker pull reg/app:2 && docker compose up -d" ;; esac\n' },
		{ desc: "2 here-doc ssh", body: "case \"$1\" in s1) ssh sample-vm bash -s <<'R'\ndocker pull reg/app:2\ndocker compose up -d\nR\n;; esac\n" },
		{ desc: "3 변수로 az 조립", body: 'case "$1" in s1) A=az; "$A" containerapp update -n prod-app -g rg --ima""ge reg/app:2 ;; esac\n' },
		{ desc: "4 eval+base64", body: 'case "$1" in s1) eval "az containerapp update -n prod-app -g rg --$(echo aW1hZ2U=|base64 -d) reg/app:2" ;; esac\n' },
		{ desc: "5 kubectl set image", body: 'case "$1" in s1) kubectl set image deployment/prod-app app=reg/app:2 ;; esac\n' },
		{ desc: "5 kubectl apply", body: 'case "$1" in s1) kubectl apply -f deploy.yaml ;; esac\n' },
	];
	for (const c of cases) {
		await t.test(c.desc, (st) => {
			const f = pinnedScriptFixture(st, { body: c.body, ...(c.remote ? { remote: c.remote } : {}) });
			f.writeOps();
			const res = f.assess("s1");
			assert.equal(res.ok, false, `${c.desc}: ops 로 받히면 안 됨 (서비스 ${f.services.join(", ")})`);
			assert.ok(res.problems.some((x) => PIN_OPS_WHY.test(x)), `${c.desc}: ${res.problems.join(" / ")}`);
		});
	}
});

test("읽기 전용 단계: 글자를 덧붙인 단계 명령은 막히고, 글자 그대로 낸 s0 은 승인·실행 기록을 남겨 s1 승인 요청까지 감", (t) => {
	const { root, stateDir, transcriptPath } = makeWorkspace(t);
	writeGateConfig(root);

	// 분류기가 운영 변경으로 보지 않는 대본(읽기만). 계획서 단계 명령이라는 사실만으로 관문에 걸려야 한다.
	const scriptRel = "scripts/sample-web-prod-check.sh";
	const scriptAbs = path.join(root, scriptRel);
	fs.mkdirSync(path.dirname(scriptAbs), { recursive: true });
	fs.writeFileSync(scriptAbs, "#!/usr/bin/env bash\ncase \"$1\" in\n  s0) echo candidate-ok ;;\n  s1) echo secret-ok ;;\n  *) exit 2 ;;\nesac\n");
	const scriptSha = sha256(fs.readFileSync(scriptAbs));
	const s0Cmd = `bash ${scriptRel} s0`;
	const s1Cmd = `bash ${scriptRel} s1`;
	assert.deepEqual(classifyProdMutations(s0Cmd, root, 0, false, root), [], "이 시험은 분류기가 못 알아보는 단계 명령을 다룬다");

	const step = (id, cmd, title) => ({ id, title, commands: [cmd], files: { [scriptRel]: scriptSha }, success_check: "끝줄 ok 확인", on_failure: "멈추고 보고" });
	const { planFile } = createValidPlan(root, {
		approval_mode: undefined,
		scenario: [
			step("s0", s0Cmd, "0단계 미리 확인(읽기만)"),
			step("s1", s1Cmd, "1단계 비밀 확인(읽기만)"),
			{ id: "r1", branch: "rollback", title: "이전 리비전으로 복귀", commands: ["az containerapp revision activate -n sample-web-prod -g sample-rg --revision sample-web-prod--prev"], success_check: "이전 리비전 트래픽 100% 확인", on_failure: "트래픽 차단 후 보고" },
		],
	});
	writePassingReviewReceipt(root, planFile);

	const sessionId = "sess-readonly-step";
	const hook = (cmd) => runDeployGuardHook(cmd, { cwd: root, root, stateDir, transcriptPath, sessionId });
	const stepState = (id) => {
		let d;
		try { d = JSON.parse(fs.readFileSync(path.join(stateDir, "deploy-plan-state.json"), "utf8")); } catch { return []; }
		return d.challenges.filter((c) => c.kind === "step" && c.step === id);
	};

	// 1. 글자를 덧붙인 꼴은 전부 막힌다. 승인 코드도 실행 기록도 생기지 않는다.
	for (const cmd of [
		`${s0Cmd} 2>&1 | tail -30`,
		`${s1Cmd} 2>&1 | tail -3`,
		`cd ${root} && ${s0Cmd}`,
		`timeout 60 ${s0Cmd} > ${path.join(stateDir, "out.txt")}`,
		`bash -c '${s0Cmd} | tail'`,
		`${s0Cmd}; echo done`,
	]) {
		const d = hook(cmd);
		assert.ok(d, `덧붙인 단계 명령은 막혀야 함: ${cmd}`);
		assert.equal(d.decision, "block");
		assert.match(d.reason, /계획서 단계 명령에 다른 글자가 붙어 있어 막습니다/, cmd);
		assert.ok(d.reason.includes(cmd.includes(s1Cmd) ? s1Cmd : s0Cmd), "계획서에 적힌 원문을 알려 줘야 함");
	}
	assert.deepEqual(stepState("s0"), [], "막힌 실행은 단계 도전을 만들지 않음");

	// 2. 단계 명령을 말하기만 하는 명령은 막지 않는다.
	const noteFile = path.join(stateDir, "note.txt");
	fs.writeFileSync(noteFile, `${s0Cmd}\n`);
	for (const cmd of [`grep -n '${s0Cmd}' ${noteFile}`, `echo ${s0Cmd}`, `cat ${scriptAbs}`, `bash ${scriptRel} s9`]) {
		assert.equal(hook(cmd), null, `단계 명령을 실행하지 않는 명령은 통과: ${cmd}`);
	}

	// 3. 글자 그대로 낸 s0: 계획 승인 → 단계 승인 → 통과, 실행 기록이 남는다.
	const planAsk = hook(s0Cmd);
	assert.match(planAsk.reason, /전체 계획 승인이 아직 없습니다/);
	appendHumanTurn(transcriptPath, `승인: ${planAsk.reason.match(/PLAN-[A-Z0-9]+/)[0]}`);
	const s0Ask = hook(s0Cmd);
	assert.match(s0Ask.reason, /단계 승인 필요: .* \/ s0/);
	// 승인 전에 덧붙여 돌려도 통과하지 않고, 승인 코드도 쓰이지 않는다.
	assert.equal(hook(`${s0Cmd} 2>&1 | tail -30`).decision, "block");
	assert.deepEqual(stepState("s0").map((c) => c.executed), [[]]);
	appendHumanTurn(transcriptPath, `승인: ${s0Ask.reason.match(/STEP-[A-Z0-9]+/)[0]}`);
	assert.equal(hook(`${s0Cmd} 2>&1 | tail -30`).decision, "block", "단계 승인이 있어도 덧붙인 꼴은 막힘");
	assert.equal(hook(s0Cmd), null, "승인된 s0 은 통과");
	assert.equal(stepState("s0").pop().status, "executed", "s0 실행 기록이 남아야 함");

	// 4. s1: s0 성공 확인 전에는 막히고, 확인 뒤에는 단계 승인 요청까지 간다.
	assert.match(hook(s1Cmd).reason, /앞 단계 성공 확인 전에는/);
	const evFile = path.join(stateDir, "s0-ok.txt");
	fs.writeFileSync(evFile, "candidate-ok\n");
	const env = { ...process.env, DEPLOY_APPROVAL_STATE_DIR: stateDir };
	const ok = spawnSync(process.execPath, [path.join(root, ".agents/scripts/approval-plan.mjs"), "step-ok", planFile, "s0", "--evidence", evFile], { cwd: root, env, encoding: "utf8" });
	assert.equal(ok.status, 0, ok.stderr);
	const s1Ask = hook(s1Cmd);
	assert.match(s1Ask.reason, /단계 승인 필요: .* \/ s1/);
	assert.match(s1Ask.reason, /단계 승인 코드: STEP-[A-Z0-9]+/);
	appendHumanTurn(transcriptPath, `승인: ${s1Ask.reason.match(/STEP-[A-Z0-9]+/)[0]}`);
	assert.equal(hook(s1Cmd), null, "승인된 s1 은 통과");
});

test("읽기 전용 단계: 덧붙여 돌린 s0 과 step-ok 기록만으로는 s1 로 못 넘어가고, 막는 글이 글자 그대로 다시 내라고 알림", (t) => {
	const { root, stateDir, transcriptPath } = makeWorkspace(t);
	writeGateConfig(root);
	const scriptRel = "scripts/sample-web-prod-check.sh";
	const scriptAbs = path.join(root, scriptRel);
	fs.mkdirSync(path.dirname(scriptAbs), { recursive: true });
	fs.writeFileSync(scriptAbs, "#!/usr/bin/env bash\necho ok \"$1\"\n");
	const scriptSha = sha256(fs.readFileSync(scriptAbs));
	const step = (id) => ({ id, title: `${id} 확인(읽기만)`, commands: [`bash ${scriptRel} ${id}`], files: { [scriptRel]: scriptSha }, success_check: "끝줄 ok 확인", on_failure: "멈추고 보고" });
	const { planFile } = createValidPlan(root, { approval_mode: undefined, scenario: [step("s0"), step("s1")], rollback: { method: "읽기만 하는 계획이라 되돌릴 것이 없음", duration: "0분", step_ids: [] } });
	writePassingReviewReceipt(root, planFile);
	const sessionId = "sess-readonly-skip";
	const hook = (cmd) => runDeployGuardHook(cmd, { cwd: root, root, stateDir, transcriptPath, sessionId });

	const planAsk = hook(`bash ${scriptRel} s0`);
	assert.match(planAsk.reason, /전체 계획 승인이 아직 없습니다/, planAsk.reason);
	appendHumanTurn(transcriptPath, `승인: ${planAsk.reason.match(/PLAN-[A-Z0-9]+/)[0]}`);
	const s0Ask = hook(`bash ${scriptRel} s0`);
	appendHumanTurn(transcriptPath, `승인: ${s0Ask.reason.match(/STEP-[A-Z0-9]+/)[0]}`);
	// 승인 뒤 덧붙여 돌리려 함(11/14 실측 꼴) → 막힘. step-ok 를 남겨도 s1 은 못 간다.
	assert.equal(hook(`bash ${scriptRel} s0 2>&1 | tail -30`).decision, "block");
	const evFile = path.join(stateDir, "s0-ok.txt");
	fs.writeFileSync(evFile, "ok s0\n");
	const env = { ...process.env, DEPLOY_APPROVAL_STATE_DIR: stateDir };
	assert.equal(spawnSync(process.execPath, [path.join(root, ".agents/scripts/approval-plan.mjs"), "step-ok", planFile, "s0", "--evidence", evFile], { cwd: root, env, encoding: "utf8" }).status, 0);
	const blocked = hook(`bash ${scriptRel} s1`);
	assert.equal(blocked.decision, "block");
	assert.match(blocked.reason, /s0 단계가 실제 실행\(executed\)되지 않음/);
	assert.match(blocked.reason, /계획서에 적힌 글자 그대로/);
	// 글자 그대로 s0 을 내면 풀린다.
	assert.equal(hook(`bash ${scriptRel} s0`), null);
	assert.match(hook(`bash ${scriptRel} s1`).reason, /단계 승인 필요: .* \/ s1/);
});
