#!/usr/bin/env node
/** Claude Code stdin/stdout adapter for the shared request-contract core. */

const path = require("path");
const adapter = require(path.join(__dirname, "..", "..", ".agents", "hooks", "core", "request-contract-adapter.js"));

async function main() {
	let raw = "";
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) raw += chunk;
	let input = {};
	try {
		input = JSON.parse(raw || "{}");
	} catch {
		input = { __parse_error: true };
	}
	const { output } = adapter.processEnvelope("claude", input, process.argv[2] || process.env.REQUEST_CONTRACT_EVENT);
	if (output) process.stdout.write(JSON.stringify(output));
}

main().catch(() => {
	process.stdout.write(JSON.stringify({ decision: "block", reason: "[request-contract:adapter_failure] Claude adapter failed closed." }));
});
