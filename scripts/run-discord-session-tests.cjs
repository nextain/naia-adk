#!/usr/bin/env node
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const expected = path.join(root, ".agents", "skills", "manage-discord-sessions", "helper", "discord-router.mjs");
if (!fs.statSync(expected, { throwIfNoEntry: false })?.isFile()) {
	process.stderr.write(`discord-test-preflight: FAIL canonical helper missing under ${root}\n`);
	process.exit(1);
}
const freeTmpInodes = process.platform === "win32"
	? null
	: Number(fs.statfsSync(require("node:os").tmpdir()).ffree);
const minimumFreeInodes = Number(process.env.DISCORD_TEST_MIN_FREE_INODES ?? 10_000);
if (!Number.isSafeInteger(minimumFreeInodes) || minimumFreeInodes < 1) {
	process.stderr.write("discord-test-preflight: FAIL invalid DISCORD_TEST_MIN_FREE_INODES\n");
	process.exit(1);
}
if (freeTmpInodes !== null && freeTmpInodes < minimumFreeInodes) {
	process.stderr.write(`discord-test-preflight: FAIL tmp_free_inodes=${freeTmpInodes} required=${minimumFreeInodes}\n`);
	process.exit(1);
}
const revision = cp.spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
if (revision.status !== 0 || !/^[a-f0-9]{40}$/.test(revision.stdout.trim())) {
	process.stderr.write("discord-test-preflight: FAIL canonical Git revision unavailable\n");
	process.exit(1);
}
process.stdout.write(`discord-test-context root=${root} revision=${revision.stdout.trim()} node=${process.execPath} tmp_free_inodes=${freeTmpInodes ?? "not_reported"}\n`);
const testsDirectory = path.join(root, ".agents", "skills", "manage-discord-sessions", "tests");
const testFiles = fs.readdirSync(testsDirectory).filter((name) => name.endsWith(".test.mjs")).sort().map((name) => path.join(testsDirectory, name));
if (process.platform === "win32") {
	const perFileTimeoutMs = Number(process.env.DISCORD_TEST_FILE_TIMEOUT_MS ?? 300_000);
	if (!Number.isSafeInteger(perFileTimeoutMs) || perFileTimeoutMs < 1_000) {
		process.stderr.write("discord-test-runner: FAIL invalid DISCORD_TEST_FILE_TIMEOUT_MS\n");
		process.exit(1);
	}
	const runIsolated = (testFile) => new Promise((resolve) => {
		const testLabel = path.basename(testFile);
		const isBackendRunnerContract = testLabel === "backend-runner.test.mjs";
		const skipRepeatedAcl = isBackendRunnerContract
			? "backend-runner-only"
			: testLabel === "discord-cutover-rollback.test.mjs"
				? "cutover-rollback-only"
				: null;
		const testArguments = ["--test", "--test-force-exit"];
		if (isBackendRunnerContract) testArguments.push("--test-concurrency=4");
		testArguments.push(testFile);
		const child = cp.spawn(process.execPath, testArguments, {
			cwd: root,
			stdio: "inherit",
			windowsHide: true,
			env: skipRepeatedAcl
				? { ...process.env, NAIA_DISCORD_TEST_SKIP_ACL: skipRepeatedAcl }
				: process.env,
		});
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
			cp.spawnSync(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
				timeout: 10_000,
			});
			child.kill("SIGKILL");
		}, perFileTimeoutMs);
		child.once("error", (error) => {
			clearTimeout(timer);
			resolve({ ok: false, reason: error.message });
		});
		child.once("close", (status) => {
			clearTimeout(timer);
			resolve({
				ok: !timedOut && status === 0,
				reason: timedOut
					? `timeout_after_${perFileTimeoutMs}ms`
					: `exit_${status ?? "unknown"}`,
			});
		});
	});
	void (async () => {
		const failures = [];
		for (const testFile of testFiles) {
			const label = path.basename(testFile);
			process.stdout.write(`discord-test-file: START ${label}\n`);
			const isolated = await runIsolated(testFile);
			if (!isolated.ok) {
				process.stderr.write(`discord-test-file: FAIL ${label} ${isolated.reason}\n`);
				failures.push(`${label}:${isolated.reason}`);
				continue;
			}
			process.stdout.write(`discord-test-file: PASS ${label}\n`);
		}
		if (failures.length > 0) {
			process.stderr.write(`discord-test-runner: FAIL ${failures.join(",")}\n`);
			process.exitCode = 1;
			return;
		}
		process.stdout.write(`discord-test-runner: PASS ${testFiles.length} isolated files\n`);
	})();
} else {
	const result = cp.spawnSync(process.execPath, ["--test", "--test-concurrency=4", ...testFiles], {
		cwd: root,
		stdio: "inherit",
	});
	if (result.error) {
		process.stderr.write(`discord-test-runner: FAIL ${result.error.message}\n`);
		process.exit(1);
	}
	process.exit(result.status ?? 1);
}
