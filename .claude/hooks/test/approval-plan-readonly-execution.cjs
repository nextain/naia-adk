"use strict";
// Approval gate tests: readonly-execution.
const { test, runDeployGuardHook, assert, fs, path, sha256, gitRun, writePassingReviewReceipt } = require("./approval-plan-fixtures.cjs");
const { setupReadOnlyOpsWorkspace } = require("./approval-plan-readonly-fixtures.cjs");

test("읽기 전용 ops B2: --parameters·다중 --scripts·모르는 옵션·셸 연산자·따옴표 쪼개기·R5(sudo bash/3토큰)·opsProblem 누락 방지", (t) => {
	const scriptRel = ".agents/progress/sample-ro-work/gates/ops/ro-check.sh";
	const allowCfg = { "azure:vm:sample-vm": { label: "샘플 VM", allowOps: true, allowCustomCommands: true } };
	const badAzCommands = [
		["--parameters", `az vm run-command invoke -g sample-rg -n sample-vm --command-id RunShellScript --scripts @${scriptRel} --parameters k=v`],
		["--scripts 둘", `az vm run-command invoke -g sample-rg -n sample-vm --command-id RunShellScript --scripts @${scriptRel} --scripts @${scriptRel}`],
		["--scripts 인자 둘", `az vm run-command invoke -g sample-rg -n sample-vm --command-id RunShellScript --scripts @${scriptRel} extra.sh`],
		["모르는 옵션", `az vm run-command invoke -g sample-rg -n sample-vm --command-id RunShellScript --scripts @${scriptRel} --timeout-in-seconds 30`],
		["--ids 옵션", `az vm run-command invoke -g sample-rg -n sample-vm --command-id RunShellScript --scripts @${scriptRel} --ids /sub/id`],
		["RunPowerShellScript", `az vm run-command invoke -g sample-rg -n sample-vm --command-id RunPowerShellScript --scripts @${scriptRel}`],
		["쪼갠 --scripts 옵션", `az vm run-command invoke -g sample-rg -n sample-vm --command-id RunShellScript --scr"i"pts @${scriptRel}`],
		["쪼갠 --scripts 값", `az vm run-command invoke -g sample-rg -n sample-vm --command-id RunShellScript --scripts=""@${scriptRel}`],
		["쪼갠 --query 옵션", `az vm run-command invoke -g sample-rg -n sample-vm --command-id RunShellScript --scripts @${scriptRel} --'query' value`],
		["셸 세미콜론", `az vm run-command invoke -g sample-rg -n sample-vm --command-id RunShellScript --scripts @${scriptRel}; echo hi`],
		["셸 &&", `az vm run-command invoke -g sample-rg -n sample-vm --command-id RunShellScript --scripts @${scriptRel} && true`],
		["셸 파이프", `az vm run-command invoke -g sample-rg -n sample-vm --command-id RunShellScript --scripts @${scriptRel} | cat`],
		["셸 리다이렉션", `az vm run-command invoke -g sample-rg -n sample-vm --command-id RunShellScript --scripts @${scriptRel} > /tmp/out`],
		["쿼리 안 치환 $( )", `az vm run-command invoke -g sample-rg -n sample-vm --command-id RunShellScript --scripts @${scriptRel} --query '$(id)'`],
		["쿼리 안 백틱", `az vm run-command invoke -g sample-rg -n sample-vm --command-id RunShellScript --scripts @${scriptRel} --query '\`id\`'`],
		["opsProblem VERSION_CHANGE", `az vm run-command invoke -g sample-rg -n sample-vm --command-id RunShellScript --scripts @${scriptRel} --query '--image'`],
	];
	for (const [label, cmd] of badAzCommands) {
		const fx = setupReadOnlyOpsWorkspace(t, {
			configServices: allowCfg,
			customCommand: cmd,
		});
		const d = runDeployGuardHook(fx.command, { cwd: fx.root, root: fx.root, stateDir: fx.stateDir, transcriptPath: fx.transcriptPath });
		assert.equal(d?.decision, "block", `${label}: 무코드 통과 금지`);
		assert.ok(!fx.readAudit().some((a) => a.approved_by === "readonly-no-code"), `${label}: readonly-no-code 감사가 찍히면 안 됨`);
	}

	// R5: sudo bash / 3토큰 bash <대본> <단계id> 는 allowCustomCommands 가 있으면 승인 코드 경로(PLAN-), 없으면 차단(무코드 아님)
	const sshScript = "#!/usr/bin/env bash\nssh sample-vm 'uptime'\n";
	for (const [label, cmd] of [
		["sudo bash", "sudo bash scripts/ro-ssh-check.sh"],
		["3토큰 bash 인자", "bash scripts/ro-ssh-check.sh s1"],
	]) {
		const fR5 = setupReadOnlyOpsWorkspace(t, {
			service: "ssh:sample-vm",
			scriptRel: "scripts/ro-ssh-check.sh",
			scriptBody: sshScript,
			configServices: { "ssh:sample-vm": { label: "SSH VM", allowOps: true, allowCustomCommands: true } },
			customCommand: cmd,
		});
		const dR5 = runDeployGuardHook(fR5.command, { cwd: fR5.root, root: fR5.root, stateDir: fR5.stateDir, transcriptPath: fR5.transcriptPath });
		assert.equal(dR5?.decision, "block", `${label}: 무코드 아님`);
		assert.match(dR5.reason, /PLAN-/, `${label}: 승인 코드 경로로 떨어져야 함`);
	}
});

