---
name: review-pass
version: "3.1"
description: >
  Stage-gated multi-AI cross-validation review with optional REQ-ID traceability.
  4 stages (planning, development, test, integration) with configurable reviewers,
  finding consensus, and convergence loop. Fully project-agnostic and distributable.
triggers:
  - "/review-pass"
  - "review pass"
  - "리뷰 패스"
input_schema:
  stage:
    type: enum
    values: [planning, development, test, integration]
    required: true
    description: "Review stage — determines lenses, reviewers, and convergence"
  files:
    type: "string[]"
    required: true
    description: "File paths to review"
  request_contract_bundle:
    type: string
    required: false
    description: "Exact review-bundle JSON exported by scripts/request-contract.cjs; mandatory in governed mode"
  source_artifacts:
    type: "string[]"
    required: false
    description: "Immutable original human-source artifacts; mandatory for planning and integration"
  baseline_ref:
    type: string
    required: false
    description: "Immutable commit/tree identifying the working product before the change; mandatory for planning and integration"
  preservation_contract:
    type: string
    required: false
    description: "Contract with top-level preservation.baseline_ref/intent/surfaces/vendor_sources and schema-valid surface evidence/authority fields; mandatory for planning and integration"
  incident_history:
    type: string
    required: false
    description: "Prior corrections and known drift; mandatory when any correction or failed review exists, otherwise explicit 'none'"
  context:
    type: string
    required: false
    description: "What was implemented/changed, which issue it addresses"
  req_ids:
    type: "string[]"
    required: false
    description: "REQ-IDs to validate coverage against"
  deferred_req_ids:
    type: "string[]"
    required: false
    description: "REQ-IDs intentionally deferred (won't block convergence)"
  reviewers:
    type: "string[]"
    required: false
    description: "Override default reviewers (e.g. gemini,opencode,codex,claude)"
  "--light":
    type: boolean
    required: false
    description: "Reduce convergence to 1 clean round, skip non-essential lenses"
output:
  documents: []
  records:
    - name: "review_log"
      path: "configurable via review-pass.yaml, default: review-log.json"
  side_effects:
    - description: "Auto-fixes CONFIRMED findings (with safety guard)"
      adapter: "file_system"
steps:
  - id: "validate_inputs"
    action: "Check CLI tools available, load profile, resolve reviewers"
  - id: "round_loop"
    action: "Run review rounds until convergence"
    gate: false
  - id: "report"
    action: "Output final report"
failure_policy:
  retry: true
  rollback: true
  on_failure: "abort"
idempotency: false
---

# Review Pass v3 — Stage-Gated Multi-AI Cross-Validation

## Purpose

Multi-AI cross-validation review that adapts review power, perspective, and
convergence criteria to the current development stage. Optional REQ-ID
traceability for requirements-driven projects.

**Core principles:**
- **Project-agnostic**: No hardcoded paths, tools, or conventions. All configurable.
- **Independent roles**: Four evidence-separated review executions reduce shared-context blind spots; adapters and model providers are configurable
- **Stage-aware**: Planning, development, test, and integration have different needs
- **Convergent**: Automated loop until at least 2 consecutive clean rounds for every standard stage
- **Traceable**: REQ-ID coverage validated at every stage (when applicable, optional)
- **Source-complete**: In governed mode the exact source chain and full current/prior scope history are mandatory review inputs; caller-selected files cannot redefine scope
- **Baseline-preserving**: Planning and integration compare the current product with an immutable baseline and an explicit surface-preservation contract
- **Evidence-separated**: Source, baseline, implementation/test, and authority/release reviewers receive different evidence views to prevent shared anchoring
- **Safe**: Auto-fix with diff preview, rollback, and safety guard

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `stage` | **yes** | `planning` / `development` / `test` / `integration` |
| `files` | **yes** | Comma-separated file paths to review |
| `request_contract_bundle` | governed mode | Private bundle locator returned by `node scripts/request-contract.cjs review-challenge --unit <id> --writer-session <id>` |
| `source_artifacts` | planning, integration | Immutable original-source files or governed bundle references; AI summaries are not substitutes |
| `baseline_ref` | planning, integration | Immutable commit/tree for the pre-change product |
| `preservation_contract` | planning, integration | Contract containing top-level `preservation.baseline_ref/intent/surfaces/vendor_sources`; each surface carries lowercase disposition, paths, evidence IDs, and destructive authority fields |
| `incident_history` | planning, integration | Immutable chronology of the original directives, later corrections, drift evidence, and current state; a selected incident excerpt or AI summary alone is insufficient |
| `context` | recommended | What was implemented/changed, issue reference |
| `req_ids` | optional | Comma-separated REQ-IDs to validate coverage |
| `deferred_req_ids` | optional | Comma-separated REQ-IDs intentionally deferred |
| `reviewers` | optional | Override default reviewers from profile |
| `--light` | optional | 1 clean round, reduced lens set |

## When to Run

| Development Phase | Review Stage | Purpose |
|-------------------|-------------|---------|
| After Plan, before Build | `planning` | Requirements ↔ Design alignment |
| After each Build phase | `development` | Code ↔ Plan alignment + REQ coverage |
| After E2E Test | `test` | Test quality + REQ-to-test mapping |
| Before Commit/Sync | `integration` | Full E2E traceability audit |

## Core Rules

> **The orchestrator AI does NOT report intermediate results to the user.**
> **CONFIRMED findings are auto-fixed with diff preview (see section 6.6).**
> **CONTESTED findings first receive independent arbitration and source-evidence verification. Ask the user only for a remaining material decision.**
> **Only the final report is shown after convergence.**
> **Governed mode forbids `--light`, caller-only file scope, unsigned deferral, and review without the exact current request-contract bundle.**
> **Planning/integration without original source, immutable baseline, and a preservation contract is NOT CLEAN.**
> **A solo CRITICAL preservation, scope, authority, or release finding is a veto and is never auto-dismissed.**

