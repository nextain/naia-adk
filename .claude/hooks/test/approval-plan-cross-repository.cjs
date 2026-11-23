"use strict";
// Approval gate tests: cross-repository.
const { test, fs, path, os, populatePlanRepo, createValidPlan, sha256, writePassingReviewReceipt, spawnSync, SCRIPT_PATH, REPO_ROOT, assert, writeGateConfig, deployPlan, gitRun } = require("./approval-plan-fixtures.cjs");
const { setupReadOnlyOpsWorkspace } = require("./approval-plan-readonly-fixtures.cjs");

test("cross-repo: 다른 git 저장소·worktree 계획서 check·report·review-prompt(readOnlyScripts)·preapprove·step-ok 및 심볼릭 거부", (t) => {
	const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "approval-plan-cross-repo-")));
	t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

	// 1. 다른 git 저장소(.git 디렉토리) + 실행기 해시가 REPO_ROOT 와 다른 경우
	const foreignRoot = path.join(tmp, "foreign-repo");
	const stateDir = path.join(tmp, "state");
	fs.mkdirSync(stateDir, { recursive: true });
	populatePlanRepo(foreignRoot, { foreignMarker: "foreign-repo-only" });
	const { planFile, scriptRel } = createValidPlan(foreignRoot);
	const customScript = "#!/usr/bin/env bash\n# foreign-only-rollout\naz containerapp update -n sample-web-prod -g sample-rg --image sample/web:v1\n";
	fs.writeFileSync(path.join(foreignRoot, scriptRel), customScript);
	const customSha = sha256(Buffer.from(customScript, "utf8"));
	const loadedForeignPlan = JSON.parse(fs.readFileSync(planFile, "utf8"));
	loadedForeignPlan.scenario[0].files[scriptRel] = customSha;
	fs.writeFileSync(planFile, JSON.stringify(loadedForeignPlan, null, 2));
	writePassingReviewReceipt(foreignRoot, planFile);

	const env = { ...process.env, DEPLOY_APPROVAL_STATE_DIR: stateDir };
	const chk = spawnSync(process.execPath, [SCRIPT_PATH, "check", planFile], { cwd: REPO_ROOT, env, encoding: "utf8" });
	assert.equal(chk.status, 0, `check failed:\n${chk.stdout}\n${chk.stderr}`);
	assert.match(chk.stdout, /계획서: \.agents\/progress\/sample-work\/gates\/deploy-plan\.json/);
	assert.match(chk.stdout, /적대 리뷰: 통과/);

	const rep = spawnSync(process.execPath, [SCRIPT_PATH, "report", planFile], { cwd: REPO_ROOT, env, encoding: "utf8" });
	assert.equal(rep.status, 0, `report failed:\n${rep.stderr}`);
	assert.match(rep.stdout, /\[운영 배포 승인 요청\] sample-web-rollout-01/);

	const rp = spawnSync(process.execPath, [SCRIPT_PATH, "review-prompt", planFile], { cwd: REPO_ROOT, env, encoding: "utf8" });
	assert.equal(rp.status, 0, `review-prompt failed:\n${rp.stderr}`);
	assert.match(rp.stdout, new RegExp(`\\(sha ${customSha}\\)`));
	assert.match(rp.stdout, /# foreign-only-rollout/);

	const pre = spawnSync(process.execPath, [SCRIPT_PATH, "preapprove", planFile, "--session", "cross-repo-sess-1"], { cwd: REPO_ROOT, env, encoding: "utf8" });
	assert.equal(pre.status, 0, `preapprove failed:\n${pre.stdout}\n${pre.stderr}`);
	assert.match(pre.stdout, /사전발급 코드\(사용자 본인이 한 메시지로 승인\): PLAN PLAN-[0-9A-F]{64} s1 STEP-[0-9A-F]{64} r1 STEP-[0-9A-F]{64}/);

	const evFile = path.join(stateDir, "s1-ok.txt");
	fs.writeFileSync(evFile, "HTTP/1.1 200 OK\n");
	const okRes = spawnSync(process.execPath, [SCRIPT_PATH, "step-ok", planFile, "s1", "--evidence", evFile], { cwd: REPO_ROOT, env, encoding: "utf8" });
	assert.equal(okRes.status, 0, `step-ok failed:\n${okRes.stderr}`);
	assert.match(okRes.stdout, /단계 s1 성공 확인 기록: \.agents\/progress\/sample-work\/gates\/deploy-steps\/s1\.json/);

	// 1b. 다른 git 저장소의 readOnlyScripts 가 review-prompt 에도 planRoot 기준으로 실림(PR147 결합)
	const fRoForeign = setupReadOnlyOpsWorkspace(t);
	const realRoRoot = fs.realpathSync(fRoForeign.root);
	const realRoPlan = path.join(realRoRoot, ".agents", "progress", "sample-ro-work", "gates", "deploy-plan.json");
	const rpRo = spawnSync(process.execPath, [SCRIPT_PATH, "review-prompt", realRoPlan], { cwd: REPO_ROOT, env, encoding: "utf8" });
	assert.equal(rpRo.status, 0, `cross-repo readOnlyScripts review-prompt failed:\n${rpRo.stderr}`);
	assert.match(rpRo.stdout, /readOnlyScripts/);
	assert.match(rpRo.stdout, new RegExp(fRoForeign.scriptSha));

	// 2. 다른 git worktree(.git 파일) 저장소
	const wtRoot = path.join(tmp, "foreign-wt");
	populatePlanRepo(wtRoot, { gitMode: "worktree", foreignMarker: "foreign-wt-only" });
	const { planFile: wtPlan } = createValidPlan(wtRoot);
	writePassingReviewReceipt(wtRoot, wtPlan);
	const wtChk = spawnSync(process.execPath, [SCRIPT_PATH, "check", wtPlan], { cwd: REPO_ROOT, env, encoding: "utf8" });
	assert.equal(wtChk.status, 0, `worktree check failed:\n${wtChk.stdout}\n${wtChk.stderr}`);
	const wtPre = spawnSync(process.execPath, [SCRIPT_PATH, "preapprove", wtPlan, "--session", "cross-repo-wt-1"], { cwd: REPO_ROOT, env, encoding: "utf8" });
	assert.equal(wtPre.status, 0, `worktree preapprove failed:\n${wtPre.stderr}`);

	// 3. 자기 저장소(ROOT) 안 계획서
	const toolRoot = path.join(tmp, "self-repo");
	populatePlanRepo(toolRoot);
	const { planFile: selfPlan } = createValidPlan(toolRoot);
	writePassingReviewReceipt(toolRoot, selfPlan);
	const selfScript = path.join(toolRoot, ".agents/scripts/approval-plan.mjs");
	assert.equal(spawnSync(process.execPath, [selfScript, "check", selfPlan], { cwd: toolRoot, env, encoding: "utf8" }).status, 0);
	assert.equal(spawnSync(process.execPath, [selfScript, "preapprove", selfPlan, "--session", "self-sess-1"], { cwd: toolRoot, env, encoding: "utf8" }).status, 0);

	// 4. 심볼릭 링크·저장소 밖(.git 없음)·심볼릭 .git 경로 거부
	const symPlanRepo = path.join(tmp, "sym-plan-repo");
	populatePlanRepo(symPlanRepo, { foreignMarker: "sym-plan" });
	const { planFile: targetCopy, gatesDir: symGatesDir } = createValidPlan(symPlanRepo);
	const renamedReal = path.join(symGatesDir, "real-plan.json");
	fs.renameSync(targetCopy, renamedReal);
	fs.symlinkSync(renamedReal, targetCopy);

	const linkedRepo = path.join(tmp, "linked-foreign-repo");
	fs.symlinkSync(foreignRoot, linkedRepo);
	const linkedPlan = path.join(linkedRepo, ".agents/progress/sample-work/gates/deploy-plan.json");

	const selfGates = path.join(toolRoot, ".agents/progress/sym-work/gates");
	fs.mkdirSync(selfGates, { recursive: true });
	const selfSymPlan = path.join(selfGates, "deploy-plan.json");
	fs.symlinkSync(planFile, selfSymPlan);

	const noGitRoot = path.join(tmp, "no-git-dir");
	populatePlanRepo(noGitRoot, { gitMode: "none" });
	const { planFile: noGitPlan } = createValidPlan(noGitRoot);
	writePassingReviewReceipt(noGitRoot, noGitPlan);

	const symGitRepo = path.join(tmp, "sym-git-repo");
	const realGit = path.join(tmp, "real-dot-git");
	fs.mkdirSync(realGit, { recursive: true });
	fs.mkdirSync(symGitRepo, { recursive: true });
	fs.symlinkSync(realGit, path.join(symGitRepo, ".git"));
	populatePlanRepo(symGitRepo, { gitMode: "none" });
	const { planFile: symGitPlan } = createValidPlan(symGitRepo);
	writePassingReviewReceipt(symGitRepo, symGitPlan);

	for (const [label, script, planArg] of [
		["symlinked plan file", SCRIPT_PATH, targetCopy],
		["symlinked repo dir", SCRIPT_PATH, linkedPlan],
		["symlink inside ROOT", selfScript, selfSymPlan],
		["no .git directory", SCRIPT_PATH, noGitPlan],
		["symlinked .git", SCRIPT_PATH, symGitPlan],
	]) {
		assert.notEqual(spawnSync(process.execPath, [script, "check", planArg], { cwd: REPO_ROOT, env, encoding: "utf8" }).status, 0, `${label}: check must fail closed`);
		assert.notEqual(spawnSync(process.execPath, [script, "preapprove", planArg, "--session", "deny-sess"], { cwd: REPO_ROOT, env, encoding: "utf8" }).status, 0, `${label}: preapprove must fail closed`);
	}
});

