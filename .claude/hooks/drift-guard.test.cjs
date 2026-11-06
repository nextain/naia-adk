"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const HOOKS_DIR = __dirname;
const ARTIFACT_GUARD = path.join(HOOKS_DIR, "artifact-drift-guard.js");
const COPY_FILE_GUARD = path.join(HOOKS_DIR, "copy-file-guard.js");
const STALE_NOTICE_HOOK = path.join(HOOKS_DIR, "stale-uncommitted-notice.js");
const STALE_SCRIPT = path.resolve(HOOKS_DIR, "..", "..", "scripts", "check-stale-uncommitted.cjs");

function runHook(hookPath, payload, cwd) {
	const res = spawnSync(process.execPath, [hookPath], {
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
	git(dir, ["init"]);
	git(dir, ["config", "user.email", "test@example.com"]);
	git(dir, ["config", "user.name", "Test User"]);
}

describe("1. Artifact Gate (artifact-drift-guard.js)", () => {
	let tmpRoot;
	let repoDir;
	let outsideScript;

	before(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "naia-drift-artifact-"));
		repoDir = path.join(tmpRoot, "repo");
		initGitRepo(repoDir);

		const serviceDir = path.join(repoDir, "naia-labs", "avatar", "service");
		fs.mkdirSync(serviceDir, { recursive: true });
		const renderScript = path.join(serviceDir, "stream_render.py");
		fs.writeFileSync(renderScript, "print('render v1')\n", "utf8");
		git(repoDir, ["add", "naia-labs/avatar/service/stream_render.py"]);
		git(repoDir, ["commit", "-m", "initial commit"]);

		outsideScript = path.join(tmpRoot, "outside_render.py");
		fs.writeFileSync(outsideScript, "print('outside')\n", "utf8");
	});

	after(() => {
		if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("allows generating .nva from a committed and clean script", () => {
		const res = runHook(
			ARTIFACT_GUARD,
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: {
					command: "python naia-labs/avatar/service/stream_render.py --out char-scale085.nva",
				},
			},
			repoDir,
		);
		assert.equal(res.status, 0);
		assert.equal(res.parsed, null);
	});

	it("allows non-artifact commands even when the script is uncommitted", () => {
		const untrackedScript = path.join(repoDir, "scratch_check.py");
		fs.writeFileSync(untrackedScript, "print('check')\n", "utf8");
		try {
			const res = runHook(
				ARTIFACT_GUARD,
				{
					cwd: repoDir,
					tool_name: "Bash",
					tool_input: {
						command: "python scratch_check.py --out output.json",
					},
				},
				repoDir,
			);
			assert.equal(res.status, 0);
			assert.equal(res.parsed, null);
		} finally {
			fs.rmSync(untrackedScript, { force: true });
		}
	});

	it("blocks generating .nva when a tracked script has uncommitted modifications", () => {
		const renderScript = path.join(repoDir, "naia-labs", "avatar", "service", "stream_render.py");
		const original = fs.readFileSync(renderScript, "utf8");
		fs.writeFileSync(renderScript, original + "# scale=0.85\n", "utf8");
		try {
			const res = runHook(
				ARTIFACT_GUARD,
				{
					cwd: repoDir,
					tool_name: "Bash",
					tool_input: {
						command: "python naia-labs/avatar/service/stream_render.py --out char-scale085.nva",
					},
				},
				repoDir,
			);
			assert.equal(res.parsed?.decision, "block");
			assert.match(
				res.parsed?.reason || "",
				/커밋 안 된 대본으로 산출물을 만들 수 없습니다\. 공통 코드에 고쳐 가지에 커밋하고 PR 로 올린 뒤 실행하세요\./,
			);
		} finally {
			fs.writeFileSync(renderScript, original, "utf8");
		}
	});

	it("blocks generating .nva from an untracked script inside the git repository", () => {
		const untracked = path.join(repoDir, "naia-labs", "avatar", "service", "manual_bake.py");
		fs.writeFileSync(untracked, "print('bake')\n", "utf8");
		try {
			const res = runHook(
				ARTIFACT_GUARD,
				{
					cwd: repoDir,
					tool_name: "Bash",
					tool_input: {
						command: "uv run naia-labs/avatar/service/manual_bake.py char-bust.nva",
					},
				},
				repoDir,
			);
			assert.equal(res.parsed?.decision, "block");
			assert.match(
				res.parsed?.reason || "",
				/커밋 안 된 대본으로 산출물을 만들 수 없습니다\. 공통 코드에 고쳐 가지에 커밋하고 PR 로 올린 뒤 실행하세요\./,
			);
		} finally {
			fs.rmSync(untracked, { force: true });
		}
	});

	it("blocks generating .nva from a script outside the git repository (/tmp)", () => {
		const res = runHook(
			ARTIFACT_GUARD,
			{
				cwd: repoDir,
				tool_name: "Bash",
				tool_input: {
					command: `python ${outsideScript} --out char-long.nva`,
				},
			},
			repoDir,
		);
		assert.equal(res.parsed?.decision, "block");
		assert.match(
			res.parsed?.reason || "",
			/커밋 안 된 대본으로 산출물을 만들 수 없습니다\. 공통 코드에 고쳐 가지에 커밋하고 PR 로 올린 뒤 실행하세요\./,
		);
	});

	it("supports configuring artifact extensions via .agents/context/drift-guard.json", () => {
		const ctxDir = path.join(repoDir, ".agents", "context");
		fs.mkdirSync(ctxDir, { recursive: true });
		const cfgFile = path.join(ctxDir, "drift-guard.json");
		fs.writeFileSync(
			cfgFile,
			JSON.stringify({ artifact_extensions: [".custombundle"] }),
			"utf8",
		);
		const untracked = path.join(repoDir, "bundle_gen.js");
		fs.writeFileSync(untracked, "console.log('bundle');\n", "utf8");
		try {
			const blocked = runHook(
				ARTIFACT_GUARD,
				{
					cwd: repoDir,
					tool_name: "Bash",
					tool_input: {
						command: "node bundle_gen.js dist/out.custombundle",
					},
				},
				repoDir,
			);
			assert.equal(blocked.parsed?.decision, "block");
		} finally {
			fs.rmSync(untracked, { force: true });
			fs.rmSync( path.join(repoDir, ".agents"), { recursive: true, force: true });
		}
	});
});

