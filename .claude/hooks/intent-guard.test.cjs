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
const bashPolicy = require(path.join(ROOT_DIR, ".agents", "hooks", "policies", "bash.js"));

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

const BASE_REQ_YAML = `id: REQ-001-table-schema-stage
title: "Two-stage document conversion over extracted table records"
title_ko: "문서 변환 파이프라인의 앞 단계 표 추출물 열 계약"
product: "doc-converter"
module: "table-extractor"
status: active
source: human
source_provenance: pending
priority: high
created: 2026-09-24
updated: 2026-09-24
change_effect: extend
preserves: ["stage-table-contract"]
must_not_change: ["utf8-json-encoding"]
description: |
  Initial design: Stage 1 extracts table rows with raw string amounts for direct display.
acceptance_criteria:
  - "Extracted table rows preserve zero parse error rate and normalized KRW integer amounts."
design: |
  Stage 1 produces artifacts/extracted-tables.json with raw amount text from source documents.
artifacts:
  - id: "extracted-tables-json"
    path: "artifacts/extracted-tables.json"
    stage: "upstream-table-extractor"
    intent_test:
      condition: "row_parse_error_rate <= 0.005 and amount_krw >= 0"
      test_path: "tests/extracted-tables-intent.test.mjs"
      symbol: "extracted table rows maintain normalized KRW integers"
      receipt: null
trace:
  code:
    - path: "src/extractor.mjs"
      symbol: "extractDocumentTables"
      coverage: full
  tests:
    - path: "tests/extracted-tables-intent.test.mjs"
      symbol: "extracted table rows maintain normalized KRW integers"
      coverage: full
  reviews:
    planning: null
    development: null
    test: null
    integration: null
decisions: []
`;

const UPDATED_DESIGN_REQ_YAML = BASE_REQ_YAML.replace(
	"Stage 1 produces artifacts/extracted-tables.json with raw amount text from source documents.",
	"Stage 2 aggregates numeric columns directly; therefore Stage 1 artifacts/extracted-tables.json must normalize amount_krw as non-negative integer values in KRW across all rows.",
);

