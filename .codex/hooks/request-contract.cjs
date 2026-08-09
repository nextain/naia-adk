#!/usr/bin/env node
/** Codex stdin/stdout adapter for the shared request-contract core. */

const path = require("path");

let adapter = null;

function fallbackFailureOutput(eventName) {
	const message = `[request-contract:adapter_failure] Governed request-contract evaluation failed closed during ${eventName}.`;
	if (["SessionStart", "PreCompact", "PostCompact"].includes(eventName)) {
		return { continue: false, stopReason: message };
	}
	return { decision: "block", reason: message };
}

function failureOutput(eventName) {
	if (adapter && typeof adapter.failureOutput === "function") {
		return adapter.failureOutput("codex", eventName, { code: "adapter_failure" });
	}
	return fallbackFailureOutput(eventName);
}

async function main() {
	adapter = require(path.join(__dirname, "..", "..", ".agents", "hooks", "core", "request-contract-adapter.js"));
	let raw = "";
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) raw += chunk;
	let input = {};
	try {
		input = JSON.parse(raw || "{}");
	} catch {
		input = { __parse_error: true };
	}
	const { output } = adapter.processEnvelope("codex", input, process.argv[2] || process.env.REQUEST_CONTRACT_EVENT);
	if (output) process.stdout.write(JSON.stringify(output));
}

main().catch(() => {
	const eventName = process.argv[2] || process.env.REQUEST_CONTRACT_EVENT || "Unknown";
	process.stdout.write(JSON.stringify(failureOutput(eventName)));
	process.exitCode = 0;
});