describe("2. Copy-File Gate (copy-file-guard.js)", () => {
	let tmpDir;

	before(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "naia-drift-copy-"));
		fs.writeFileSync(path.join(tmpDir, "stream_render.py"), "# original\n", "utf8");
		fs.writeFileSync(path.join(tmpDir, "foo.ts"), "// original\n", "utf8");
		fs.writeFileSync(path.join(tmpDir, "render_085.py"), "# scale 085\n", "utf8");
		fs.mkdirSync(path.join(tmpDir, "migrations"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "migrations", "001_init.py"), "# migration 1\n", "utf8");
	});

	after(() => {
		if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("blocks creating stream_render_v2.py when stream_render.py exists in the same folder", () => {
		const target = path.join(tmpDir, "stream_render_v2.py");
		const res = runHook(
			COPY_FILE_GUARD,
			{
				cwd: tmpDir,
				tool_name: "Write",
				tool_input: { file_path: target, content: "# v2\n" },
			},
			tmpDir,
		);
		assert.equal(res.parsed?.decision, "block");
		assert.match(res.parsed?.reason || "", /원래 파일을 고치세요/);
	});

	it("blocks creating foo-copy.ts and other variant suffixes (_new, _old, _backup, _fixed, _final, -v3, ' (1)', number-only)", () => {
		const variants = [
			"foo-copy.ts",
			"foo_copy.ts",
			"foo-v3.ts",
			"foo_new.ts",
			"foo_old.ts",
			"foo_backup.ts",
			"foo_fixed.ts",
			"foo_final.ts",
			"foo (1).ts",
			"foo2.ts",
			"render_082.py",
		];
		for (const name of variants) {
			const res = runHook(
				COPY_FILE_GUARD,
				{
					cwd: tmpDir,
					tool_name: "Write",
					tool_input: { file_path: path.join(tmpDir, name), content: "// copy\n" },
				},
				tmpDir,
			);
			assert.equal(res.parsed?.decision, "block", `expected ${name} to be blocked`);
			assert.match(res.parsed?.reason || "", /원래 파일을 고치세요/);
		}
	});

	it("allows editing an existing file (stream_render.py or foo.ts)", () => {
		const res = runHook(
			COPY_FILE_GUARD,
			{
				cwd: tmpDir,
				tool_name: "Edit",
				tool_input: {
					file_path: path.join(tmpDir, "stream_render.py"),
					old_string: "# original",
					new_string: "# updated",
				},
			},
			tmpDir,
		);
		assert.equal(res.status, 0);
		assert.equal(res.parsed, null);
	});

	it("allows creating test files (test_foo.py, foo.test.ts, foo_test.py)", () => {
		for (const testName of ["test_foo.py", "test_stream_render.py", "foo.test.ts", "stream_render_test.py"]) {
			const res = runHook(
				COPY_FILE_GUARD,
				{
					cwd: tmpDir,
					tool_name: "Write",
					tool_input: { file_path: path.join(tmpDir, testName), content: "# test\n" },
				},
				tmpDir,
			);
			assert.equal(res.status, 0);
			assert.equal(res.parsed, null, `expected test file ${testName} to be allowed`);
		}
	});

	it("allows creating files inside migrations/ folder", () => {
		const res = runHook(
			COPY_FILE_GUARD,
			{
				cwd: tmpDir,
				tool_name: "Write",
				tool_input: {
					file_path: path.join(tmpDir, "migrations", "002_init.py"),
					content: "# migration 2\n",
				},
			},
			tmpDir,
		);
		assert.equal(res.status, 0);
		assert.equal(res.parsed, null);
	});
});

