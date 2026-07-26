# Development model routing

The coding-process settings are separate from runtime conversation settings.
Codex Sol high performs expert design; HY3 high performs issue orchestration;
HY3 medium performs implementation and testing in separate sessions and
executions; and HY3 low is reserved for translation only.

Substantive adversarial review is a parallel Terra high plus HY3 high gate.
Translation review is a parallel Claude Haiku plus HY3 medium gate. Every
reviewer must differ in role, sessionId, and executionId from the producer it
reviews and from its peer reviewer. HY3 high may review HY3 medium output when
those three boundaries differ.

The P0 issue orchestrator is a no-runner planner/evaluator. It verifies
digest-bound receipts and configured independence, but does not start a
provider, prove runtime parallelism, or perform real approval verification.
Findings invalidate the affected generation and the evaluator rejects a fourth
rerun (`maxReruns: 3`).