test("읽기 전용 ops B3: 심볼릭 링크·상위 심볼릭 링크·미추적 파일·HEAD 불일치 파일 → 코드 필요(무코드 불가)", (t) => {
	const allowCfg = { "azure:vm:sample-vm": { label: "샘플 VM", allowOps: true, allowCustomCommands: true } };

	// 1. 대본 자체가 심볼릭 링크
	const fSym = setupReadOnlyOpsWorkspace(t, {
		configServices: allowCfg,
		commitScript: false,
		readOnlyScripts: [],
	});
	const targetRel = ".agents/progress/sample-ro-work/gates/ops/real-target.sh";
	const symRel = ".agents/progress/sample-ro-work/gates/ops/sym-link.sh";
	fs.writeFileSync(path.join(fSym.root, targetRel), "#!/usr/bin/env bash\necho ok\n");
	fs.symlinkSync("real-target.sh", path.join(fSym.root, symRel));
	const symSha = sha256(fs.readFileSync(path.join(fSym.root, symRel)));
	gitRun(fSym.root, ["add", targetRel, symRel]);
	const cfgSym = JSON.parse(fs.readFileSync(fSym.cfgPath, "utf8"));
	cfgSym.readOnlyScripts = [{ sha256: symSha, path: symRel, service: "azure:vm:sample-vm" }];
	fs.writeFileSync(fSym.cfgPath, JSON.stringify(cfgSym, null, 2));
	gitRun(fSym.root, ["add", "config/deploy-gate.json"]);
	gitRun(fSym.root, ["commit", "-m", "commit symlink script"]);
	const symCmd = `az vm run-command invoke -g sample-rg -n sample-vm --command-id RunShellScript --scripts @${symRel}`;
	const planSym = JSON.parse(fs.readFileSync(fSym.planFile, "utf8"));
	planSym.scenario[0].commands = [symCmd];
	planSym.scenario[0].files = { [symRel]: symSha };
	fs.writeFileSync(fSym.planFile, JSON.stringify(planSym, null, 2));
	writePassingReviewReceipt(fSym.root, fSym.planFile, { readOnlyScripts: [] });
	const dSym = runDeployGuardHook(symCmd, { cwd: fSym.root, root: fSym.root, stateDir: fSym.stateDir, transcriptPath: fSym.transcriptPath });
	assert.equal(dSym?.decision, "block");
	assert.match(dSym.reason, /PLAN-/, "심볼릭 링크 대본은 무코드가 아니라 승인 코드 필요로 떨어져야 함");

	// 2. 상위 폴더가 심볼릭 링크
	const fDirSym = setupReadOnlyOpsWorkspace(t, {
		configServices: allowCfg,
		commitScript: false,
		readOnlyScripts: [],
	});
	fs.mkdirSync(path.join(fDirSym.root, "real-ops"), { recursive: true });
	const realInDir = "real-ops/ro.sh";
	fs.writeFileSync(path.join(fDirSym.root, realInDir), "#!/usr/bin/env bash\necho ok\n");
	fs.symlinkSync("real-ops", path.join(fDirSym.root, "link-ops"));
	const dirSymRel = "link-ops/ro.sh";
	const dirSymSha = sha256(fs.readFileSync(path.join(fDirSym.root, dirSymRel)));
	gitRun(fDirSym.root, ["add", realInDir, "link-ops"]);
	const cfgDirSym = JSON.parse(fs.readFileSync(fDirSym.cfgPath, "utf8"));
	cfgDirSym.readOnlyScripts = [{ sha256: dirSymSha, path: dirSymRel, service: "azure:vm:sample-vm" }];
	fs.writeFileSync(fDirSym.cfgPath, JSON.stringify(cfgDirSym, null, 2));
	gitRun(fDirSym.root, ["add", "config/deploy-gate.json"]);
	gitRun(fDirSym.root, ["commit", "-m", "commit parent symlink"]);
	const dirSymCmd = `az vm run-command invoke -g sample-rg -n sample-vm --command-id RunShellScript --scripts @${dirSymRel}`;
	const planDirSym = JSON.parse(fs.readFileSync(fDirSym.planFile, "utf8"));
	planDirSym.scenario[0].commands = [dirSymCmd];
	planDirSym.scenario[0].files = { [dirSymRel]: dirSymSha };
	fs.writeFileSync(fDirSym.planFile, JSON.stringify(planDirSym, null, 2));
	writePassingReviewReceipt(fDirSym.root, fDirSym.planFile, { readOnlyScripts: [] });
	const dDirSym = runDeployGuardHook(dirSymCmd, { cwd: fDirSym.root, root: fDirSym.root, stateDir: fDirSym.stateDir, transcriptPath: fDirSym.transcriptPath });
	assert.equal(dDirSym?.decision, "block");
	assert.match(dDirSym.reason, /PLAN-/, "상위 심볼릭 링크 대본도 승인 코드 필요");

	// 3. 미추적 쓰기 가능 대본 파일 (설정에 sha+path+service 를 맞춰 커밋해도 대본이 git 미추적이면 무코드 불가)
	const fUntrackedScript = setupReadOnlyOpsWorkspace(t, {
		configServices: allowCfg,
		commitScript: false,
		readOnlyScripts: null,
		bindReadOnlyScripts: false,
	});
	writePassingReviewReceipt(fUntrackedScript.root, fUntrackedScript.planFile, {
		readOnlyScripts: [{ sha256: fUntrackedScript.scriptSha, path: fUntrackedScript.scriptRel, service: "azure:vm:sample-vm", script_sha256: fUntrackedScript.scriptSha }],
	});
	const dUntrackedScript = runDeployGuardHook(fUntrackedScript.command, { cwd: fUntrackedScript.root, root: fUntrackedScript.root, stateDir: fUntrackedScript.stateDir, transcriptPath: fUntrackedScript.transcriptPath });
	assert.equal(dUntrackedScript?.decision, "block");
	assert.match(dUntrackedScript.reason, /PLAN-/, "git 미추적 대본은 무코드 불가 → 승인 코드 필요");

	// 4. 추적 중이지만 작업 트리 내용이 HEAD 블롭과 다름
	const fModifiedHead = setupReadOnlyOpsWorkspace(t, {
		configServices: allowCfg,
		commitScript: true,
		readOnlyScripts: [],
		bindReadOnlyScripts: false,
	});
	const modifiedBody = "#!/usr/bin/env bash\necho v2-not-committed\n";
	fs.writeFileSync(fModifiedHead.scriptAbs, modifiedBody);
	const modSha = sha256(Buffer.from(modifiedBody, "utf8"));
	const cfgMod = JSON.parse(fs.readFileSync(fModifiedHead.cfgPath, "utf8"));
	cfgMod.readOnlyScripts = [{ sha256: modSha, path: fModifiedHead.scriptRel, service: "azure:vm:sample-vm" }];
	fs.writeFileSync(fModifiedHead.cfgPath, JSON.stringify(cfgMod, null, 2));
	gitRun(fModifiedHead.root, ["add", "config/deploy-gate.json"]);
	gitRun(fModifiedHead.root, ["commit", "-m", "register v2 sha without committing script"]);
	const planMod = JSON.parse(fs.readFileSync(fModifiedHead.planFile, "utf8"));
	planMod.scenario[0].files = { [fModifiedHead.scriptRel]: modSha };
	fs.writeFileSync(fModifiedHead.planFile, JSON.stringify(planMod, null, 2));
	writePassingReviewReceipt(fModifiedHead.root, fModifiedHead.planFile, {
		readOnlyScripts: [{ sha256: modSha, path: fModifiedHead.scriptRel, service: "azure:vm:sample-vm", script_sha256: modSha }],
	});
	const dMod = runDeployGuardHook(fModifiedHead.command, { cwd: fModifiedHead.root, root: fModifiedHead.root, stateDir: fModifiedHead.stateDir, transcriptPath: fModifiedHead.transcriptPath });
	assert.equal(dMod?.decision, "block");
	assert.match(dMod.reason, /PLAN-/, "HEAD 블롭과 다른 작업 트리 대본은 무코드 불가 → 승인 코드 필요");
});