describe("3. Stale Uncommitted Changes Notice (check-stale-uncommitted.cjs & stale-uncommitted-notice.js)", () => {
	let wsDir;

	before(() => {
		wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "naia-drift-stale-"));
		initGitRepo(wsDir);
		fs.writeFileSync(path.join(wsDir, "README.md"), "# ws\n", "utf8");
		git(wsDir, ["add", "README.md"]);
		git(wsDir, ["commit", "-m", "init ws"]);

		const subRepo = path.join(wsDir, "projects", "avatar-studio");
		initGitRepo(subRepo);
		fs.writeFileSync(path.join(subRepo, "main.py"), "print('hi')\n", "utf8");
		git(subRepo, ["add", "main.py"]);
		git(subRepo, ["commit", "-m", "init subrepo"]);
	});

	after(() => {
		if (wsDir) fs.rmSync(wsDir, { recursive: true, force: true });
	});

	it("emits no warning when repositories have no stale uncommitted changes", () => {
		const res = runHook(STALE_NOTICE_HOOK, { cwd: wsDir }, wsDir);
		assert.equal(res.status, 0);
		assert.equal(res.parsed, null);
	});

	it("detects stale uncommitted changes (>4h) in workspace and projects/* and emits a one-line SessionStart warning", () => {
		const subFile = path.join(wsDir, "projects", "avatar-studio", "main.py");
		fs.writeFileSync(subFile, "print('modified 5 hours ago')\n", "utf8");
		const fiveHoursAgo = new Date(Date.now() - 5 * 3600 * 1000);
		fs.utimesSync(subFile, fiveHoursAgo, fiveHoursAgo);

		const scriptRes = spawnSync(process.execPath, [STALE_SCRIPT, "--root", wsDir], {
			encoding: "utf8",
		});
		assert.equal(scriptRes.status, 0);
		assert.match(scriptRes.stdout, /projects\/avatar-studio/);

		const hookRes = runHook(STALE_NOTICE_HOOK, { cwd: wsDir }, wsDir);
		assert.equal(hookRes.status, 0);
		const ctx = hookRes.parsed?.hookSpecificOutput?.additionalContext || "";
		assert.ok(ctx.length > 0, "expected SessionStart additionalContext warning");
		assert.ok(!ctx.includes("\n"), "warning must be a single line");
		assert.match(ctx, /projects\/avatar-studio/);
	});
});