### Governed-mode preflight (before every stage)

When request-contract integrity is enabled (`REQUEST_CONTRACT=on` or the runtime marker exists):

1. Issue a one-time review challenge, load its mode-0600 private bundle, and recompute the canonical digest. Reject stale, partial, expired, or replayed input. Raw sources never cross stdout or command arguments.
2. Review every exact source prompt and its byte-exact partition of obligation atoms plus every current and prior directive, state, target, acceptance criterion, authority, tombstone, change occurrence, implementation mapping, and evidence mapping in the bundle. Every directive atom must appear verbatim in a mapped directive surface before review can start.
3. Treat the bundle as the scope floor. `files`, `req_ids`, and prose `context` may add focus but may not remove anything.
4. A deferred/superseded/abandoned requirement counts as disposed only when the bundle carries a valid signed user-presence authority and an immutable tombstone covering its directive, target, criterion, trace-artifact, and trace-edge IDs.
5. Launch only a configured SHA-256-allowlisted reviewer through the trusted platform runner. The Linux reference is `scripts/request-contract-review-runner.cjs`: it pins reviewer and bundle bytes, runs them through isolated `bubblewrap`, and accepts a receipt only while consuming the same-process, one-time run evidence whose semantic fields exactly equal actual reviewer stdout. There is no direct review-JSON ingestion command. It records the sandbox child kernel boot/start identity and rejects collision with every writer host identity. Reviewer and review-runner attestors are SHA-256-pinned snapshots that bind their executable digests and the exact review-payload digest. Reviewer time, stderr, and rejected fields never control public output. Never allowlist a generic blind signer.
6. Reviewer stdout must list only the complete opaque relationship projection: source and obligation-atom IDs, directive/target/criterion, authority/tombstone, trace, change, implementation/evidence, and every current/prior scope-version mapping. It must never contain text, paths, locators, summaries, or digests. The trusted runner injects issued binding fields only after sandbox exit. The final receipt must be signed by the configured reviewer credential from a context and kernel process identity distinct from every writer session/host. The core issues the opaque `run_id`; `CLEAN` has zero closed finding codes and `DIRTY` has at least one. Invocation fields, writer sessions, and writer process identities are digest-bound, and run/context/process/execution identities are compaction-persistent global claims.
7. Review issuance is denied while any mutation lease is active. At ingestion, recompute the complete bundle and source/contract/workspace/scope/work/config/binding values; reject the receipt instead of recording it if any post-launch drift exists. Any later revision restarts the Clean streak. The general floor is two consecutive Clean receipts. Preservation adds planning×4 and integration×4 stage-bound roles; one four-role streak without stage attestation is not equivalent.

### Product-preservation preflight (planning and integration)

This preflight applies to all feature work, including non-governed projects:

1. Require `source_artifacts`, `baseline_ref`, `preservation_contract`, and an immutable `incident_history`. It must contain or securely resolve the original directives, later corrections, drift evidence, and current state in order; a meta-instruction to "review the whole history", selected excerpts, or AI prose summary cannot replace the history itself. Missing or mutable inputs produce `NOT_CLEAN`.
2. Verify that `baseline_ref` resolves to an immutable commit/tree. For imported third-party source, require an attested origin repository identity, immutable commit/tree, and digest computed from that origin tree; URL/commit syntax plus a local subtree digest is insufficient.
3. Load the project-specific preservation adapter and make it derive the exact complete baseline surface set independently of the proposed contract. Require every discovered surface to have a lowercase disposition plus `baseline_evidence_id` and `current_evidence_id`; reject missing, additional, renamed, or unreachable surfaces that lack an explicit disposition. UI routes/navigation, APIs, CLI commands, library exports, data schemas, jobs, package/deployment targets, and operations/handoff paths are examples; unsupported kinds require explicit N/A evidence rather than silent omission.
4. Treat `preserve` and `extend` as defaults. `replace|remove|disable|redirect|migrate` is valid only when that surface carries an exact `authority_id` and `expected_diff_digest`. Silence, an AI-authored issue/comment, or a derived REQ is not authority.
5. Reject requirements that omit source authority or immutable source references. A derived requirement may explain a human directive but may not narrow, supersede, or reverse it.
6. Treat capability reachability loss as deletion even when files remain: broken bindings/references, shadowed entry points, disconnected discovery paths, incompatible exports/schemas, changed package/deployment targets, and misleading handoff artifacts are in scope.
7. Require probes referenced by each surface's `baseline_evidence_id` and `current_evidence_id`. The probe must be a signed receipt emitted by an allowlisted project-adapter runner after executing the real entry, binding runner/command/exit/result/subject. Agent-authored probe JSON and shape/digest-only evidence are `NOT_CLEAN`. A new test that merely asserts an old entry is absent, redirected, or hidden is a false-green signal without valid destructive authority evidence.
8. Runtime stage binding and role-specific first-verdict views are implemented and adversarially tested. Treat real-entry probe execution semantics, named vendor-origin attestation, comparison/convergence rounds, and project-complete external-side-effect gating as **PENDING** until code and adversarial tests demonstrate them. Procedure text must not upgrade a pending control into an implemented guarantee.
9. If prior corrections or failed reviews exist, give reviewers the actual incident history and changed artifacts; do not provide only the orchestrator's conclusion.

---

## 1. Stage Profiles (defaults, overridable via config)

Each lens includes actionable checks for headless reviewers.

The following lenses are mandatory at **every** stage and cannot be removed by
project overrides or `--light`:

1. `context_output_separation` (`FINDING-CONTEXT-OUTPUT-SEPARATION`) — Check every new code, UI, and document content unit against its source atoms. Background/reference/example/internal text needs explicit `derive`, `quote`, or `require` render authority; agent-workflow background/preconditions are never shipping content edges.
2. `audience_surface_fit` (`FINDING-AUDIENCE-SURFACE-FIT`) — Check that each output unit's kind, audience, and exposure match the actual consumer and surface. Correct text on the wrong audience surface is a finding.
3. `unjustified_product_surface` (`FINDING-UNJUSTIFIED-PRODUCT-SURFACE`) — Compare the baseline and current surface inventory. Do not flag unchanged baseline text, but flag each newly introduced public/product surface that lacks objective and content-source authority.

### planning
- **Reviewers**: 4 separated role executions (tool-independent; roles are not optional)
- **Convergence**: the general two-Clean floor plus one Clean first verdict from each of the four planning roles; any evidence change invalidates the affected stage (`--light` forbidden)
- **Arbiter**: none (CONTESTED → inline user prompt, loop resumes)
- **Lenses (with REQ-IDs)**:
  1. `source_fidelity` — Check: independently extract obligations from original source before seeing derived REQs; every human directive is covered and every derived REQ is entailed
  2. `design_coherence` — Check: no internal contradictions between sections; dependencies are identified; scope is bounded
  3. `feasibility` — Check: technical approach is realistic; no assumed-but-unverified capabilities; effort estimate matches scope
  4. `preservation_setup` — Check: baseline is immutable; every product surface has a disposition and probe; destructive dispositions carry exact user authority
- **Lenses (without REQ-IDs)**:
  1. `source_fidelity` — (same as above; source authority is required even without REQ-IDs)
  2. `design_coherence` — (same as above)
  3. `feasibility` — (same as above)
  4. `preservation_setup` — (same as above)

These lenses are checks distributed across the four canonical roles in section 1.1; they are not
replacement role names and must not be recorded as role coverage.

### development
- **Reviewers**: 3 (configurable)
- **Convergence**: 2 consecutive clean rounds (1 in --light)
- **Arbiter**: separate tool from reviewer set (configurable, must not be in reviewer pool)
- **Lenses (with REQ-IDs)**:
  1. `correctness` — Check: logic matches intent; null checks on external inputs; off-by-one in loops; error paths handled; no silent failures
  2. `completeness` — Check: all planned items implemented; all REQ-IDs have code mappings; no TODO stubs in production paths
  3. `consistency` — Check: naming matches project conventions; import paths correct; no conflicts with existing code; no unintended side effects
  4. `pattern_compliance` — Check: same patterns as similar files in project; not inventing novel approaches alone; read 2-3 similar files to compare
  5. `req_to_code` — Check: each REQ-ID maps to specific code (file + symbol); acceptance criteria traceable to implementation
- **Lenses (without REQ-IDs)**:
  1. `correctness` — (same as above)
  2. `completeness` — Check: all planned items implemented; no missing files; no TODO stubs
  3. `consistency` — (same as above)
  4. `pattern_compliance` — (same as above)

### test
- **Reviewers**: 2 (configurable)
- **Convergence**: 2 consecutive clean rounds (1 only in explicit non-governed `--light`)
- **Arbiter**: none (CONTESTED → inline user prompt, loop resumes)
- **Lenses (with REQ-IDs)**:
  1. `test_validity` — Check: tests import and call the changed code; assertions execute after the code under test runs; mocks don't replace the actual logic being tested
  2. `coverage` — Check: all REQ-IDs have corresponding test cases; negative cases exist; edge cases tested
  3. `assertion_quality` — Check: assertions check specific values not just "not null"; no assertions that always pass; error messages are meaningful
  4. `req_to_test` — Check: each REQ-ID maps to specific test file + test name; test names reflect the requirement
- **Lenses (without REQ-IDs)**:
  1. `test_validity` — (same as above)
  2. `coverage` — Check: all changed code paths are tested; negative cases exist; edge cases tested
  3. `assertion_quality` — (same as above)

### integration
- **Reviewers**: 4 separated role executions (tool-independent; roles are not optional)
- **Convergence**: the general two-Clean floor plus four new integration role executions; planning receipts cannot be reused (`--light` forbidden)
- **Arbiter**: separate tool from reviewer set (configurable, must not be in reviewer pool)
- **Lenses (with REQ-IDs)**:
  1. `source_to_release` — Check: original source→REQ→plan→code→test→runtime→delivery state is complete, with no AI-derived authority substitution
  2. `cross_stage_consistency` — Check: plan description matches code; code matches tests; no contradictions between any two stages
  3. `baseline_preservation` — Check: every `preserve|extend` evidence pair matches baseline behavior; every `replace|remove|disable|redirect|migrate` has exact `authority_id`, matching `expected_diff_digest`, and valid current paths except for `remove`
  4. `authority_release` — Check: incident history is resolved, review evidence is current, and NOT CLEAN work is restricted to REVIEW_ONLY
- **Lenses (without REQ-IDs)**:
  1. `source_to_release` — (same as above; source authority is required even without REQ-IDs)
  2. `cross_stage_consistency` — (same as above)
  3. `baseline_preservation` — (same as above)
  4. `authority_release` — (same as above)

Integration issues new stage-bound receipts for the same four canonical roles. Planning role
receipts do not count toward integration coverage.

### 1.1 Separated Reviewer Roles

Planning and integration use four evidence-separated roles. A role is an independently
launched execution, not a hardcoded provider name. Different providers or models are preferred,
but one configured adapter may run multiple roles only when every role has a distinct process,
context, execution ID, and first verdict. If fewer than four role executions complete, the stage
is `NOT_CLEAN` rather than gracefully degraded.

| Role | Evidence shown first | Evidence withheld until first verdict | Primary question |
|------|----------------------|--------------------------------------|------------------|
| `source_fidelity` | Exact original-source bundle and source authority | Derived REQs, plan, implementation summary | What did the user actually authorize, constrain, and preserve? |
| `baseline_preservation` | Baseline tree/runtime, project-adapter surface inventory, before probes | Current REQs and orchestrator conclusions | What existed and was reachable before the change? |
| `implementation_test` | Current code, tests, test output, current runtime probes | Other reviewers' findings | What changed, and do tests exercise the real product path? |
| `authority_release` | Source-to-REQ mapping, destructive approvals, incident history, review receipts, delivery state | Proposed completion wording | Is any derived interpretation acting as authority, and is release permitted? |

