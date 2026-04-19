#!/usr/bin/env node
/**
 * Deploy Guard Test Runner
 *
 * Runs blocking/pass tests by invoking the hook as a subprocess
 * with proper stdin piping. Avoids the hook intercepting its own test commands.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const HOOK = path.resolve(__dirname, "..", "hooks", "deploy-guard.js");

let PASS = 0;
let FAIL = 0;

function runTest(desc, input, expectBlock, expectProject) {
	let stdout = "";
	let exitCode = 0;
	try {
		stdout = execFileSync("node", [HOOK], {
			input: JSON.stringify(input),
			encoding: "utf8",
			timeout: 5000,
		});
	} catch (e) {
		stdout = e.stdout || "";
		exitCode = e.status || 1;
	}

	if (expectBlock) {
		if (stdout.includes('"decision":"block"')) {
			if (!expectProject || stdout.includes(expectProject)) {
				console.log(`PASS: ${desc} → blocked (${expectProject || "generic"})`);
				PASS++;
			} else {
				console.log(`FAIL: ${desc} → blocked but wrong project (expected: ${expectProject})`);
				FAIL++;
			}
		} else {
			console.log(`FAIL: ${desc} → NOT blocked! stdout: ${stdout.substring(0, 100)}`);
			FAIL++;
		}
	} else {
		if (!stdout.includes('"decision":"block"') && exitCode === 0) {
			console.log(`PASS: ${desc} → passed`);
			PASS++;
		} else {
			console.log(`FAIL: ${desc} → unexpectedly blocked! stdout: ${stdout.substring(0, 100)}`);
			FAIL++;
		}
	}
}

// === Pass tests ===
runTest("vercel preview", { tool_name: "Bash", tool_input: { command: "vercel" } }, false);
runTest("vercel env ls", { tool_name: "Bash", tool_input: { command: "vercel env ls" } }, false);
runTest("gcloud dev service", { tool_name: "Bash", tool_input: { command: "gcloud run deploy naia-gateway-dev --region asia-northeast3" } }, false);
runTest("non-bash tool", { tool_name: "Edit", tool_input: { file_path: "test.js" } }, false);
runTest("echo with vercel text", { tool_name: "Bash", tool_input: { command: 'echo "run vercel --prod to deploy"' } }, false);

// === Block tests ===
runTest("vercel prod (naia)", {
	tool_name: "Bash", cwd: "/var/home/luke/dev/naia.nextain.io",
	tool_input: { command: "vercel --prod" },
}, true, "naia.nextain.io");

runTest("vercel prod (aiedu)", {
	tool_name: "Bash", cwd: "/var/home/luke/dev/aiedu.nextain.io",
	tool_input: { command: "vercel --prod" },
}, true, "aiedu.nextain.io");

runTest("vercel production (about)", {
	tool_name: "Bash", cwd: "/var/home/luke/dev/about.nextain.io",
	tool_input: { command: "vercel --production" },
}, true, "about.nextain.io");

runTest("gcloud prod gateway", {
	tool_name: "Bash", tool_input: { command: "gcloud run deploy naia-gateway --region asia-northeast3 --source ." },
}, true, "naia-gateway");

runTest("gcloud app deploy", {
	tool_name: "Bash", tool_input: { command: "gcloud app deploy" },
}, true, "gcloud");

runTest("quote evasion", {
	tool_name: "Bash", cwd: "/var/home/luke/dev/naia.nextain.io",
	tool_input: { command: "vercel '--p'r'o'd" },
}, true, "naia.nextain.io");

console.log(`\nResults: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL > 0 ? 1 : 0);