const BASE_TEST_CONTENT = `import test from "node:test";
import assert from "node:assert/strict";

test("extracted table rows maintain normalized KRW integers", () => {
  const row_parse_error_rate = 0.001;
  const amount_krw = 125000;
  assert.ok(row_parse_error_rate <= 0.005);
  assert.ok(amount_krw >= 0);
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
		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", BASE_REQ_YAML);
		writeFile(repoDir, "tests/extracted-tables-intent.test.mjs", BASE_TEST_CONTENT);
		writeFile(repoDir, "src/extractor.mjs", "export function extractDocumentTables() {}\n");
		git(repoDir, ["add", "."]);
		git(repoDir, ["commit", "-m", "initial baseline"]);

		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", UPDATED_DESIGN_REQ_YAML);
		git(repoDir, ["add", ".agents/requirements/REQ-001-table-schema-stage.yaml"]);

		const res = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "git commit -m 'feat: switch to normalized column schema'" },
			},
			repoDir,
		);

		assert.equal(res.parsed?.decision, "block");
		assert.match(res.parsed?.reason || "", /다시 검사해야 할 앞 단계 산출물:/);
		assert.match(
			res.parsed?.reason || "",
			/extracted-tables-json \(artifacts\/extracted-tables\.json\)/,
		);
		assert.match(res.parsed?.reason || "", /REQ-001-table-schema-stage/);
		assert.match(res.parsed?.reason || "", /\(c\) 설계 변경 후 의도 시험 미실행/);
	});

	it("2. [차단 - (a)] 산출물에 의도 시험(condition/test_path)이 빠져 있거나 템플릿 자리표시자면 막는다", () => {
		const repoDir = path.join(tmpRoot, "case-block-missing-intent-spec");
		initGitRepo(repoDir);
		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", BASE_REQ_YAML);
		writeFile(repoDir, "tests/extracted-tables-intent.test.mjs", BASE_TEST_CONTENT);
		git(repoDir, ["add", "."]);
		git(repoDir, ["commit", "-m", "initial"]);

		const noIntentReq = UPDATED_DESIGN_REQ_YAML.replace(
			/ {4}intent_test:[\s\S]*?receipt: null/,
			'    intent_test:\n      condition: ""\n      test_path: ""',
		);
		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", noIntentReq);
		git(repoDir, ["add", ".agents/requirements/REQ-001-table-schema-stage.yaml"]);

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
		const weakConditions = [
			"파일 모양과 레코드 개수만 확인",
			"check file existence and record count only",
			"파일 존재 여부 확인",
		];

		for (let idx = 0; idx < weakConditions.length; idx++) {
			const weakCondition = weakConditions[idx];
			const repoDir = path.join(tmpRoot, `case-block-shape-count-only-${idx}`);
			initGitRepo(repoDir);
			writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", BASE_REQ_YAML);
			writeFile(repoDir, "tests/extracted-tables-intent.test.mjs", BASE_TEST_CONTENT);
			git(repoDir, ["add", "."]);
			git(repoDir, ["commit", "-m", "initial"]);

			const weakReq = UPDATED_DESIGN_REQ_YAML.replace(
				"row_parse_error_rate <= 0.005 and amount_krw >= 0",
				weakCondition,
			);
			writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", weakReq);
			writeFile(
				repoDir,
				"tests/extracted-tables-intent.test.mjs",
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
		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", BASE_REQ_YAML);
		writeFile(repoDir, "tests/extracted-tables-intent.test.mjs", BASE_TEST_CONTENT);
		git(repoDir, ["add", "."]);
		git(repoDir, ["commit", "-m", "initial"]);

		const missingFileReq = UPDATED_DESIGN_REQ_YAML.replace(
			'test_path: "tests/extracted-tables-intent.test.mjs"',
			'test_path: "tests/non-existent-intent.test.mjs"',
		);
		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", missingFileReq);
		git(repoDir, ["add", ".agents/requirements/REQ-001-table-schema-stage.yaml"]);

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
		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", BASE_REQ_YAML);
		writeFile(repoDir, "tests/extracted-tables-intent.test.mjs", BASE_TEST_CONTENT);
		if (typeof policy.runRequirementIntentTests === "function") {
			policy.runRequirementIntentTests(repoDir);
		} else {
			const oldDoc = policy.parseRequirementDocument(BASE_REQ_YAML, "REQ-001-table-schema-stage");
			writeFile(
				repoDir,
				".agents/progress/intent-receipts/REQ-001-table-schema-stage.json",
				JSON.stringify({
					requirement_id: "REQ-001-table-schema-stage",
					artifact_id: "extracted-tables-json",
					test_path: "tests/extracted-tables-intent.test.mjs",
					status: "pass",
					design_sha256: oldDoc.designDigest,
				}),
			);
		}
		git(repoDir, ["add", "."]);
		git(repoDir, ["commit", "-m", "initial with receipt"]);

		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", UPDATED_DESIGN_REQ_YAML);
		git(repoDir, ["add", ".agents/requirements/REQ-001-table-schema-stage.yaml"]);

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
		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", BASE_REQ_YAML);
		writeFile(repoDir, "tests/extracted-tables-intent.test.mjs", BASE_TEST_CONTENT);
		git(repoDir, ["add", "."]);
		git(repoDir, ["commit", "-m", "initial"]);

		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", UPDATED_DESIGN_REQ_YAML);
		git(repoDir, ["add", ".agents/requirements/REQ-001-table-schema-stage.yaml"]);

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
		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", BASE_REQ_YAML);
		writeFile(repoDir, "tests/extracted-tables-intent.test.mjs", BASE_TEST_CONTENT);
		git(repoDir, ["add", "."]);
		git(repoDir, ["commit", "-m", "initial"]);

		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", UPDATED_DESIGN_REQ_YAML);
		writeFile(
			repoDir,
			"tests/extracted-tables-intent.test.mjs",
			BASE_TEST_CONTENT + "\n// Re-verified normalized KRW column contract for stage 2\n",
		);
		git(repoDir, [
			"add",
			".agents/requirements/REQ-001-table-schema-stage.yaml",
			"tests/extracted-tables-intent.test.mjs",
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

	it("8. [통과 - 정상 (2)] 시험 파일 코드는 그대로여도 의도 시험 실행기(--run-tests)가 만든 유효한 영수증이 있으면 통과한다", () => {
		const repoDir = path.join(tmpRoot, "case-pass-valid-receipt");
		initGitRepo(repoDir);
		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", BASE_REQ_YAML);
		writeFile(repoDir, "tests/extracted-tables-intent.test.mjs", BASE_TEST_CONTENT);
		git(repoDir, ["add", "."]);
		git(repoDir, ["commit", "-m", "initial"]);

		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", UPDATED_DESIGN_REQ_YAML);
		const runRes = runCli(["--run-tests", "--cwd", repoDir], repoDir);
		assert.equal(runRes.status, 0, `--run-tests should succeed: ${runRes.stderr}`);
		git(repoDir, ["add", ".agents/requirements/REQ-001-table-schema-stage.yaml"]);

		const res = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "git commit -m 'feat: design change with runner intent receipt'" },
			},
			repoDir,
		);

		assert.equal(res.status, 0);
		assert.equal(res.parsed, null);
	});

	it("9. [통과 - 정상 (3)] 요구사항 파일의 비설계 메타데이터(updated, status, priority 등)만 바뀐 커밋과 일반 코드 커밋은 통과한다", () => {
		const repoDir = path.join(tmpRoot, "case-pass-metadata-only");
		initGitRepo(repoDir);
		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", BASE_REQ_YAML);
		writeFile(repoDir, "tests/extracted-tables-intent.test.mjs", BASE_TEST_CONTENT);
		git(repoDir, ["add", "."]);
		git(repoDir, ["commit", "-m", "initial"]);

		const metadataOnlyReq = BASE_REQ_YAML.replace("updated: 2026-09-24", "updated: 2026-11-08").replace(
			"status: active",
			"status: verified",
		);
		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", metadataOnlyReq);
		git(repoDir, ["add", ".agents/requirements/REQ-001-table-schema-stage.yaml"]);

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
		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", BASE_REQ_YAML);
		writeFile(repoDir, "tests/extracted-tables-intent.test.mjs", BASE_TEST_CONTENT);
		git(repoDir, ["add", "."]);
		git(repoDir, ["commit", "-m", "initial"]);

		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", UPDATED_DESIGN_REQ_YAML);
		const failCli = runCli(["--check", "--worktree", "--cwd", repoDir], repoDir);
		assert.equal(failCli.status, 1);
		assert.match(failCli.stderr, /다시 검사해야 할 앞 단계 산출물:/);

		writeFile(
			repoDir,
			"tests/extracted-tables-intent.test.mjs",
			BASE_TEST_CONTENT + "\n// updated intent assertion\n",
		);
		const passCli = runCli(["--check", "--worktree", "--cwd", repoDir], repoDir);
		assert.equal(passCli.status, 0);
		assert.match(passCli.stdout, /intent-guard: PASS/);

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
		assert.match(guideText, /표 추출물/);
		assert.match(guideText, /artifacts\/extracted-tables\.json/);
		assert.match(guideText, /다시 검사해야 할 앞 단계 산출물/);
	});

	it("11. [차단 - 심각-1 도메인 중립성] 안내 문서·시험·정책·템플릿이 미디어 생성 구조 표현 없이 문서 변환 표 추출 일반 예시만 사용한다", () => {
		const targetFiles = [
			path.join(ROOT_DIR, "docs", "guides", "design-intent-guard.md"),
			path.join(ROOT_DIR, ".agents", "hooks", "policies", "design-intent-guard.js"),
			path.join(ROOT_DIR, ".agents", "requirements", "_template.yaml"),
			path.join(ROOT_DIR, ".agents", "context", "agents-rules.json"),
			path.join(ROOT_DIR, ".users", "context", "agents-rules.md"),
			__filename,
		];
		const decodedBanned = [
			Buffer.from("6261636b67726f756e642d6c6f6f70", "hex").toString("utf8"),
			Buffer.from("636f6d706f7369746520726567696f6e", "hex").toString("utf8"),
			Buffer.from("6f75746c696e65206472696674", "hex").toString("utf8"),
			Buffer.from("706978656c204d4145", "hex").toString("utf8"),
			Buffer.from("6d6f7574685f6f70656e", "hex").toString("utf8"),
			Buffer.from("617564696f5f726d73", "hex").toString("utf8"),
			Buffer.from("2e7765626d", "hex").toString("utf8"),
			Buffer.from("ebb0b0eab2bd20ec9881ec8381", "hex").toString("utf8"),
			Buffer.from("eca084eab2bd20eca1b0eab081", "hex").toString("utf8"),
			Buffer.from("ebb09cec999420eca1b0eab081", "hex").toString("utf8"),
			Buffer.from("eab3a0eca09520eca28ced919c", "hex").toString("utf8"),
			Buffer.from("ec9e8520ebaaa8ec9691", "hex").toString("utf8"),
			Buffer.from("ec9e85c2b7ec9ca4eab3bd", "hex").toString("utf8"),
			Buffer.from("ec9e85ec9d8420eb8ba4eb9194", "hex").toString("utf8"),
			Buffer.from("ed9484eb9e98ec9e84", "hex").toString("utf8"),
			Buffer.from("ed81b4eba6bd", "hex").toString("utf8"),
		];

		for (const filePath of targetFiles) {
			const content = fs.readFileSync(filePath, "utf8");
			for (const token of decodedBanned) {
				assert.equal(
					content.includes(token),
					false,
					`File ${path.relative(ROOT_DIR, filePath)} contains banned domain token: ${token}`,
				);
			}
		}
	});

	it("12. [차단 - 심각-2 수기 영수증 방어] 손으로 쓴 design_sha256 영수증은 시험 파일 해시(test_sha256)·실행기 증명(run_proof)·종료 코드(exit_code) 검증에서 차단되고 실제 실행기(--run-tests)가 만든 영수증만 통과한다", () => {
		const repoDir = path.join(tmpRoot, "case-block-forged-receipt");
		initGitRepo(repoDir);
		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", BASE_REQ_YAML);
		writeFile(repoDir, "tests/extracted-tables-intent.test.mjs", BASE_TEST_CONTENT);
		git(repoDir, ["add", "."]);
		git(repoDir, ["commit", "-m", "initial"]);

		const newDoc = policy.parseRequirementDocument(UPDATED_DESIGN_REQ_YAML, "REQ-001-table-schema-stage");
		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", UPDATED_DESIGN_REQ_YAML);

		// 1) Hand-written receipt with only status: "pass" + design_sha256 (no runner proof / test_sha256 / exit_code)
		writeFile(
			repoDir,
			".agents/progress/intent-receipts/REQ-001-table-schema-stage.json",
			JSON.stringify({
				requirement_id: "REQ-001-table-schema-stage",
				artifact_id: "extracted-tables-json",
				test_path: "tests/extracted-tables-intent.test.mjs",
				status: "pass",
				design_sha256: newDoc.designDigest,
				ran_at: "2026-11-08T10:00:00Z",
			}),
		);
		git(repoDir, ["add", ".agents/requirements/REQ-001-table-schema-stage.yaml"]);

		const forgedRes = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "git commit -m 'feat: hand-written receipt attempt'" },
			},
			repoDir,
		);
		assert.equal(forgedRes.parsed?.decision, "block", "hand-written receipt without runner proof must be blocked");

		// 2) Run actual test runner (--run-tests) -> generates valid receipt with test_sha256, design_sha256, exit_code: 0, run_proof
		const runRes = runCli(["--run-tests", "--cwd", repoDir], repoDir);
		assert.equal(runRes.status, 0, `--run-tests failed: ${runRes.stderr}`);

		const receiptRaw = JSON.parse(
			fs.readFileSync(
				path.join(repoDir, ".agents/progress/intent-receipts/REQ-001-table-schema-stage.json"),
				"utf8",
			),
		);
		const entry = Array.isArray(receiptRaw.artifacts) ? receiptRaw.artifacts[0] : receiptRaw;
		assert.equal(entry.exit_code, 0);
		assert.equal(entry.design_sha256, newDoc.designDigest);
		assert.match(entry.test_sha256 || "", /^[a-f0-9]{64}$/);
		assert.match(entry.run_proof || "", /^[a-f0-9]{64}$/);

		const passRes = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "git commit -m 'feat: runner receipt passes'" },
			},
			repoDir,
		);
		assert.equal(passRes.parsed, null, "runner-generated receipt must pass");

		// 3) Tamper with test file on disk without re-running runner (and without staging test file) -> test_sha256 mismatch blocks!
		writeFile(
			repoDir,
			"tests/extracted-tables-intent.test.mjs",
			BASE_TEST_CONTENT + "\n// unverified edit after receipt generation\n",
		);
		const mismatchRes = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "git commit -m 'feat: receipt with mismatched test_sha256'" },
			},
			repoDir,
		);
		assert.equal(mismatchRes.parsed?.decision, "block", "mismatched test_sha256 must block");
		assert.match(mismatchRes.parsed?.reason || "", /시험 파일 해시|test_sha256/);
	});

	it("13. [차단 - 심각-P1 조건 강도 판별] 조사·어미를 바꾼 존재·개수·크기·확장자 조건과 지표·비교 연산이 없는 조건(적대 케이스 12종)을 모두 차단한다", () => {
		const adversarialWeakConditions = [
			"파일이 존재한다",
			"파일 있음",
			"verify the file is present",
			"행 수가 충분한지 본다",
			"산출물 파일이 정상적으로 생성되었는지 확인합니다",
			"출력 JSON 확장자와 비어 있지 않음을 점검",
			"output artifact exists and has non-zero byte size",
			"file_count >= 1",
			"파일 크기 >= 100B",
			"line_count >= 10 and file_size > 0",
			"레코드 개수가 10개 이상인지 확인",
			"결과물이 문제없이 잘 나오는지만 본다",
		];

		for (const cond of adversarialWeakConditions) {
			assert.equal(
				policy.isShapeOrCountOnlyCondition(cond),
				true,
				`Expected adversarial weak condition to be rejected: "${cond}"`,
			);
		}

		const validConditions = [
			"row_parse_error_rate <= 0.005 and amount_krw >= 0",
			"표 추출물의 통화 코드(currency_code) == 'KRW' 이고 금액 합계 오차율 <= 0.001",
			"schema_mismatch_count == 0 and normalized_unit == 'KRW'",
		];
		for (const cond of validConditions) {
			assert.equal(
				policy.isShapeOrCountOnlyCondition(cond),
				false,
				`Expected valid content condition to pass: "${cond}"`,
			);
		}
	});

	it("14. [차단 - 보통-P2/P3 시험 내용·조건 교차검사] 심볼이 주석에만 있거나 실제 단언(assert) 없이 동어반복만 있거나 condition의 수치 임계가 시험 코드에 없으면 차단한다", () => {
		const repoDir = path.join(tmpRoot, "case-block-weak-test-body");
		initGitRepo(repoDir);
		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", BASE_REQ_YAML);
		writeFile(repoDir, "tests/extracted-tables-intent.test.mjs", BASE_TEST_CONTENT);
		git(repoDir, ["add", "."]);
		git(repoDir, ["commit", "-m", "initial"]);

		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", UPDATED_DESIGN_REQ_YAML);

		// Subcase A: symbol only in a comment
		writeFile(
			repoDir,
			"tests/extracted-tables-intent.test.mjs",
			`import assert from "node:assert/strict";
