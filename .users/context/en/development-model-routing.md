# Development Model Assignment

This document defines the model assignment criteria for the Alpha ADK root collaboration process. Where possible, perform contract checks and deterministic checks first, and use the least expensive role that can safely handle work with a defined scope. Escalate to a higher role only when there is elevated risk or unresolved lack of evidence. OpenCode is not used. HY3 may be evaluated only in an isolated benchmark and is not used for operational routing. Passing the benchmark alone does not automatically lift this prohibition; a separate policy decision is required.

## General Contract Layer

The canonical rules define the capabilities and evidence of the `coordinator·explorer·designer·implementer·tester·independent reviewer·mediator·translator`, rather than the model names of Codex or Claude. Specific CLI flags and model names belong only in adapters. Therefore, other tools may use this harness if they satisfy the same role capabilities, contract scope, identical revision hash, distinct role/session/execution IDs, and blocking conditions on failure.

Before invoking a model, perform deterministic checks first and select the least expensive adapter that satisfies the required capabilities and risk level. If no adapter can provide a required independent role, block the process instead of replacing it with a self-check.

Every delegated or nested role inherits the coordinator's authorized objective, scope, routine execution authority, and exception boundary. It must not request approval again for ordinary in-scope reading, implementation, testing, building, or non-destructive Git work. Approval remains required for irreversible or destructive action including remote-ref deletion, force push, unrelated-history integration, external messaging or payment, production-impacting mutation, material cost, credential exposure, or material scope expansion.

General roles are explicitly mapped in adapters. The implementer is connected to Codex's worker, and translation uses the low-cost fallback chain Claude Haiku 4.5 → Codex GPT-5.6 Luna(low) → Claude Sonnet. All CLI calls use a shared stdin-based invocation function, so long prompts are not passed as command-line arguments.

## Codex Adapter

Codex `gpt-5.6-sol` (medium reasoning level) is the default coordinator and final integration owner. This role handles contract interpretation, integration decisions, final cleanup, and final file changes.

| Work | Model and reasoning level | Execution scope |
|---|---|---|
| Scoped exploration, context mapping, evidence collection | Codex Terra, low | Read-only |
| Implementation within the approved scope | Codex Terra, medium | Workspace writing permitted |
| Analysis of scoped design alternatives | Codex Terra, high | Read-only |
| Focused testing and test evidence collection | Codex Terra, medium | Workspace writing permitted |
| Independent adversarial review of the revision | A model/provider different from the implementer where possible; required panel: Codex Terra, high | Read-only |
| Mediation of high-risk integration or unresolved review findings | Codex Sol, high | Read-only |

## Claude Adapter

Claude does not pin an old model ID with a specific date to this contract. Use the currently supported alias or model name from the installed Claude configuration.

- Lightweight role: Use for mechanical classification, translation batches, and scoped exploration when supported by the installed configuration.
- General role: Use for general analysis or implementation selected by the installed configuration.
- Higher-level role: Use only for design, safety-critical decisions, or unresolved review evidence.

Claude likewise cannot serve as both the implementer and adversarial reviewer of the same execution.

## Independent Adversarial Review

An implementer's self-check is useful, but it is not an adversarial review. An adversarial review is mandatory, and where possible a model or provider different from the implementer is preferred. This preference never relaxes the following mandatory independence conditions.

- `session_id`
- `execution_id`

The reviewer examines the same immutable revision hash in read-only mode, rather than a previous or ambiguous state. Every change requires independent clean reviews by Codex Terra and Claude Sonnet while the revision remains unchanged. Session and execution IDs in local receipts are recalculated from the original CLI execution records preserved in `.agents/progress/review-evidence/`, and are not accepted based only on a string entered by the caller. The Sol mediator determines the evidence only when unresolved findings exist.

All review evidence must include the contract or requirement ID, revision hash, implementer and reviewer session and execution IDs, and test records.

Local hooks are deterministic safeguards for tool paths exposed to Codex. Ambiguous shell writes are blocked unless the approval contract contains the exact command pattern. The boundary that guarantees the cryptographic authenticity of processes and models is a signed isolated review execution; general progress JSON or local hook files do not claim to guarantee authenticity at that level.

## Cost Control

Schema, hash, mirror, index, and record checks are deterministic checks that do not invoke an LLM. Translation and mechanical classification process only changed inputs in lightweight model batches with hash caching. Sol's high reasoning level is used only for mediation or genuinely high-risk work.

## Quick Application Profiles