test("cross-repo review: 외부 저장소 계획서 review 가 planRoot 기준으로 프롬프트·매니페스트·bwrap --chdir 를 쓰고 check/preapprove 를 통과함", (t) => {
	const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "approval-plan-cross-review-")));
	t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
	const extRoot = path.join(tmp, "external-app");
	fs.mkdirSync(path.join(extRoot, "scripts"), { recursive: true });
	assert.equal(spawnSync("git", ["init", "-q", extRoot], { encoding: "utf8" }).status, 0);
	assert.equal(spawnSync("git", ["-C", extRoot, "config", "user.email", "ext@example.invalid"], { encoding: "utf8" }).status, 0);
	assert.equal(spawnSync("git", ["-C", extRoot, "config", "user.name", "Ext"], { encoding: "utf8" }).status, 0);

	// 주의: external-app 안에는 .agents/scripts 실행기 파일이 전혀 없다(순수 외부 저장소).
	const { planFile, scriptRel, gatesDir } = createValidPlan(extRoot, { name: "ext-web-rollout-01" });
	// createValidPlan 이 복사한 실행기 파일은 제거해 "실행기 없는 순수 외부 저장소" 조건 검증
	fs.rmSync(path.join(extRoot, ".agents/scripts"), { recursive: true, force: true });
	fs.rmSync(path.join(extRoot, ".claude/hooks"), { recursive: true, force: true });
	fs.rmSync(path.join(extRoot, ".claude/deploy"), { recursive: true, force: true });

	const pinnedScript = "#!/usr/bin/env bash\n# external-pinned-unique-marker\naz containerapp update -n sample-web-prod -g sample-rg --image sample/web:v9\n";
	fs.writeFileSync(path.join(extRoot, scriptRel), pinnedScript, { mode: 0o755 });
	const pinnedSha = sha256(Buffer.from(pinnedScript, "utf8"));

	const roScriptRel = "scripts/check-ext-ro.sh";
	const roScript = "#!/usr/bin/env bash\n# external-ro-unique-marker\naz containerapp show -n sample-web-prod -g sample-rg\n";
	fs.writeFileSync(path.join(extRoot, roScriptRel), roScript, { mode: 0o755 });
	const roSha = sha256(Buffer.from(roScript, "utf8"));

	writeGateConfig(extRoot, {
		services: {
			"azure:containerapp:sample-web-prod": { label: "샘플 웹 운영 앱", allowOps: true, allowRollback: true, commandMustContain: ["sample-web-prod"] },
		},
		readOnlyScripts: [{ sha256: roSha, path: roScriptRel, service: "azure:containerapp:sample-web-prod", note: "읽기 전용 확인" }],
	});

	const planObj = JSON.parse(fs.readFileSync(planFile, "utf8"));
	planObj.scenario[0].files[scriptRel] = pinnedSha;
	planObj.scenario[0].files[roScriptRel] = roSha;
	fs.writeFileSync(planFile, JSON.stringify(planObj, null, 2));

	assert.equal(spawnSync("git", ["-C", extRoot, "add", "scripts", "config"], { encoding: "utf8" }).status, 0);
	assert.equal(spawnSync("git", ["-C", extRoot, "commit", "-qm", "init ext"], { encoding: "utf8" }).status, 0);

	const binDir = path.join(tmp, "bin");
	const fakeHome = path.join(tmp, "home");
	fs.mkdirSync(binDir, { recursive: true });
	fs.mkdirSync(path.join(fakeHome, ".gemini"), { recursive: true });
	fs.mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
	const bwrapArgsFile = path.join(tmp, "bwrap-args.txt");
	const reviewerCwdFile = path.join(tmp, "reviewer-cwd.txt");
	const receivedPromptFile = path.join(tmp, "received-prompt.txt");
	fs.writeFileSync(path.join(binDir, "bwrap"), `#!/bin/sh
printf '%s\\n' "$@" > "${bwrapArgsFile}"
while [ "$1" != "--" ] && [ "$#" -gt 0 ]; do shift; done
shift
exec "$@"
`, { mode: 0o755 });
	const passBody = ["판정: PASS", ...deployPlan.CRITERIA.map(([id]) => `${id}: PASS`), "참고 지적: 0", "남은 지적: 0"].join("\n");
	const fakeArgon = path.join(binDir, "fake-agy");
	fs.writeFileSync(fakeArgon, `#!/bin/sh
pwd -P > "${reviewerCwdFile}"
cat > "${receivedPromptFile}"
cat <<'REVIEW_EOF'
${passBody}
REVIEW_EOF
`, { mode: 0o755 });

	const stateDir = path.join(tmp, "state");
	fs.mkdirSync(stateDir, { recursive: true });
	const env = {
		...process.env,
		HOME: fakeHome,
		PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
		APPROVAL_PLAN_ARGON_BIN: fakeArgon,
		DEPLOY_APPROVAL_STATE_DIR: stateDir,
	};

	// ADK 저장소 루트(REPO_ROOT)에서 외부 계획서를 리뷰해도 planRoot(extRoot) 기준으로 동작해야 함
	const rev = spawnSync(process.execPath, [SCRIPT_PATH, "review", planFile, "--author", "muse"], {
		cwd: REPO_ROOT, encoding: "utf8", timeout: 30000, env,
	});
	assert.equal(rev.status, 0, `cross-repo review failed:\n${rev.stdout}\n${rev.stderr}`);

	const bwrapArgs = fs.readFileSync(bwrapArgsFile, "utf8").trim().split("\n");
	const chdirIdx = bwrapArgs.indexOf("--chdir");
	assert.ok(chdirIdx >= 0, `bwrap --chdir missing: ${JSON.stringify(bwrapArgs)}`);
	assert.equal(bwrapArgs[chdirIdx + 1], extRoot, "bwrap --chdir 는 planRoot 여야 함");
	assert.equal(fs.readFileSync(reviewerCwdFile, "utf8").trim(), extRoot, "reviewer process cwd 는 planRoot 여야 함");

	const promptSent = fs.readFileSync(receivedPromptFile, "utf8");
	assert.match(promptSent, new RegExp(pinnedSha));
	assert.match(promptSent, /external-pinned-unique-marker/);
	assert.match(promptSent, new RegExp(roSha));
	assert.match(promptSent, /external-ro-unique-marker/);

	const rec = JSON.parse(fs.readFileSync(path.join(gatesDir, deployPlan.REVIEW_FILE), "utf8"));
	assert.equal(rec.plan, path.relative(extRoot, planFile), "review record plan path must be relative to planRoot");
	assert.equal(rec.read_only_scripts?.length, 1, "readOnlyScripts must bind from external planRoot");
	assert.equal(rec.read_only_scripts[0].path, roScriptRel);
	assert.equal(rec.reviewers.length, 1);
	const expectedManifest = deployPlan.reviewInputManifest(planFile, extRoot, { readOnlyScripts: rec.read_only_scripts });
	assert.equal(rec.reviewers[0].receipt.input_manifest_sha256, expectedManifest, "manifest 는 planRoot 기준으로 계산돼야 함");

	const chk = spawnSync(process.execPath, [SCRIPT_PATH, "check", planFile], { cwd: REPO_ROOT, encoding: "utf8", env });
	assert.equal(chk.status, 0, `cross-repo check after review failed:\n${chk.stdout}\n${chk.stderr}`);
	const pre = spawnSync(process.execPath, [SCRIPT_PATH, "preapprove", planFile, "--session", "ext-review-sess-1"], { cwd: REPO_ROOT, encoding: "utf8", env });
	assert.equal(pre.status, 0, `cross-repo preapprove after review failed:\n${pre.stdout}\n${pre.stderr}`);

	// 다른 실행기 해시(foreignMarker)가 있는 외부 저장소에서도 ADK(ROOT) 실행기 기준으로 review 통과(deploy-plan.js:732 회귀 방지)
	const markedRoot = path.join(tmp, "marked-foreign-app");
	populatePlanRepo(markedRoot, { foreignMarker: "different-foreign-executor" });
	assert.equal(spawnSync("git", ["init", "-q", markedRoot], { encoding: "utf8" }).status, 0);
	assert.equal(spawnSync("git", ["-C", markedRoot, "config", "user.email", "ext@example.invalid"], { encoding: "utf8" }).status, 0);
	assert.equal(spawnSync("git", ["-C", markedRoot, "config", "user.name", "Ext"], { encoding: "utf8" }).status, 0);
	const { planFile: markedPlan } = createValidPlan(markedRoot, { name: "marked-ext-rollout-01" });
	assert.equal(spawnSync("git", ["-C", markedRoot, "add", "-A"], { encoding: "utf8" }).status, 0);
	assert.equal(spawnSync("git", ["-C", markedRoot, "commit", "-qm", "init marked"], { encoding: "utf8" }).status, 0);
	const markedRev = spawnSync(process.execPath, [SCRIPT_PATH, "review", markedPlan, "--author", "muse"], {
		cwd: markedRoot, encoding: "utf8", timeout: 30000, env,
	});
	assert.equal(markedRev.status, 0, `marked foreign review failed:\n${markedRev.stdout}\n${markedRev.stderr}`);
});

