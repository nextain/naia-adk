"use strict";
// Approval gate tests: target-fixtures.
const { makeWorkspace, path, fs, sha256, classifyProdMutations, assert, assessReadiness, verifiedPlanBinding, writeGateConfig, createValidPlan, runDeployGuardHook, spawnSync, appendHumanTurn } = require("./approval-plan-fixtures.cjs");

function pinnedScriptFixture(t, { body = 'case "$1" in s1) az vm run-command invoke -g sample-rg -n sample-vm --command-id RunShellScript --scripts @remote-s1.sh ;; r1) echo "$2" ;; esac\n', remote = "#!/usr/bin/env bash\nsystemctl restart sample-web\n", services = null } = {}) {
	const { root } = makeWorkspace(t);
	const planDir = path.join(root, ".agents", "progress", "sample-vm-work");
	const gatesDir = path.join(planDir, "gates");
	fs.mkdirSync(gatesDir, { recursive: true });
	const script = path.join(planDir, "vm.sh");
	const remotePath = path.join(planDir, "remote-s1.sh");
	fs.writeFileSync(script, `#!/usr/bin/env bash\nset -euo pipefail\n${body}`);
	fs.writeFileSync(remotePath, remote);
	const files = { [script]: sha256(fs.readFileSync(script)), [remotePath]: sha256(fs.readFileSync(remotePath)) };
	const real = services || (() => {
		// 훅처럼 분류기(classifyProdMutations)가 낸 서비스 집합을 쓴다.
		const hits = classifyProdMutations(`sudo bash ${script} s1`, root, 0, false, root);
		return [...new Set(hits.map((h) => h.service))];
	})();
	assert.ok(real.length > 0, "분류기 서비스 집합이 비어 있지 않아야 함");
	fs.mkdirSync(path.join(root, "config"), { recursive: true });
	fs.writeFileSync(path.join(root, "config", "deploy-gate.json"), JSON.stringify({ schema: "deploy-gate/v1", services: Object.fromEntries(real.map((s) => [s, { label: s, allowOps: true }])) }));
	const plan = {
		planId: "sample-vm-work",
		services: [`script:${script}`, ...real],
		scenario: [
			{ id: "s1", commands: [`sudo bash ${script} s1`], files: { ...files } },
			{ id: "r1", branch: "rollback", commands: [`bash ${script} r1 fixed-1`], files: { ...files } },
		],
		rollback: { step_ids: ["r1"] },
	};
	const assess = (stepId = "s1") => {
		const entry = plan.scenario.find((s) => s.id === stepId);
		const command = entry.commands[0];
		return assessReadiness(real, { root, command, cwd: root, planBinding: { plan, entry, command, cwd: root, gatesDir } });
	};
	const writeOps = () => fs.writeFileSync(path.join(gatesDir, "deploy.json"), JSON.stringify({ kind: "ops", services: real, reason: "고정 대본 운영 작업", createdAt: new Date().toISOString() }));
	const bind = (stepId = "s1", kind = "ops") => {
		const entry = plan.scenario.find((s) => s.id === stepId);
		return verifiedPlanBinding({ plan, entry, command: entry.commands[0], cwd: root, gatesDir }, "", kind, real, root);
	};
	return { root, planDir, gatesDir, script, remote: remotePath, files, plan, services: real, assess, writeOps, bind };
}

function transitionFixture(t) {
	const { root, stateDir, transcriptPath } = makeWorkspace(t);
	const service = "fixture:settings";
	writeGateConfig(root, { services: { [service]: { allowCustomCommands: true } } });
	const f = createValidPlan(root, { services: [service] });
	const before = "sample setting v1\n", after = "sample setting v2\n";
	const file = "scripts/setting.conf";
	const live = path.join(root, file);
	const pin = {
		role: "target", path: file, before: sha256(before), after: sha256(after),
		before_source: "scripts/original.conf", after_source: "scripts/candidate.conf",
		transitions: { s1: { to: "after", resume: true }, r1: { to: "before", partial_after: "s1", resume: true } },
	};
	fs.writeFileSync(live, before);
	fs.writeFileSync(path.join(root, pin.before_source), before);
	fs.writeFileSync(path.join(root, pin.after_source), after);
	fs.writeFileSync(f.scriptAbs, '#!/bin/sh\nset -eu\ncp "$1" "$2"\ncat "$2"\n');
	f.plan.file_pins = [pin];
	const argsByStep = {
		s1: [f.scriptRel, pin.after_source, file],
		r1: [f.scriptRel, pin.before_source, file],
	};
	const scriptSha = sha256(fs.readFileSync(f.scriptAbs));
	for (const entry of f.plan.scenario) {
		const args = argsByStep[entry.id];
		const source = args[1];
		entry.commands = [["bash", ...args].join(" ")];
		entry.files = {
			[f.scriptRel]: scriptSha,
			[source]: sha256(fs.readFileSync(path.join(root, source))),
			[file]: entry.id === "s1" ? pin.before : pin.after,
		};
	}
	const step1Cmd = f.plan.scenario[0].commands[0];
	const rollbackCmd = f.plan.scenario[1].commands[0];
	const writePlan = () => fs.writeFileSync(f.planFile, JSON.stringify(f.plan, null, 2));
	writePlan();
	const sessionId = "sample-target-session";
	const env = { ...process.env, DEPLOY_APPROVAL_STATE_DIR: stateDir };
	const hook = (command, session = sessionId) => runDeployGuardHook(command, { cwd: root, root, stateDir, transcriptPath, sessionId: session });
	const cli = (...args) => spawnSync(process.execPath, [path.join(root, ".agents/scripts/approval-plan.mjs"), args[0], f.planFile, ...args.slice(1)], { cwd: root, env, encoding: "utf8" });
	const evidence = path.join(stateDir, "result.txt");
	const run = id => {
		const args = argsByStep[id];
		assert.equal(hook(["bash", ...args].join(" ")), null);
		const child = spawnSync("bash", args, { cwd: root, encoding: "utf8" });
		assert.equal(child.status, 0, child.stderr);
		fs.writeFileSync(evidence, child.stdout);
	};
	return { ...f, step1Cmd, rollbackCmd, root, before, after, live, pin, hook, cli, run, sessionId, transcriptPath, env, evidence, writePlan, approve: text => appendHumanTurn(transcriptPath, text) };
}

module.exports = {
	pinnedScriptFixture,
	transitionFixture,
};
