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
	if (relPath.includes(".agents/requirements/REQ-001")) {
		const defaultArtifact = path.join(repoDir, "artifacts", "extracted-tables.json");
		if (!fs.existsSync(defaultArtifact)) {
			fs.mkdirSync(path.dirname(defaultArtifact), { recursive: true });
			fs.writeFileSync(
				defaultArtifact,
				JSON.stringify({ row_parse_error_rate: 0.001, rows: [{ amount_krw: 125000 }] }, null, 2) + "\n",
				"utf8",
			);
		}
	}
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
      symbol: "verifyExtractedTablesIntent"
      receipt: null
trace:
  code:
    - path: "src/extractor.mjs"
      symbol: "extractDocumentTables"
      coverage: full
  tests:
    - path: "tests/extracted-tables-intent.test.mjs"
      symbol: "verifyExtractedTablesIntent"
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
import fs from "node:fs";

export function verifyExtractedTablesIntent() {
  const data = JSON.parse(fs.readFileSync("artifacts/extracted-tables.json", "utf8"));
  const row_parse_error_rate = data.row_parse_error_rate;
  const amount_krw = data.rows[0].amount_krw;
  assert.ok(row_parse_error_rate <= 0.005);
  assert.ok(amount_krw >= 0);
}

test("extracted table rows maintain normalized KRW integers", () => {
  verifyExtractedTablesIntent();
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
		git(repoDir, [
			"add",
			".agents/requirements/REQ-001-table-schema-stage.yaml",
			".agents/intent-receipts/REQ-001-table-schema-stage.json",
		]);

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
		// [사소-S1] 회귀 방지 목적의 16진 인코딩 금지어 목록 (평문 도메인 용어가 저장소에 노출되지 않도록 유지)
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
			".agents/intent-receipts/REQ-001-table-schema-stage.json",
			JSON.stringify({
				requirement_id: "REQ-001-table-schema-stage",
				artifact_id: "extracted-tables-json",
				test_path: "tests/extracted-tables-intent.test.mjs",
				status: "pass",
				design_sha256: newDoc.designDigest,
				ran_at: "2026-11-08T10:00:00Z",
			}),
		);
		git(repoDir, [
			"add",
			".agents/requirements/REQ-001-table-schema-stage.yaml",
			".agents/intent-receipts/REQ-001-table-schema-stage.json",
		]);

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
				path.join(repoDir, ".agents/intent-receipts/REQ-001-table-schema-stage.json"),
				"utf8",
			),
		);
		const entry = Array.isArray(receiptRaw.artifacts) ? receiptRaw.artifacts[0] : receiptRaw;
		assert.equal(entry.exit_code, 0);
		assert.equal(entry.design_sha256, newDoc.designDigest);
		assert.match(entry.test_sha256 || "", /^[a-f0-9]{64}$/);
		assert.match(entry.run_proof || "", /^[a-f0-9]{64}$/);

		git(repoDir, [
			"add",
			".agents/requirements/REQ-001-table-schema-stage.yaml",
			".agents/intent-receipts/REQ-001-table-schema-stage.json",
		]);
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
import fs from "node:fs";
// verifyExtractedTablesIntent
const data = JSON.parse(fs.readFileSync("artifacts/extracted-tables.json", "utf8"));
assert.ok(data.row_parse_error_rate <= 0.005);
assert.ok(data.rows[0].amount_krw >= 0);
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
export function verifyExtractedTablesIntent() {
  // 0.005 and 0 in comment
  assert.ok(true);
}
test("extracted table rows maintain normalized KRW integers", () => {
  verifyExtractedTablesIntent();
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
import fs from "node:fs";
export function verifyExtractedTablesIntent() {
  const data = JSON.parse(fs.readFileSync("artifacts/extracted-tables.json", "utf8"));
  assert.ok(data.row_parse_error_rate <= 0.99);
  assert.ok(data.rows[0].amount_krw >= 0);
}
test("extracted table rows maintain normalized KRW integers", () => {
  verifyExtractedTablesIntent();
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

		// With runner receipt staged in the same change set, retiring passes
		const runRes = runCli(["--run-tests", "--cwd", repoDir], repoDir);
		assert.equal(runRes.status, 0);
		git(repoDir, ["add", ".agents/intent-receipts/REQ-001-table-schema-stage.json"]);
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

	it("19. [차단 - 심각-R1 공개값 run_proof 재계산 위조 및 실패 시험 영수증 차단] 공개 상수·해시로 run_proof를 재계산한 위조 영수증과 실제 실행 시 실패하는 시험의 위조 영수증을 관문 재실행 및 출력 지문 대조로 차단한다", () => {
		const crypto = require("node:crypto");
		assert.equal(
			policy.computeReceiptProof,
			undefined,
			"computeReceiptProof must not be exported publicly",
		);

		const repoDir = path.join(tmpRoot, "case-block-r1-proof-forgery");
		initGitRepo(repoDir);
		writeFile(
			repoDir,
			"artifacts/extracted-tables.json",
			JSON.stringify({ row_parse_error_rate: 0.001, rows: [{ amount_krw: 125000 }] }, null, 2) + "\n",
		);
		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", BASE_REQ_YAML);
		writeFile(repoDir, "tests/extracted-tables-intent.test.mjs", BASE_TEST_CONTENT);
		git(repoDir, ["add", "."]);
		git(repoDir, ["commit", "-m", "initial"]);

		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", UPDATED_DESIGN_REQ_YAML);
		const newDoc = policy.parseRequirementDocument(UPDATED_DESIGN_REQ_YAML, "REQ-001-table-schema-stage");
		const testBytes = fs.readFileSync(path.join(repoDir, "tests/extracted-tables-intent.test.mjs"), "utf8");
		const testSha256 = crypto.createHash("sha256").update(testBytes, "utf8").digest("hex");
		const artifactBytes = fs.readFileSync(path.join(repoDir, "artifacts/extracted-tables.json"), "utf8");
		const artifactSha256 = crypto.createHash("sha256").update(artifactBytes, "utf8").digest("hex");
		const fakeOutputSha256 = "a".repeat(64);
		const ranAt = "2026-11-08T10:30:00.000Z";
		const forgedProof = crypto
			.createHash("sha256")
			.update(
				[
					"naia-adk-intent-guard-receipt-v1",
					"intent-guard-runner/v1",
					"REQ-001-table-schema-stage",
					"extracted-tables-json",
					"tests/extracted-tables-intent.test.mjs",
					newDoc.designDigest,
					testSha256,
					artifactSha256,
					"0",
					fakeOutputSha256,
					ranAt,
				].join("|"),
				"utf8",
			)
			.digest("hex");

		const forgedReceiptPayload = JSON.stringify(
			{
				runner: "intent-guard-runner/v1",
				requirement_id: "REQ-001-table-schema-stage",
				design_sha256: newDoc.designDigest,
				ran_at: ranAt,
				status: "pass",
				artifacts: [
					{
						requirement_id: "REQ-001-table-schema-stage",
						artifact_id: "extracted-tables-json",
						path: "artifacts/extracted-tables.json",
						test_path: "tests/extracted-tables-intent.test.mjs",
						status: "pass",
						exit_code: 0,
						design_sha256: newDoc.designDigest,
						test_sha256: testSha256,
						artifact_sha256: artifactSha256,
						output_sha256: fakeOutputSha256,
						ran_at: ranAt,
						runner: "intent-guard-runner/v1",
						run_proof: forgedProof,
					},
				],
			},
			null,
			2,
		);
		writeFile(repoDir, ".agents/intent-receipts/REQ-001-table-schema-stage.json", forgedReceiptPayload);
		writeFile(repoDir, ".agents/progress/intent-receipts/REQ-001-table-schema-stage.json", forgedReceiptPayload);
		git(repoDir, [
			"add",
			".agents/requirements/REQ-001-table-schema-stage.yaml",
			".agents/intent-receipts/REQ-001-table-schema-stage.json",
		]);

		const resForgedProof = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "git commit -m 'feat: forged run_proof receipt'" },
			},
			repoDir,
		);
		assert.equal(
			resForgedProof.parsed?.decision,
			"block",
			"Receipt with recomputed run_proof and fabricated output_sha256 must be blocked",
		);
		assert.match(
			resForgedProof.parsed?.reason || "",
			/실행 출력 지문\(output_sha256\)이 관문 직접 실행 출력과 불일치/,
			"11-field forged proof must reach and fail at output_sha256 comparison",
		);

		// Subcase B: Test actually fails on execution (amount_krw < 0), even if test file was updated in the same commit
		writeFile(
			repoDir,
			"artifacts/extracted-tables.json",
			JSON.stringify({ row_parse_error_rate: 0.001, rows: [{ amount_krw: -500 }] }, null, 2) + "\n",
		);
		writeFile(
			repoDir,
			"tests/extracted-tables-intent.test.mjs",
			BASE_TEST_CONTENT + "\n// edited test but artifact violates amount_krw >= 0\n",
		);
		git(repoDir, ["add", "."]);
		const resFailingTest = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "git commit -m 'feat: failing test should be blocked by gate re-run'" },
			},
			repoDir,
		);
		assert.equal(
			resFailingTest.parsed?.decision,
			"block",
			"Gate must re-run test at commit time and block when test exits non-zero",
		);
	});

	it("20. [차단/통과 - 보통-R2 영수증 커밋 경로 및 CI 재현성] 기본 영수증 경로(.agents/intent-receipts/)가 gitignore 대상이 아니며 같은 변경 집합에 스테이지·커밋되어야 통과하고 깨끗한 체크아웃에서 --commit HEAD가 재현된다", () => {
		const ignoreCheck = spawnSync(
			"git",
			["-C", ROOT_DIR, "check-ignore", "-q", ".agents/intent-receipts/REQ-001.json"],
			{ encoding: "utf8" },
		);
		assert.notEqual(
			ignoreCheck.status,
			0,
			".agents/intent-receipts/ must NOT be ignored by .gitignore",
		);

		const repoDir = path.join(tmpRoot, "case-r2-committed-receipt");
		initGitRepo(repoDir);
		writeFile(
			repoDir,
			"artifacts/extracted-tables.json",
			JSON.stringify({ row_parse_error_rate: 0.001, rows: [{ amount_krw: 125000 }] }, null, 2) + "\n",
		);
		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", BASE_REQ_YAML);
		writeFile(repoDir, "tests/extracted-tables-intent.test.mjs", BASE_TEST_CONTENT);
		git(repoDir, ["add", "."]);
		git(repoDir, ["commit", "-m", "initial"]);

		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", UPDATED_DESIGN_REQ_YAML);
		const runRes = runCli(["--run-tests", "--cwd", repoDir], repoDir);
		assert.equal(runRes.status, 0, `--run-tests failed: ${runRes.stderr}`);

		const expectedReceiptRel = ".agents/intent-receipts/REQ-001-table-schema-stage.json";
		assert.ok(
			fs.existsSync(path.join(repoDir, expectedReceiptRel)),
			"Runner must write receipt to committable .agents/intent-receipts/<REQ-ID>.json",
		);

		// Stage ONLY the requirement file without staging the receipt file -> must block!
		git(repoDir, ["add", ".agents/requirements/REQ-001-table-schema-stage.yaml"]);
		const unstagedReceiptRes = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "git commit -m 'feat: unstaged receipt must block'" },
			},
			repoDir,
		);
		assert.equal(
			unstagedReceiptRes.parsed?.decision,
			"block",
			"Receipt not staged in the same change set must be blocked",
		);

		// Stage the receipt file in the same change set -> passes commit and --commit HEAD even after worktree cleanup!
		git(repoDir, ["add", expectedReceiptRel]);
		const stagedReceiptRes = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "git commit -m 'feat: staged receipt passes'" },
			},
			repoDir,
		);
		assert.equal(stagedReceiptRes.parsed, null, "Staged valid receipt must pass");
		git(repoDir, ["commit", "-m", "feat: design change with committed receipt"]);

		// Simulate clean CI checkout by deleting untracked/working-tree receipt cache if any, then run --commit HEAD
		const ciCheck = runCli(["--commit", "HEAD", "--cwd", repoDir], repoDir);
		assert.equal(ciCheck.status, 0, `--commit HEAD must succeed from committed receipt: ${ciCheck.stderr}`);
		assert.match(ciCheck.stdout, /intent-guard: PASS/);
	});

	it("21. [차단 - 보통-R3/P2a/P2b/P3a 공허 상수 시험·문자열 리터럴 심볼/수치·다인자 상수 단언 차단] 산출물을 읽지 않는 상수 시험, 문자열 리터럴 안의 심볼·수치, assert.equal(1, 1)류를 모두 차단한다", () => {
		const repoDir = path.join(tmpRoot, "case-r3-p2-p3-vacuous");
		initGitRepo(repoDir);
		writeFile(
			repoDir,
			"artifacts/extracted-tables.json",
			JSON.stringify({ row_parse_error_rate: 0.001, rows: [{ amount_krw: 125000 }] }, null, 2) + "\n",
		);
		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", BASE_REQ_YAML);
		writeFile(repoDir, "tests/extracted-tables-intent.test.mjs", BASE_TEST_CONTENT);
		git(repoDir, ["add", "."]);
		git(repoDir, ["commit", "-m", "initial"]);

		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", UPDATED_DESIGN_REQ_YAML);

		// Subcase 1 [보통-R3]: Vacuous hardcoded constants without reading/referencing artifacts/extracted-tables.json
		writeFile(
			repoDir,
			"tests/extracted-tables-intent.test.mjs",
			`import test from "node:test";
import assert from "node:assert/strict";
export function verifyExtractedTablesIntent() {
  const row_parse_error_rate = 0.001;
  const amount_krw = 125000;
  assert.ok(row_parse_error_rate <= 0.005);
  assert.ok(amount_krw >= 0);
}
test("vacuous test", () => verifyExtractedTablesIntent());
`,
		);
		git(repoDir, ["add", "."]);
		const resVacuous = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "git commit -m 'feat: vacuous constant test'" },
			},
			repoDir,
		);
		assert.equal(resVacuous.parsed?.decision, "block", "Vacuous constant test without reading artifact must be blocked");

		// Subcase 2 [보통-P2a]: Symbol present only inside a string literal, not as an identifier
		const reqWithIdentifierSymbol = UPDATED_DESIGN_REQ_YAML.replace(
			/symbol:\s*"[^"]+"/,
			'symbol: "verifyExtractedTablesIntent"',
		);
		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", reqWithIdentifierSymbol);
		writeFile(
			repoDir,
			"tests/extracted-tables-intent.test.mjs",
			`import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
test("verifyExtractedTablesIntent", () => {
  const data = JSON.parse(fs.readFileSync("artifacts/extracted-tables.json", "utf8"));
  assert.ok(data.row_parse_error_rate <= 0.005);
  assert.ok(data.rows[0].amount_krw >= 0);
});
`,
		);
		git(repoDir, ["add", "."]);
		const resStringSymbol = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "git commit -m 'feat: symbol in string literal only'" },
			},
			repoDir,
		);
		assert.equal(
			resStringSymbol.parsed?.decision,
			"block",
			"Symbol appearing only inside a string literal must be blocked",
		);

		// Subcase 3 [보통-P2b]: Multi-argument constant-to-constant assertions only (assert.equal(1, 1), assert.deepStrictEqual({}, {}))
		writeFile(
			repoDir,
			"tests/extracted-tables-intent.test.mjs",
			`import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
export function verifyExtractedTablesIntent() {
  const data = JSON.parse(fs.readFileSync("artifacts/extracted-tables.json", "utf8"));
  const threshold = 0.005;
  const minVal = 0;
  assert.equal(1, 1);
  assert.deepStrictEqual({}, {});
}
test("constant-to-constant assertions", () => verifyExtractedTablesIntent());
`,
		);
		git(repoDir, ["add", "."]);
		const resConstAssert = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "git commit -m 'feat: constant assertions only'" },
			},
			repoDir,
		);
		assert.equal(
			resConstAssert.parsed?.decision,
			"block",
			"Multi-argument constant-to-constant assertions must be blocked",
		);

		// Subcase 4 [보통-P3a]: Numeric threshold (0.005) present only inside a string literal
		writeFile(
			repoDir,
			"tests/extracted-tables-intent.test.mjs",
			`import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
export function verifyExtractedTablesIntent() {
  const data = JSON.parse(fs.readFileSync("artifacts/extracted-tables.json", "utf8"));
  const description = "row_parse_error_rate <= 0.005";
  assert.ok(data.row_parse_error_rate <= 0.5);
  assert.ok(data.rows[0].amount_krw >= 0);
}
test("threshold in string literal", () => verifyExtractedTablesIntent());
`,
		);
		git(repoDir, ["add", "."]);
		const resStringThreshold = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "git commit -m 'feat: threshold in string literal'" },
			},
			repoDir,
		);
		assert.equal(
			resStringThreshold.parsed?.decision,
			"block",
			"Numeric threshold appearing only inside a string literal must be blocked",
		);
	});

	it("22. [차단/정합 - 보통-R4/U1a/U2a/R5] find -exec 중첩 셸(sh -c), npx/pnpm/make 경유, git pull 감시 및 CI 워크플로·네이티브 하네스 연결을 모두 만족한다", () => {
		const repoDir = path.join(tmpRoot, "case-r4-u1a-u2a-r5");
		initGitRepo(repoDir);
		writeFile(
			repoDir,
			"artifacts/extracted-tables.json",
			JSON.stringify({ row_parse_error_rate: 0.001, rows: [{ amount_krw: 125000 }] }, null, 2) + "\n",
		);
		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", BASE_REQ_YAML);
		writeFile(repoDir, "tests/extracted-tables-intent.test.mjs", BASE_TEST_CONTENT);
		writeFile(
			repoDir,
			"package.json",
			JSON.stringify({ name: "tmp-pkg", scripts: { "commit-all": 'git commit -m "via npm script"' } }),
		);
		writeFile(repoDir, "Makefile", "commit-target:\n\tgit commit -m 'via makefile'\n");
		git(repoDir, ["add", "."]);
		git(repoDir, ["commit", "-m", "initial"]);

		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", UPDATED_DESIGN_REQ_YAML);
		git(repoDir, ["add", ".agents/requirements/REQ-001-table-schema-stage.yaml"]);

		const cmds = [
			`find . -maxdepth 0 -exec sh -c 'git commit -m "nested find sh"' \\;`,
			`find . -maxdepth 0 -exec bash -c "git commit -m 'nested find bash'" \\;`,
			`npx git commit -m "npx git commit"`,
			`npm run commit-all`,
			`pnpm commit-all`,
			`make commit-target`,
			`git pull origin main`,
		];

		for (const cmd of cmds) {
			const res = runHook(
				{
					cwd: repoDir,
					tool_name: "Bash",
					tool_input: { command: cmd },
				},
				repoDir,
			);
			assert.equal(res.parsed?.decision, "block", `Command must be blocked: ${cmd}`);
		}

		// Guide documents pull / checkout / reset --hard
		const guideText = fs.readFileSync(
			path.join(ROOT_DIR, "docs", "guides", "design-intent-guard.md"),
			"utf8",
		);
		assert.match(guideText, /pull/);
		assert.match(guideText, /checkout/);
		assert.match(guideText, /reset --hard/);

		// CI workflow and run-native-harness-tests.cjs actually invoke intent-guard.js
		const ciYml = fs.readFileSync(path.join(ROOT_DIR, ".github", "workflows", "ci.yml"), "utf8");
		assert.match(ciYml, /intent-guard\.js/);
		const nativeHarness = fs.readFileSync(
			path.join(ROOT_DIR, "scripts", "run-native-harness-tests.cjs"),
			"utf8",
		);
		assert.match(nativeHarness, /intent-guard\.js/);
	});

	it("23. [차단/통과 - 보통-U3a/사소-F1a] 설계·산출물 섹션을 통째로 지우는 2단계 우회 시도는 차단하고 정당한 git mv 파일 이동은 통과한다", () => {
		const repoDir = path.join(tmpRoot, "case-u3a-two-step-delete");
		initGitRepo(repoDir);
		writeFile(
			repoDir,
			"artifacts/extracted-tables.json",
			JSON.stringify({ row_parse_error_rate: 0.001, rows: [{ amount_krw: 125000 }] }, null, 2) + "\n",
		);
		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", BASE_REQ_YAML);
		writeFile(repoDir, "tests/extracted-tables-intent.test.mjs", BASE_TEST_CONTENT);
		git(repoDir, ["add", "."]);
		git(repoDir, ["commit", "-m", "initial"]);

		// Step 1 of 2-step bypass: strip design and artifacts sections completely while keeping status: active
		const strippedReq = `id: REQ-001-table-schema-stage
title: "Stripped requirement"
status: active
`;
		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", strippedReq);
		git(repoDir, ["add", ".agents/requirements/REQ-001-table-schema-stage.yaml"]);

		const resStripped = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "git commit -m 'chore: strip design and artifacts sections'" },
			},
			repoDir,
		);
		assert.equal(
			resStripped.parsed?.decision,
			"block",
			"Removing design/artifacts sections from a design-bearing requirement must be blocked",
		);

		// Legitimate git mv without changing design content passes
		git(repoDir, ["reset", "--hard", "HEAD"]);
		git(repoDir, [
			"mv",
			".agents/requirements/REQ-001-table-schema-stage.yaml",
			".agents/requirements/REQ-001-table-schema-moved.yaml",
		]);
		const resMove = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "git commit -m 'chore: rename requirement file via git mv'" },
			},
			repoDir,
		);
		assert.equal(resMove.parsed, null, "Legitimate git mv preserving requirement design must pass");
	});

	it("24. [정합 - 사소-C1a/C1b/C1c] bash.commit이 공용 추출기를 재사용하고 중복 옵션 집합이 없으며 예외 발생 시 stderr 경고 후 fail-open 한다", () => {
		const repoDir = path.join(tmpRoot, "case-c1-abc");
		initGitRepo(repoDir);
		writeFile(
			repoDir,
			".agents/progress/issue-1.json",
			JSON.stringify({ issue: "#1", current_phase: "build" }),
		);

		// [사소-C1a] bashPolicy.commit detects wrapped commit (`bash -c "git commit -m wip"`) via shared extractor
		const commitRes = bashPolicy.commit('bash -c "git commit -m wip"', { cwd: repoDir });
		assert.ok(
			commitRes && commitRes.reason && commitRes.reason.includes("커밋 차단"),
			"bash.commit must detect wrapped git commit via shared extractGitCommitInvocations",
		);

		// [사소-C1b] design-intent-guard.js does not define duplicate GIT_OPT_WITH_VALUE / GIT_OPT_NO_VALUE
		const policySource = fs.readFileSync(
			path.join(ROOT_DIR, ".agents", "hooks", "policies", "design-intent-guard.js"),
			"utf8",
		);
		assert.doesNotMatch(policySource, /\bGIT_OPT_WITH_VALUE\b/);
		assert.doesNotMatch(policySource, /\bGIT_OPT_NO_VALUE\b/);

		// [사소-C1c] designIntentRecheck catches unexpected errors, writes warning to stderr, and returns null (fail-open)
		const badData = {};
		Object.defineProperty(badData, "cwd", {
			get() {
				throw new Error("simulated cwd getter failure");
			},
		});
		let stderrCaptured = "";
		const origWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = (chunk, ...rest) => {
			stderrCaptured += String(chunk);
			return true;
		};
		let recRes;
		try {
			recRes = policy.designIntentRecheck("git commit -m test", badData);
		} finally {
			process.stderr.write = origWrite;
		}
		assert.equal(recRes, null, "designIntentRecheck must fail-open on unexpected exception");
		assert.match(stderrCaptured, /simulated cwd getter failure|intent-guard/i);
	});

	it("25. [차단/통과 - 보통-N1 스테이지·커밋 블롭 materialize 검사 및 작업 트리 괴리 차단] staged·commit 모드에서 작업 트리와 인덱스/커밋 블롭이 다를 때 블롭을 임시 파일로 꺼내 검사·실행하고 괴리를 차단한다", () => {
		const repoDir = path.join(tmpRoot, "case-n1-blob-materialize");
		initGitRepo(repoDir);
		writeFile(
			repoDir,
			"artifacts/extracted-tables.json",
			JSON.stringify({ row_parse_error_rate: 0.001, rows: [{ amount_krw: 125000 }] }, null, 2) + "\n",
		);
		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", BASE_REQ_YAML);
		writeFile(repoDir, "tests/extracted-tables-intent.test.mjs", BASE_TEST_CONTENT);
		git(repoDir, ["add", "."]);
		git(repoDir, ["commit", "-m", "initial"]);

		// Subcase A (staged mode): stage a broken/failing test in the index, then overwrite worktree with passing test without staging
		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", UPDATED_DESIGN_REQ_YAML);
		const failingTestContent = BASE_TEST_CONTENT.replace(
			"assert.ok(amount_krw >= 0);",
			"assert.ok(amount_krw >= 0);\n  assert.ok(amount_krw < 0);",
		);
		writeFile(repoDir, "tests/extracted-tables-intent.test.mjs", failingTestContent);
		git(repoDir, [
			"add",
			".agents/requirements/REQ-001-table-schema-stage.yaml",
			"tests/extracted-tables-intent.test.mjs",
		]);
		// Overwrite worktree with passing test WITHOUT git add
		writeFile(
			repoDir,
			"tests/extracted-tables-intent.test.mjs",
			BASE_TEST_CONTENT + "\n// worktree looks valid while index blob is broken\n",
		);

		const stagedDriftRes = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "git commit -m 'feat: staged broken blob masked by worktree'" },
			},
			repoDir,
		);
		assert.equal(
			stagedDriftRes.parsed?.decision,
			"block",
			"Staged mode must inspect/execute staged blob and block when index blob fails or diverges from worktree",
		);

		// Subcase B (commit mode --commit HEAD): commit a valid test+design, then corrupt/delete worktree files and verify --commit HEAD still passes from HEAD blobs
		writeFile(
			repoDir,
			"tests/extracted-tables-intent.test.mjs",
			BASE_TEST_CONTENT + "\n// valid committed test\n",
		);
		git(repoDir, ["add", "tests/extracted-tables-intent.test.mjs"]);
		git(repoDir, ["commit", "-m", "feat: valid design and test commit"]);

		// Corrupt worktree test and artifact after commit
		writeFile(repoDir, "tests/extracted-tables-intent.test.mjs", "// empty comment only in worktree\n");
		writeFile(
			repoDir,
			"artifacts/extracted-tables.json",
			JSON.stringify({ row_parse_error_rate: 0.99, rows: [{ amount_krw: -999 }] }) + "\n",
		);

		const commitHeadRes = runCli(["--commit", "HEAD", "--cwd", repoDir], repoDir);
		assert.equal(
			commitHeadRes.status,
			0,
			`--commit HEAD must materialize and execute HEAD blobs rather than dirty worktree files: ${commitHeadRes.stderr}`,
		);
	});

	it("26. [통과/정합 - 보통-N2/사소-N4 최소 env 허용목록·프로세스 그룹 종료·신뢰 경계 문서화] 의도 시험 실행 시 비허용 환경변수를 차단하고 자손 프로세스 그룹을 통째 종료하며 문서에 신뢰 경계를 명시한다", () => {
		const repoDir = path.join(tmpRoot, "case-n2-n4-env-pgid");
		initGitRepo(repoDir);
		writeFile(
			repoDir,
			"artifacts/extracted-tables.json",
			JSON.stringify({ row_parse_error_rate: 0.001, rows: [{ amount_krw: 125000 }] }, null, 2) + "\n",
		);
		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", BASE_REQ_YAML);
		writeFile(repoDir, "tests/extracted-tables-intent.test.mjs", BASE_TEST_CONTENT);
		git(repoDir, ["add", "."]);
		git(repoDir, ["commit", "-m", "initial"]);

		const bgPidFile = path.join(repoDir, "bg-grandchild.pid");
		const envAndGrandchildTest = `import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";

export function verifyExtractedTablesIntent() {
  const data = JSON.parse(fs.readFileSync("artifacts/extracted-tables.json", "utf8"));
  const row_parse_error_rate = data.row_parse_error_rate;
  const amount_krw = data.rows[0].amount_krw;
  assert.ok(row_parse_error_rate <= 0.005);
  assert.ok(amount_krw >= 0);
  assert.equal(process.env.INTENT_GUARD_LEAKED_SECRET, undefined);
  assert.equal(process.env.TZ, "UTC");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(${JSON.stringify(bgPidFile)}, String(child.pid), "utf8");
  child.unref();
}

test("minimal env and process group cleanup", () => {
  verifyExtractedTablesIntent();
});
`;
		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", UPDATED_DESIGN_REQ_YAML);
		writeFile(repoDir, "tests/extracted-tables-intent.test.mjs", envAndGrandchildTest);
		git(repoDir, [
			"add",
			".agents/requirements/REQ-001-table-schema-stage.yaml",
			"tests/extracted-tables-intent.test.mjs",
		]);

		const prevSecret = process.env.INTENT_GUARD_LEAKED_SECRET;
		const prevTz = process.env.TZ;
		process.env.INTENT_GUARD_LEAKED_SECRET = "should-not-leak";
		process.env.TZ = "America/New_York";
		let checkRes;
		try {
			checkRes = policy.checkRepositoryDesignIntent(repoDir, { mode: "staged" });
		} finally {
			if (prevSecret === undefined) delete process.env.INTENT_GUARD_LEAKED_SECRET;
			else process.env.INTENT_GUARD_LEAKED_SECRET = prevSecret;
			if (prevTz === undefined) delete process.env.TZ;
			else process.env.TZ = prevTz;
		}

		assert.equal(
			checkRes.ok,
			true,
			`Test asserting minimal env allowlist and TZ=UTC must pass: ${checkRes.reason || ""}`,
		);
		assert.ok(fs.existsSync(bgPidFile), "Grandchild pid file should have been written");
		const bgPid = Number(fs.readFileSync(bgPidFile, "utf8").trim());
		assert.ok(Number.isInteger(bgPid) && bgPid > 0);

		let bgAlive = false;
		try {
			process.kill(bgPid, 0);
			if (fs.existsSync(`/proc/${bgPid}/stat`)) {
				const statText = fs.readFileSync(`/proc/${bgPid}/stat`, "utf8");
				const stateChar = statText.slice(statText.lastIndexOf(")") + 1).trim()[0];
				bgAlive = stateChar !== "Z" && stateChar !== "X";
			} else {
				bgAlive = true;
			}
			if (bgAlive) process.kill(bgPid, "SIGKILL");
		} catch {
			bgAlive = false;
		}
		assert.equal(bgAlive, false, "Background grandchild process in test process group must be terminated");

		const guideText = fs.readFileSync(
			path.join(ROOT_DIR, "docs", "guides", "design-intent-guard.md"),
			"utf8",
		);
		assert.match(guideText, /신뢰 경계/);
		assert.match(guideText, /모르는 브랜치|시험 파일을 먼저/);
	});

	it("27. [통과 - 보통-N3 비결정적 콘솔 로그 출력 완화 및 TAP 집계 지문 검증] 시험이 시각·난수·경로 등 비결정적 console 로그를 출력해도 TAP 집계 지문으로 영수증 검증을 통과한다", () => {
		const repoDir = path.join(tmpRoot, "case-n3-noisy-console-tap");
		initGitRepo(repoDir);
		writeFile(
			repoDir,
			"artifacts/extracted-tables.json",
			JSON.stringify({ row_parse_error_rate: 0.001, rows: [{ amount_krw: 125000 }] }, null, 2) + "\n",
		);
		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", BASE_REQ_YAML);
		const noisyTestContent = `import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

export function verifyExtractedTablesIntent() {
  console.log("diagnostic timestamp:", Date.now(), Math.random(), process.pid, import.meta.url);
  const data = JSON.parse(fs.readFileSync("artifacts/extracted-tables.json", "utf8"));
  const row_parse_error_rate = data.row_parse_error_rate;
  const amount_krw = data.rows[0].amount_krw;
  assert.ok(row_parse_error_rate <= 0.005);
  assert.ok(amount_krw >= 0);
}

test("extracted table rows with diagnostic console output", () => {
  verifyExtractedTablesIntent();
});
`;
		writeFile(repoDir, "tests/extracted-tables-intent.test.mjs", noisyTestContent);
		git(repoDir, ["add", "."]);
		git(repoDir, ["commit", "-m", "initial with noisy test"]);

		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", UPDATED_DESIGN_REQ_YAML);
		const runRes = runCli(["--run-tests", "--cwd", repoDir], repoDir);
		assert.equal(runRes.status, 0, `--run-tests must succeed: ${runRes.stderr}`);

		git(repoDir, [
			"add",
			".agents/requirements/REQ-001-table-schema-stage.yaml",
			".agents/intent-receipts/REQ-001-table-schema-stage.json",
		]);

		const hookRes = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "git commit -m 'feat: noisy test with receipt should pass'" },
			},
			repoDir,
		);
		assert.equal(
			hookRes.parsed,
			null,
			`Legitimate test with console.log timestamp/random/path must not break receipt output_sha256: ${JSON.stringify(hookRes.parsed)}`,
		);
	});

	it("28. [통과/차단 - 보통-N5 make 호출 타깃 한정 레시피 전개] Makefile의 다른 타깃에 git commit이 있어도 호출된 타깃(make build)은 통과하고 커밋 타깃(make commit-target)만 차단한다", () => {
		const repoDir = path.join(tmpRoot, "case-n5-make-target-only");
		initGitRepo(repoDir);
		writeFile(
			repoDir,
			"artifacts/extracted-tables.json",
			JSON.stringify({ row_parse_error_rate: 0.001, rows: [{ amount_krw: 125000 }] }, null, 2) + "\n",
		);
		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", BASE_REQ_YAML);
		writeFile(repoDir, "tests/extracted-tables-intent.test.mjs", BASE_TEST_CONTENT);
		writeFile(
			repoDir,
			"Makefile",
			[
				".PHONY: build commit-target release",
				"build:",
				"\tnode -e \"console.log('building only')\"",
				"",
				"commit-target:",
				"\tgit commit -m 'via makefile commit-target'",
				"",
				"release: commit-target",
				"\tnode -e \"console.log('releasing')\"",
				"",
			].join("\n"),
		);
		git(repoDir, ["add", "."]);
		git(repoDir, ["commit", "-m", "initial"]);

		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", UPDATED_DESIGN_REQ_YAML);
		git(repoDir, ["add", ".agents/requirements/REQ-001-table-schema-stage.yaml"]);

		const buildRes = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "make build" },
			},
			repoDir,
		);
		assert.equal(
			buildRes.parsed,
			null,
			`make build must NOT be over-blocked when only commit-target runs git commit: ${JSON.stringify(buildRes.parsed)}`,
		);

		const defaultMakeRes = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "make" },
			},
			repoDir,
		);
		assert.equal(defaultMakeRes.parsed, null, "default make target (build) must NOT be blocked");

		const commitTargetRes = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "make commit-target" },
			},
			repoDir,
		);
		assert.equal(commitTargetRes.parsed?.decision, "block", "make commit-target must be blocked");

		const releaseTargetRes = runHook(
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: { command: "make release" },
			},
			repoDir,
		);
		assert.equal(
			releaseTargetRes.parsed?.decision,
			"block",
			"make release (depending on commit-target) must be blocked",
		);
	});

	it("29. [차단/정합 - 보통-N6/사소-N7 11필드 정규 증명 output_sha256 불일치 차단 및 공허 검사 가장자리 문서화] 11필드 정규 run_proof 위조가 output_sha256 비교에서 차단되고 문서에 리터럴 경로·상수 이름 안내가 있다", () => {
		const crypto = require("node:crypto");
		const repoDir = path.join(tmpRoot, "case-n6-n7-exact-11-field");
		initGitRepo(repoDir);
		const artifactContent =
			JSON.stringify({ row_parse_error_rate: 0.001, rows: [{ amount_krw: 125000 }] }, null, 2) + "\n";
		writeFile(repoDir, "artifacts/extracted-tables.json", artifactContent);
		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", BASE_REQ_YAML);
		const distinctConstTest = `import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

export function verifyExtractedTablesIntent() {
  const data = JSON.parse(fs.readFileSync("artifacts/extracted-tables.json", "utf8"));
  const min_amount_krw = 0;
  assert.ok(data.row_parse_error_rate <= 0.005);
  assert.ok(data.rows[0].amount_krw >= min_amount_krw);
}

test("distinct constant name min_amount_krw passes vacuous check", () => {
  verifyExtractedTablesIntent();
});
`;
		writeFile(repoDir, "tests/extracted-tables-intent.test.mjs", distinctConstTest);
		git(repoDir, ["add", "."]);
		git(repoDir, ["commit", "-m", "initial"]);

		writeFile(repoDir, ".agents/requirements/REQ-001-table-schema-stage.yaml", UPDATED_DESIGN_REQ_YAML);
		const newDoc = policy.parseRequirementDocument(UPDATED_DESIGN_REQ_YAML, "REQ-001-table-schema-stage");
		const testSha256 = crypto.createHash("sha256").update(distinctConstTest, "utf8").digest("hex");
		const artifactSha256 = crypto.createHash("sha256").update(artifactContent, "utf8").digest("hex");
		const wrongOutputSha256 = "b".repeat(64);
		const ranAt = "2026-11-08T11:55:00.000Z";
		const elevenFields = [
			"naia-adk-intent-guard-receipt-v1",
			"intent-guard-runner/v1",
			"REQ-001-table-schema-stage",
			"extracted-tables-json",
			"tests/extracted-tables-intent.test.mjs",
			newDoc.designDigest,
			testSha256,
			artifactSha256,
			"0",
			wrongOutputSha256,
			ranAt,
		];
		assert.equal(elevenFields.length, 11);
		const validProofWithWrongOutput = crypto
			.createHash("sha256")
			.update(elevenFields.join("|"), "utf8")
			.digest("hex");

		writeFile(
			repoDir,
			".agents/intent-receipts/REQ-001-table-schema-stage.json",
			JSON.stringify(
				{
					runner: "intent-guard-runner/v1",
					requirement_id: "REQ-001-table-schema-stage",
					design_sha256: newDoc.designDigest,
					ran_at: ranAt,
					status: "pass",
					artifacts: [
						{
							requirement_id: "REQ-001-table-schema-stage",
							artifact_id: "extracted-tables-json",
							path: "artifacts/extracted-tables.json",
							test_path: "tests/extracted-tables-intent.test.mjs",
							status: "pass",
							exit_code: 0,
							design_sha256: newDoc.designDigest,
							test_sha256: testSha256,
							artifact_sha256: artifactSha256,
							output_sha256: wrongOutputSha256,
							ran_at: ranAt,
							runner: "intent-guard-runner/v1",
							run_proof: validProofWithWrongOutput,
						},
					],
				},
				null,
				2,
			),
		);
		git(repoDir, [
			"add",
			".agents/requirements/REQ-001-table-schema-stage.yaml",
			".agents/intent-receipts/REQ-001-table-schema-stage.json",
		]);

		const checkRes = policy.checkRepositoryDesignIntent(repoDir, { mode: "staged" });
		assert.equal(checkRes.ok, false);
		assert.match(
			checkRes.reason || "",
			/실행 출력 지문\(output_sha256\)이 관문 직접 실행 출력과 불일치/,
		);

		const guideText = fs.readFileSync(
			path.join(ROOT_DIR, "docs", "guides", "design-intent-guard.md"),
			"utf8",
		);
		assert.match(guideText, /리터럴/);
		assert.match(guideText, /min_amount_krw|다른 이름/);
	});
});