test("review snapshot ignores only the deploy audit log during review", (t) => {
	for (const [changed, shouldPass] of [[".claude/deploy/audit.jsonl", true], ["src/code.js", false], [".claude/deploy/audit.jsonl.extra", false]]) {
		const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "review-audit-snapshot-")));
		t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
		const root = path.join(tmp, "repo");
		fs.mkdirSync(root);
		gitRun(root, ["init", "-q"]);
		gitRun(root, ["config", "user.email", "test@example.invalid"]);
		gitRun(root, ["config", "user.name", "Test"]);
		const { planFile } = createValidPlan(root);
		writeGateConfig(root, { planReview: { reviewer: "argon", until: new Date(Date.now() + 60000).toISOString() } });
		for (const rel of [".claude/deploy/audit.jsonl", "src/code.js", ".claude/deploy/audit.jsonl.extra"]) {
			const file = path.join(root, rel);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, "initial\n");
		}
		gitRun(root, ["add", "-A"]);
		gitRun(root, ["commit", "-qm", "initial"]);
		const bin = path.join(tmp, "bin"), home = path.join(tmp, "home"), state = path.join(tmp, "state");
		fs.mkdirSync(bin); fs.mkdirSync(path.join(home, ".gemini"), { recursive: true }); fs.mkdirSync(state);
		fs.writeFileSync(path.join(bin, "bwrap"), '#!/bin/sh\nwhile [ "$1" != "--" ] && [ "$#" -gt 0 ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 });
		const body = ["판정: PASS", ...deployPlan.CRITERIA.map(([id]) => `${id}: PASS`), "참고 지적: 0", "남은 지적: 0"].join("\n");
		const reviewer = path.join(bin, "reviewer");
		const mutation = shouldPass ? `printf '%s\\n' '{"event":"blocked-state-lock"}'` : "printf x";
		fs.writeFileSync(reviewer, `#!/bin/sh\ncat >/dev/null\n${mutation} >> ${JSON.stringify(path.join(root, changed))}\ncat <<'EOF'\n${body}\nEOF\n`, { mode: 0o755 });
		const env = { ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, APPROVAL_PLAN_ARGON_BIN: reviewer, DEPLOY_APPROVAL_STATE_DIR: state };
		const result = spawnSync(process.execPath, [SCRIPT_PATH, "review", planFile, "--author", "muse"], { cwd: root, env, encoding: "utf8", timeout: 30000 });
		if (shouldPass) assert.equal(result.status, 0, `${changed}: ${result.stdout} ${result.stderr}`);
		else { assert.notEqual(result.status, 0, changed); assert.match(result.stdout + result.stderr, /읽기 전용 검사 실패/); }
	}
});
