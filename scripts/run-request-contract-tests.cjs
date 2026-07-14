#!/usr/bin/env node
/** Run the broad fault suite and the memory-isolated full client parity suite. */

const cp = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");
const suite = path.join(root, ".claude", "hooks", "test", "run-request-contract-test.js");

/** The transcript parser and the requirement trace gate the rest: a misread verdict here would license everything after it. */
const gates = [
	{ label: "review-transcript-parser", argv: [path.join(root, "scripts", "request-contract-review-transcript.cjs")] },
	{ label: "requirements-trace", argv: [path.join(root, "scripts", "validate-request-contract-requirements.cjs")] },
];
for (const gate of gates) {
	const result = cp.spawnSync(process.execPath, gate.argv, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
	if (result.error || result.status !== 0) {
		if (result.stdout) process.stderr.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		process.stderr.write(`request-contract ${gate.label}: FAIL\n`);
		process.exit(result.status || 1);
	}
	process.stdout.write(`request-contract ${gate.label}: PASS\n`);
}
const runs = [
	{ label: "fault-suite", env: { ...process.env, TEST_FILTER: "" } },
	{ label: "persisted-client-parity", env: { ...process.env, TEST_FILTER: "full persisted lifecycle" } },
];

for (const run of runs) {
	process.stdout.write(`request-contract ${run.label}: RUN\n`);
	const result = cp.spawnSync(process.execPath, [suite], { cwd: root, env: run.env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
	if (result.error || result.status !== 0) {
		if (result.stdout) process.stderr.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		process.stderr.write(`request-contract ${run.label}: FAIL\n`);
		process.exit(result.status || 1);
	}
	process.stdout.write(`request-contract ${run.label}: PASS\n`);
}

process.stdout.write("request-contract orchestrator: PASS\n");
