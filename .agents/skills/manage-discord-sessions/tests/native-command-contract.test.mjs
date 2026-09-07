import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { NATIVE_COMMAND_CONTRACT } from "../helper/native-command-contract.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const cli = fileURLToPath(new URL("../helper/cli.mjs", import.meta.url));

function runCli(...args) {
	return spawnSync(process.execPath, [cli, ...args], {
		cwd: root,
		encoding: "utf8",
	});
}

test("native contract is the CLI command and service action source", () => {
	const { cli } = NATIVE_COMMAND_CONTRACT;
	assert.deepEqual(cli.known_commands, [
		"status", "health-check", "jobs", "job", "watch", "logs", "monitor", "cancel", "restart",
		"amend", "submit", "history", "latest", "attachment", "reply", "service", "cutover", "artifacts",
	]);
	assert.equal(cli.known_commands.length, 18);
	assert.equal(Object.keys(cli.option_flags).length, 20);
	assert.deepEqual(cli.boolean_options, ["json", "jsonl", "events", "once", "active", "failed", "follow", "readOnly"]);
	assert.deepEqual(cli.value_options, ["adkRoot", "jobId", "instance", "channelId", "authorId", "limit", "messageId", "attachmentId", "outputPath", "expectedSha256", "contentPath"]);
	assert.deepEqual(cli.numeric_options, ["limit"]);
	assert.equal(cli.option_flags["--output"], "outputPath");
	assert.deepEqual(cli.command_options, {
		status: ["json"],
		"health-check": ["json"],
		jobs: ["json", "active", "failed", "limit"],
		job: ["json", "events"],
		watch: ["jsonl", "once", "jobId"],
		logs: ["jsonl", "follow", "jobId"],
		monitor: ["once"],
		cancel: ["json", "jobId"],
		restart: ["json", "jobId"],
		amend: ["json", "jobId", "contentPath"],
		submit: ["json", "channelId", "authorId", "contentPath", "readOnly"],
		history: ["json", "channelId", "authorId", "limit"],
		latest: ["json", "channelId", "authorId", "limit"],
		attachment: ["json", "channelId", "messageId", "attachmentId", "outputPath", "expectedSha256"],
		reply: ["json", "channelId", "contentPath"],
		service: ["json"],
		cutover: ["json", "jobId"],
		artifacts: ["json"],
	});
	assert.deepEqual(cli.positional_arity, { job: 2, service: 2, cutover: 2, artifacts: 2 });
	assert.deepEqual(cli.actions, {
		service: ["status", "start", "stop", "restart", "install", "enable", "disable", "unit"],
		cutover: ["prepare", "verify", "canary", "rollback"],
		artifacts: ["list", "prune"],
	});
	assert.deepEqual(NATIVE_COMMAND_CONTRACT.readonly_commands, [
		"status", "health-check", "jobs", "job", "watch", "logs", "monitor", "history", "latest", "artifacts list",
	]);
	assert.deepEqual(NATIVE_COMMAND_CONTRACT.service_commands, [
		"service status", "service start", "service stop", "service restart", "service install",
		"service enable", "service disable", "service unit",
	]);
	assert.deepEqual(NATIVE_COMMAND_CONTRACT.cutover_commands, [
		"cutover prepare", "cutover verify", "cutover canary", "cutover rollback",
	]);
});

test("CLI rejects options and service actions absent from the shared contract", () => {
	const unknownOption = runCli("status", "--contract-drift");
	assert.equal(unknownOption.status, 2);
	assert.match(unknownOption.stderr, /unknown option/);

	const unknownServiceAction = runCli("service", "contract-drift");
	assert.equal(unknownServiceAction.status, 2);
	assert.match(unknownServiceAction.stderr, /service requires/);

	const prototypeOption = runCli("status", "--toString");
	assert.equal(prototypeOption.status, 2);
	assert.match(prototypeOption.stderr, /unknown option/);
});

test("recognized service lifecycle actions reach the manager without mutating the host", () => {
	const probeRoot = mkdtempSync(join(tmpdir(), "naia-native-contract-"));
	try {
		for (const action of ["install", "enable", "disable"]) {
			const result = runCli("service", action, "--adk-root", probeRoot, "--instance", "contract-probe");
			// The empty fixture fails at the manager's missing-config/registration
			// precondition, before any host service command can run. Exit 1 proves
			// the action passed CLI validation and reached that manager branch.
			assert.equal(result.status, 1, `${action} should reach the service manager`);
			assert.doesNotMatch(result.stderr, /service requires|unknown option|invalid arguments/i);
		}
	} finally {
		rmSync(probeRoot, { recursive: true, force: true });
	}
});

test("contract module remains a side-effect-free source surface", () => {
	const source = readFileSync(new URL("../helper/native-command-contract.mjs", import.meta.url), "utf8");
	assert.doesNotMatch(source, /node:child_process|fetch\s*\(|spawn\s*\(|manageService|provider|model/i);
});
