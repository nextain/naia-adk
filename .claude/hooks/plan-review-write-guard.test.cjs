"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "../..");
const HOOK_PATH = path.join(REPO_ROOT, ".claude/hooks/plan-review-write-guard.js");
const APPROVAL_SCRIPT = path.join(REPO_ROOT, ".agents/scripts/approval-plan.mjs");
const deployPlan = require("./lib/deploy-plan.js");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "plan-review-write-guard-test-"));
const liveHolders = new Set();

after(() => {
	for (const child of liveHolders) {
		try { child.kill("SIGKILL"); } catch {}
	}
	fs.rmSync(scratch, { recursive: true, force: true });
});

function spawnLiveHolder() {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], {
		stdio: "ignore",
	});
	liveHolders.add(child);
	child.unref();
	return child;
}

function makeRepoFixture(prefix = "repo-") {
	const base = fs.mkdtempSync(path.join(scratch, prefix));
	const repo = path.join(base, "instance-adk");
	const outside = path.join(base, "outside-work");
	const otherRepo = path.join(base, "other-repo");
	fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
	fs.mkdirSync(path.join(repo, "src"), { recursive: true });
	fs.mkdirSync(path.join(repo, ".agents/progress/sample-work/gates"), { recursive: true });
	fs.writeFileSync(path.join(repo, "src/app.js"), "module.exports = 1;\n");
	fs.writeFileSync(path.join(repo, ".agents/progress/sample-work/gates/deploy-plan.json"), "{}\n");
	fs.mkdirSync(outside, { recursive: true });
	fs.mkdirSync(path.join(otherRepo, ".git"), { recursive: true });
	fs.mkdirSync(path.join(otherRepo, "src"), { recursive: true });
	fs.writeFileSync(path.join(otherRepo, "src/other.js"), "module.exports = 2;\n");
	return { base, repo, outside, otherRepo, planRel: ".agents/progress/sample-work/gates/deploy-plan.json" };
}

function runHook(payload, { cwd, env = {} } = {}) {
	const input = typeof payload === "string" ? payload : JSON.stringify(payload);
	const res = spawnSync(process.execPath, [HOOK_PATH], {
		cwd: cwd || scratch,
		input,
		encoding: "utf8",
		env: {
			PATH: process.env.PATH,
			HOME: scratch,
			CLAUDE_PROJECT_DIR: cwd || scratch,
			...env,
		},
		timeout: 10000,
	});
	assert.equal(res.status, 0, `hook exited non-zero (${res.status}): ${res.stderr}`);
	const trimmed = (res.stdout || "").trim();
	return {
		raw: trimmed,
		json: trimmed ? JSON.parse(trimmed) : null,
		stderr: res.stderr || "",
	};
}

test("1. 잠금 없음 통과: Edit·Write·NotebookEdit·쓰기 셸 모두 조용히 통과한다", () => {
	const fx = makeRepoFixture("no-lock-");
	const target = path.join(fx.repo, "src/app.js");

	for (const [tool_name, tool_input] of [
		["Edit", { file_path: target, old_string: "1", new_string: "2" }],
		["Write", { file_path: target, content: "module.exports = 2;\n" }],
		["NotebookEdit", { notebook_path: path.join(fx.repo, "src/nb.ipynb"), new_source: "x=1" }],
		["Bash", { command: `echo "// mod" >> "${target}"` }],
		["Bash", { command: `cd "${fx.repo}" && sed -i 's/1/2/' src/app.js` }],
	]) {
		const res = runHook({ tool_name, cwd: fx.repo, tool_input }, { cwd: fx.repo });
		assert.equal(res.json, null, `${tool_name} should pass with no output`);
	}
});

