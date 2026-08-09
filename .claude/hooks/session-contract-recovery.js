#!/usr/bin/env node

/** Claude host adapter for orphan-contract lease and reclaim approval events. */
try {
	const recovery = require("../../.agents/harness/session-contract-recovery.cjs");
	recovery.handleEvent(process.argv[2]);
} catch (error) {
	// Lifecycle recovery is observational here. A reclaim itself remains
	// fail-closed in the explicit CLI and the mutation gate.
	process.stderr.write(`[HARNESS recovery] ${error.message}\n`);
}