// extracted table rows maintain normalized KRW integers
const row_parse_error_rate = 0.001;
const amount_krw = 100;
assert.ok(row_parse_error_rate <= 0.005);
assert.ok(amount_krw >= 0);
`,
		);
		git(repoDir, ["add", "."]);
		const resCommentSymbol = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "git commit -m 'feat: symbol in comment only'" },
			},
			repoDir,
		);
		assert.equal(resCommentSymbol.parsed?.decision, "block");
		assert.match(resCommentSymbol.parsed?.reason || "", /심볼/);

		// Subcase B: tautological assert.ok(true) only
		writeFile(
			repoDir,
			"tests/extracted-tables-intent.test.mjs",
			`import test from "node:test";
import assert from "node:assert/strict";
test("extracted table rows maintain normalized KRW integers", () => {
  // 0.005 and 0 in comment
  assert.ok(true);
});
`,
		);
		git(repoDir, ["add", "."]);
		const resTautology = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "git commit -m 'feat: tautological assertion'" },
			},
			repoDir,
		);
		assert.equal(resTautology.parsed?.decision, "block");

		// Subcase C: condition numeric threshold (0.005) missing from test code
		writeFile(
			repoDir,
			"tests/extracted-tables-intent.test.mjs",
			`import test from "node:test";
