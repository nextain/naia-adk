# Issue #18 Slice 2 — Backend Adapter Review

## Scope

Codex and Claude command contracts, provider stream normalization, process ownership, child environment isolation, terminal lifecycle truthfulness, and deterministic adapter tests.

## Independent reviewers

- `gpt-5.6-sol`, high reasoning: planning/security review and post-fix implementation review.
- `gpt-5.6-terra`, high reasoning: independent code/security review.

## Findings and resolution

- Moved attempt homes and authentication copies to a private runtime directory and guaranteed cleanup on success, failure, spawn error, cancellation, timeout, parser failure, and partial preparation failure.
- Disabled provider-native transcript persistence with Codex `--ephemeral` and Claude `--no-session-persistence`; raw retention is `none`.
- Added version floors and readiness probes; authentication must be prepared before a real run.
- Added `attempt_succeeded -> result_ready` so the runner never invents Discord delivery or overall completion.
- Added POSIX process-group ownership, TERM-to-KILL escalation, PID start-identity revalidation, and a grandchild regression test.
- Bounded stream lines, drained stderr, made provider failure sticky, and removed inferred phases, false checkpoints, and unmatched Claude tool-finished events.
- Added atomic active-attempt leasing and strict job/backend equality.
- Moved the atomic attempt reservation before process spawn and added orphaned process-group cleanup after leader exit.
- Validated command options so callers cannot weaken the fixed sandbox, permission, working-directory, or setting-source boundaries.

## Verification

- `pnpm test:discord-sessions`: 35/35 passed.
- Full `pnpm test`: passed.
- Full `pnpm build`: passed.
- Contract-conformance oracle: passed.
- Benchmark contract: passed.
- Request-contract verification: expected scope-digest failure against historical review receipts; unrelated receipts were not rewritten.

## Decision

Both reviewers confirmed CLEAN with no remaining blocking or high-severity finding on the final diff.
