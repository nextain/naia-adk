# Issue #18 observability planning review — 2026-07-30

Stage: planning
Artifact: `docs/design/discord-session-observability.md` and DSO-001 through DSO-006
Reviewers: `gpt-5.6-sol high`, `gpt-5.6-terra high` reader test

## External reviewer availability

- OpenRouter `nvidia/nemotron-3-ultra-550b-a55b:free`: probe passed; review output was empty. Unavailable, not CLEAN.
- OpenRouter `deepseek/deepseek-v4-flash:free`: probe passed; review output was empty. Unavailable, not CLEAN.
- Local Claude: read-only attempts ended at max turns or connection close without a verdict. Unavailable, not CLEAN.

## Evidence-accepted findings

- The artifact is an observability sub-design, not the complete #18 design.
- A service-wide status contract was missing.
- Job events needed per-job sequence, global ordinal, and stable dedupe identity.
- Rejected ingress cannot pretend to be a job event.
- Lifecycle transitions, terminal activity semantics, timing defaults, and evidence precedence were incomplete.
- Free-form safe summaries and self-reported backend verification could create false safety and false completion.
- CLI JSON/error/watch behavior, reboot ownership, delivery ambiguity, and operator authorization required testable contracts.

The design was revised against explicit user intent and repository source. Later convergence rounds added a closed producer/payload contract, current-attempt evidence, strict metadata validation, PID+boot+process-start ownership, sidecar protection, and exact idempotency semantics.

## Final planning convergence

- `gpt-5.6-sol high`: CLEAN on the final design and implementation contract.
- `gpt-5.6-terra high`: CLEAN on the final design and implementation contract.
- Unavailable reviewers remain recorded as unavailable and were never counted as CLEAN.