test("2. 살아 있는 잠금 + 파일 변이 도구(Edit/Write/NotebookEdit/MultiEdit/apply_patch) 막힘", () => {
	const fx = makeRepoFixture("live-edit-");
	const holder = spawnLiveHolder();
	const now = Date.now();
	const acq = deployPlan.acquirePlanReviewLock({
		repoRoot: fx.repo,
		plan: fx.planRel,
		pid: holder.pid,
		ttlMs: 30 * 60 * 1000,
		now,
	});
	assert.equal(acq.ok, true);

	const expectedMsg = `계획 리뷰 중(${fx.planRel}, ${acq.lock.startedAt}) — 끝난 뒤 다시`;
	const target = path.join(fx.repo, "src/app.js");

	for (const [tool_name, tool_input, callCwd] of [
		["Edit", { file_path: target }, fx.repo],
		["Write", { file_path: target, content: "x" }, fx.outside],
		["NotebookEdit", { notebook_path: path.join(fx.repo, "src/book.ipynb") }, fx.outside],
		["MultiEdit", { file_path: target, edits: [{ old_string: "1", new_string: "2" }] }, fx.repo],
		["apply_patch", { patch: "*** Begin Patch\n*** Update File: src/app.js\n@@\n-module.exports = 1;\n+module.exports = 2;\n*** End Patch\n" }, fx.repo],
	]) {
		const res = runHook({ tool_name, cwd: callCwd, tool_input }, { cwd: callCwd });
		assert.equal(res.json?.decision, "block", `${tool_name} must block`);
		assert.ok(res.json.reason.includes(expectedMsg), `unexpected reason: ${res.json.reason}`);
	}

	// 잠긴 저장소 밖(작업 폴더·다른 저장소) 파일 편집은 막지 않는다.
	const outEdit = runHook({
		tool_name: "Write",
		cwd: fx.outside,
		tool_input: { file_path: path.join(fx.outside, "prompt.md"), content: "ok" },
	}, { cwd: fx.outside });
	assert.equal(outEdit.json, null);

	const otherEdit = runHook({
		tool_name: "Edit",
		cwd: fx.otherRepo,
		tool_input: { file_path: path.join(fx.otherRepo, "src/other.js") },
	}, { cwd: fx.otherRepo });
	assert.equal(otherEdit.json, null);

	deployPlan.releasePlanReviewLock(acq);
});

test("3. 살아 있는 잠금 + 쓰기 셸 명령 막힘 (리다이렉션·인플레이스·git·스크립트·심볼릭 링크 포함)", () => {
	const fx = makeRepoFixture("live-bash-write-");
	const holder = spawnLiveHolder();
	const now = Date.now();
	const acq = deployPlan.acquirePlanReviewLock({
		repoRoot: fx.repo,
		plan: fx.planRel,
		pid: holder.pid,
		ttlMs: 30 * 60 * 1000,
		now,
	});
	assert.equal(acq.ok, true);

	const target = path.join(fx.repo, "src/app.js");
	const symLink = path.join(fx.outside, "linked-app.js");
	fs.symlinkSync(target, symLink);

	const expectedSub = `계획 리뷰 중(${fx.planRel}, ${acq.lock.startedAt}) — 끝난 뒤 다시`;

	const mutatingCommands = [
		[`echo "x" > "${target}"`, fx.outside],
		[`sed -i 's/1/2/' "${target}"`, fx.outside],
		[`rm -f "${target}"`, fx.repo],
		[`cp "${path.join(fx.otherRepo, "src/other.js")}" "${target}"`, fx.outside],
		[`mv "${target}" "${path.join(fx.repo, "src/moved.js")}"`, fx.repo],
		[`touch "${path.join(fx.repo, "src/new.txt")}"`, fx.outside],
		[`mkdir -p "${path.join(fx.repo, "src/sub")}"`, fx.repo],
		[`cd "${fx.repo}" && git checkout -- src/app.js`, fx.outside],
		[`git -C "${fx.repo}" add src/app.js`, fx.outside],
		[`cd "${fx.repo}" && git commit -am "mutate"`, fx.outside],
		[`cd "${fx.repo}" && git reset --hard`, fx.outside],
		[`cd "${fx.repo}" && git stash`, fx.outside],
		[`python3 -c "open('${target}', 'w').write('bad')"`, fx.outside],
		[`node -e "require('fs').writeFileSync('${target}', 'bad')"`, fx.outside],
		[`echo "via-symlink" > "${symLink}"`, fx.outside],
		[`rm -f "${path.join(fx.repo, ".agents/state/plan-review.lock")}"`, fx.outside],
		[`echo "{}" > "${path.join(fx.repo, fx.planRel)}"`, fx.repo],
	];

	for (const [command, callCwd] of mutatingCommands) {
		const res = runHook({ tool_name: "Bash", cwd: callCwd, tool_input: { command } }, { cwd: callCwd });
		assert.equal(res.json?.decision, "block", `expected block for command: ${command}`);
		assert.ok(res.json.reason.includes(expectedSub), `missing message in reason for ${command}: ${res.json.reason}`);
	}

	// 저장소 밖으로만 쓰는 셸 명령은 통과
	for (const command of [
		`echo "ok" > "${path.join(fx.outside, "log.txt")}"`,
		`python3 -c "open('${path.join(fx.outside, "out.json")}', 'w').write('{}')"`,
	]) {
		const res = runHook({ tool_name: "Bash", cwd: fx.repo, tool_input: { command } }, { cwd: fx.repo });
		assert.equal(res.json, null, `outside write should pass: ${command}`);
	}

	deployPlan.releasePlanReviewLock(acq);
});

