# Issue #16 harness and benchmark checkpoint

Status: checkpoint only; benchmark optimization is not complete.

## Verified on native Windows

- Entry-point synchronization tests passed.
- Dual-context translation tests passed; Claude Haiku reported a session-limit failure and the declared fallback path passed.
- Full workspace build passed.
- Benchmark contract schema, baseline, native runner, and Codex adapter tests passed.
- Request-contract validation correctly failed closed because its historical independent-review receipts target an older tree. Refresh those receipts on the final immutable snapshot; do not weaken the gate.

## Remaining work

1. Keep Codex 5.6 Sol as the main orchestrator and final integrator.
2. Separate the model-routing benchmark from deterministic harness/runtime verification.
3. Compare bounded worker roles using Codex Terra/Luna, Azure `DeepSeek-V4-Flash`, OpenRouter `tencent/hy3`, and `upstage/Solar-Open2-250B` when credentials are available.
4. Measure quality, total billed cost or credit use, latency, retry/fallback cost, Korean dual-context fidelity, and contract compliance. A connectivity probe is not evidence of savings.
5. Keep all unvalidated external candidates disabled in production routing.
6. Obtain two independent clean adversarial reviews on the same immutable snapshot. A producer self-check never counts as review.
7. Refresh request-contract receipts, run full verification, and update issue #16.

Linux and Windows are tested natively and independently. Windows support must not acquire a WSL, Bash, VM, container, or symlink dependency.