After each role produces its first independent verdict, the orchestrator performs a comparison
round using the four outputs. Never seed a role with another role's conclusion. The orchestrator
must construct four role-specific views and attest their included/withheld fields. The governed
runtime now binds role-specific view digests and planning/integration stages, and seals planning×4
before implementation mutation. **PENDING:** normalized cross-role comparison and convergence
receipts are not yet runtime-enforced, so preservation output remains `REVIEW_ONLY` until that and
the other pending release controls are complete.

---

## 2. CLI Invocation Protocol

### 2.1 Encoding Setup

Set UTF-8 encoding before any CLI invocation:

**PowerShell (Windows):**
```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
```

**Bash (Linux/macOS):**
```bash
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8
```

### 2.2 Prompt Delivery

Write prompt to a temporary file, then pipe via stdin. Never inline large
prompts in command arguments (encoding/length issues).

**PowerShell:**
```powershell
$promptFile = [System.IO.Path]::GetTempFileName()
Set-Content -Path $promptFile -Value $prompt -Encoding UTF8
Get-Content $promptFile -Raw | & $toolCommand
```

**Bash:**
```bash
promptFile=$(mktemp)
echo "$prompt" > "$promptFile"
cat "$promptFile" | $toolCommand
```

### 2.3 Reviewer Invocation

Each reviewer is invoked as a headless CLI process. Commands are configurable
via the tools section of the profile. Standard patterns:

| Tool | Headless Command | Read-Only | Notes |
|------|-----------------|-----------|-------|
| `claude` | `cat $f \| claude -p --output-format json --allowedTools "Read,Glob,Grep" --max-turns 5` | yes (restricted tools) | stdin pipe works |
| `gemini` | `gemini -p "{prompt}" -m {model}` | yes (default) | use inline -p, NOT stdin pipe (broken on Windows) |
| `opencode` | `opencode run "{prompt}" --dir "$dir" -m {model}` | yes (default) | no stdin, positional arg |
| `codex` | `codex exec "{prompt}" --sandbox read-only --full-auto` | yes (sandbox) | inline prompt |

**Adapter interface**: Each tool adapter implements:

```
invoke(prompt: string, config: ToolConfig) → raw_output: string
parse(raw_output: string, strategy: "json" | "text_fallback") → Finding[]
```

**Custom tool registration**: Add entries to the `tools` section in config.
Each entry requires: `command` (with `{prompt}` and `{repo}` placeholders),
`stdin` (boolean), and `parse` strategy.

### 2.4 Timeout

Per-call timeout: 60s for planning/test, 120s for development/integration.
On timeout: treat as reviewer failure → graceful degradation (R-1).

### 2.5 Parallel Execution

Run all reviewers for a round in parallel via temp-file-based output capture.

**PowerShell:**
```powershell
$jobs = @()
foreach ($reviewer in $reviewers) {
    $outFile = [System.IO.Path]::GetTempFileName()
    $jobs += Start-Process -FilePath $tool -ArgumentList $args `
              -RedirectStandardOutput $outFile -NoNewWindow -PassThru
}
$allDone = Wait-Process -InputObject ($jobs.Id) -Timeout $perCallTimeout -ErrorAction SilentlyContinue
```

**Bash:**
```bash
pids=()
out_files=()
for reviewer in "${reviewers[@]}"; do
    out_file=$(mktemp)
    out_files+=("$out_file")
    invoke_tool "$reviewer" "$prompt" > "$out_file" 2>/dev/null &
    pids+=($!)
done
for pid in "${pids[@]}"; do
    timeout $per_call_timeout wait "$pid" 2>/dev/null || true
done
```

---

## 3. Output Schema

### 3.1 Reviewer Prompt Format

Each reviewer receives only the evidence view assigned to its role. The common envelope contains:

```
## Review Context
Stage: {stage}
Role: {source_fidelity | baseline_preservation | implementation_test | authority_release | standard}
Files: {file_list}
REQ-IDs: {req_ids or "N/A for this review"}
Deferred REQ-IDs: {deferred or "none"}
Known issues from previous rounds: {known_issues or "none"}
Source artifacts: {role-visible immutable source references or "withheld for independence"}
Baseline ref: {role-visible immutable ref or "withheld for independence"}
Preservation contract: {role-visible path or "withheld for independence"}
Incident history: {role-visible history or "withheld for independence"}

## Review Lens
Lens: {lens_name}
Checks to perform:
{actionable_checklist_from_stage_definition}

## Output Format (MANDATORY)
### Files Read
- `path/to/exact-file`

List every required repository-relative path separately. Ranges, directory shorthand, globs, and “A through B” do not count as read evidence.

### Findings
- `file:line [CRITICAL|HIGH|MEDIUM|LOW|INFO] [correctness|preservation|scope|authority|release] REQ-ID — description`
  (REQ-ID is optional; include only if the finding relates to a specific requirement)
or
NONE

### REQ-ID Coverage (skip if no REQ-IDs provided)
- REQ-001: COVERED (path/to/file:symbol_name)
- REQ-002: NOT FOUND
or ALL COVERED or N/A