test("4. 살아 있는 잠금 + 읽기 도구 및 읽기 전용 셸 명령 통과", () => {
	const fx = makeRepoFixture("live-read-");
	const holder = spawnLiveHolder();
	const acq = deployPlan.acquirePlanReviewLock({
		repoRoot: fx.repo,
		plan: fx.planRel,
		pid: holder.pid,
		ttlMs: 30 * 60 * 1000,
	});
	assert.equal(acq.ok, true);

	for (const tool_name of ["Read", "Grep", "Glob"]) {
		const res = runHook({
			tool_name,
			cwd: fx.repo,
			tool_input: { file_path: path.join(fx.repo, "src/app.js") },
		}, { cwd: fx.repo });
		assert.equal(res.json, null, `${tool_name} must pass`);
	}

	const readOnlyCommands = [
		"git status --short",
		"git diff HEAD",
		"git log -n 3 --oneline",
		"git branch --show-current",
		"git tag --list",
		"git stash list",
		"ls -la src",
		"cat src/app.js",
		"grep -rn module src",
		"node --test .claude/hooks/drift-guard.test.cjs",
	];
	for (const command of readOnlyCommands) {
		const res = runHook({ tool_name: "Bash", cwd: fx.repo, tool_input: { command } }, { cwd: fx.repo });
		assert.equal(res.json, null, `read-only Bash must pass: ${command}`);
	}

	deployPlan.releasePlanReviewLock(acq);
});

test("5. 죽은 PID 잠금: 쓰기를 막지 않고 통과하며 한 줄 알림을 낸다", () => {
	const fx = makeRepoFixture("dead-pid-");
	const shortProc = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
	const deadPid = shortProc.pid || 99999999;

	const lockFile = deployPlan.planReviewLockPath(fx.repo);
	fs.mkdirSync(path.dirname(lockFile), { recursive: true });
	fs.writeFileSync(lockFile, JSON.stringify({
		schema: deployPlan.PLAN_REVIEW_LOCK_SCHEMA,
		pid: deadPid,
		pidStartTicks: "1",
		plan: fx.planRel,
		repoRoot: fx.repo,
		startedAt: "2026-11-15T12:00:00.000Z",
		expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
	}, null, 2));

	const editRes = runHook({
		tool_name: "Edit",
		cwd: fx.repo,
		tool_input: { file_path: path.join(fx.repo, "src/app.js") },
	}, { cwd: fx.repo });
	assert.notEqual(editRes.json?.decision, "block");
	const notice = editRes.json?.hookSpecificOutput?.additionalContext || "";
	assert.ok(notice.length > 0, "expected one-line notice for dead lock");
	assert.equal(notice.includes("\n"), false, "notice must be a single line");
	assert.match(notice, /죽은 계획 리뷰 잠금 무시/);

	const bashRes = runHook({
		tool_name: "Bash",
		cwd: fx.repo,
		tool_input: { command: `echo "ok" >> "${path.join(fx.repo, "src/app.js")}"` },
	}, { cwd: fx.repo });
	assert.notEqual(bashRes.json?.decision, "block");
	assert.match(bashRes.json?.hookSpecificOutput?.additionalContext || "", /죽은 계획 리뷰 잠금 무시/);
});

