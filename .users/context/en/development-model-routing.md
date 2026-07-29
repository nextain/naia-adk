# Development Model Routing

This document defines the model assignment criteria for the Alpha ADK root collaboration process. Where possible, perform contract checks and deterministic checks first, then use the least expensive role capable of safely handling the scoped work. Escalate to a higher-level role only when there is risk or unresolved insufficiency of evidence. OpenCode is not used. HY3 may be evaluated only in an isolated benchmark and is not used for operational routing. Passing the benchmark alone does not automatically lift this prohibition; a separate policy decision is required.

## General Contract Layer

The canonical rules define the capabilities and evidence of the `coordinator·explorer·designer·implementer·tester·independent reviewer·mediator·translator`, not the model names of Codex or Claude. Specific CLI flags and model names belong only in adapters. Accordingly, other tools may use this harness if they satisfy the same role capabilities, contract scope, identical revision hash, distinct role·session·execution IDs, and blocking conditions on failure.

Before making a model call, perform deterministic checks first and select the least expensive adapter that satisfies the required capabilities and risk level. If no adapter can provide a required independent role, block the process rather than substituting a self-check.

General-purpose roles are explicitly mapped in adapters. The implementer is connected to Codex's worker, and translation uses a low-cost fallback chain in the order Claude Haiku 4.5 → Codex GPT-5.6 Luna(low) → Claude Sonnet. All CLI calls use the shared stdin-based invocation function, so long prompts are not passed as command-line arguments.

## Codex Adapter

The default coordinator and final integration owner is Codex's `gpt-5.6-sol` (medium reasoning level). This role handles contract interpretation, integration decisions, final cleanup, and final file changes.

| Task | Model and reasoning level | Execution scope |
|---|---|---|
| Scoped exploration, context mapping, evidence collection | Codex Terra, low | Read-only |
| Implementation within the approved scope | Codex Terra, medium | Workspace write access |
| Scoped design alternative analysis | Codex Terra, high | Read-only |
| Focused testing and verification evidence collection | Codex Terra, medium | Workspace write access |
| Independent adversarial review of the revision | A model·provider different from the implementer where possible; required panel: Codex Terra, high | Read-only |
| Mediation of high-risk integration or unresolved review findings | Codex Sol, high | Read-only |

## Claude Adapter

Claude does not pin a dated legacy model ID to this contract. Use the currently supported alias or model name from the installed Claude configuration.

- Lightweight role: Use for mechanical classification, translation batches, and scoped exploration when supported by the installation configuration.
- General role: Use for general analysis or implementation selected by the installation configuration.
- Higher-level role: Use only for design, safety-critical decisions, or unresolved review evidence.

Claude likewise cannot serve as both the implementer and the adversarial reviewer for the same execution.

## Independent Adversarial Review

The implementer's self-check is useful, but it is not an adversarial review. An adversarial review is mandatory, and where possible, a model or provider different from the implementer is preferred. This preference never relaxes the following mandatory independence conditions.

- `session_id`
- `execution_id`

The reviewer examines the immutable same revision hash in read-only mode, rather than a previous or ambiguous state. Every change requires independent clean reviews by Codex Terra and Claude Sonnet while the revision remains unchanged. Session and execution IDs in local receipts are recalculated from the original CLI execution records preserved in `.agents/progress/review-evidence/`; they are not accepted solely from a string entered by the caller. A Sol mediator determines the evidence only when unresolved findings remain.

All review evidence must include the contract or requirement ID, revision hash, the implementer's and reviewer's session·execution IDs, and test records.

Local hooks are deterministic safeguards for tool paths exposed to Codex. Ambiguous shell writes are blocked unless the approval contract contains the exact command pattern. The boundary that guarantees the cryptographic authenticity of the process and model is a signed isolated review execution; ordinary progress JSON or local hook files do not claim to provide that level of authenticity.

## Cost Control

Schema, hash, mirror, index, and record checks are deterministic checks that do not call an LLM. Translation and mechanical classification process only changed inputs in lightweight model batches with hash caching. Sol's high reasoning level is used only for mediation or genuinely high-risk work.

## Benchmark Candidates and Promotion Conditions

Codex `gpt-5.6-sol` is fixed as the primary coordinator and final integrator. The benchmark is a test to verify whether a less expensive model·provider·adapter combination can be used for limited subordinate tasks, rather than a test to replace Sol. Results comparing different providers are not expressed as causal differences attributable solely to the models.

- Codex Terra: Candidates for exploration, implementation, testing, and independent review
- Codex Luna: Candidates for translation, mechanical classification, and limited exploration
- Azure `DeepSeek-V4-Flash`: Candidate for analysis, code generation, and structured output. Tool-calling capability is not claimed.
- OpenRouter `tencent/hy3`: Candidate for analysis and code generation. Tool use is evaluated only after passing capability exploration, with the actual higher-level provider and routing method fixed.
- Upstage private beta `solar-open2`: Candidate for Korean analysis, code generation, and documentation work. The key is injected only through `UPSTAGE_KEY` and is not placed in the repository.

Model capability benchmarks run fixed tasks on models and evaluate them with an external grader. Agent execution benchmarks run the actual runtime and fault-injection tools with a fixed model. Harness benchmarks execute the actual hooks and verifiers deterministically, without asking the model to guess the correct state. All retries·fallbacks·timeouts·final failures are included in the quality and cost denominators. Korean dual context and Windows-native operation are verified separately, and promotion to operational routing requires two clean independent adversarial reviews of the same revision.

Common model comparisons are limited to tool-free text·JSON tasks. Tool compatibility is recorded in separate provider-specific tests and is not combined with the common score. Candidate models may see only an empty temporary work folder and public inputs; the answer key·grader·manifest are kept outside the candidate process and installed packages. The answer key is accessed by a separate grading process only after the candidate output hash has been fixed. Each attempt uses a new session, and the caching method is recorded.

Development testing runs 24 public task bundles per path three times and is not used for operational decisions. The operational promotion test runs at least 80 private task bundles five times after a priori power analysis. Sol and the five candidates are grouped into one Holm correction family, and the task-level paired bootstrap with 10,000 iterations must show a lower bound of at least -5%p for the quality difference and a cost upper bound showing at least 15% savings. Sol comparison workers run in least-privilege sessions separated from the coordinator, and coordination costs are recorded separately as common overhead.

Receipts record the provider, endpoint, API version, original model, deployment·routing model, actual higher-level provider, adapter version·hash, request configuration hash, usage conversion version, and unsupported arguments. Authorization headers, API keys, signed URLs, and credential values are not included anywhere in records·logs·hashes. Windows is separately passed with Node 22 or later and native PowerShell; successful remote model calls do not substitute for passing the Windows harness.

Every benchmark journal creates an HMAC hash chain for each record and verifies it again before analysis. On Windows, the native PowerShell helper encrypts and stores the HMAC key using CurrentUser DPAPI without outputting or saving the plaintext key to a file. The core runner receives the key externally on any platform, so DPAPI is a Windows-only adapter and is not a dependency for other platforms. Executions whose keys cannot later be recovered for verification are treated only as calibration material and are not used for routing decisions.
