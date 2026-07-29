# Issue 16 — Development model-routing pilot

Date: 2026-07-30
Scope: public development fixtures only; no production-routing claim

## Contract and execution

- Sol remained the main orchestrator and final integrator. `worker-sol-control` was a separate minimal worker session.
- Each route ran the same 24 public task clusters three times (72 scheduled attempts).
- Candidates received only the public prompt in a new empty scratch directory. Scoring ran outside the candidate process.
- No retries, fallbacks, model substitution, web search, apps, WSL, Bash, symlink, VM, or container dependency was used.
- The durable runs share a CurrentUser DPAPI-protected HMAC authority. The analysis re-read and validated each plan binding and journal hash chain.
- The first calibration exposed a defective binary-search oracle. The half-open interval's `right = length` was valid; only the non-progressing `left = mid` was defective. The oracle was corrected, all package tests passed, and calibration journals were excluded.

## Durable development results

| Route | Pass | API-equivalent USD | Worker wall time | Observed role signal |
|---|---:|---:|---:|---|
| `worker-sol-control` | 71/72 (98.61%) | 1.2455700 | 324.058 s | control only |
| `worker-terra` | 72/72 (100%) | 0.3325620 | 310.680 s | bounded worker candidate |
| `worker-luna` | 67/72 (93.06%) | 0.1563554 | 297.668 s | mechanical/translation candidate only |

Task-clustered paired bootstrap, 10,000 resamples:

- Terra vs Sol: quality delta estimate +1.37%p, 95% interval [0, +4.17%p]; cost delta estimate -72.99%, 95% interval [-78.73%, -65.58%]. Both development signals passed.
- Luna vs Sol: quality delta estimate -5.61%p, 95% interval [-16.67%, +2.78%p]; cost delta estimate -87.36%, 95% interval [-90.25%, -83.61%]. Cost signal passed; quality non-inferiority signal failed.
- Report digest: `06eada1dae2ba7cf21562a404229338f3be43c71a6dfde549c703e5eee4c18c1`.

## Interpretation and limits

- Terra is the current development-set leader for bounded no-tool worker tasks. This does not authorize replacing Sol as orchestrator or promoting Terra to production routing.
- Luna remains attractive for deterministic translation, classification, and extraction guarded by an exact validator; it is not supported as a general worker by this pilot.
- The task set is public and small, the five-candidate Holm family is incomplete, and orchestration plus total operational cost is outside this worker-only comparison.
- Azure DeepSeek V4 Flash, OpenRouter HY3, and Upstage Solar Open2 were not called because their credential environment variable names were absent from this process. HY3 remains prohibited outside the sealed benchmark regardless of future scores.
- Next evidence: provider one-task probes when credentials are visible, actual naia-agent runtime suite, deterministic governance-harness probes, then frozen hidden-set power analysis and independent reviews.

## Linux handoff checkpoint

This checkpoint is intentionally **not** a production-routing completion claim.
The completed run proves only A-layer, single-worker calibration on bounded public
fixtures.  The Terra percentage above is therefore not a total-system saving and
must not be used as evidence for the intended multi-model composition.

### Proven at this checkpoint

- Provider-neutral, journaled worker calibration runs reproducibly for Sol, Terra,
  and Luna without WSL or a shell wrapper dependency.
- Cost, quality, task-clustered confidence intervals, plan binding, and receipt
  integrity are measured for those isolated workers.
- Native Windows harness hardening and process cleanup have targeted regression
  coverage; Linux remains a first-class native target rather than a Windows WSL
  dependency.

### Not yet proven

- The end-to-end composition of Sol as main orchestrator with lower-cost workers,
  independent reviewers, retries, rework, handoffs, and context synchronization.
- Total-system cost reduction after orchestration, review, retry, translation, and
  integration overhead.
- Azure DeepSeek V4 Flash, OpenRouter HY3, and Upstage `solar-open2` routes.
- Two current-digest independent CLEAN adversarial reviews. Previous DIRTY review
  logs are invalidated whenever their reviewed digest changes and cannot be reused.

### Continuation order on native Linux

1. Pull this checkpoint and read the root and `naia-adk` mandatory context before
   running or editing the harness.
2. Run the targeted contract, supervisor, translation, benchmark, and native Linux
   E2E suites. Do not introduce a WSL dependency on Windows.
3. Obtain two fresh independent CLEAN review receipts for the exact current digest,
   update the RCI review references, and run the complete native harness aggregate.
4. Freeze and compare at least these composition policies on the same end-to-end
   tasks: all-Sol control; Sol+Terra; Sol+Terra+Luna for deterministic work; and
   Sol with DeepSeek V4 Flash, HY3, or Solar selected by role.
5. Include request-contract atomization, UC/FE and their tests, implementation,
   independent adversarial review, correction, dual-context synchronization, and
   integration in every system trial. A model must never review its own work.
6. Account for orchestrator, worker, handoff, retry, review, rework, translation,
   and integration tokens/cost. Measure quality, consistency, duplication, context
   loss, review detection, and wall time—not goal arrival alone.
7. When credentials are visible, use `UPSTAGE_KEY` with model `solar-open2`; probe
   Azure DeepSeek V4 Flash and OpenRouter HY3 only through their sealed provider
   routes. Add the requested latest Claude Opus design/adversarial review when its
   service limit permits.
8. Publish the composition evidence and fresh review receipts to issue #16 before
   changing the production routing policy.

### Checkpoint verification (Windows native)

- Review-scope index digest self-test: PASS.
- Request-contract unreadable-store prompt preservation regression: PASS.
- BEH supervisor fault injection: 22/22 PASS.
- BEH supervisor real-process wrapper: 17/17 PASS.
- Dual-context translation tests: PASS (Claude Haiku was session-limited and the
  configured fallback completed; this is not a Haiku availability claim).
- Benchmark-contract package: PASS, including schema/semantics, pre-recovery
  baseline, native runner, provider-neutral accounting, 72-attempt runner,
  analysis, and Windows DPAPI journal-key tests.
- Review transcript parser and staged-diff whitespace validation: PASS.
- Remaining release gate: native Linux E2E plus two fresh independent CLEAN review
  receipts for the exact digest and the resulting full aggregate run.