test("6. 시한 넘은 잠금: 살아 있는 PID 여도 시한이 지났으면 통과하고 한 줄 알림을 낸다", () => {
	const fx = makeRepoFixture("expired-lock-");
	const holder = spawnLiveHolder();
	const pastNow = Date.now() - 2 * 60 * 60 * 1000;
	const acq = deployPlan.acquirePlanReviewLock({
		repoRoot: fx.repo,
		plan: fx.planRel,
		pid: holder.pid,
		ttlMs: 1000,
		now: pastNow,
	});
	assert.equal(acq.ok, true);

	const res = runHook({
		tool_name: "Edit",
		cwd: fx.repo,
		tool_input: { file_path: path.join(fx.repo, "src/app.js") },
	}, { cwd: fx.repo });
	assert.notEqual(res.json?.decision, "block");
	const notice = res.json?.hookSpecificOutput?.additionalContext || "";
	assert.ok(notice.length > 0, "expected one-line notice for expired lock");
	assert.equal(notice.includes("\n"), false, "notice must be a single line");
	assert.match(notice, /시한 넘은 계획 리뷰 잠금 무시/);

	deployPlan.releasePlanReviewLock(acq);
});

test("7. 리뷰 실행기 자신과 gates/ 리뷰 기록 쓰기는 통과하되 deploy-plan.json 수정은 막는다", () => {
	const fx = makeRepoFixture("review-exempt-");
	const holder = spawnLiveHolder();
	const acq = deployPlan.acquirePlanReviewLock({
		repoRoot: fx.repo,
		plan: fx.planRel,
		pid: holder.pid,
		ttlMs: 30 * 60 * 1000,
	});
	assert.equal(acq.ok, true);

	const gatesDir = path.join(fx.repo, ".agents/progress/sample-work/gates");
	for (const file of [
		path.join(gatesDir, "deploy-plan-review.json"),
		path.join(gatesDir, "deploy-plan-review-2026-11-15-argon.md"),
		path.join(gatesDir, "deploy-plan-review-findings.md"),
	]) {
		const wRes = runHook({
			tool_name: "Write",
			cwd: fx.repo,
			tool_input: { file_path: file, content: "ok\n" },
		}, { cwd: fx.repo });
		assert.equal(wRes.json, null, `review record Write should pass: ${file}`);

		const bRes = runHook({
			tool_name: "Bash",
			cwd: fx.repo,
			tool_input: { command: `printf 'ok\\n' > "${file}"` },
		}, { cwd: fx.repo });
		assert.equal(bRes.json, null, `review record Bash redirect should pass: ${file}`);
	}

	// 리뷰 기록 쓰기와 일반 코드 쓰기가 섞인 셸 명령은 반드시 차단
	const mixedRes = runHook({
		tool_name: "Bash",
		cwd: fx.repo,
		tool_input: {
			command: `printf '{}' > "${path.join(gatesDir, "deploy-plan-review.json")}" && echo bad >> "${path.join(fx.repo, "src/app.js")}"`,
		},
	}, { cwd: fx.repo });
	assert.equal(mixedRes.json?.decision, "block");

	// 같은 gates/ 폴더여도 deploy-plan.json 자체는 수정 차단
	const planEditRes = runHook({
		tool_name: "Edit",
		cwd: fx.repo,
		tool_input: { file_path: path.join(gatesDir, "deploy-plan.json") },
	}, { cwd: fx.repo });
	assert.equal(planEditRes.json?.decision, "block");

	deployPlan.releasePlanReviewLock(acq);

	// 리뷰 실행기 자신(현재 프로세스 PID 계보)은 통과
	const selfAcq = deployPlan.acquirePlanReviewLock({
		repoRoot: fx.repo,
		plan: fx.planRel,
		pid: process.pid,
		ttlMs: 30 * 60 * 1000,
	});
	assert.equal(selfAcq.ok, true);
	const selfRes = runHook({
		tool_name: "Write",
		cwd: fx.repo,
		tool_input: { file_path: path.join(fx.repo, "src/app.js"), content: "self" },
	}, { cwd: fx.repo });
	assert.equal(selfRes.json, null, "descendant of review runner PID should pass");
	deployPlan.releasePlanReviewLock(selfAcq);
});

