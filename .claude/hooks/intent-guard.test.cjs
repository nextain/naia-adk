"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const HOOKS_DIR = __dirname;
const ROOT_DIR = path.resolve(HOOKS_DIR, "..", "..");
const INTENT_GUARD_HOOK = path.join(HOOKS_DIR, "intent-guard.js");
const policy = require(path.join(ROOT_DIR, ".agents", "hooks", "policies", "design-intent-guard.js"));

function runHook(payload, cwd) {
	const res = spawnSync(process.execPath, [INTENT_GUARD_HOOK], {
		input: JSON.stringify(payload),
		encoding: "utf8",
		cwd: cwd || process.cwd(),
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: cwd || process.cwd(),
			CLAUDE_HARNESS: "1",
		},
	});
	const stdout = (res.stdout || "").trim();
	let parsed = null;
	if (stdout) {
		try {
			parsed = JSON.parse(stdout);
		} catch {
			parsed = { raw: stdout };
		}
	}
	return { status: res.status, stdout, stderr: res.stderr, parsed };
}

function runCli(args, cwd) {
	return spawnSync(process.execPath, [INTENT_GUARD_HOOK, ...args], {
		encoding: "utf8",
		cwd: cwd || process.cwd(),
	});
}

function git(cwd, args) {
	const res = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
	return res.stdout.trim();
}

function initGitRepo(dir) {
	fs.mkdirSync(dir, { recursive: true });
	git(dir, ["init", "-q"]);
	git(dir, ["config", "user.email", "test@example.com"]);
	git(dir, ["config", "user.name", "Test User"]);
}

function writeFile(repoDir, relPath, content) {
	const abs = path.join(repoDir, relPath);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content, "utf8");
}

const BASE_REQ_YAML = `id: REQ-001-layered-stage
title: "Layered composite stage over background loop video"
title_ko: "배경 루프 영상 위 전경 조각 합성"
product: "example-stage"
module: "composite-renderer"
status: active
source: human
source_provenance: pending
priority: high
created: 2026-09-24
updated: 2026-09-24
change_effect: extend
preserves: ["stage-output-contract"]
must_not_change: ["frame-rate-24fps"]
description: |
  Initial design: single-stage background clip renders full motion directly.
acceptance_criteria:
  - "Background video plays smoothly at 24fps."
design: |
  Stage 1 produces clips/background-loop.webm as a direct full-body animation clip.
artifacts:
  - id: "background-loop-video"
    path: "clips/background-loop.webm"
    stage: "upstream-background-producer"
    intent_test:
      condition: "All frames maintain composite region pixel MAE <= 1.5 and outline drift <= 1.0px"
      test_path: "tests/background-loop-intent.test.mjs"
      symbol: "background loop keeps composite region steady"
      receipt: null
trace:
  code:
    - path: "src/producer.mjs"
      symbol: "buildBackgroundLoop"
      coverage: full
  tests:
    - path: "tests/background-loop-intent.test.mjs"
      symbol: "background loop keeps composite region steady"
      coverage: full
  reviews:
    planning: null
    development: null
    test: null
    integration: null
decisions: []
`;

const UPDATED_DESIGN_REQ_YAML = BASE_REQ_YAML.replace(
	"Stage 1 produces clips/background-loop.webm as a direct full-body animation clip.",
	"Stage 2 overlays foreground patches at a fixed region; therefore Stage 1 clips/background-loop.webm must keep the target region steady and closed across all frames.",
);

const BASE_TEST_CONTENT = `import test from "node:test";
import assert from "node:assert/strict";

test("background loop keeps composite region steady", () => {
  const maxOutlineDriftPx = 0.5;
  const regionMae = 0.8;
  assert.ok(maxOutlineDriftPx <= 1.0);
  assert.ok(regionMae <= 1.5);
});
`;

