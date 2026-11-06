#!/usr/bin/env node
/**
 * Copy File Guard Hook (PreToolUse on Edit|Write) — Claude adapter.
 * Envelope: ./_claude-edit-hook.js. Policy: shared tool-agnostic
 * .agents/hooks/policies/edit.js → duplicateCodeFile.
 */
const path = require("path");
let H, P;
try {
	H = require("./_claude-edit-hook.js");
	P = require(path.join(__dirname, "..", "..", ".agents", "hooks", "policies", "edit.js"));
} catch {
	process.exit(0);
}

H.start((data) => P.duplicateCodeFile(data));