test("8. 손상된 잠금·잘못된 입력·시한 초과(hook-watchdog) 시 모두 fail-closed 로 막는다", async () => {
	const fx = makeRepoFixture("fail-closed-");

	// 깨진 표준입력 JSON -> 막음
	const badInput = runHook("{not-valid-json", { cwd: fx.repo });
	assert.equal(badInput.json?.decision, "block");

	// 손상된 잠금 파일 -> 쓰기 막음
	const lockFile = deployPlan.planReviewLockPath(fx.repo);
	fs.mkdirSync(path.dirname(lockFile), { recursive: true });
	fs.writeFileSync(lockFile, "{corrupt-lock-json");
	const corruptWrite = runHook({
		tool_name: "Edit",
		cwd: fx.repo,
		tool_input: { file_path: path.join(fx.repo, "src/app.js") },
	}, { cwd: fx.repo });
	assert.equal(corruptWrite.json?.decision, "block");

	// 시한 감시(hook-watchdog): 표준입력을 닫지 않아 자식 관문이 멈추면 시한 내 강제 종료하고 막는다(11/13 교훈).
	const watchdogResult = await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [HOOK_PATH], {
			cwd: fx.repo,
			env: {
				PATH: process.env.PATH,
				HOME: scratch,
				CLAUDE_PROJECT_DIR: fx.repo,
				NAIA_PLAN_REVIEW_GUARD_WATCHDOG_MS: "150",
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		// 의도적으로 child.stdin.end() 를 부르지 않아 자식의 readFileSync(0) 을 멈추게 한다.
		child.stdin.write('{"tool_name":"Edit"');
		const safety = setTimeout(() => {
			try { child.kill("SIGKILL"); } catch {}
			reject(new Error("watchdog failed to terminate hanging hook in time"));
		}, 5000);
		child.on("close", (status) => {
			clearTimeout(safety);
			try { child.stdin.destroy(); } catch {}
			resolve({ status, stdout });
		});
	});
	assert.equal(watchdogResult.status, 0);
	const parsed = JSON.parse(watchdogResult.stdout);
	assert.equal(parsed.decision, "block");
	assert.match(parsed.reason, /계획 리뷰 쓰기 관문이 .*초 안에 판정하지 못해 막습니다/);
});