import assert from "node:assert/strict";
test("extracted table rows maintain normalized KRW integers", () => {
  const row_parse_error_rate = 0.1;
  const amount_krw = 10;
  assert.ok(row_parse_error_rate <= 0.99);
  assert.ok(amount_krw >= 0);
});
`,
		);
		git(repoDir, ["add", "."]);
		const resThresholdMismatch = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "git commit -m 'feat: missing threshold 0.005'" },
			},
			repoDir,
		);
		assert.equal(resThresholdMismatch.parsed?.decision, "block");
		assert.match(resThresholdMismatch.parsed?.reason || "", /0\.005/);
	});

	it("15. [차단 - 보통-U1/U2/사소-U4 셸 우회 방어] 실제 훅 흉내 입력으로 bash -c, env, cd &&, git -C 붙임형, --amend, alias, for/do, xargs, find -exec, node -e, 단일 &, git cherry-pick/apply 우회를 모두 차단한다", () => {
		const repoDir = path.join(tmpRoot, "case-block-shell-bypasses");
		initGitRepo(repoDir);
		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", BASE_REQ_YAML);
		writeFile(repoDir, "tests/extracted-tables-intent.test.mjs", BASE_TEST_CONTENT);
		git(repoDir, ["add", "."]);
		git(repoDir, ["commit", "-m", "initial"]);

		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", UPDATED_DESIGN_REQ_YAML);
		git(repoDir, ["add", ".agents/requirements/REQ-001-table-schema-stage.yaml"]);

		const bypassCommandsInRepo = [
			`git commit --amend --no-edit`,
			`for i in 1; do git commit -m "loop commit"; done`,
			`if true; then git commit -m "if commit"; fi`,
			`alias g=git; g commit -m "alias commit"`,
			`echo "msg" | xargs -I{} git commit -m "{}"`,
			`find . -maxdepth 0 -exec git commit -m "find exec commit" \\;`,
			`node -e 'require("child_process").execSync("git commit -m node_subproc")'`,
			`git commit -m "background commit" &`,
			`git cherry-pick HEAD`,
			`git merge feature-branch`,
		];

		for (const cmd of bypassCommandsInRepo) {
			const res = runHook(
				{
					cwd: repoDir,
					tool_name: "Bash",
					tool_input: { command: cmd },
				},
				repoDir,
			);
			assert.equal(res.parsed?.decision, "block", `bypass command in repo must be blocked: ${cmd}`);
			assert.match(res.parsed?.reason || "", /다시 검사해야 할 앞 단계 산출물:/);
		}

		// Verify single `&` does not pollute explicitPaths
		const invs = policy.extractGitCommitInvocations(`git commit -m "bg" &`, repoDir);
		assert.equal(invs.length, 1);
		assert.deepEqual(invs[0].explicitPaths, []);

		// Attached -C<repoDir> and --work-tree=<repoDir> from parent directory
		const attachedFromParent = [
			`git -C"${repoDir}" commit -m "attached -C"`,
			`git --work-tree="${repoDir}" --git-dir="${repoDir}/.git" commit -m "work-tree eq"`,
		];
		for (const cmd of attachedFromParent) {
			const res = runHook(
				{
					cwd: tmpRoot,
					tool_name: "Bash",
					tool_input: { command: cmd },
				},
				tmpRoot,
			);
			assert.equal(res.parsed?.decision, "block", `attached -C/work-tree must be blocked: ${cmd}`);
		}
	});

	it("16. [차단/통과 - 보통-U3 요구사항 삭제 방어] 설계·산출물이 있는 요구사항 파일 삭제 커밋은 차단하고 status: retired + 실행 영수증 갱신은 통과한다", () => {
		const repoDir = path.join(tmpRoot, "case-block-req-delete");
		initGitRepo(repoDir);
		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", BASE_REQ_YAML);
		writeFile(repoDir, "tests/extracted-tables-intent.test.mjs", BASE_TEST_CONTENT);
		git(repoDir, ["add", "."]);
		git(repoDir, ["commit", "-m", "initial"]);

		// Delete requirement file and stage deletion
		git(repoDir, ["rm", ".agents/requirements/REQ-001-table-schema-stage.yaml"]);
		const delRes = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "git commit -m 'chore: delete requirement file'" },
			},
			repoDir,
		);
		assert.equal(delRes.parsed?.decision, "block", "deleting design-bearing REQ file must be blocked");
		assert.match(delRes.parsed?.reason || "", /삭제할 수 없습니다|status:\s*retired/);

		// Restore and retire properly with status: retired + runner receipt
		git(repoDir, ["reset", "--hard", "HEAD"]);
		const retiredReq = BASE_REQ_YAML.replace("status: active", "status: retired");
		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", retiredReq);
		git(repoDir, ["add", ".agents/requirements/REQ-001-table-schema-stage.yaml"]);

		// Without receipt/test update, retiring is blocked
		const retireNoReceipt = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "git commit -m 'chore: retire without receipt'" },
			},
			repoDir,
		);
		assert.equal(retireNoReceipt.parsed?.decision, "block");

		// With runner receipt, retiring passes
		const runRes = runCli(["--run-tests", "--cwd", repoDir], repoDir);
		assert.equal(runRes.status, 0);
		const retireWithReceipt = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "git commit -m 'chore: retire with receipt'" },
			},
			repoDir,
		);
		assert.equal(retireWithReceipt.parsed, null);
	});

	it("17. [통과 - 보통-F1/사소-F2 거짓 차단 방지] 작업 트리에 미스테이지 REQ 설계 수정이 남아 있어도 무관한 파일만 스테이지한 커밋이나 요구사항 없는 저장소 커밋은 통과한다", () => {
		const repoDir = path.join(tmpRoot, "case-pass-unstaged-dirty-req");
		initGitRepo(repoDir);
		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", BASE_REQ_YAML);
		writeFile(repoDir, "tests/extracted-tables-intent.test.mjs", BASE_TEST_CONTENT);
		writeFile(repoDir, "README.md", "# Doc Converter\n");
		git(repoDir, ["add", "."]);
		git(repoDir, ["commit", "-m", "initial"]);

		// Leave REQ design modification UNSTAGED in working tree, but stage ONLY README.md
		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", UPDATED_DESIGN_REQ_YAML);
		writeFile(repoDir, "README.md", "# Doc Converter\n\nFixed typo.\n");
		git(repoDir, ["add", "README.md"]);

		const unrelatedStagedRes = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: 'git commit -m "docs: fix typo in README"' },
			},
			repoDir,
		);
		assert.equal(
			unrelatedStagedRes.parsed,
			null,
			`Unstaged dirty REQ must not block unrelated staged commit, got: ${JSON.stringify(unrelatedStagedRes.parsed)}`,
		);

		// Commit with explicit path `git commit -m "docs: fix typo" README.md` also passes
		const explicitPathRes = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: 'git commit -m "docs: fix typo" README.md' },
			},
			repoDir,
		);
		assert.equal(explicitPathRes.parsed, null);

		// Meanwhile `git commit -a -m "..."` WOULD include the unstaged dirty REQ, so it MUST block!
		const commitAllRes = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: 'git commit -a -m "feat: commit all dirty files"' },
			},
			repoDir,
		);
		assert.equal(commitAllRes.parsed?.decision, "block");

		// Repo without any requirements folder passes immediately
		const noReqRepo = path.join(tmpRoot, "case-pass-no-req-repo");
		initGitRepo(noReqRepo);
		writeFile(noReqRepo, "index.js", "console.log('hi');\n");
		git(noReqRepo, ["add", "index.js"]);
		const noReqRes = runHook(
			{
				cwd: noReqRepo,
				tool_name: "Bash",
				tool_input: { command: 'git commit -m "chore: initial"' },
			},
			noReqRepo,
		);
		assert.equal(noReqRes.parsed, null);
	});

	it("18. [정합 - 보통-C1/사소-C2/C3/C4/F3] 자체 셸 파서를 제거하고 git-command-parser를 재사용하며 bash.js 표면·pi 로그·문서 CI 안내·검사 시간을 만족한다", () => {
		const policySource = fs.readFileSync(
			path.join(ROOT_DIR, ".agents", "hooks", "policies", "design-intent-guard.js"),
			"utf8",
		);
		// Must NOT re-implement splitShellSegments / tokenizeSegment / unwrapGroupTokens
		assert.doesNotMatch(policySource, /function\s+splitShellSegments\b/);
		assert.doesNotMatch(policySource, /function\s+tokenizeSegment\b/);
		assert.doesNotMatch(policySource, /function\s+unwrapGroupTokens\b/);
		assert.match(policySource, /git-command-parser\.js|effective-argv\.js/);

		// bash.js re-export surface is narrowed to designIntentRecheck, intentGuard, checkRepositoryDesignIntent
		assert.equal(typeof bashPolicy.designIntentRecheck, "function");
		assert.equal(typeof bashPolicy.checkRepositoryDesignIntent, "function");
		assert.equal(bashPolicy.isShapeOrCountOnlyCondition, undefined);
		assert.equal(bashPolicy.extractGitCommitInvocations, undefined);

		// .pi/extensions/naia-harness.ts logs warning on fail-open guard error
		const piSource = fs.readFileSync(
			path.join(ROOT_DIR, ".pi", "extensions", "naia-harness.ts"),
			"utf8",
		);
		assert.match(piSource, /designIntentRecheck/);
		assert.match(piSource, /console\.warn|stderr\.write/);

		// Guide documents CI (--commit HEAD) and performance measurements
		const guideText = fs.readFileSync(
			path.join(ROOT_DIR, "docs", "guides", "design-intent-guard.md"),
			"utf8",
		);
		assert.match(guideText, /--commit HEAD/);
		assert.match(guideText, /--run-tests/);
		assert.match(guideText, /CI/);

		// Performance check on the workspace repository (< 500ms)
		const t0 = Date.now();
		const res = policy.checkRepositoryDesignIntent(ROOT_DIR, { mode: "auto" });
		const elapsedMs = Date.now() - t0;
		assert.equal(res.ok, true);
		assert.ok(elapsedMs < 500, `checkRepositoryDesignIntent took too long: ${elapsedMs}ms`);
	});
});
