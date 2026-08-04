# Consensus and Convergence

## Contents

- [Finding matching](#4-finding-matching-algorithm)
- [Arbitration](#5-arbitration-protocol)
- [Convergence loop](#6-convergence-loop)
- [Graceful degradation](#7-graceful-degradation)
- [Reviewer health](#8-health-score-per-reviewer-no-extra-api-calls)
- [Anti-anchoring](#9-anti-anchoring)

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
   - For a complexity finding: the complete current complexity report and its
     `complexitySha256`; the arbiter must echo that exact digest

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

    # 1) Execute the mandatory repository-wide preflight command shown above.
    preflight = execute_review_preflight_command(repo, immutable_baseline_ref)
    complexity = preflight.complexity
    if preflight.verdict == "NOT_CLEAN":
        consecutive_clean = 0
        review_log.append({round: pass_number, result: "NOT_CLEAN", reason: "REFACTOR_REQUIRED"})
    # Keep running reviewers so they can validate WARN and WAIVED claims and propose bounded splits.

    # 2) Resolve executions. R means independent executions, not provider count.
    available_adapters = check_adapters(stage_config)
    if len(available_adapters) == 0: abort("No review adapter available")
    if stage in [planning, integration]:
        active_runs = schedule_four_roles(available_adapters)
        validate_distinct_role_executions(active_runs)  # exact 4-role coverage or NOT_CLEAN
    else:
        active_runs = schedule_standard_reviewers(available_adapters)
    R_actual = len(active_runs)
    apply_graceful_degradation(stage, active_runs)

    # 3) Ensure arbiter is not in reviewer pool
    if arbiter in active_runs:
        active_runs.remove(arbiter)
        R_actual = len(active_runs)

    # 4) Run independent reviews (Phase 1)
    findings_per_reviewer = parallel_invoke(active_runs, stage, pass_number, known_issues)

    # 5) Parse findings
    all_findings = flat_map(parse, findings_per_reviewer)

    # 6) Match + vote (Phase 2)
    classified = match_and_classify(all_findings, R_actual)
    confirmed = classified.filter(c -> c.type == CONFIRMED)
    contested = classified.filter(c -> c.type == CONTESTED)
    vetoes = classified.filter(c -> c.type == VETO)

    # 7) Resolve CONTESTED (Phase 3); vetoes require restoration, evidence, or user authority
    for finding in contested:
        if arbiter_available and arbiter not in active_runs:
            decision = arbitrate(finding)
            if decision == CONFIRMED: confirmed.append(finding)
            else: known_issues.add(finding)
        else:
            evidence = revalidate_primary_source_requirements_code_and_tests(finding)
            if evidence == CONFIRMED:
                confirmed.append(finding)
            elif independent_arbiter_becomes_available():
                decision = retry_with_independent_arbiter(finding, evidence)
                if decision == CONFIRMED: confirmed.append(finding)
                else: known_issues.add(finding)
            elif material_user_decision_remains(finding, evidence):
                user_decision = prompt_user_for_material_decision(finding, evidence)
                if user_decision == FIX: confirmed.append(finding)
                else: known_issues.add(finding)
            else:
                known_issues.add(finding)

    # 8) Auto-fix CONFIRMED (with safety guard, see section 6.5)
    mandatory_evidence_ok = validate_required_inputs_and_preservation_probes(stage)
    if vetoes.length > 0:
        consecutive_clean = 0
        review_log.append({round: pass_number, result: "NOT_CLEAN", vetoes: vetoes})
    elif confirmed.length > 0:
        snapshot = create_isolated_snapshot(complete_changed_set)
        for finding in confirmed: apply_fix(finding)
        diff = show_diff(snapshot)
        # Diff is logged. If rollback needed, restore from snapshot.
        consecutive_clean = 0
        review_log.append({round: pass_number, result: "FIXED", count: confirmed.length, diff: diff})
    elif contested.length == 0 and mandatory_evidence_ok and complexity_review_is_current_and_verified(preflight, all_findings):
        consecutive_clean += 1
        review_log.append({round: pass_number, result: "CLEAN"})
    else:
        consecutive_clean = 0
        review_log.append({round: pass_number, result: "NOT_CLEAN", reason: "unresolved or missing evidence"})

    # 9) Invalidate stale known_issues
    invalidate_known_issues_on_code_change()

    pass_number += 1

# Output final report
```

`CLEAN` requires all five conditions: mandatory inputs are valid, all preservation probes
pass, deterministic complexity has no unwaived requirement or mismatched waiver, no
unresolved/contested finding remains, and no veto exists. Budget exhaustion,
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
snapshot = create_isolated_snapshot(complete_changed_set)
  → copy every changed/untracked file byte plus deletion, type, and mode metadata to an
    owner-only temporary directory; record an exact SHA-256 manifest
  → do not run git stash, reset, checkout, or any operation that mutates unrelated user changes
```

After auto-fix, if review reveals the fix was wrong:
```
restore_snapshot(snapshot)
  → verify the snapshot manifest and the expected post-fix hashes first
  → restore only the paths changed by the recorded auto-fix; if any path has drifted outside
    that exact diff, stop for manual reconciliation instead of overwriting it
```

Snapshot scope: the complete repository changed set, including untracked paths and metadata.
The restore scope remains the exact auto-fix diff so unrelated work is preserved.

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