test("9. approval-plan.mjs review 실행 중 잠금을 잡고 끝나거나 중단되면 잠금과 빈 폴더를 깨끗이 지운다", async () => {
	const base = fs.mkdtempSync(path.join(scratch, "e2e-review-"));
	const root = path.join(base, "repo");
	const stateDir = path.join(base, "approval-state");
	fs.mkdirSync(root, { recursive: true });
	fs.mkdirSync(stateDir, { recursive: true });

	for (const rel of deployPlan.REVIEW_EXECUTOR_FILES) {
		const dst = path.join(root, rel);
		fs.mkdirSync(path.dirname(dst), { recursive: true });
		fs.copyFileSync(path.join(REPO_ROOT, rel), dst);
	}
	fs.writeFileSync(path.join(root, ".gitignore"), ".agents/state/\n.agents/work/\n");

	const scriptRel = "scripts/rollout.sh";
	const scriptAbs = path.join(root, scriptRel);
	fs.mkdirSync(path.dirname(scriptAbs), { recursive: true });
	fs.writeFileSync(scriptAbs, `#!/usr/bin/env bash\nnode ${path.join(root, ".agents/scripts/approval-plan.mjs")} assert ${path.join(root, ".agents/progress/sample-work/gates/deploy-plan.json")} s1 || exit 1\naz containerapp update -n sample-web-prod -g sample-rg --image sample/web:v1\n`);
	const scriptSha = crypto.createHash("sha256").update(fs.readFileSync(scriptAbs)).digest("hex");

	spawnSync("git", ["init", "-q"], { cwd: root });
	spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
	spawnSync("git", ["config", "user.name", "Test"], { cwd: root });
	spawnSync("git", ["add", "."], { cwd: root });
	spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });

	const gatesDir = path.join(root, ".agents/progress/sample-work/gates");
	fs.mkdirSync(gatesDir, { recursive: true });
	const planPath = path.join(gatesDir, "deploy-plan.json");
	const plan = {
		schema: "deploy-plan/v1",
		author_model: "codex",
		approval_mode: "preapprove_steps",
		planId: "sample-web-rollout-lock-test",
		createdAt: new Date().toISOString(),
		services: ["azure:containerapp:sample-web-prod"],
		what_why: "리뷰 중 쓰기 잠금 통합 검증용 샘플 배포 계획입니다.",
		architecture_fit: {
			original_request: "계획 리뷰 진행 중 인스턴스 저장소 쓰기 잠금 및 PreToolUse 관문 통합 검증",
			parent_structure: "ADK 배포 승인 계획 관문(approval-plan) 및 PreToolUse 하네스 계층",
			acceptance_rationale: "기존 배포 계획 리뷰 실행기 흐름과 PreToolUse 관문 체인에 정식 잠금 계층으로 결합하며 단일 파일 우회 땜빵이 아님",
		},
		changes: ["컨테이너 이미지 sample/web:v1 반영"],
		scenario: [
			{
				id: "s1",
				title: "v1 이미지 배포",
				commands: [`bash ${scriptRel} prod`],
				files: { [scriptRel]: scriptSha },
				success_check: "헬스체크 200 응답 확인",
				on_failure: "r1 단계로 복귀하고 보고",
			},
			{
				id: "r1",
				branch: "rollback",
				title: "이전 리비전 복귀",
				commands: ["az containerapp revision activate -n sample-web-prod -g sample-rg --revision sample-web-prod--prev"],
				success_check: "이전 리비전 트래픽 100% 확인",
				on_failure: "즉시 운영팀 보고",
			},
		],
		risks: { items: ["기동 지연"], worst_case: "최대 1분 지연" },
		irreversible: ["없음: 이미지 교체만 수행"],
		disconnect_safety: "터미널 끊김 시 az containerapp revision list 확인 후 r1 수동 실행 가능",
		rerun_safety: { lock: "동일 리비전 고정", run_dir: ".agents/progress/sample-work", no_latest_pick: "명시 태그 사용" },
		success_verification: "헬스 엔드포인트 200 확인",
		rollback: { method: "r1 명령으로 복귀", duration: "1분", step_ids: ["r1"] },
		residual_risks: ["전환 순간 재시도 가능"],
		incident: { criteria: ["5xx 5% 초과"], actions: [] },
	};
	fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);

	// plan-review.sh 의 snap() 과 동일한 스냅샷 함수
	const snap = () => {
		const r = spawnSync("git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"], { encoding: "utf8" });
		return (r.stdout || "")
			.split(/\r?\n/)
			.filter(Boolean)
			.filter((line) => !/^(\?\?|!!) (\.agents\/progress\/|\.agents\/work\/|\.agents\/\.dm-outbox\/|gates\/|tmp\/)/.test(line))
			.join("\n");
	};

	const observedLockFile = path.join(base, "observed-lock.json");
	const mockMuse = path.join(base, "mock-muse.js");
	const passCriteria = deployPlan.CRITERIA.map(([id]) => `${id}: PASS`).join("\n");
	fs.writeFileSync(mockMuse, [
		"#!/usr/bin/env node",
		"const fs = require('fs');",
		`const lockPath = ${JSON.stringify(deployPlan.planReviewLockPath(root))};`,
		`if (fs.existsSync(lockPath)) fs.copyFileSync(lockPath, ${JSON.stringify(observedLockFile)});`,
		`process.stdout.write(${JSON.stringify(`판정: PASS\n${passCriteria}\n참고 지적: 0\n남은 지적: 0\n`)});`,
	].join("\n"), { mode: 0o755 });

	const beforeSnap = snap();
	const runRes = spawnSync(process.execPath, [path.join(root, ".agents/scripts/approval-plan.mjs"), "review", planPath, "--author", "codex"], {
		cwd: root,
		encoding: "utf8",
		env: {
			PATH: process.env.PATH,
			HOME: base,
			DEPLOY_GUARD_STATE_DIR: stateDir,
			APPROVAL_PLAN_MUSE_BIN: mockMuse,
		},
		timeout: 20000,
	});
	assert.equal(runRes.status, 0, `review failed: ${runRes.stdout}\n${runRes.stderr}`);
	assert.equal(fs.existsSync(observedLockFile), true, "lock file must exist while reviewer is running");
	const observed = JSON.parse(fs.readFileSync(observedLockFile, "utf8"));
	assert.equal(observed.plan, ".agents/progress/sample-work/gates/deploy-plan.json");
	assert.equal(fs.existsSync(deployPlan.planReviewLockPath(root)), false, "lock file must be removed after review");
	assert.equal(fs.existsSync(path.join(root, ".agents/state")), false, "empty .agents/state dir must be removed after review");
	assert.equal(snap(), beforeSnap, "plan-review.sh snap() before and after must match byte-for-byte");

	// 중단(SIGTERM) 시에도 trap/핸들러가 잠금과 빈 폴더를 지워야 하며, 도는 동안에는 중복 리뷰와 외부 Edit 를 모두 막는다.
	const slowMuse = path.join(base, "slow-muse.js");
	fs.writeFileSync(slowMuse, "#!/usr/bin/env node\nsetInterval(() => {}, 10000);\n", { mode: 0o755 });
	const child = spawn(process.execPath, [path.join(root, ".agents/scripts/approval-plan.mjs"), "review", planPath, "--author", "codex", "--out", path.join(gatesDir, "deploy-plan-review-sigterm.md")], {
		cwd: root,
		env: {
			PATH: process.env.PATH,
			HOME: base,
			DEPLOY_GUARD_STATE_DIR: stateDir,
			APPROVAL_PLAN_MUSE_BIN: slowMuse,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});

	const lockPath = deployPlan.planReviewLockPath(root);
	const deadline = Date.now() + 8000;
	while (!fs.existsSync(lockPath) && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 40));
	}
	assert.equal(fs.existsSync(lockPath), true, "lock must appear during slow review");

	// 리뷰 진행 중 외부 세션이 Edit 를 시도하면 실제로 막힌다.
	const midReviewEdit = runHook({
		tool_name: "Edit",
		cwd: root,
		tool_input: { file_path: scriptAbs },
	}, { cwd: root });
	assert.equal(midReviewEdit.json?.decision, "block");
	assert.match(midReviewEdit.json.reason, /계획 리뷰 중\(\.agents\/progress\/sample-work\/gates\/deploy-plan\.json, .*\) — 끝난 뒤 다시/);

	// 같은 저장소에서 두 번째 review 를 동시에 띄우면 잠금 충돌로 즉시 거절된다.
	const secondReview = spawnSync(process.execPath, [path.join(root, ".agents/scripts/approval-plan.mjs"), "review", planPath, "--author", "codex", "--out", path.join(gatesDir, "deploy-plan-review-second.md")], {
		cwd: root,
		encoding: "utf8",
		env: {
			PATH: process.env.PATH,
			HOME: base,
			DEPLOY_GUARD_STATE_DIR: stateDir,
			APPROVAL_PLAN_MUSE_BIN: mockMuse,
		},
		timeout: 10000,
	});
	assert.equal(secondReview.status, 1);
	assert.match(secondReview.stderr, /이미 진행 중인 계획 리뷰 잠금이 있습니다/);

	child.kill("SIGTERM");
	await new Promise((resolve) => child.on("close", resolve));
	assert.equal(fs.existsSync(lockPath), false, "lock file must be removed on SIGTERM");
	assert.equal(fs.existsSync(path.join(root, ".agents/state")), false, "empty .agents/state must be removed on SIGTERM");
});