### Verdict
CLEAN | FOUND_ISSUES | VETO
```

### 3.2 Finding Schema

```
Finding {
  file: string           // file path
  line: number | null    // line number (null for file-level)
  symbol: string | null  // function/class/symbol name
  severity: CRITICAL | HIGH | MEDIUM | LOW | INFO
  finding_class: correctness | preservation | scope | authority | release
  veto: boolean          // true for solo CRITICAL preservation/scope/authority/release
  req_id: string | null  // associated REQ-ID (null if N/A)
  description: string    // what's wrong
  reviewer: string       // which reviewer found this
}
```

### 3.3 Parsing Strategy

1. **Primary**: Parse JSON output when tool supports `--output-format json`
2. **Fallback**: Extract structured findings from freeform text:
   - Match lines containing `file:line [SEVERITY]` patterns
   - Extract REQ-ID references (REQ-\d+)
   - If no structured data extractable → health score LOW for that reviewer

---

## 4. Finding Matching Algorithm

### 4.1 Grouping

```
Group all findings by file path.
Within each file group, compare findings from different reviewers.
```

### 4.2 Matching Rules (priority order)

1. **Symbol match**: Both reference the same function/class name → MATCH
2. **Line proximity**: line distance < 20 lines → MATCH candidate
3. **Keyword similarity**: Jaccard coefficient > 0.5 on meaningful tokens → MATCH candidate
4. **No match**: Finding is unique to one reviewer

### 4.3 Classification

```
matched_group = all findings matched together
supporters = count of unique reviewers in matched_group

Classification thresholds (R = number of available reviewers):

VETO classes (evaluate before consensus thresholds):
  severity == CRITICAL and finding_class in [preservation, scope, authority, release]
    → VETO even with one supporter; never AUTO-DISMISS and never count the round CLEAN

CRITICAL severity:
  supporters == R → CONFIRMED (unanimous)
  supporters >= 2 → CONTESTED (needs arbiter)
  supporters == 1 and R >= 3 → AUTO-DISMISSED only for non-veto correctness findings
  else → CONTESTED

HIGH/MEDIUM/LOW/INFO severity:
  supporters >= max(2, ceil(R/2)) → CONFIRMED
  supporters == 1 and R >= 3 → AUTO_DISMISSED
  else → CONTESTED
```

**Key rule:** consensus confirms ordinary correctness findings. It does not erase a
specific destructive-change warning. A solo CRITICAL preservation, scope, authority,
or release finding is a blocking veto until the evidence is corrected or the user grants
surface-specific authority.

---

## 5. Arbitration Protocol

### 5.1 Arbiter Must Be Separate from Reviewers

The arbiter tool must NOT be in the reviewer pool for the current stage.
If the default config assigns the same tool as both reviewer and arbiter
(e.g., claude as reviewer AND arbiter), the orchestrator auto-resolves:
- Remove arbiter tool from reviewer pool, OR
- Use a different model/tier for arbitration, OR
- Fall back to user escalation

**Arbiter auto-selection algorithm** (when config says `arbiter: auto`):

```
1. List all configured tools not in the current reviewer pool
2. Rank by capability tier: claude > gemini > opencode > codex (configurable)
3. Select highest-ranked available tool
4. If none is available outside the reviewer pool → run deterministic/source-evidence
   verification and retry an independent arbiter; ask only if a material decision remains
```

### 5.2 When Arbiter Exists (development, integration)

For CONTESTED findings:

Veto findings do not enter ordinary arbitration. An arbiter may verify objective evidence,
but may not invent or dismiss user authority, reinterpret an additive request as replacement,
or approve release while required evidence is NOT CLEAN. Resolve a veto only by restoring the
preserved surface, supplying the missing immutable evidence, or obtaining exact user approval
for the named `replace|remove|disable|redirect|migrate` disposition.

```
1. Compose arbitration prompt:
   - The finding (file, line, description, severity)
   - Supporting reviewer's argument
   - Opposing reviewer's argument (or absence)
   - Actual code: file content ± 20 lines around the finding
   - Relevant REQ-ID acceptance criteria (if any)

2. Invoke arbiter (separate CLI session, read-only tools only):
   Parse output for: CONFIRMED or DISMISSED + rationale

3. Apply decision:
   CONFIRMED → add to confirmed list for auto-fix
   DISMISSED → add to known_issues with suppress_hash
```

### 5.3 When No Arbiter Is Immediately Available

Do not turn CONTESTED into an automatic user prompt. Re-check the immutable source,
requirements, code, and test evidence; then retry with an independent arbiter outside the
reviewer pool. Evidence-confirmed in-scope defects are auto-fixed and re-reviewed. Ask the
user only when evidence cannot resolve a material design, business, product, scope, authority,
or irreversible/external-impact decision.

---

## 6. Convergence Loop

### 6.1 Main Loop

#### Lens Iteration Strategy

Development and test may send all active lenses to standard reviewers. Planning and
integration instead invoke the four separated roles from section 1.1 with role-specific
evidence views:

```
if stage in [planning, integration]:
    role_prompts = build_separated_prompts(
      source_fidelity, baseline_preservation, implementation_test, authority_release
    )
    role_runs = assign_available_adapters(
      role_prompts,
      prefer_distinct_provider=true,
      prefer_distinct_model=true,
      require_distinct_execution=true
    )
    first_verdicts = parallel_invoke(role_runs)
    require_exact_role_coverage(first_verdicts)
    findings = compare_role_outputs(first_verdicts)
else:
    active_lenses = resolve_lenses(stage, req_ids_provided)
    reviewer_prompt = build_prompt(stage, files, req_ids, known_issues, active_lenses)
```

Do not send the same generated summary to all four roles. Shared input anchoring defeats
reviewer independence even when models differ. Roles see one another's outputs only in the
comparison round after their first verdicts are fixed.

In `--light` mode only the first lens is sent for eligible development/test work. Planning and
integration cannot use `--light`.

#### Loop Algorithm

```
consecutive_clean = 0
pass_number = 1
review_log = []
known_issues = []
arbiter_available = resolve_arbiter(stage_config)  # true if auto-select finds one, or explicit
max_rounds = 8
start_time = now()

