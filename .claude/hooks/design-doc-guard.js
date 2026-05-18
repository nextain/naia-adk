#!/usr/bin/env node
/**
 * Design Doc Guard Hook (PreToolUse on Edit|Write) — Claude adapter.
 * Envelope: ./_claude-edit-hook.js. Policy: shared tool-agnostic
 * .agents/hooks/policies/edit.js → designDoc (also used by pi adapter).
 * Unlock file is __dirname-dependent → resolved here, passed via opts
 * (byte-identical to original). (G-OC01 part2, pure refactor.)
 */
const path = require("path");
const { resolve } = require("path");
let H, P;
try {
	H = require("./_claude-edit-hook.js");
	P = require(path.join(__dirname, "..", "..", ".agents", "hooks", "policies", "edit.js"));
} catch {
	process.exit(0); // original main().catch fail-open
}

// __dirname = .claude/hooks → .claude/design-doc-unlock (identical to original)
const unlockFile = resolve(__dirname, "..", "design-doc-unlock");

H.start((data) => P.designDoc(data, { unlockFile }));