test("읽기 전용 ops B4: 와일드카드 service 설정 오류 및 다른 경로·서비스 sha 재사용 차단", (t) => {
	// 1. 와일드카드(*, ?) service → config 설정 오류로 즉시 차단
	for (const globSvc of ["azure:vm:*", "azure:vm:sample-?m", "azure:vm:[s]ample-vm"]) {
		const fGlob = setupReadOnlyOpsWorkspace(t, {
			configServices: { "azure:vm:sample-vm": { label: "샘플 VM", allowOps: true, allowCustomCommands: true } },
			readOnlyScripts: [{ sha256: "a".repeat(64), path: ".agents/progress/sample-ro-work/gates/ops/ro-check.sh", service: globSvc }],
			bindReadOnlyScripts: false,
		});
		const dGlob = runDeployGuardHook(fGlob.command, { cwd: fGlob.root, root: fGlob.root, stateDir: fGlob.stateDir, transcriptPath: fGlob.transcriptPath });
		assert.equal(dGlob?.decision, "block", `글롭 service(${globSvc})는 차단되어야 함`);
		assert.match(dGlob.reason, /와일드카드|배열|설정/, `글롭 거부 이유 명시(${globSvc}): ${dGlob.reason}`);
	}

	// 2. path 누락 → config 설정 오류로 즉시 차단
	const fNoPath = setupReadOnlyOpsWorkspace(t, {
		readOnlyScripts: [{ sha256: "a".repeat(64), service: "azure:vm:sample-vm" }],
		bindReadOnlyScripts: false,
	});
	const dNoPath = runDeployGuardHook(fNoPath.command, { cwd: fNoPath.root, root: fNoPath.root, stateDir: fNoPath.stateDir, transcriptPath: fNoPath.transcriptPath });
	assert.equal(dNoPath?.decision, "block");
	assert.match(dNoPath.reason, /path/);

	// 3. 같은 sha 를 다른 경로(copy)에 재사용 → 무코드 불가, 승인 코드 필요 (리뷰 영수증이 registered-other.sh 를 묶고 있어도 ro-copy.sh 는 거부)
	const copyRel = ".agents/progress/sample-ro-work/gates/ops/ro-copy.sh";
	const regOtherRel = ".agents/progress/sample-ro-work/gates/ops/registered-other.sh";
	const fReusePath = setupReadOnlyOpsWorkspace(t, {
		configServices: { "azure:vm:sample-vm": { label: "샘플 VM", allowOps: true, allowCustomCommands: true } },
		scriptRel: copyRel,
		readOnlyScripts: [{ sha256: "0".repeat(64), path: regOtherRel, service: "azure:vm:sample-vm" }],
		bindReadOnlyScripts: false,
	});
	fs.writeFileSync(path.join(fReusePath.root, regOtherRel), fs.readFileSync(fReusePath.scriptAbs));
	gitRun(fReusePath.root, ["add", regOtherRel]);
	const cfgCopy = JSON.parse(fs.readFileSync(fReusePath.cfgPath, "utf8"));
	cfgCopy.readOnlyScripts = [{ sha256: fReusePath.scriptSha, path: regOtherRel, service: "azure:vm:sample-vm" }];
	fs.writeFileSync(fReusePath.cfgPath, JSON.stringify(cfgCopy, null, 2));
	gitRun(fReusePath.root, ["add", "config/deploy-gate.json"]);
	gitRun(fReusePath.root, ["commit", "-m", "register different path with same sha"]);
	writePassingReviewReceipt(fReusePath.root, fReusePath.planFile, {
		readOnlyScripts: [{ sha256: fReusePath.scriptSha, path: regOtherRel, service: "azure:vm:sample-vm", script_sha256: fReusePath.scriptSha }],
	});
	const dReusePath = runDeployGuardHook(fReusePath.command, { cwd: fReusePath.root, root: fReusePath.root, stateDir: fReusePath.stateDir, transcriptPath: fReusePath.transcriptPath });
	assert.equal(dReusePath?.decision, "block");
	assert.match(dReusePath.reason, /PLAN-/, "같은 sha 여도 등록된 path 와 다르면 승인 코드 필요");

	// 4. 같은 sha+path 를 다른 service 로 재사용 → 무코드 불가, 승인 코드 필요
	const fReuseSvc = setupReadOnlyOpsWorkspace(t, {
		configServices: { "azure:vm:sample-vm": { label: "샘플 VM", allowOps: true, allowCustomCommands: true } },
		readOnlyScripts: [],
		bindReadOnlyScripts: false,
	});
	const cfgSvcReuse = JSON.parse(fs.readFileSync(fReuseSvc.cfgPath, "utf8"));
	cfgSvcReuse.readOnlyScripts = [{ sha256: fReuseSvc.scriptSha, path: fReuseSvc.scriptRel, service: "azure:vm:other-vm" }];
	fs.writeFileSync(fReuseSvc.cfgPath, JSON.stringify(cfgSvcReuse, null, 2));
	gitRun(fReuseSvc.root, ["add", "config/deploy-gate.json"]);
	gitRun(fReuseSvc.root, ["commit", "-m", "register other service"]);
	writePassingReviewReceipt(fReuseSvc.root, fReuseSvc.planFile, {
		readOnlyScripts: [{ sha256: fReuseSvc.scriptSha, path: fReuseSvc.scriptRel, service: "azure:vm:other-vm", script_sha256: fReuseSvc.scriptSha }],
	});
	const dReuseSvc = runDeployGuardHook(fReuseSvc.command, { cwd: fReuseSvc.root, root: fReuseSvc.root, stateDir: fReuseSvc.stateDir, transcriptPath: fReuseSvc.transcriptPath });
	assert.equal(dReuseSvc?.decision, "block");
	assert.match(dReuseSvc.reason, /PLAN-/, "다른 service 에 등록된 항목 재사용 시 승인 코드 필요");
});