while consecutive_clean < convergence_threshold:
    # 0) Budget check
    if pass_number > max_rounds:
        break with warning "Max rounds reached."
    if (now() - start_time) > max_total_time:
        break with warning "Time budget exceeded."
    
    # 1) Resolve executions. R means independent executions, not provider count.
    available_adapters = check_adapters(stage_config)
    if len(available_adapters) == 0: abort("No review adapter available")
    if stage in [planning, integration]:
        active_runs = schedule_four_roles(available_adapters)
        validate_distinct_role_executions(active_runs)  # exact 4-role coverage or NOT_CLEAN
    else:
        active_runs = schedule_standard_reviewers(available_adapters)
    R_actual = len(active_runs)
    apply_graceful_degradation(stage, active_runs)

    # 2) Ensure arbiter is not in reviewer pool
    if arbiter in active_runs:
        active_runs.remove(arbiter)
        R_actual = len(active_runs)
    
    # 3) Run independent reviews (Phase 1)
    findings_per_reviewer = parallel_invoke(active_runs, stage, pass_number, known_issues)

    # 4) Parse findings
    all_findings = flat_map(parse, findings_per_reviewer)

    # 5) Match + vote (Phase 2)
    classified = match_and_classify(all_findings, R_actual)
    confirmed = classified.filter(c -> c.type == CONFIRMED)
    contested = classified.filter(c -> c.type == CONTESTED)
    vetoes = classified.filter(c -> c.type == VETO)

    # 6) Resolve CONTESTED (Phase 3); vetoes require restoration, evidence, or user authority
    for finding in contested:
        if arbiter_available and arbiter not in active_runs:
            decision = arbitrate(finding)
            if decision == CONFIRMED: confirmed.append(finding)
            else: known_issues.add(finding)
        else:
            options = "[F] Fix  [D] Dismiss"
            if arbiter_configured: options += "  [A] Retry with arbiter"
            user_decision = prompt_user(finding, options)
            if user_decision == FIX: confirmed.append(finding)
            elif user_decision == RETRY_WITH_ARBITER and arbiter_available:
                decision = arbitrate(finding)
                if decision == CONFIRMED: confirmed.append(finding)
                else: known_issues.add(finding)
            else: known_issues.add(finding)  # DISMISS

    # 7) Auto-fix CONFIRMED (with safety guard, see section 6.5)
    mandatory_evidence_ok = validate_required_inputs_and_preservation_probes(stage)
    if vetoes.length > 0:
        consecutive_clean = 0
        review_log.append({round: pass_number, result: "NOT_CLEAN", vetoes: vetoes})
    elif confirmed.length > 0:
        snapshot = git_stash_or_snapshot()
        for finding in confirmed: apply_fix(finding)
        diff = show_diff(snapshot)
        # Diff is logged. If rollback needed, restore from snapshot.
        consecutive_clean = 0
        review_log.append({round: pass_number, result: "FIXED", count: confirmed.length, diff: diff})
    elif contested.length == 0 and mandatory_evidence_ok:
        consecutive_clean += 1
        review_log.append({round: pass_number, result: "CLEAN"})
    else:
        consecutive_clean = 0
        review_log.append({round: pass_number, result: "NOT_CLEAN", reason: "unresolved or missing evidence"})

    # 8) Invalidate stale known_issues
    invalidate_known_issues_on_code_change()

    pass_number += 1

# Output final report
```

`CLEAN` requires all four conditions: mandatory inputs are valid, all preservation probes
pass, no unresolved/contested finding remains, and no veto exists. Budget exhaustion,
reviewer-role degradation, missing evidence, or a veto yields `NOT_CLEAN`, never partial Clean.

### 6.2 Convergence Thresholds by Stage

| Stage | Standard | --light |
|-------|----------|---------|
| planning | 2 clean | forbidden |
| development | 2 clean | 1 clean |
| test | 2 clean | 1 clean (non-governed only) |
| integration | 2 clean | forbidden |

### 6.3 Budget Guard

```yaml
budget:
  per_call_timeout:
    planning: 60
    development: 120
    test: 60
    integration: 120
  max_rounds: 8
  max_total_time_min: 30
```

Enforced in loop: `pass_number > max_rounds` or `elapsed > max_total_time_min`.
Both checks are hard limits, not advisory. On trigger: report findings so far.

### 6.4 Rollback Mechanism

Before auto-fix:
```
snapshot = create_snapshot()
  → git stash (if git repo) or copy files in {files} argument to temp dir
```

After auto-fix, if review reveals the fix was wrong:
```
restore_snapshot(snapshot)
  → git stash pop or copy temp files back
```

Snapshot scope: all files in the `{files}` argument (known targets of the review).

### 6.5 Safety Guard for Auto-fix

Auto-fix is applied directly (reviewers are read-only; the orchestrator applies
fixes using its own edit tools). After all fixes in a round:
1. Compute diff against pre-fix snapshot
2. Log the diff in review_log
3. If any reviewer's health score is LOW (<40, see section 8): warn and offer rollback

### 6.6 No Re-entry Problem

The loop does not pause merely because a finding is CONTESTED. It preserves state while
independent arbitration and source-evidence verification run. Only a remaining material
decision pauses for user input, after which the same loop iteration resumes.
All prior state (known_issues, review_log, consecutive_clean) is preserved.

---

## 7. Graceful Degradation

```
configured_adapters = resolve_configured_adapters()
available_adapters = adapters_that_respond_within_timeout(configured_adapters)

if available_adapters.length < configured_adapters.length:
    warn("Degraded adapters: {unavailable_adapters}")

if stage in [planning, integration]:
    role_runs = schedule_four_roles(available_adapters)
    if successful_distinct_role_runs(role_runs) < 4:
        stop with NOT_CLEAN("Four distinct role executions are mandatory")
    if duplicate_role(role_runs) or duplicate_execution_identity(role_runs):
        stop with NOT_CLEAN("Role or execution identity was reused")
