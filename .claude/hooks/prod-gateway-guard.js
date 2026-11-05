#!/usr/bin/env node
/**
 * Prod Gateway Guard Hook (PreToolUse on Edit|Write) — Claude adapter.
 * Envelope: ./_claude-edit-hook.js. Policy: shared tool-agnostic
 * .agents/hooks/policies/edit.js → prodGateway (also used by pi adapter).
 * Behavior byte-identical (G-OC01 part2, pure refactor).
 */
const path = require("path");
const fs = require("fs");
let H, P;
try {
	H = require("./_claude-edit-hook.js");
	P = require(path.join(__dirname, "..", "..", ".agents", "hooks", "policies", "edit.js"));
} catch {
	if (fs.existsSync(path.join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), ".naia-role.json"))) {
		process.stdout.write(JSON.stringify({ decision: "block", reason: "[Harness] Gateway policy module is unavailable (fail-closed)." }));
	}
	process.exit(0); // original main().catch fail-open
}

H.start((data) => P.prodGateway(data));
