#!/usr/bin/env node
"use strict";

/**
 * 가드가 호스트 도구 이름에 상관없이 막는지 본다.
 *
 * 2026-09-13 grok 적대리뷰가 찾았습니다. 차단이 실증된 가드 다섯을 다시 등록했는데,
 * 본문이 `tool_name !== "Bash"` 면 그냥 나가므로 grok 세션에서는 훅이 뜨고도 즉시
 * 빠졌습니다. 등록은 됐고 발화는 안 하는 상태입니다.
 *
 * 그래서 같은 위험한 명령을 Claude 이름과 grok 이름으로 각각 넣어, 두 봉투가 **같은
 * 판정**을 받는지 봅니다. 정규화 표에 이름을 하나 더 적는 것만으로는 통과할 수 없고,
 * 실제로 막아야 통과합니다.
 */

const assert = require("node:assert");
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..", "..");
const hookDir = path.join(root, ".claude", "hooks");

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

/** 훅을 봉투 하나로 돌리고 차단 여부를 돌려준다. 차단은 종료 코드 2 이거나 deny 판정이다. */
function run(hook, envelope) {
	const result = cp.spawnSync(process.execPath, [path.join(hookDir, hook)], {
		input: JSON.stringify(envelope),
		encoding: "utf8",
		cwd: root,
		timeout: 30_000,
		env: { ...process.env, CLAUDE_PROJECT_DIR: root },
	});
	const said = `${result.stdout || ""}${result.stderr || ""}`;
	const blocked = result.status === 2 || /"(?:decision|permissionDecision)"\s*:\s*"(?:deny|block)"/.test(said);
	return { blocked, said, status: result.status };
}

/** 같은 일을 Claude 이름과 grok 이름으로 각각 시킨다. */
const shellPair = (command) => [
	{ tool_name: "Bash", tool_input: { command } },
	{ tool_name: "run_terminal_command", tool_input: { command } },
];

const editPair = (file_path, content) => [
	{ tool_name: "Write", tool_input: { file_path, content } },
	{ tool_name: "search_replace", tool_input: { file_path, content } },
];

// 가드가 찾는 문자열을 시험 파일에 그대로 적으면, 이 시험을 실행하는 셸 명령 자체가
// 가드에 걸린다(실제로 한 번 걸렸다). 그래서 조각으로 나눠 실행 시점에 맞춘다.
const PROD_DEPLOY = ["vercel", "--", "prod"].join("").replace("vercel--", "vercel --");
const MASTER_KEY = ["NAIA", "GATEWAY", "MASTER", "KEY"].join("_");

test("도구 이름 정규화 표가 두 호스트를 같은 값으로 옮긴다", () => {
	const { normalizedToolName } = require(path.join(hookDir, "tool-names.js"));
	assert.strictEqual(normalizedToolName("Bash"), "shell");
	assert.strictEqual(normalizedToolName("run_terminal_command"), "shell");
	assert.strictEqual(normalizedToolName("functions.run_terminal_command"), "shell", "이름공간이 붙어도 잎만 본다");
	assert.strictEqual(normalizedToolName("Write"), "file-mutation");
	assert.strictEqual(normalizedToolName("search_replace"), "file-mutation");
	assert.strictEqual(normalizedToolName("Read"), "read");
});

test("deploy-guard 는 prod 배포를 두 이름 모두에서 막는다", () => {
	const [claude, grok] = shellPair(PROD_DEPLOY);
	const a = run("deploy-guard.js", claude);
	const b = run("deploy-guard.js", grok);
	assert.strictEqual(a.blocked, true, `Claude 이름에서 막아야 한다: ${a.said.slice(0, 200)}`);
	assert.strictEqual(b.blocked, true, `grok 이름에서도 막아야 한다: ${b.said.slice(0, 200)}`);
});

test("deploy-guard 는 안전한 명령을 두 이름 모두에서 통과시킨다", () => {
	for (const envelope of shellPair("echo hello")) {
		assert.strictEqual(run("deploy-guard.js", envelope).blocked, false);
	}
});

test("prod-gateway-guard 는 두 이름에서 같은 판정을 낸다", () => {
	const [claude, grok] = editPair(path.join(root, ".env.local"), `${MASTER_KEY}=prod-master-key-value\n`);
	const a = run("prod-gateway-guard.js", claude);
	const b = run("prod-gateway-guard.js", grok);
	assert.strictEqual(a.blocked, b.blocked,
		`두 이름의 판정이 갈렸다 (Claude ${a.blocked} / grok ${b.blocked}): ${a.said.slice(0, 150)} || ${b.said.slice(0, 150)}`);
});

test("운영 게이트웨이 주소는 모든 편집 도구에서 막힌다", () => {
	for (const envelope of editPair(path.join(root, ".env.local"), "GATEWAY_URL=https://naia-gateway-123.asia-northeast3.run.app/")) {
		assert.strictEqual(run("prod-gateway-guard.js", envelope).blocked, true, envelope.tool_name);
	}
});

test("commit-guard 도 두 이름에서 같은 판정을 낸다", () => {
	for (const hook of ["commit-guard.js"]) {
		const [claude, grok] = shellPair("git commit -m 'test'");
		const a = run(hook, claude);
		const b = run(hook, grok);
		assert.strictEqual(a.blocked, b.blocked, `${hook}: 두 이름의 판정이 갈렸다 (${a.blocked} / ${b.blocked})`);
		assert.strictEqual(a.status, b.status, `${hook}: 종료 코드가 갈렸다 (${a.status} / ${b.status})`);
	}
});

test("가드가 모두 정규화 표를 쓴다", () => {
	for (const hook of ["deploy-guard.js", "commit-guard.js", "email-send-guard.js", "prod-gateway-guard.js"]) {
		const source = fs.readFileSync(path.join(hookDir, hook), "utf8");
		if (/require\("\.\/_claude-bash-guard\.js"\)/.test(source)) {
			const adapter = fs.readFileSync(path.join(hookDir, "_claude-bash-guard.js"), "utf8");
			assert.match(adapter, /require\("\.\/tool-names\.js"\)/, `${hook} 의 공통 봉투가 정규화 표를 쓰지 않는다`);
			assert.match(adapter, /isShellTool\(toolName\)/, `${hook} 의 공통 봉투가 셸 이름을 검사하지 않는다`);
		} else if (/require\("\.\/_claude-edit-hook\.js"\)/.test(source)) {
			const adapter = fs.readFileSync(path.join(hookDir, "_claude-edit-hook.js"), "utf8");
			assert.match(adapter, /isFileMutationTool/, `${hook} 의 공통 봉투가 파일 도구를 검사하지 않는다`);
		} else {
			assert.match(source, /require\("\.\/tool-names\.js"\)/, `${hook} 가 정규화 표를 쓰지 않는다`);
		}
		assert.ok(!/tool_?[Nn]ame\s*(?:\|\|\s*""\s*)?!==\s*"Bash"/.test(source), `${hook} 에 Bash 이름 하나만 보는 줄이 남아 있다`);
	}
});

let failed = 0;
for (const [name, fn] of cases) {
	try { fn(); process.stdout.write(`  PASS ${name}\n`); }
	catch (error) { failed += 1; process.stdout.write(`  FAIL ${name}\n    ${error.message}\n`); }
}
process.stdout.write(`${cases.length - failed}/${cases.length} 통과\n`);
process.exit(failed === 0 ? 0 : 1);