describe("Design-Change Consumer / Upstream Artifact Intent Guard (intent-guard.js)", () => {
	let tmpRoot;

	before(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "naia-intent-guard-"));
	});

	after(() => {
		if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("1. [차단 - (c)] 설계 칸을 바꿨는데 산출물 의도 시험이 같은 변경에서 다시 돌지 않으면 커밋을 막고 '다시 검사해야 할 앞 단계 산출물' 목록을 출력한다", () => {
		const repoDir = path.join(tmpRoot, "case-block-not-rerun");
		initGitRepo(repoDir);
		writeFile(repoDir, ".agents/requirements/REQ-001-layered-stage.yaml", BASE_REQ_YAML);
		writeFile(repoDir, "tests/background-loop-intent.test.mjs", BASE_TEST_CONTENT);
		writeFile(repoDir, "src/producer.mjs", "export function buildBackgroundLoop() {}\n");
		git(repoDir, ["add", "."]);
		git(repoDir, ["commit", "-m", "initial baseline"]);

		// Modify design field in REQ-001 without re-running or updating the intent test
		writeFile(repoDir, ".agents/requirements/REQ-001-layered-stage.yaml", UPDATED_DESIGN_REQ_YAML);
		git(repoDir, ["add", ".agents/requirements/REQ-001-layered-stage.yaml"]);

		const res = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "git commit -m 'feat: switch to overlay composite design'" },
			},
			repoDir,
		);

		assert.equal(res.parsed?.decision, "block");
		assert.match(res.parsed?.reason || "", /다시 검사해야 할 앞 단계 산출물:/);
		assert.match(
			res.parsed?.reason || "",
			/background-loop-video \(clips\/background-loop\.webm\)/,
		);
		assert.match(res.parsed?.reason || "", /REQ-001-layered-stage/);
		assert.match(res.parsed?.reason || "", /\(c\) 설계 변경 후 의도 시험 미실행/);
	});

	it("2. [차단 - (a)] 산출물에 의도 시험(condition/test_path)이 빠져 있거나 템플릿 자리표시자면 막는다", () => {
		const repoDir = path.join(tmpRoot, "case-block-missing-intent-spec");
		initGitRepo(repoDir);
		writeFile(repoDir, ".agents/requirements/REQ-001-layered-stage.yaml", BASE_REQ_YAML);
		writeFile(repoDir, "tests/background-loop-intent.test.mjs", BASE_TEST_CONTENT);
		git(repoDir, ["add", "."]);
		git(repoDir, ["commit", "-m", "initial"]);

		const noIntentReq = UPDATED_DESIGN_REQ_YAML.replace(
			/ {4}intent_test:[\s\S]*?receipt: null/,
			"    intent_test:\n      condition: \"\"\n      test_path: \"\"",
		);
		writeFile(repoDir, ".agents/requirements/REQ-001-layered-stage.yaml", noIntentReq);
		git(repoDir, ["add", ".agents/requirements/REQ-001-layered-stage.yaml"]);

		const res = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "git commit -m 'feat: update design without intent test'" },
			},
			repoDir,
		);

		assert.equal(res.parsed?.decision, "block");
		assert.match(res.parsed?.reason || "", /다시 검사해야 할 앞 단계 산출물:/);
		assert.match(res.parsed?.reason || "", /\(a\) 의도 시험 미기재/);
	});

	it("3. [차단 - (a)] 파일 모양·개수만 보는 시험 조건은 의도 시험으로 인정하지 않고 막는다", () => {
		const repoDir = path.join(tmpRoot, "case-block-shape-count-only");
		initGitRepo(repoDir);
		writeFile(repoDir, ".agents/requirements/REQ-001-layered-stage.yaml", BASE_REQ_YAML);
		writeFile(repoDir, "tests/background-loop-intent.test.mjs", BASE_TEST_CONTENT);
		git(repoDir, ["add", "."]);
		git(repoDir, ["commit", "-m", "initial"]);

		for (const weakCondition of [
			"파일 모양과 프레임 개수만 확인",
			"check file existence and frame count only",
			"파일 존재 여부 확인",
		]) {
			const weakReq = UPDATED_DESIGN_REQ_YAML.replace(
				"All frames maintain composite region pixel MAE <= 1.5 and outline drift <= 1.0px",
				weakCondition,
			);
			writeFile(repoDir, ".agents/requirements/REQ-001-layered-stage.yaml", weakReq);
			writeFile(
				repoDir,
				"tests/background-loop-intent.test.mjs",
				BASE_TEST_CONTENT + `\n// updated for ${weakCondition}\n`,
			);
			git(repoDir, ["add", "."]);

			const res = runHook(
				{
					cwd: repoDir,
					tool_name: "Bash",
					tool_input: { command: "git commit -m 'feat: weak shape-only test'" },
				},
				repoDir,
			);
			assert.equal(res.parsed?.decision, "block", `should block weak condition: ${weakCondition}`);
			assert.match(res.parsed?.reason || "", /다시 검사해야 할 앞 단계 산출물:/);
			assert.match(res.parsed?.reason || "", /\(a\) 의도 시험 부적격\(파일 모양·개수만 보는 시험\)/);
		}
	});

	it("4. [차단 - (b)] 의도 시험 파일(test_path)이 실제로 존재하지 않거나 심볼이 없으면 막는다", () => {
		const repoDir = path.join(tmpRoot, "case-block-missing-file");
		initGitRepo(repoDir);
		writeFile(repoDir, ".agents/requirements/REQ-001-layered-stage.yaml", BASE_REQ_YAML);
		writeFile(repoDir, "tests/background-loop-intent.test.mjs", BASE_TEST_CONTENT);
		git(repoDir, ["add", "."]);
		git(repoDir, ["commit", "-m", "initial"]);

		const missingFileReq = UPDATED_DESIGN_REQ_YAML.replace(
			'test_path: "tests/background-loop-intent.test.mjs"',
			'test_path: "tests/non-existent-intent.test.mjs"',
		);
		writeFile(repoDir, ".agents/requirements/REQ-001-layered-stage.yaml", missingFileReq);
		git(repoDir, ["add", ".agents/requirements/REQ-001-layered-stage.yaml"]);

		const res = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "git commit -m 'feat: missing test file'" },
			},
			repoDir,
		);

		assert.equal(res.parsed?.decision, "block");
		assert.match(res.parsed?.reason || "", /다시 검사해야 할 앞 단계 산출물:/);
		assert.match(res.parsed?.reason || "", /\(b\) 의도 시험 실제 파일 없음/);
	});

	it("5. [차단 - (c)] 이전 설계에서 만든 낡은 시험 영수증(stale receipt)은 새 설계 변경을 통과시키지 못한다", () => {
		const repoDir = path.join(tmpRoot, "case-block-stale-receipt");
		initGitRepo(repoDir);
		const oldDoc = policy.parseRequirementDocument(BASE_REQ_YAML, "REQ-001-layered-stage");
		writeFile(repoDir, ".agents/requirements/REQ-001-layered-stage.yaml", BASE_REQ_YAML);
		writeFile(repoDir, "tests/background-loop-intent.test.mjs", BASE_TEST_CONTENT);
		writeFile(
			repoDir,
			".agents/progress/intent-receipts/REQ-001-layered-stage.json",
			JSON.stringify({
				requirement_id: "REQ-001-layered-stage",
				artifact_id: "background-loop-video",
				test_path: "tests/background-loop-intent.test.mjs",
				status: "pass",
				design_sha256: oldDoc.designDigest,
			}),
		);
		git(repoDir, ["add", "."]);
		git(repoDir, ["commit", "-m", "initial with receipt"]);

		// Now change design without updating receipt's design_sha256
		writeFile(repoDir, ".agents/requirements/REQ-001-layered-stage.yaml", UPDATED_DESIGN_REQ_YAML);
		git(repoDir, ["add", ".agents/requirements/REQ-001-layered-stage.yaml"]);

		const res = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "git commit -m 'feat: change design with stale receipt'" },
			},
			repoDir,
		);

		assert.equal(res.parsed?.decision, "block");
		assert.match(res.parsed?.reason || "", /다시 검사해야 할 앞 단계 산출물:/);
		assert.match(res.parsed?.reason || "", /이전 설계 영수증/);
	});

	it("6. [차단 - 셸 감싸기 방어] bash -c, sh -c, 서브셸 (cd ... && git commit), env/timeout 감싸기에서도 동일하게 차단한다", () => {
		const repoDir = path.join(tmpRoot, "case-block-wrappers");
		initGitRepo(repoDir);
		writeFile(repoDir, ".agents/requirements/REQ-001-layered-stage.yaml", BASE_REQ_YAML);
		writeFile(repoDir, "tests/background-loop-intent.test.mjs", BASE_TEST_CONTENT);
		git(repoDir, ["add", "."]);
		git(repoDir, ["commit", "-m", "initial"]);

		writeFile(repoDir, ".agents/requirements/REQ-001-layered-stage.yaml", UPDATED_DESIGN_REQ_YAML);
		git(repoDir, ["add", ".agents/requirements/REQ-001-layered-stage.yaml"]);

		const wrappedInRepo = [
			`bash -c "git commit -m 'wrapped bash'"`,
			`sh -c 'git commit -m "wrapped sh"'`,
			`env GIT_AUTHOR_NAME=Test timeout 10 git commit -m "env timeout commit"`,
			`eval "git commit -m 'eval commit'"`,
		];

		for (const cmd of wrappedInRepo) {
			const res = runHook(
				{
					cwd: repoDir,
					tool_name: "Bash",
					tool_input: { command: cmd },
				},
				repoDir,
			);
			assert.equal(res.parsed?.decision, "block", `wrapper in repo should be blocked: ${cmd}`);
			assert.match(res.parsed?.reason || "", /다시 검사해야 할 앞 단계 산출물:/);
		}

		const wrappedFromParent = [
			`(cd "${repoDir}" && git commit -m "subshell commit")`,
			`bash -c "cd '${repoDir}' && git commit -m 'bash cd commit'"`,
			`git -C "${repoDir}" commit -a -m "git -C commit"`,
		];

		for (const cmd of wrappedFromParent) {
			const res = runHook(
				{
					cwd: tmpRoot,
					tool_name: "Bash",
					tool_input: { command: cmd },
				},
				tmpRoot,
			);
			assert.equal(res.parsed?.decision, "block", `wrapper from parent should be blocked: ${cmd}`);
			assert.match(res.parsed?.reason || "", /다시 검사해야 할 앞 단계 산출물:/);
		}
	});

	it("7. [통과 - 정상 (1)] 설계 칸을 바꾸고 같은 커밋에 산출물 의도 시험 파일(test_path)도 함께 갱신해 스테이지하면 통과한다", () => {
		const repoDir = path.join(tmpRoot, "case-pass-test-updated");
		initGitRepo(repoDir);
		writeFile(repoDir, ".agents/requirements/REQ-001-layered-stage.yaml", BASE_REQ_YAML);
		writeFile(repoDir, "tests/background-loop-intent.test.mjs", BASE_TEST_CONTENT);
		git(repoDir, ["add", "."]);
		git(repoDir, ["commit", "-m", "initial"]);

		writeFile(repoDir, ".agents/requirements/REQ-001-layered-stage.yaml", UPDATED_DESIGN_REQ_YAML);
		writeFile(
			repoDir,
			"tests/background-loop-intent.test.mjs",
			BASE_TEST_CONTENT + "\n// Re-verified closed steady region for 2-stage composite\n",
		);
		git(repoDir, [
			"add",
			".agents/requirements/REQ-001-layered-stage.yaml",
			"tests/background-loop-intent.test.mjs",
		]);

		const res = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "git commit -m 'feat: update design and re-verify intent test'" },
			},
			repoDir,
		);

		assert.equal(res.status, 0);
		assert.equal(res.parsed, null);
	});

	it("8. [통과 - 정상 (2)] 시험 파일 코드는 그대로여도 현재 설계 해시(design_sha256)와 일치하는 통과 영수증이 있으면 통과한다", () => {
		const repoDir = path.join(tmpRoot, "case-pass-valid-receipt");
		initGitRepo(repoDir);
		writeFile(repoDir, ".agents/requirements/REQ-001-layered-stage.yaml", BASE_REQ_YAML);
		writeFile(repoDir, "tests/background-loop-intent.test.mjs", BASE_TEST_CONTENT);
		git(repoDir, ["add", "."]);
		git(repoDir, ["commit", "-m", "initial"]);

		const newDoc = policy.parseRequirementDocument(UPDATED_DESIGN_REQ_YAML, "REQ-001-layered-stage");
		writeFile(repoDir, ".agents/requirements/REQ-001-layered-stage.yaml", UPDATED_DESIGN_REQ_YAML);
		writeFile(
			repoDir,
			".agents/progress/intent-receipts/REQ-001-layered-stage.json",
			JSON.stringify({
				requirement_id: "REQ-001-layered-stage",
				artifact_id: "background-loop-video",
				test_path: "tests/background-loop-intent.test.mjs",
				status: "pass",
				design_sha256: newDoc.designDigest,
				ran_at: "2026-11-08T10:00:00Z",
			}),
		);
		git(repoDir, ["add", ".agents/requirements/REQ-001-layered-stage.yaml"]);

		const res = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "git commit -m 'feat: design change with fresh intent receipt'" },
			},
			repoDir,
		);

		assert.equal(res.status, 0);
		assert.equal(res.parsed, null);
	});

	it("9. [통과 - 정상 (3)] 요구사항 파일의 비설계 메타데이터(updated, status, priority 등)만 바뀐 커밋과 일반 코드 커밋은 통과한다", () => {
		const repoDir = path.join(tmpRoot, "case-pass-metadata-only");
		initGitRepo(repoDir);
		writeFile(repoDir, ".agents/requirements/REQ-001-layered-stage.yaml", BASE_REQ_YAML);
		writeFile(repoDir, "tests/background-loop-intent.test.mjs", BASE_TEST_CONTENT);
		git(repoDir, ["add", "."]);
		git(repoDir, ["commit", "-m", "initial"]);

		const metadataOnlyReq = BASE_REQ_YAML.replace("updated: 2026-09-24", "updated: 2026-11-08").replace(
			"status: active",
			"status: verified",
		);
		writeFile(repoDir, ".agents/requirements/REQ-001-layered-stage.yaml", metadataOnlyReq);
		git(repoDir, ["add", ".agents/requirements/REQ-001-layered-stage.yaml"]);

		const res = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "git commit -m 'chore: bump requirement metadata'" },
			},
			repoDir,
		);
		assert.equal(res.status, 0);
		assert.equal(res.parsed, null);

		// Read-only commands pass
		const echoRes = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "echo 'git commit -m example'" },
			},
			repoDir,
		);
		assert.equal(echoRes.parsed, null);
	});

	it("10. [CLI --check / --worktree / --commit] CLI 검사기 모드에서도 차단과 통과가 정확히 동작하고 템플릿·규칙·문서 정합성을 만족한다", () => {
		const repoDir = path.join(tmpRoot, "case-cli-mode");
		initGitRepo(repoDir);
		writeFile(repoDir, ".agents/requirements/REQ-001-layered-stage.yaml", BASE_REQ_YAML);
		writeFile(repoDir, "tests/background-loop-intent.test.mjs", BASE_TEST_CONTENT);
		git(repoDir, ["add", "."]);
		git(repoDir, ["commit", "-m", "initial"]);

		// Modify design in worktree without updating test -> CLI --check fails with exit code 1
		writeFile(repoDir, ".agents/requirements/REQ-001-layered-stage.yaml", UPDATED_DESIGN_REQ_YAML);
		const failCli = runCli(["--check", "--worktree", "--cwd", repoDir], repoDir);
		assert.equal(failCli.status, 1);
		assert.match(failCli.stderr, /다시 검사해야 할 앞 단계 산출물:/);

		// Update test in worktree -> CLI --check passes with exit code 0
		writeFile(
			repoDir,
			"tests/background-loop-intent.test.mjs",
			BASE_TEST_CONTENT + "\n// updated intent assertion\n",
		);
		const passCli = runCli(["--check", "--worktree", "--cwd", repoDir], repoDir);
		assert.equal(passCli.status, 0);
		assert.match(passCli.stdout, /intent-guard: PASS/);

		// Verify repository artifacts (_template.yaml, agents-rules.json, docs/guides/design-intent-guard.md)
		const templateText = fs.readFileSync(
			path.join(ROOT_DIR, ".agents", "requirements", "_template.yaml"),
			"utf8",
		);
		assert.match(templateText, /^design:/m);
		assert.match(templateText, /^artifacts:/m);
		assert.match(templateText, /intent_test:/);
		assert.match(templateText, /condition:/);
		assert.match(templateText, /test_path:/);

		const rules = JSON.parse(
			fs.readFileSync(path.join(ROOT_DIR, ".agents", "context", "agents-rules.json"), "utf8"),
		);
		assert.ok(
			typeof rules.conventions?.design_intent_guard === "string" &&
				!rules.conventions.design_intent_guard.includes("\n") &&
				rules.conventions.design_intent_guard.includes("docs/guides/design-intent-guard.md"),
			"agents-rules.json must have a one-line design_intent_guard rule with docs link",
		);

		const guidePath = path.join(ROOT_DIR, "docs", "guides", "design-intent-guard.md");
		assert.ok(fs.existsSync(guidePath), "docs/guides/design-intent-guard.md must exist");
		const guideText = fs.readFileSync(guidePath, "utf8");
		assert.match(guideText, /배경 영상/);
		assert.match(guideText, /clips\/background-loop\.webm/);
		assert.match(guideText, /다시 검사해야 할 앞 단계 산출물/);
	});
});
