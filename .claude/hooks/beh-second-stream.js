#!/usr/bin/env node
/**
 * BEH advisory 2nd-stream (§3.5, §6.6) — out-of-band CLI. ADVISORY ONLY.
 *
 * Reads the session ledger, builds the structured summary (counts/shapes only,
 * no source content), and — if an LLM hook is configured — produces an advisory
 * note. NEVER gates; deterministic enforcement is unaffected by this running,
 * failing, or being absent. Logic = .agents/hooks/core/beh-second-stream.js.
 *
 * Usage:  node beh-second-stream.js <cwd> <session_id>
 * (No LLM is wired by default — prints the structured summary it WOULD send.
 *  A future llmFn boundary plugs in here; the plumbing is what's tested.)
 */
const path = require("path");
const beh = require(path.join(__dirname, "..", "..", ".agents", "hooks", "core", "beh-ledger.js"));
const ss = require(path.join(__dirname, "..", "..", ".agents", "hooks", "core", "beh-second-stream.js"));

const cwd = process.argv[2] || process.cwd();
const sessionId = process.argv[3];
if (!sessionId) {
	console.error("usage: node beh-second-stream.js <cwd> <session_id>");
	process.exit(2);
}
const { ledger } = beh.behPaths(cwd, sessionId);
const events = beh.readLedger(ledger);
// llmFn = null → advisory plumbing only (structured summary). Never gates.
const result = ss.runAdvisory(events, null);
console.log(JSON.stringify({ advisory: result.advisory, summary: result.summary, gated: result.gated }, null, 2));
