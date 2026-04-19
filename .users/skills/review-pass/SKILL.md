---
name: review-pass
version: "3.0"
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
- **Multi-AI**: Independent reviewers via CLI tools reduce single-model blind spots
- **Stage-aware**: Planning, development, test, and integration have different needs
- **Convergent**: Automated loop until N consecutive clean rounds
- **Traceable**: REQ-ID coverage validated at every stage (when applicable, optional)
- **Safe**: Auto-fix with diff preview, rollback, and safety guard

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `stage` | **yes** | `planning` / `development` / `test` / `integration` |
| `files` | **yes** | Comma-separated file paths to review |
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
> **CONTESTED findings at R=2 trigger inline user prompt, then loop resumes.**
> **Only the final report is shown after convergence.**

---

## 1. Stage Profiles (defaults, overridable via config)

Each lens includes actionable checks for headless reviewers.

### planning
- **Reviewers**: 2 (configurable)
- **Convergence**: 1 consecutive clean round
- **Arbiter**: none (CONTESTED → inline user prompt, loop resumes)
- **Lenses (with REQ-IDs)**:
  1. `req_completeness` — Check: every requirement from the issue has a REQ-ID; no orphan REQ-IDs; acceptance criteria are testable
  2. `design_coherence` — Check: no internal contradictions between sections; dependencies are identified; scope is bounded
  3. `feasibility` — Check: technical approach is realistic; no assumed-but-unverified capabilities; effort estimate matches scope
  4. `traceability_setup` — Check: each REQ-ID has acceptance criteria; each criterion is independently verifiable; test method is stated
- **Lenses (without REQ-IDs)**:
  1. `completeness` — Check: all stated goals have implementation steps; no missing sections; edge cases identified
  2. `design_coherence` — (same as above)
  3. `feasibility` — (same as above)
  4. `clarity` — Check: unambiguous language; no undefined terms; a new team member could implement from this plan

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
- **Convergence**: 1 consecutive clean round
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
- **Reviewers**: 3 (configurable)
- **Convergence**: 2 consecutive clean rounds (1 in --light)
- **Arbiter**: separate tool from reviewer set (configurable, must not be in reviewer pool)
- **Lenses (with REQ-IDs)**:
  1. `req_trace_e2e` — Check: every REQ-ID traceable issue→plan→code→test; no orphan REQ-IDs at any stage; full chain for each
  2. `cross_stage_consistency` — Check: plan description matches code; code matches tests; no contradictions between any two stages
  3. `regression_risk` — Check: existing tests still pass; no breaking API changes; config changes are backward-compatible
  4. `drift_detection` — Check: implementation matches plan intent (not just letter); no scope creep; no missing pieces from original plan
- **Lenses (without REQ-IDs)**:
  1. `completeness_e2e` — Check: all planned changes are implemented and tested; nothing dropped silently
  2. `cross_stage_consistency` — (same as above)
  3. `regression_risk` — (same as above)
  4. `drift_detection` — (same as above)

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

Every reviewer receives a prompt containing:

```
## Review Context
Stage: {stage}
Files: {file_list}
REQ-IDs: {req_ids or "N/A for this review"}
Deferred REQ-IDs: {deferred or "none"}
Known issues from previous rounds: {known_issues or "none"}

## Review Lens
Lens: {lens_name}
Checks to perform:
{actionable_checklist_from_stage_definition}

## Output Format (MANDATORY)
### Files Read
- path/to/file (lines X-Y)

### Findings
- `file:line [CRITICAL|HIGH|MEDIUM|LOW|INFO] REQ-ID — description`
  (REQ-ID is optional; include only if the finding relates to a specific requirement)
or
NONE

### REQ-ID Coverage (skip if no REQ-IDs provided)
- REQ-001: COVERED (path/to/file:symbol_name)
- REQ-002: NOT FOUND
or ALL COVERED or N/A

### Verdict
CLEAN | FOUND_ISSUES
```

### 3.2 Finding Schema

```
Finding {
  file: string           // file path
  line: number | null    // line number (null for file-level)
  symbol: string | null  // function/class/symbol name
  severity: CRITICAL | HIGH | MEDIUM | LOW | INFO
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

CRITICAL severity:
  supporters == R → CONFIRMED (unanimous)
  supporters >= 2 → CONTESTED (needs arbiter)
  supporters == 1 and R >= 3 → AUTO-DISMISSED
  else → CONTESTED

HIGH/MEDIUM/LOW/INFO severity:
  supporters >= max(2, ceil(R/2)) → CONFIRMED
  supporters == 1 and R >= 3 → AUTO_DISMISSED
  else → CONTESTED
```

**Key rule: at any R, a single reviewer's finding is NEVER auto-confirmed.
Minimum supporters for CONFIRMED is always >= 2, or unanimous for CRITICAL.**

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
4. If none available outside reviewer pool → fall back to user escalation
   (no inline arbiter possible at this stage)
```

### 5.2 When Arbiter Exists (development, integration)

For CONTESTED findings:

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

### 5.3 When No Arbiter (planning, test — typically R=2)

CONTESTED findings trigger an **inline user prompt, then loop resumes**:

```
"Round {N}: Reviewer A found [{severity}] {finding_description}
 Reviewer B did not flag this.
 
 Please judge:
 [F] Fix it (treat as CONFIRMED)
 [D] Dismiss it (add to known_issues)
 [A] Retry with arbiter (spawn arbiter for this finding)"