The canonical source for the primary structure is `packages/benchmark-contract/baselines/development-composition-profiles.json`. Profiles contain only roles intended for long-term retention and their safety conditions, while current model bindings are separated. When a new model becomes available, update only the small experiments and binding evidence for the relevant role rather than redesigning the profile.

- `control`: Uses Sol for all roles in separate executions. It is the quality and cost baseline and the high-risk fallback.
- `balanced`: Sol handles planning and integration, while Luna performs limited implementations with a precise automatic verifier. When no verifier exists, Terra handles the limited implementation and performs focused testing. This is the opt-in default profile currently available.
- `economy`: Gradually expands only Luna mechanical tasks for which subsequent evidence has been established, while maintaining the safety boundaries of `balanced`.

Luna implementation is permitted only when the scope is limited and a precise verifier exists. Without a verifier or when Luna is not exposed by the current runtime, fall back to Terra; when the scope is not limited or the risk is high, fall back to Sol. Sol and Terra are the default available bindings, and only bindings explicitly exposed by the runtime may be selected. Selection fails closed when no eligible binding is available. Because Windows child processes do not preserve an empty environment value, declare an empty set as `CODEX_AVAILABLE_BINDINGS=none` or `[]`. Independent reviews must use author and session/execution IDs that differ, and should use a different model binding where possible. Initial availability of `balanced` means that it can be used; it does not mean that cost savings for the full development composition have been demonstrated.

## Benchmark Candidates and Promotion Conditions

Codex `gpt-5.6-sol` is fixed as the primary coordinator and final integrator. The benchmark tests whether a less expensive model, provider, or adapter combination can be used for limited sub-tasks; it is not a test intended to replace Sol. Results comparing different providers are not expressed as causal differences attributable solely to the models.

- Codex Terra: Candidate for exploration, implementation, testing, and independent review
- Codex Luna: Candidate for translation, mechanical classification, and limited exploration
- Azure `DeepSeek-V4-Flash`: Candidate for analysis, code generation, and structured output. Tool-calling capability is not claimed.
- OpenRouter `tencent/hy3`: Candidate for analysis and code generation. Tool use is evaluated only after passing capability exploration, with the actual upstream provider and routing method fixed.
- Upstage private beta `solar-open2`: Candidate for Korean analysis, code generation, and document work. The key is injected only through `UPSTAGE_KEY` and is not placed in the repository.

Model capability benchmarks run fixed tasks on models and evaluate them with an external grader. Agent execution benchmarks run the actual runtime and fault-injection tools with a fixed model. Harness benchmarks deterministically run the actual hooks and verifiers without asking the model to guess the correct state. All retries, fallbacks, timeouts, and final failures are included in the quality and cost denominators. Korean dual context and Windows-native behavior are verified separately, and promotion to operational routing requires two clean independent adversarial reviews of the same revision.

Common model comparisons are limited to tool-free text and JSON tasks. Tool compatibility is recorded in separate provider-specific tests and is not combined with the common score. Candidate models can see only an empty temporary work folder and public inputs; the answer key, grader, and manifest remain outside the candidate process and installed packages. The separate grading process accesses the answer key only after the candidate output hash has been fixed. Each attempt uses a new session, and the caching method is recorded.

Development tests run 24 public task bundles per path three times and are not used for operational decisions. Operational promotion tests run at least 80 private task bundles five times after an a priori power analysis. Sol and the five candidates are grouped into one Holm correction family, and the task-level paired bootstrap with 10,000 iterations must show a lower bound on the quality difference of at least -5%p and a cost upper bound demonstrating at least 15% savings. Sol comparison workers run in least-privilege sessions separate from the coordinator, and coordination costs are recorded separately as common overhead.

Receipts record the provider, endpoint, API version, original model, deployment/routing model, actual upstream provider, adapter version/hash, request configuration hash, usage conversion version, and unsupported arguments. Authorization headers, API keys, signed URLs, and credential values are not included in records, logs, or hashes. Windows must pass separately with Node 22 or later and native PowerShell; successful remote model calls do not substitute for passing the Windows harness.

All benchmark journals create an HMAC hash chain for each record and are reverified before analysis. On Windows, the native PowerShell helper encrypts and stores the HMAC key using CurrentUser DPAPI and does not print or save the plaintext key to a file. The core runner receives the key externally on any platform, so DPAPI is a Windows-only adapter and is not a dependency of other platforms. Executions whose keys cannot later be recovered for verification are treated only as calibration material and are not used for routing decisions.
