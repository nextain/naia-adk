"use strict";
// Approval gate tests: local-operations.
const { test, makeWorkspace, writeGateConfig, path, fs, assert, classifyProdMutations, runDeployGuardHook, createValidPlan, writePassingReviewReceipt, appendHumanTurn, deployPlan } = require("./approval-plan-fixtures.cjs");

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
	const code = d1?.reason.match(/승인 코드:\s*(PLAN-[0-9A-F]{64})/);
	assert.ok(code, JSON.stringify(d1));
	appendHumanTurn(transcriptPath, `계획 승인합니다 ${code[1]}`);
	const d2 = runDeployGuardHook(command, { cwd: root, root, stateDir, transcriptPath });
	assert.match(d2?.reason || "", /단계 승인 코드:\s*STEP-[0-9A-F]{64}/);
	assert.equal(d2.decision, "block");
	const stepCode = d2.reason.match(/단계 승인 코드:\s*(STEP-[0-9A-F]{64})/)[1];
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

test("목록 그룹(vm) run-command 의 변수 대상도 스크립트 안 한 값으로 서비스 이름을 정함", (t) => {
	const { root } = makeWorkspace(t);
	const dir = path.join(root, "runner");
	fs.mkdirSync(dir, { recursive: true });
	const tool = ["a", "z"].join("");
	fs.writeFileSync(path.join(dir, "op.sh"), [
		"#!/bin/bash",
		"case \"$1\" in",
		"  prod) RG=sample-prod-rg; VM=sample-prod-vm ;;",
		"  *) exit 2 ;;",
		"esac",
		`${tool} vm run-command invoke -g "$RG" --vm-name "$VM" --command-id RunShellScript --scripts 'true'`,
		"",
	].join("\n"));
	const hits = classifyProdMutations(`bash ${path.join(dir, "op.sh")} prod`, root);
	assert.ok(hits.some((h) => h.service === "azure:vm:sample-prod-vm"), `변수 대상이 풀려야 함: ${JSON.stringify(hits)}`);
	assert.ok(!hits.some((h) => /\$/.test(h.service)), `변수 이름이 서비스에 남으면 안 됨: ${JSON.stringify(hits)}`);
});

test("한 줄 여러 대입·heredoc 안 함수와 source 가 있어도 prod 갈래 값으로 VM 이름을 정하고, 명령 앞 대입은 묶지 않음", (t) => {
	const { root } = makeWorkspace(t);
	const dir = path.join(root, "runner");
	fs.mkdirSync(dir, { recursive: true });
	const tool = ["a", "z"].join("");
	const body = (bind, heredocBlock) => [
		"#!/bin/bash",
		"set -euo pipefail",
		bind,
		"case \"$ENVIRONMENT\" in",
		"  prod) RG=sample-prod-rg; VM=sample-prod-vm ;;",
		"  dev) RG=sample-dev-rg; VM=sample-dev-vm ;;",
		"  *) exit 64 ;;",
		"esac",
		...heredocBlock,
		`${tool} vm run-command create -g "$RG" --vm-name "$VM" --run-command-name x --script "@$TMPDIR/remote.sh"`,
		"",
	].join("\n");
	const quotedHeredoc = [
		"{",
		"  cat <<'REMOTE'",
		"cleanup() {",
		"  true",
		"}",
		"# the source just verified",
		"REMOTE",
		"} > \"$TMPDIR/remote.sh\"",
	];
	fs.writeFileSync(path.join(dir, "multi.sh"), body("ENVIRONMENT=\"$1\" RUN_ID=\"$2\" STAGE=\"${3:-backup}\"", quotedHeredoc));
	const hits = classifyProdMutations(`bash ${path.join(dir, "multi.sh")} prod 20261111T050000Z-x`, root);
	assert.ok(hits.length > 0 && hits.every((h) => h.service === "azure:vm:sample-prod-vm"), `prod 갈래 VM 으로 풀려야 함: ${JSON.stringify(hits)}`);
	const devHits = classifyProdMutations(`bash ${path.join(dir, "multi.sh")} dev 20261111T050000Z-x`, root);
	assert.deepEqual(devHits, [], `dev 인자는 운영 아님: ${JSON.stringify(devHits)}`);
	fs.writeFileSync(path.join(dir, "prefix.sh"), body("ENVIRONMENT=\"$1\" true", quotedHeredoc));
	const prefixHits = classifyProdMutations(`bash ${path.join(dir, "prefix.sh")} prod 20261111T050000Z-x`, root);
	assert.ok(prefixHits.length > 0 && prefixHits.every((h) => h.service !== "azure:vm:sample-prod-vm"), `명령 앞 대입은 셸 변수가 아니므로 갈래를 고르면 안 됨: ${JSON.stringify(prefixHits)}`);

	// <<- 탭 들여쓰기 종료자와 본문 안 eval/shift 도 본문이 비워져 정상 분기 선택
	fs.writeFileSync(path.join(dir, "dash-heredoc.sh"), body("ENVIRONMENT=\"$1\" RUN_ID=\"$2\"", [
		"cat <<-'REMOTE' > \"$TMPDIR/remote.sh\"",
		"\teval \"$PAYLOAD\"",
		"\tshift",
		"\tREMOTE",
	]));
	const dashHits = classifyProdMutations(`bash ${path.join(dir, "dash-heredoc.sh")} prod 20261111T050000Z-x`, root);
	assert.ok(dashHits.length > 0 && dashHits.every((h) => h.service === "azure:vm:sample-prod-vm"), `<<- 탭 heredoc 본문의 eval/shift 는 무시되어야 함: ${JSON.stringify(dashHits)}`);

	// heredoc 밖의 실제 source 는 보수적으로 원문을 유지해 갈래를 줄이지 않음
	fs.writeFileSync(path.join(dir, "outside-source.sh"), body("ENVIRONMENT=\"$1\"", [
		...quotedHeredoc,
		"source ./env.sh",
	]));
	const outsideSourceHits = classifyProdMutations(`bash ${path.join(dir, "outside-source.sh")} prod`, root);
	assert.ok(outsideSourceHits.length > 0 && outsideSourceHits.every((h) => h.service !== "azure:vm:sample-prod-vm"), `heredoc 밖 source 는 갈래를 줄이지 않아야 함: ${JSON.stringify(outsideSourceHits)}`);

	// 닫히지 않은 heredoc 이 명령 뒤에 있으면 보수적으로 원문을 유지해 갈래를 줄이지 않음
	fs.writeFileSync(path.join(dir, "unclosed-heredoc.sh"), [
		body("ENVIRONMENT=\"$1\"", []),
		"cat <<'REMOTE' > \"$TMPDIR/remote.sh\"",
		"echo unclosed",
		"",
	].join("\n"));
	const unclosedHits = classifyProdMutations(`bash ${path.join(dir, "unclosed-heredoc.sh")} prod`, root);
	assert.ok(unclosedHits.length > 0 && unclosedHits.every((h) => h.service !== "azure:vm:sample-prod-vm"), `닫히지 않은 heredoc 은 갈래를 줄이지 않아야 함: ${JSON.stringify(unclosedHits)}`);
});

module.exports = {
	localRegressionCases,
};
