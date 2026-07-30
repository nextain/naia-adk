# Issue #18 observability development review — 2026-07-30

Stage: development and test  
Artifact: Slice 1 observable core for DSO-001 through DSO-006  
Reviewers: independent `gpt-5.6-sol high`, two independent `gpt-5.6-terra high` reviewers

## Findings accepted and fixed

- Event kinds now enforce closed producer and payload contracts; backends cannot author lifecycle completion.
- External events require stable dedupe keys and the current attempt ID; exact old retries remain idempotent while new delayed events are rejected.
- Completion evidence is bound to current attempt and revision unless reuse was predeclared.
- Job metadata and timestamps are closed, canonical, and safe for projections.
- State paths, database, WAL, and SHM reject symlinks/owner mismatch and use private modes.
- Service and child liveness bind PID to helper-observed boot ID and process-start identity.
- Same-generation owner tuple changes and live cross-generation takeover are rejected; an observed boot boundary permits recovery.
- `recovery_review` cannot be resumed by an adapter event.
- CLI parsing is strict and does not widen a missing job scope.
- Newer SQLite schemas are rejected before PRAGMA or DDL mutation.

## Final convergence

- `gpt-5.6-sol high`: CLEAN
- `gpt-5.6-terra high` requirements/security reviewer: CLEAN
- Independent `gpt-5.6-terra high` code-security reviewer: CLEAN

## Deterministic evidence

- `pnpm test:discord-sessions`: 18/18 PASS
- `pnpm test`: PASS
- `pnpm build`: PASS (non-failing Next.js workspace-root warning only)
- DSO YAML parse, entry-point link, executable mode, diff check, and conflict-marker scan: PASS
- Event contract conformance: PASS for all 20 event kinds
- Benchmark, entry-point, context-translation, artifacts-spec, and native harness subtests: PASS except the request-contract receipt gate below
- `verify-request-contract`: expected FAIL because existing RCI receipts bind an older repository scope digest; no unrelated receipt was forged or rewritten

Slice 1 is not evidence that Discord Gateway, real Codex/Claude adapters, systemd reboot execution, or Discord projection already work. Those remain later slices.