else:
    R_configured = stage_reviewer_count()
    R_available = count_available_standard_reviewers()

    if R_available == R_configured - 1 and R_configured >= 3:
        disable AUTO_DISMISS (needs R>=3)
        continue

    if R_available == 1:
        convergence_threshold = max(convergence_threshold, 2)
        warn("Single reviewer. Convergence increased to {convergence_threshold}")

    if R_available == 0:
        abort("No review tools available. Cannot proceed.")
```

---

## 8. Health Score (per-reviewer, no extra API calls)

Computed from each reviewer's parsed output, in-context:

```
signals (each 0 or 1):
  files_read:   files_read section non-empty → 1
  specificity:  (findings with file:line or file:symbol) / max(findings, 1) > 0.5 → 1
  req_aligned:  findings reference REQ-IDs when applicable → 1
  verdict_ok:   (findings > 0 ↔ verdict == FOUND_ISSUES) → 1

health = (files_read * 0.2 + specificity * 0.3 + req_aligned * 0.3 + verdict_ok * 0.2) * 100

if health < 40:
  warn("Reviewer {reviewer} quality low (health={health}). Consider different model.")
  Do NOT auto-dismiss based solely on low-health reviewer output
  Flag findings from low-health reviewers as lower confidence in report
```

**At R=2**: Per-reviewer health is computed independently using the same formula.
Inter-reviewer agreement is tracked separately as a binary (both agree on verdict or not)
and reported in the final report, but does not affect the health score.

---

## 9. Anti-Anchoring

### 9.1 known_issues Suppression

Dismissed findings are added to `known_issues` to prevent re-reporting.
Each entry includes a `suppress_hash`:

```
range = [max(1, finding.line - 10) : finding.line + 10]
suppress_hash = sha256(read_file(file) for lines in range)
```

For findings without a line number: hash the entire file.
For untracked files: hash the working tree content.

### 9.2 Invalidation

Before each round, re-check known_issues:

```
for each item in known_issues:
    try:
        current_hash = sha256(read_file(item.file) for lines in item.range)
    catch (file deleted or range invalid):
        remove from known_issues  # file changed fundamentally
        continue
    if current_hash != item.suppress_hash:
        remove from known_issues  # code changed — allow re-detection
```

---

## 10. Configuration

### 10.1 Config Search Order

The skill searches for configuration in this order (first found wins):

1. `./review-pass.yaml` — project root
2. `{skill_dir}/config.yaml` — skill directory (wherever SKILL.md lives)
3. `$XDG_CONFIG_HOME/review-pass/config.yaml` — user-level (Linux/macOS)
4. `%APPDATA%/review-pass/config.yaml` — user-level (Windows)

If no config found: use built-in defaults from section 10.2.

Merge strategy: config files fully replace the defaults for the sections they
define. Partial overrides are not merged — each section is all-or-nothing.

### 10.2 Default Profile

```yaml
tools:
  claude:
    command: 'claude -p --output-format json --allowedTools "Read,Glob,Grep" --max-turns 5'
    stdin: true
    parse: json
  gemini:
    command: 'gemini -p "{prompt}" -m gemini-2.5-flash'
    stdin: false
    parse: text_fallback
  opencode:
    command: 'opencode run "{prompt}" --dir "{repo}" -m {model}'
    stdin: false
    parse: text_fallback
  codex:
    command: 'codex exec "{prompt}" --sandbox read-only --full-auto'
    stdin: false
    parse: text_fallback

# Requirements management (optional — skip if not applicable)
requirements:
  dir: ""  # directory containing REQ-{NNN}-*.yaml files
  file_pattern: "REQ-*-{kebab}.yaml"  # {kebab} = kebab-case title fragment

stages:
  planning:
    reviewers: []  # empty means schedule roles from any available adapter; distinct provider/model preferred
    roles: [source_fidelity, baseline_preservation, implementation_test, authority_release]
    arbiter: null
    convergence: 2
    lenses: [source_fidelity, design_coherence, feasibility, preservation_setup, context_output_separation, audience_surface_fit, unjustified_product_surface]
    lenses_no_req: [source_fidelity, design_coherence, feasibility, preservation_setup, context_output_separation, audience_surface_fit, unjustified_product_surface]
  development:
    reviewers: [gemini, opencode, codex]
    arbiter: claude  # MUST NOT be in reviewers — orchestrator auto-resolves
    convergence: 2
    lenses: [correctness, completeness, consistency, pattern_compliance, req_to_code, context_output_separation, audience_surface_fit, unjustified_product_surface]
    lenses_no_req: [correctness, completeness, consistency, pattern_compliance, context_output_separation, audience_surface_fit, unjustified_product_surface]
  test:
    reviewers: [gemini, opencode]
    arbiter: null
    convergence: 2
    lenses: [test_validity, coverage, assertion_quality, req_to_test, context_output_separation, audience_surface_fit, unjustified_product_surface]
    lenses_no_req: [test_validity, coverage, assertion_quality, context_output_separation, audience_surface_fit, unjustified_product_surface]
  integration:
    reviewers: []  # empty means schedule roles from any available adapter; distinct provider/model preferred
    roles: [source_fidelity, baseline_preservation, implementation_test, authority_release]
    arbiter: null  # all tools are independent roles; user resolves semantic vetoes
    convergence: 2
    lenses: [source_to_release, cross_stage_consistency, baseline_preservation, authority_release, context_output_separation, audience_surface_fit, unjustified_product_surface]
    lenses_no_req: [source_to_release, cross_stage_consistency, baseline_preservation, authority_release, context_output_separation, audience_surface_fit, unjustified_product_surface]
```

### 10.3 Per-Project Override

Create `./review-pass.yaml` in the project root:

```yaml
tools:
  opencode:
    command: 'opencode run "{prompt}" --dir "{repo}" -m zai-coding-plan/glm-5.1'
requirements:
  dir: ".agents/requirements"
stages:
  development:
    reviewers: [gemini, opencode]
    convergence: 1
