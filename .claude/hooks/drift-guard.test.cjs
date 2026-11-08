require("../../scripts/test-signal-safety.cjs");
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

	it("P1-1 & P1-2: blocks uncommitted scripts in artifact_script_dirs even without CLI artifact tokens or when output is a variable, and allows committed scripts", () => {
		const untrackedInService = path.join(repoDir, "naia-labs", "avatar", "service", "manual_bake.py");
		const buildDir = path.join(repoDir, "scripts", "build-Avatar");
		fs.mkdirSync(buildDir, { recursive: true });
		const untrackedInBuild = path.join(buildDir, "pack.py");
		fs.writeFileSync(untrackedInService, "open('char-scale085.nva','wb').write(b'x')\n", "utf8");
		fs.writeFileSync(untrackedInBuild, "print('pack')\n", "utf8");
		try {
			for (const cmd of [
				"python naia-labs/avatar/service/manual_bake.py",
				"python naia-labs/avatar/service/manual_bake.py $OUT",
				"OUT=a.nva; python naia-labs/avatar/service/manual_bake.py $OUT",
				"EXT=nva; OUT=char.$EXT; python scripts/build-Avatar/pack.py $OUT",
				"python scripts/build-Avatar/pack.py",
			]) {
				const res = runHook(
					ARTIFACT_GUARD,
					{ cwd: repoDir, tool_name: "Bash", tool_input: { command: cmd } },
					repoDir,
				);
				assert.equal(res.parsed?.decision, "block", `expected block for: ${cmd}`);
			}

			for (const allowCmd of [
				"python naia-labs/avatar/service/stream_render.py",
				"python naia-labs/avatar/service/stream_render.py $OUT",
				"OUT=a.nva; python naia-labs/avatar/service/stream_render.py $OUT",
			]) {
				const res = runHook(
					ARTIFACT_GUARD,
					{ cwd: repoDir, tool_name: "Bash", tool_input: { command: allowCmd } },
					repoDir,
				);
				assert.equal(res.parsed, null, `expected allow for committed script: ${allowCmd}`);
			}
		} finally {
			fs.rmSync(untrackedInService, { force: true });
			fs.rmSync(buildDir, { recursive: true, force: true });
		}
	});

	it("P1-4 & P1-5: unwraps (), {}, env, sudo, nohup, time, xargs, find -exec and blocks stdin pipes (| bash, | sh, | python) with artifact tokens", () => {
		const untracked = path.join(repoDir, "naia-labs", "avatar", "service", "manual_bake.py");
		fs.writeFileSync(untracked, "print('bake')\n", "utf8");
		try {
			const shouldBlock = [
				"(python naia-labs/avatar/service/manual_bake.py char-scale085.nva)",
				"{ python naia-labs/avatar/service/manual_bake.py char-scale085.nva; }",
				"(cd naia-labs/avatar/service && python manual_bake.py)",
				"env FOO=1 sudo -u root nohup time python naia-labs/avatar/service/manual_bake.py char-scale085.nva",
				'echo "python naia-labs/avatar/service/manual_bake.py char-scale085.nva" | bash',
				'echo "open(\'char-scale085.nva\',\'wb\')" | sh',
				'printf "open(\'char-scale085.nva\',\'wb\')" | python3',
				"echo naia-labs/avatar/service/manual_bake.py | xargs -I{} python {} char-scale085.nva",
				"find naia-labs -name manual_bake.py -exec python {} char-scale085.nva \\;",
			];
			for (const cmd of shouldBlock) {
				const res = runHook(
					ARTIFACT_GUARD,
					{ cwd: repoDir, tool_name: "Bash", tool_input: { command: cmd } },
					repoDir,
				);
				assert.equal(res.parsed?.decision, "block", `expected block for: ${cmd}`);
			}

			const shouldAllow = [
				"(python naia-labs/avatar/service/stream_render.py char-scale085.nva)",
				"{ python naia-labs/avatar/service/stream_render.py char-scale085.nva; }",
				"env FOO=1 sudo nohup time python naia-labs/avatar/service/stream_render.py char-scale085.nva",
				'echo "echo hello" | bash',
				"echo naia-labs/avatar/service/stream_render.py | xargs -I{} python {} char-scale085.nva",
				"find naia-labs/avatar/service -name stream_render.py -exec python {} char-scale085.nva \\;",
			];
			for (const cmd of shouldAllow) {
				const res = runHook(
					ARTIFACT_GUARD,
					{ cwd: repoDir, tool_name: "Bash", tool_input: { command: cmd } },
					repoDir,
				);
				assert.equal(res.parsed, null, `expected allow for: ${cmd}`);
			}
		} finally {
			fs.rmSync(untracked, { force: true });
		}
	});

	it("P1-8: blocks python -c and node -e inline code when command contains an artifact token, and allows without artifact tokens", () => {
		for (const cmd of [
			"python -c \"open('char-scale085.nva','wb').write(bake())\"",
			"python3 -c \"import pathlib; pathlib.Path('out.nva').write_bytes(b'1')\"",
			"node -e \"require('fs').writeFileSync('setup.exe', 'x')\"",
		]) {
			const res = runHook(
				ARTIFACT_GUARD,
				{ cwd: repoDir, tool_name: "Bash", tool_input: { command: cmd } },
				repoDir,
			);
			assert.equal(res.parsed?.decision, "block", `expected block for inline: ${cmd}`);
		}

		for (const allowCmd of [
			'python -c "import sys; print(sys.version)"',
			'node -e "console.log(1 + 1)"',
		]) {
			const res = runHook(
				ARTIFACT_GUARD,
				{ cwd: repoDir, tool_name: "Bash", tool_input: { command: allowCmd } },
				repoDir,
			);
			assert.equal(res.parsed, null, `expected allow for inline: ${allowCmd}`);
		}
	});

	it("P1-3: blocks cp/mv/ln/install/rsync to an artifact extension when source is uncommitted, and allows when source is committed", () => {
		const committedNva = path.join(repoDir, "committed-base.nva");
		fs.writeFileSync(committedNva, "base-nva\n", "utf8");
		git(repoDir, ["add", "committed-base.nva"]);
		git(repoDir, ["commit", "-m", "add committed nva"]);

		const untrackedBin = path.join(repoDir, "tmp.bin");
		const untrackedNva = path.join(repoDir, "char-scale085.nva");
		fs.writeFileSync(untrackedBin, "raw\n", "utf8");
		fs.writeFileSync(untrackedNva, "nva\n", "utf8");
		try {
			for (const cmd of [
				"mv tmp.bin char-scale085.nva",
				"cp char-scale085.nva char-scale082.nva",
				"ln -s tmp.bin linked.nva",
				"install -m 644 tmp.bin dist/app.exe",
				"rsync -a tmp.bin synced.nva",
			]) {
				const res = runHook(
					ARTIFACT_GUARD,
					{ cwd: repoDir, tool_name: "Bash", tool_input: { command: cmd } },
					repoDir,
				);
				assert.equal(res.parsed?.decision, "block", `expected block for transfer: ${cmd}`);
			}

			for (const allowCmd of [
				"cp committed-base.nva committed- copy.nva",
				"mv tmp.bin notes.txt",
			]) {
				const res = runHook(
					ARTIFACT_GUARD,
					{ cwd: repoDir, tool_name: "Bash", tool_input: { command: allowCmd } },
					repoDir,
				);
				assert.equal(res.parsed, null, `expected allow for transfer: ${allowCmd}`);
			}
		} finally {
			fs.rmSync(untrackedBin, { force: true });
			fs.rmSync(untrackedNva, { force: true });
		}
	});

	it("P2-1: python -m does not misidentify subsequent arguments (like tests/ or out.nva) as a script when module is external, while still checking local modules", () => {
		const testsDir = path.join(repoDir, "tests");
		fs.mkdirSync(testsDir, { recursive: true });
		const testFile = path.join(testsDir, "test_sample.py");
		fs.writeFileSync(testFile, "def test_ok(): pass\n", "utf8");
		git(repoDir, ["add", "tests/test_sample.py"]);
		git(repoDir, ["commit", "-m", "add test"]);
		// Modify file inside tests/ so tests/ has uncommitted changes
		fs.writeFileSync(testFile, "def test_ok(): assert True\n", "utf8");

		const localPkgDir = path.join(repoDir, "localpkg");
		fs.mkdirSync(localPkgDir, { recursive: true });
		const localUntrackedMod = path.join(localPkgDir, "baker.py");
		fs.writeFileSync(localUntrackedMod, "print('local baker')\n", "utf8");

		try {
			for (const allowCmd of [
				"python -m pytest tests/ --junitxml=r.nva",
				"python -m installed_external_pkg out.nva",
				"python3 -m unittest discover -s tests",
			]) {
				const res = runHook(
					ARTIFACT_GUARD,
					{ cwd: repoDir, tool_name: "Bash", tool_input: { command: allowCmd } },
					repoDir,
				);
				assert.equal(res.parsed, null, `expected allow for external -m: ${allowCmd}`);
			}

			const blockedLocalMod = runHook(
				ARTIFACT_GUARD,
				{
					cwd: repoDir,
					tool_name: "Bash",
					tool_input: { command: "python -m localpkg.baker --out char.nva" },
				},
				repoDir,
			);
			assert.equal(blockedLocalMod.parsed?.decision, "block");
		} finally {
			git(repoDir, ["checkout", "--", "tests/test_sample.py"]);
			fs.rmSync(localPkgDir, { recursive: true, force: true });
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

	it("P1-6: blocks NotebookEdit and MultiEdit when creating variant copy files, and allows editing existing files", () => {
		const settingsPath = path.resolve(HOOKS_DIR, "..", "settings.json");
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
		const copyGroup = (settings.hooks?.PreToolUse || []).find((g) =>
			(g.hooks || []).some((h) => (h.command || "").includes("copy-file-guard.js")),
		);
		assert.ok(copyGroup, "copy-file-guard.js must be registered in PreToolUse");
		assert.match(copyGroup.matcher || "", /NotebookEdit/);
		assert.match(copyGroup.matcher || "", /MultiEdit/);

		const nbBlock = runHook(
			COPY_FILE_GUARD,
			{
				cwd: tmpDir,
				tool_name: "NotebookEdit",
				tool_input: {
					notebook_path: path.join(tmpDir, "stream_render_v2.py"),
					new_source: "print('v2')",
				},
			},
			tmpDir,
		);
		assert.equal(nbBlock.parsed?.decision, "block");
		assert.match(nbBlock.parsed?.reason || "", /원래 파일을 고치세요/);

		const multiBlock = runHook(
			COPY_FILE_GUARD,
			{
				cwd: tmpDir,
				tool_name: "MultiEdit",
				tool_input: {
					file_path: path.join(tmpDir, "foo_v2.ts"),
					edits: [{ old_string: "", new_string: "export const x = 1;" }],
				},
			},
			tmpDir,
		);
		assert.equal(multiBlock.parsed?.decision, "block");
		assert.match(multiBlock.parsed?.reason || "", /원래 파일을 고치세요/);

		const nbAllowExisting = runHook(
			COPY_FILE_GUARD,
			{
				cwd: tmpDir,
				tool_name: "NotebookEdit",
				tool_input: {
					notebook_path: path.join(tmpDir, "stream_render.py"),
					new_source: "print('updated')",
				},
			},
			tmpDir,
		);
		assert.equal(nbAllowExisting.parsed, null);

		const multiAllowExisting = runHook(
			COPY_FILE_GUARD,
			{
				cwd: tmpDir,
				tool_name: "MultiEdit",
				tool_input: {
					file_path: path.join(tmpDir, "foo.ts"),
					edits: [{ old_string: "// original", new_string: "// edited" }],
				},
			},
			tmpDir,
		);
		assert.equal(multiAllowExisting.parsed, null);
	});

	it("P1-7: blocks Bash cp/mv/ln/install/rsync when target is a variant copy of a sibling code file, and allows non-variant targets", () => {
		for (const cmd of [
			"cp foo.ts foo_v2.ts",
			"cp stream_render.py stream_render_copy.py",
			"mv scratch.py stream_render_v2.py",
			"ln -s foo.ts foo_backup.ts",
			"install foo.ts foo_new.ts",
			"rsync foo.ts foo2.ts",
		]) {
			const res = runHook(
				ARTIFACT_GUARD,
				{ cwd: tmpDir, tool_name: "Bash", tool_input: { command: cmd } },
				tmpDir,
			);
			assert.equal(res.parsed?.decision, "block", `expected block for Bash copy: ${cmd}`);
			assert.match(res.parsed?.reason || "", /원래 파일을 고치세요/);
		}

		for (const allowCmd of [
			"cp foo.ts test_foo.ts",
			"cp foo.ts completely_different.ts",
		]) {
			const res = runHook(
				ARTIFACT_GUARD,
				{ cwd: tmpDir, tool_name: "Bash", tool_input: { command: allowCmd } },
				tmpDir,
			);
			assert.equal(res.parsed, null, `expected allow for Bash copy: ${allowCmd}`);
		}
	});

	it("P2-2: allows canonical numeric names (oauth2, http2, md5, sha256, base64, utf8, i18n, k8s) even when base or sibling files exist, while still blocking _v2/_copy of them", () => {
		const baseFiles = ["oauth.py", "http.go", "md.ts", "sha.py", "sha512.py", "base.ts", "utf.py"];
		for (const f of baseFiles) {
			fs.writeFileSync(path.join(tmpDir, f), "// base\n", "utf8");
		}
		try {
			const canonicalAllowed = [
				"oauth2.py",
				"http2.go",
				"md5.ts",
				"sha256.py",
				"base64.ts",
				"utf8.py",
				"i18n.ts",
				"k8s.ts",
			];
			for (const name of canonicalAllowed) {
				const res = runHook(
					COPY_FILE_GUARD,
					{
						cwd: tmpDir,
						tool_name: "Write",
						tool_input: { file_path: path.join(tmpDir, name), content: "// canonical\n" },
					},
					tmpDir,
				);
				assert.equal(res.parsed, null, `expected canonical name ${name} to be allowed`);
			}

			// If oauth2.py exists, creating oauth2_v2.py must still be blocked
			fs.writeFileSync(path.join(tmpDir, "oauth2.py"), "# oauth2\n", "utf8");
			const blockedVariant = runHook(
				COPY_FILE_GUARD,
				{
					cwd: tmpDir,
					tool_name: "Write",
					tool_input: { file_path: path.join(tmpDir, "oauth2_v2.py"), content: "# v2\n" },
				},
				tmpDir,
			);
			assert.equal(blockedVariant.parsed?.decision, "block");
		} finally {
			for (const f of [...baseFiles, "oauth2.py"]) {
				fs.rmSync(path.join(tmpDir, f), { force: true });
			}
		}
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

	it("P3: deduplicates symlinked repositories under projects/* and respects custom code_extensions and per-repo artifact_script_dirs in drift-guard.json", () => {
		const linkPath = path.join(wsDir, "projects", "avatar-studio-link");
		try {
			fs.symlinkSync(path.join(wsDir, "projects", "avatar-studio"), linkPath, "dir");
			const { discoverRepositories } = require(STALE_SCRIPT);
			const repos = discoverRepositories(wsDir);
			const names = repos.map((r) => r.name);
			assert.equal(
				names.filter((n) => n.startsWith("projects/avatar-studio")).length,
				1,
				"symlinked duplicate repository should be deduplicated",
			);
		} finally {
			fs.rmSync(linkPath, { force: true });
		}

		// Test per-repo artifact_script_dirs and code_extensions via .agents/context/drift-guard.json
		const ctxDir = path.join(wsDir, ".agents", "context");
		fs.mkdirSync(ctxDir, { recursive: true });
		fs.writeFileSync(
			path.join(ctxDir, "drift-guard.json"),
			JSON.stringify({
				artifact_script_dirs: ["custom-exporter/**"],
				code_extensions: [".lua"],
			}),
			"utf8",
		);
		const expDir = path.join(wsDir, "custom-exporter", "bin");
		fs.mkdirSync(expDir, { recursive: true });
		const untrackedExporter = path.join(expDir, "export.py");
		fs.writeFileSync(untrackedExporter, "print('export')\n", "utf8");
		fs.writeFileSync(path.join(wsDir, "mod.lua"), "-- lua\n", "utf8");
		try {
			const blockScript = runHook(
				ARTIFACT_GUARD,
				{
					cwd: wsDir,
					tool_name: "Bash",
					tool_input: { command: "python custom-exporter/bin/export.py" },
				},
				wsDir,
			);
			assert.equal(blockScript.parsed?.decision, "block");

			const blockLuaCopy = runHook(
				COPY_FILE_GUARD,
				{
					cwd: wsDir,
					tool_name: "Write",
					tool_input: { file_path: path.join(wsDir, "mod_v2.lua"), content: "-- v2\n" },
				},
				wsDir,
			);
			assert.equal(blockLuaCopy.parsed?.decision, "block");
		} finally {
			fs.rmSync(path.join(wsDir, ".agents"), { recursive: true, force: true });
			fs.rmSync(path.join(wsDir, "custom-exporter"), { recursive: true, force: true });
			fs.rmSync(path.join(wsDir, "mod.lua"), { force: true });
		}
	});
});
