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
const freeTmpInodes = Number(fs.statfsSync(require("node:os").tmpdir()).ffree);
const minimumFreeInodes = Number(process.env.DISCORD_TEST_MIN_FREE_INODES ?? 10_000);
if (!Number.isSafeInteger(minimumFreeInodes) || minimumFreeInodes < 1) {
	process.stderr.write("discord-test-preflight: FAIL invalid DISCORD_TEST_MIN_FREE_INODES\n");
	process.exit(1);
}
if (freeTmpInodes < minimumFreeInodes) {
	process.stderr.write(`discord-test-preflight: FAIL tmp_free_inodes=${freeTmpInodes} required=${minimumFreeInodes}\n`);
	process.exit(1);
}
const revision = cp.spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
if (revision.status !== 0 || !/^[a-f0-9]{40}$/.test(revision.stdout.trim())) {
	process.stderr.write("discord-test-preflight: FAIL canonical Git revision unavailable\n");
	process.exit(1);
}
process.stdout.write(`discord-test-context root=${root} revision=${revision.stdout.trim()} node=${process.execPath} tmp_free_inodes=${freeTmpInodes}\n`);
const testsDirectory = path.join(root, ".agents", "skills", "manage-discord-sessions", "tests");
const testFiles = fs.readdirSync(testsDirectory).filter((name) => name.endsWith(".test.mjs")).sort().map((name) => path.join(testsDirectory, name));
const result = cp.spawnSync(process.execPath, ["--test", "--test-concurrency=4", ...testFiles], {
	cwd: root,
	stdio: "inherit",
});
if (result.error) {
	process.stderr.write(`discord-test-runner: FAIL ${result.error.message}\n`);
	process.exit(1);
}
process.exit(result.status ?? 1);
