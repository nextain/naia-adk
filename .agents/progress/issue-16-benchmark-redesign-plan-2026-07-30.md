# Issue #16 benchmark redesign plan

Status: phase-1 usable profile implementation; phase-2 evidence plan follows.

## Fixed outcome

Codex 5.6 Sol remains the main orchestrator and final integrator. The benchmark selects cheaper bounded workers; it does not seek a global Sol replacement.

## Correction to the pilot

The four algorithm-output tasks in the first pilot are usable as a narrow model-capability smoke test. The B/C tasks are not valid runtime or harness measurements because the old adapter asked the model to emit expected JSON. Preserve those results as historical structural smoke only and exclude them from routing conclusions.

## Delivery order

### Phase 1 — usable structure and immediate opt-in

1. Freeze stable role profiles separately from replaceable model bindings.
2. Ship `control`, `balanced`, and `economy`; make `balanced` the explicit opt-in default and `control` the fail-safe fallback.
3. Keep Sol responsible for orchestration and final integration. Allow Luna for bounded implementation only behind an exact validator, use Terra as the bounded fallback without one and for focused testing, and retain the stricter low-risk rule for Luna mechanical work.
4. Expose a deterministic selector that falls back instead of guessing when scope, risk, validation, or reviewer independence is insufficient.
5. Run native Linux verification and independent cross-review of the staged phase-1 profile checkpoint. Keep the full governed request-contract CLEAN streak as a separate follow-up because it has a wider review scope.
6. Commit and push phase 1 immediately so other naia-adk sessions can pull and use the same structure.

Phase 1 explicitly does not claim proven total-system cost reduction. It makes an opt-in route available that assigns qualified bounded roles to non-Sol bindings and falls back conservatively.

The phase-1 profile checkpoint was independently reviewed CLEAN by Gemini Pro and Grok after their findings were corrected. This is profile-scope evidence, not a replacement for the request-contract receipt quorum.

### Phase 2 — small experiments and composition evidence

1. Run small, pre-registered capability experiments before end-to-end combinations.
2. Convert observations into conditional role rules with explicit forbidden conditions.
3. Compare the unchanged `control`, `balanced`, and `economy` profiles on the same full development tasks.
4. Include orchestration, handoff, retry, review, rework, translation, synchronization, and integration cost.
5. Requalify only affected bindings when a new model, price, provider route, or model version appears; do not redesign stable profiles.
6. Add external candidates only after connectivity, identity, usage, and price evidence pass.

## Benchmark work packages

1. Split the runner into model-capability, real agent-runtime, and deterministic governance-harness execution owners.
2. Use a 24-cluster public development pilot with three attempts per route. After pre-run power analysis, freeze a sealed acceptance set of at least 80 hidden task clusters with five attempts per qualifying route; the frozen sample may increase but never decrease after results are observed.
3. Introduce a provider-neutral receipt contract and fake-provider conformance tests before live calls.
4. Add adapters for Codex, Azure DeepSeek V4 Flash, OpenRouter HY3, and Upstage hosted Solar Open 2. Credentials stay external.
5. Freeze provider/deployment/model/configuration identity, raw receipt digest, usage, latency, retry/fallback/failure cost, and price evidence. Unknown price forbids a savings claim.
6. Replace B/C model prompts with actual runtime fault injection and actual hook/validator invocations.
7. Run the public development pilot, perform power estimation, freeze the acceptance sample size, and then run the sealed comparison. Use task-clustered paired bootstrap with 10,000 resamples, a -5 percentage-point non-inferiority margin, a 15 percent minimum cost improvement, and Holm correction across the five candidate-versus-Sol comparisons.
8. Require two independent clean adversarial reviews on the same immutable snapshot, refresh request-contract receipts where their reviewed scope changed, and update GitHub issue #16.

## Replaceable model bindings

- Sol orchestrator and final integrator, plus a distinct `worker-sol-control` session with the minimal worker prompt and no oracle access. Orchestration cost is common overhead and is not mixed into worker response scoring.
- Terra bounded engineering fallback and focused tester
- Luna exact-validated bounded implementation plus translation/mechanical worker
- Azure `DeepSeek-V4-Flash` structured text/code arm; no tool-calling claim
- OpenRouter `tencent/hy3` composite endpoint arm with upstream routing identity pinned
- Upstage private-beta `solar-open2` hosted API arm using `UPSTAGE_KEY`

HY3 is benchmark-only. Production routing remains prohibited even after a passing run until a separate explicit policy decision changes that rule.

The names above are current bindings, not permanent profile definitions. A successor model enters through a bounded capability experiment, evidence expiry check, and binding update. Profile semantics remain stable.

## Sealed execution boundary

- The candidate receives only public input in an empty scratch working directory.
- Hidden oracle, scorer, task manifest, and expected output are excluded from the candidate permission boundary and installed package.
- Candidate output and receipt digests are bound before a separate scorer process gains oracle access.
- Every attempt uses a new provider session or thread, does not share prior outputs, and records cache mode.
- Development fixtures are never promoted into holdout. Suspected leakage invalidates the run, tombstones the task revision, and triggers rotation.

## Provider-neutral receipt fields

Every adapter records provider ID, endpoint ID, API version, source model ID, deployment or route model ID, actual upstream provider where applicable, adapter revision and build digest, request configuration digest, usage-mapping revision, unsupported parameters, redacted request digest, raw response digest, normalized usage digest, monotonic latency, and price-snapshot digest. Authorization headers, API keys, signed URLs, and credential values are excluded before logging or hashing.

## Native Windows package

The Windows matrix uses Node 22 or later and native PowerShell only, with poison checks for WSL, Bash, required symlinks, Linux VMs, and Linux-container dependencies. Remote Azure, OpenRouter, or Upstage success never substitutes for the local native-Windows harness receipt.

## Stop conditions

- Any hard contract failure blocks promotion.
- Missing usage or frozen price evidence makes the monetary comparison unavailable rather than zero.
- Invalid, timed-out, retried, fallback, and failed attempts remain in both quality and cost denominators.
- A candidate exceeding the frozen quality non-inferiority margin cannot be promoted for that role even if cheaper.