```

After user responds:
- Fix → add to confirmed, auto-fix, continue loop
- Dismiss → add to known_issues, continue loop
- Retry → invoke arbiter per section 5.2, then continue loop

The loop does NOT break. It pauses for user input, then resumes.

---

## 6. Convergence Loop

### 6.1 Main Loop

#### Lens Iteration Strategy

Each round sends ALL active lenses to ALL reviewers simultaneously:

```
active_lenses = resolve_lenses(stage, req_ids_provided)
  → uses lenses_no_req if no req_ids, otherwise lenses

reviewer_prompt = build_prompt(
  stage, files, req_ids, known_issues,
  lenses: active_lenses  // ALL lenses in one prompt
)
```

All reviewers receive the same prompt with all active lenses. This maximizes
coverage per round and reduces total rounds needed. Each reviewer checks all
lenses independently (natural isolation between reviewers).

In --light mode: only the first lens is sent, reducing prompt size and focus.

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
    
    # 1) Check available reviewers
    available = check_tools(reviewers)
    R_actual = len(available)
    if R_actual == 0: abort("No review tools available")
    apply_graceful_degradation(R_actual)

    # 2) Ensure arbiter is not in reviewer pool
    if arbiter in available:
        available.remove(arbiter)
        R_actual = len(available)
    
    # 3) Run independent reviews (Phase 1)
    findings_per_reviewer = parallel_invoke(available, stage, pass_number, known_issues)

    # 4) Parse findings
    all_findings = flat_map(parse, findings_per_reviewer)

    # 5) Match + vote (Phase 2)
    classified = match_and_classify(all_findings, R_actual)
    confirmed = classified.filter(c -> c.type == CONFIRMED)
    contested = classified.filter(c -> c.type == CONTESTED)

    # 6) Resolve CONTESTED (Phase 3)
    for finding in contested:
        if arbiter_available and arbiter not in available:
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
    if confirmed.length > 0:
        snapshot = git_stash_or_snapshot()
        for finding in confirmed: apply_fix(finding)
        diff = show_diff(snapshot)
        # Diff is logged. If rollback needed, restore from snapshot.
        consecutive_clean = 0
        review_log.append({round: pass_number, result: "FIXED", count: confirmed.length, diff: diff})
    else:
        consecutive_clean += 1
        review_log.append({round: pass_number, result: "CLEAN"})

    # 8) Invalidate stale known_issues
    invalidate_known_issues_on_code_change()

    pass_number += 1

# Output final report
```

### 6.2 Convergence Thresholds by Stage

| Stage | Standard | --light |
|-------|----------|---------|
| planning | 1 clean | 1 clean |
| development | 2 clean | 1 clean |
| test | 1 clean | 1 clean |
| integration | 2 clean | 1 clean |

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

The loop does NOT break on escalation. It uses inline user prompts that
pause execution, get a response, and continue the same loop iteration.
All prior state (known_issues, review_log, consecutive_clean) is preserved.

---

## 7. Graceful Degradation

```
R_configured = profile.reviewers.length
R_available = count of tools that respond within timeout

if R_available < R_configured:
    warn("Degraded: {unavailable_tools} not available. R={R_available}")

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
    command: 'codex exec - --sandbox read-only --full-auto'
    stdin: true
    parse: text_fallback

# Requirements management (optional — skip if not applicable)
requirements:
  dir: ""  # directory containing REQ-{NNN}-*.yaml files
  file_pattern: "REQ-*-{kebab}.yaml"  # {kebab} = kebab-case title fragment

stages:
  planning:
    reviewers: [claude, gemini]
    arbiter: null
    convergence: 1
    lenses: [req_completeness, design_coherence, feasibility, traceability_setup]
    lenses_no_req: [completeness, design_coherence, feasibility, clarity]
  development:
    reviewers: [gemini, opencode, codex]
    arbiter: claude  # MUST NOT be in reviewers — orchestrator auto-resolves
    convergence: 2
    lenses: [correctness, completeness, consistency, pattern_compliance, req_to_code]
    lenses_no_req: [correctness, completeness, consistency, pattern_compliance]
  test:
    reviewers: [gemini, opencode]
    arbiter: null
    convergence: 1
    lenses: [test_validity, coverage, assertion_quality, req_to_test]
    lenses_no_req: [test_validity, coverage, assertion_quality]
  integration:
    reviewers: [claude, gemini, opencode]
    arbiter: auto  # auto-select: highest-tier tool NOT in reviewer pool
    convergence: 2
    lenses: [req_trace_e2e, cross_stage_consistency, regression_risk, drift_detection]
    lenses_no_req: [completeness_e2e, cross_stage_consistency, regression_risk, drift_detection]
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

When requirements conflict with code:

| REQ `source` field | Resolution rule |
|--------------------|----------------|
| `candidate` (retrofitted from code) | Code is source of truth. REQ is descriptive. |
| `human` (user-specified) | REQ is normative. Code must conform. |

---

## 12. Final Report Format

After convergence or budget exceeded:

```
## Review Pass Report

**Stage**: {stage}
**Rounds**: {total_rounds}
**Reviewers**: {reviewer_list} (R={R_actual})
**Result**: {CLEAN | FIXED | PARTIAL (budget exceeded)}
**Duration**: {elapsed_time}

### Summary
- CONFIRMED findings: {n} (all auto-fixed with diff)
- CONTESTED resolved: {n} ({via_arbiter} by arbiter, {via_user} by user)
- Remaining escalations: {n}

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

---

## 14. Light Mode (`--light`)

Applied when the user explicitly specifies `--light`:

| Item | Standard | Light |
|------|----------|-------|
| Convergence | per-stage default | 1 clean round |
| Lenses | all stage lenses | first lens only |
| Max rounds | 8 | 4 |
| Applicable | feature work, major changes | typo fixes, config, <3 files |

The orchestrator must NOT choose light mode autonomously.
