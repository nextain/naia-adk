"use strict";
// Approval gate tests: host-adapters.
const { test, makeWorkspace, writeGateConfig, path, REPO_ROOT, assert, fs, os, HOOK_PATH, spawnSync, runDeployGuardHook } = require("./approval-plan-fixtures.cjs");

test("11. P1-1 재현: Pi 어댑터(.pi/extensions/naia-harness.ts) tool_call 가드 루프가 async bash.deploy 결과를 await 하여 차단", async (t) => {
	const { root } = makeWorkspace(t);
	writeGateConfig(root);

	const harnessPath = path.join(REPO_ROOT, ".pi/extensions/naia-harness.ts");
	const prevFilename = globalThis.__filename;
	const prevDirname = globalThis.__dirname;
	globalThis.__filename = harnessPath;
	globalThis.__dirname = path.dirname(harnessPath);
	let registerPiHarness;
	try {
		delete require.cache[harnessPath];
		const mod = require(harnessPath);
		registerPiHarness = mod.default || mod;
	} finally {
		if (prevFilename === undefined) delete globalThis.__filename;
		else globalThis.__filename = prevFilename;
		if (prevDirname === undefined) delete globalThis.__dirname;
		else globalThis.__dirname = prevDirname;
	}

	const handlers = new Map();
	registerPiHarness({
		on(event, handler) {
			handlers.set(event, handler);
		},
	});
	const onToolCall = handlers.get("tool_call");
	assert.equal(typeof onToolCall, "function", "tool_call 핸들러가 등록되어야 함");

	const res1 = await onToolCall(
		{ toolName: "bash", input: { command: "vercel --prod" } },
		{ cwd: root }
	);
	assert.ok(res1 && res1.block === true, "Pi 어댑터에서 vercel --prod 배포 명령이 차단되어야 함");
	assert.match(res1.reason || "", /계획 밖 운영 명령이라 막습니다|알 수 없는 운영 명령은 막음|prod 배포/);

	const res2 = await onToolCall(
		{ toolName: "bash", input: { command: "az containerapp update -n sample-web-prod -g sample-rg --image sample/web:v1" } },
		{ cwd: root }
	);
	assert.ok(res2 && res2.block === true, "Pi 어댑터에서 az containerapp update 운영 명령이 차단되어야 함");
	assert.match(res2.reason || "", /azure:containerapp:sample-web-prod/);
});

test("hook-watchdog: 멈춘(무한 루프)·신호 종료 deploy-guard 자식을 시한 안에 끊고 JSON block 으로 막음", (t) => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hook-watchdog-test-"));
	t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

	const hooksDir = path.join(tmp, ".claude", "hooks");
	const libDir = path.join(hooksDir, "lib");
	const polDir = path.join(tmp, ".agents", "hooks", "policies");
	fs.mkdirSync(libDir, { recursive: true });
	fs.mkdirSync(polDir, { recursive: true });

	const guardCopy = path.join(hooksDir, "deploy-guard.js");
	fs.copyFileSync(HOOK_PATH, guardCopy);
	fs.copyFileSync(path.join(REPO_ROOT, ".claude/hooks/lib/hook-watchdog.js"), path.join(libDir, "hook-watchdog.js"));
	fs.writeFileSync(path.join(polDir, "bash.js"), "module.exports = { deploy: () => null };\n");

	// 1. CPU 동기 무한 루프에 빠진 자식 프로세스 -> 부모 시한 감시(150ms)가 SIGKILL 후 JSON block 반환
	fs.writeFileSync(path.join(hooksDir, "_claude-bash-guard.js"), "exports.start = () => { for (;;) {} };\n");
	const started = Date.now();
	const hung = spawnSync(process.execPath, [guardCopy], {
		cwd: tmp,
		input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }),
		encoding: "utf8",
		timeout: 5000,
		env: { ...process.env, NAIA_DEPLOY_GUARD_WATCHDOG_MS: "150" },
	});
	const elapsed = Date.now() - started;
	assert.equal(hung.status, 0, `watchdog timeout must exit 0 with block JSON: ${hung.stderr}`);
	assert.ok(elapsed < 4000, `watchdog must abort promptly, took ${elapsed}ms`);
	const hungDecision = JSON.parse(hung.stdout);
	assert.equal(hungDecision.decision, "block");
	assert.match(hungDecision.reason, /판정하지 못해 막습니다/);

	// 2. 신호(SIGTERM)로 자식이 죽어도 JSON block 으로 막음
	fs.writeFileSync(path.join(hooksDir, "_claude-bash-guard.js"), "exports.start = () => { process.kill(process.pid, 'SIGTERM'); };\n");
	const sigRes = spawnSync(process.execPath, [guardCopy], {
		cwd: tmp,
		input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }),
		encoding: "utf8",
		timeout: 5000,
		env: { ...process.env, NAIA_DEPLOY_GUARD_WATCHDOG_MS: "5000" },
	});
	assert.equal(sigRes.status, 0, `watchdog signal must exit 0 with block JSON: ${sigRes.stderr}`);
	const sigDecision = JSON.parse(sigRes.stdout);
	assert.equal(sigDecision.decision, "block");
	assert.match(sigDecision.reason, /신호 SIGTERM/);

	// 3. 실제 deploy-guard.js 가 watchdog 감시 하에서도 정상 판정(통과/차단)을 그대로 전달
	const { root, stateDir, transcriptPath } = makeWorkspace(t);
	writeGateConfig(root);
	assert.equal(runDeployGuardHook("ls", { cwd: root, root, stateDir, transcriptPath }), null);
	const blocked = runDeployGuardHook("vercel --prod", { cwd: root, root, stateDir, transcriptPath });
	assert.equal(blocked?.decision, "block");
});

