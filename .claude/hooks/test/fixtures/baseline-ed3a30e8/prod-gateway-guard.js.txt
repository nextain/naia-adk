#!/usr/bin/env node
/**
 * Prod Gateway Guard Hook (PreToolUse on Edit|Write) — Claude adapter.
 * Envelope: ./_claude-edit-hook.js. Policy: shared tool-agnostic
 * .agents/hooks/policies/edit.js → prodGateway (also used by pi adapter).
 * Behavior byte-identical (G-OC01 part2, pure refactor).
 */
const path = require("path");
let H, P;
try {
	H = require("./_claude-edit-hook.js");
	P = require(path.join(__dirname, "..", "..", ".agents", "hooks", "policies", "edit.js"));
} catch {
	process.exit(0); // original main().catch fail-open
}

H.start((data) => P.prodGateway(data));
