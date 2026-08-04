# Stage Profiles and Reviewer Roles

## Contents

- [Stage profiles](#1-stage-profiles-defaults-overridable-via-config)
- [Planning](#planning)
- [Development](#development)
- [Test](#test)
- [Integration](#integration)
- [Separated reviewer roles](#11-separated-reviewer-roles)

## 1. Stage Profiles (defaults, overridable via config)

Each lens includes actionable checks for headless reviewers.

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
  6. `structural_complexity` — Check: consume the deterministic complexity report; split new/expanded oversized files by cohesive responsibility; verify every complexity-waiver reason against actual code
- **Lenses (without REQ-IDs)**:
  1. `correctness` — (same as above)
  2. `completeness` — Check: all planned items implemented; no missing files; no TODO stubs
  3. `consistency` — (same as above)
  4. `pattern_compliance` — (same as above)
  5. `structural_complexity` — (same as above; deterministic preflight is mandatory without REQ-IDs too)

### test
- **Reviewers**: 2 (configurable)
- **Convergence**: 2 consecutive clean rounds (1 only in explicit non-governed `--light`)
- **Arbiter**: none (CONTESTED → inline user prompt, loop resumes)
- **Lenses (with REQ-IDs)**:
  1. `test_validity` — Check: tests import and call the changed code; assertions execute after the code under test runs; mocks don't replace the actual logic being tested
  2. `coverage` — Check: all REQ-IDs have corresponding test cases; negative cases exist; edge cases tested
  3. `assertion_quality` — Check: assertions check specific values not just "not null"; no assertions that always pass; error messages are meaningful
  4. `req_to_test` — Check: each REQ-ID maps to specific test file + test name; test names reflect the requirement
  5. `test_structure` — Check: oversized test files are split by behavior boundary so reviewers can trace import→call→assertion without loading unrelated scenarios; validate any waiver claim
- **Lenses (without REQ-IDs)**:
  1. `test_validity` — (same as above)
  2. `coverage` — Check: all changed code paths are tested; negative cases exist; edge cases tested
  3. `assertion_quality` — (same as above)
  4. `test_structure` — (same as above)

### integration
- **Reviewers**: 4 separated role executions (tool-independent; roles are not optional)
- **Convergence**: the general two-Clean floor plus four new integration role executions; planning receipts cannot be reused (`--light` forbidden)
- **Arbiter**: separate tool from reviewer set (configurable, must not be in reviewer pool)
- **Lenses (with REQ-IDs)**:
  1. `source_to_release` — Check: original source→REQ→plan→code→test→runtime→delivery state is complete, with no AI-derived authority substitution
  2. `cross_stage_consistency` — Check: plan description matches code; code matches tests; no contradictions between any two stages
  3. `baseline_preservation` — Check: every `preserve|extend` evidence pair matches baseline behavior; every `replace|remove|disable|redirect|migrate` has exact `authority_id`, matching `expected_diff_digest`, and valid current paths except for `remove`
  4. `authority_release` — Check: incident history is resolved, review evidence is current, and NOT CLEAN work is restricted to REVIEW_ONLY
  5. `complexity_release` — Check: no unwaived deterministic refactor requirement remains and every surviving waiver claim matches current hash-bound code
- **Lenses (without REQ-IDs)**:
  1. `source_to_release` — (same as above; source authority is required even without REQ-IDs)
  2. `cross_stage_consistency` — (same as above)
  3. `baseline_preservation` — (same as above)
  4. `authority_release` — (same as above)
  5. `complexity_release` — (same as above)

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
