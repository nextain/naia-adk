#!/usr/bin/env node
/** Claude host adapter for the shared lightweight session-contract gate. */
try {
	require("../../.codex/hooks/session-contract-gate.cjs").main();
} catch (error) {
	process.stdout.write(JSON.stringify({
		decision: "block",
		reason: `[HARNESS] 세션 계약 관문을 실행하지 못해 막습니다 (fail-closed): ${error && error.message || error}`,
	}));
	process.exit(0);
}