```

### 10.4 Environment Detection

Auto-detect available tools at runtime:

**PowerShell:**
```powershell
foreach ($tool in $configuredTools.Keys) {
    if (Get-Command $tool -ErrorAction SilentlyContinue) {
        $available += $tool
    }
}
```

**Bash:**
```bash
for tool in "${!configured_tools[@]}"; do
    if command -v "$tool" &>/dev/null; then
        available+=("$tool")
    fi
done
```

---

## 11. REQ-ID Integration (Optional)

### 11.1 When req_ids Argument Is Provided

1. Locate REQ files using `requirements.dir` + `requirements.file_pattern` from config
2. Load each REQ file, extract acceptance_criteria
3. Include criteria in reviewer prompts
4. Validate: each non-deferred REQ-ID has code coverage (development) or test coverage (test)
5. Integration stage: full chain trace — issue → REQ → code → test
6. Non-deferred, uncovered REQ-IDs block convergence (treated as findings)
7. Deferred REQ-IDs (from `deferred_req_ids` arg or REQ file `status: deferred`)
   are noted in the report but do NOT block convergence

### 11.2 When req_ids Is Not Provided

REQ-related lenses are replaced by `lenses_no_req` equivalents from the profile.
Review proceeds normally without REQ-ID tracking.

### 11.3 Source Authority Rule

Every requirement and acceptance criterion must identify immutable source references. A
top-level statement such as "the whole conversation" is not enough. When sources conflict:

| REQ `source` field | Resolution rule |
|--------------------|----------------|
| `candidate` (retrofitted from code) | Code is source of truth. REQ is descriptive. |
| `derived` (AI interpretation) | Must name `derived_from`; may clarify but never narrow, supersede, or reverse a human directive. |
| `human` (user-specified) | Normative only when bound to an immutable exact source reference; code and derived artifacts must conform. |
| missing or ambiguous | Blocking source-fidelity finding; the review is `NOT_CLEAN`. |

An AI-authored issue, comment, summary, or REQ does not become human authority because it was
posted through the user's account. Supersession and destructive disposition require explicit,
surface-specific user approval.

---

## 12. Final Report Format

After convergence or budget exceeded:

```
## Review Pass Report

**Stage**: {stage}
**Rounds**: {total_rounds}
**Reviewers**: {reviewer_list} (R={R_actual})
**Result**: {CLEAN | NOT_CLEAN}
**Delivery state**: {RELEASE_ELIGIBLE | REVIEW_ONLY}
**Duration**: {elapsed_time}

### Summary
- CONFIRMED findings: {n} (all auto-fixed with diff)
- CONTESTED resolved: {n} ({via_arbiter} by arbiter, {via_user} by user)
- Remaining escalations: {n}
- Blocking vetoes: {n}
- Preservation probes: {passed}/{total}

### REQ-ID Coverage (if applicable)
- REQ-001: COVERED (src/file.ts:SymbolName)
- REQ-002: NOT FOUND — needs implementation
- REQ-003: DEFERRED (intentionally)

### Escalation List (unresolved CONTESTED from user prompts)
{numbered list, if any remain after user resolved inline during loop}

### Review Log
| Round | Lens | Result | Details |
|-------|------|--------|---------|
| 1 | correctness | FIXED | 3 findings (diff attached) |
| 2 | completeness | FIXED | 1 finding |
| 3 | — | CLEAN | — |
| 4 | — | CLEAN | Converged |

### Reviewer Health Scores
| Reviewer | Health | Notes |
|----------|--------|-------|
| gemini | 85 | Good specificity |
| opencode | 45 | Low — consider different model |
```

---

## 13. Finding Classification: Auto-fix vs. Escalation

**RULE: Spec/standard lookup test (apply first)**

If the conflict is answerable by reading an external spec, standard, or upstream
source code — it is **NOT** an escalation. Research it and fix directly.

**Auto-fix** (no user needed):
- Wrong logic, off-by-one, missing null check
- Convention violations (verifiable by reading project config)
- Missing error handling
- Test that doesn't actually test what it claims
- Unused imports, dead code

**Escalate** (user decision needed):
- Business logic direction (A vs B approach)
- Design decisions with no objective right answer
- Scope questions (should this be done here or separately?)
- Requirements ambiguity (REQ says X but could mean Y)
- Changes that affect public API or user-facing behavior
- Any `replace|remove|disable|redirect|migrate` disposition or change to a primary entry, discovery/binding path, exported contract, package/deployment target, or handoff artifact
- Any request to dismiss a preservation, scope, authority, or release veto

---

## 14. Light Mode (`--light`)

Applied when the user explicitly specifies `--light`:

| Item | Standard | Light |
|------|----------|-------|
| Convergence | per-stage default | 1 clean round |
| Lenses | all stage lenses | first lens only |
| Max rounds | 8 | 4 |
| Applicable | feature work, major changes | development/test typo fixes and non-feature config only; never planning/integration |

The orchestrator must NOT choose light mode autonomously.

---

## 15. Delivery Gate

- `CLEAN` plus current, trusted preservation evidence yields `RELEASE_ELIGIBLE` only after every REQUIRED control is implemented and verified. A generic runtime Clean does not override a PENDING preservation control.
- Any missing input, unresolved finding, veto, failed probe, budget exhaustion, or insufficient
  reviewer-role separation yields `NOT_CLEAN` and `REVIEW_ONLY`.
- `REVIEW_ONLY` may be committed locally as a checkpoint. Remote review-branch push is publication
  and is forbidden until an exact signed checkpoint-publication operation is implemented and tested.
  It must not merge, deploy, publish a release, close the issue, or use completion language.
- Deployment and release automation must consume the delivery state and fail closed unless it is
  `RELEASE_ELIGIBLE`. Built-in release-command regexes are supplemental detection, not a complete
  security boundary; each project must provide a strict adapter declaration for every external-side-
  effect operation. A test-count summary is not a substitute for this state.