test("차단-1·2: deploy-guard 는 hook-watchdog 누락·예외 및 정책 로드 실패 시 일반·역할 세션 모두 block JSON 을 냄", (t) => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-guard-failclosed-"));
	t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
	const invoke = (guardFile, cwdDir, adkDir = "") => spawnSync(process.execPath, [guardFile], {
		cwd: cwdDir,
		input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "echo hi" }, cwd: cwdDir }),
		encoding: "utf8",
		timeout: 5000,
		env: { ...process.env, CLAUDE_PROJECT_DIR: cwdDir, NAIA_ADK_ROOT: adkDir },
	});
	const roleDir = path.join(tmp, "role-ws");
	const normalDir = path.join(tmp, "normal-ws");
	fs.mkdirSync(roleDir, { recursive: true });
	fs.mkdirSync(normalDir, { recursive: true });
	fs.writeFileSync(path.join(roleDir, ".naia-role.json"), JSON.stringify({ read: [] }));

	for (const [mode, setupFn] of [
		["watchdog-missing", () => {}],
		["watchdog-throws", (rootDir) => {
			fs.mkdirSync(path.join(rootDir, ".claude/hooks/lib"), { recursive: true });
			fs.writeFileSync(path.join(rootDir, ".claude/hooks/lib/hook-watchdog.js"), 'throw new Error("watchdog broken");\n');
		}],
		["policy-load-fail", (rootDir) => {
			fs.mkdirSync(path.join(rootDir, ".claude/hooks/lib"), { recursive: true });
			fs.copyFileSync(path.join(REPO_ROOT, ".claude/hooks/lib/hook-watchdog.js"), path.join(rootDir, ".claude/hooks/lib/hook-watchdog.js"));
			// bash.js 를 만들지 않아 policy require 실패 유발
		}],
	]) {
		const iso = path.join(tmp, mode);
		fs.mkdirSync(path.join(iso, ".claude/hooks"), { recursive: true });
		const guardCopy = path.join(iso, ".claude/hooks/deploy-guard.js");
		fs.copyFileSync(path.join(REPO_ROOT, ".claude/hooks/deploy-guard.js"), guardCopy);
		fs.copyFileSync(path.join(REPO_ROOT, ".claude/hooks/_claude-bash-guard.js"), path.join(iso, ".claude/hooks/_claude-bash-guard.js"));
		setupFn(iso);
		for (const [label, cwdDir] of [["normal", normalDir], ["role", roleDir]]) {
			const res = invoke(guardCopy, cwdDir, iso);
			assert.equal(res.status, 0, `${mode}/${label}: exit 0 expected, got ${res.status} stderr=${res.stderr}`);
			const parsed = JSON.parse(res.stdout || "null");
			assert.equal(parsed?.decision, "block", `${mode}/${label}: must emit block JSON, got ${res.stdout}`);
		}
	}
});
