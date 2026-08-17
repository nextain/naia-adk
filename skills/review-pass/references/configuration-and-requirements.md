# Configuration and Requirements

## Contents

- [Configuration](#10-configuration)
- [Config search order](#101-config-search-order)
- [Default profile](#102-default-profile)
- [Per-project override](#103-per-project-override)
- [Environment detection](#104-environment-detection)
- [REQ-ID integration](#11-req-id-integration-optional)
- [Source authority](#113-source-authority-rule)

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
    command: 'claude -p --input-format text --output-format json --no-session-persistence --permission-mode plan --allowedTools Read,Glob,Grep'
    stdin: true
    parse: json
  codex:
    command: 'codex exec --ephemeral --sandbox read-only --skip-git-repo-check -C "{repo}" -m {model} -'
    stdin: true
    parse: text_fallback

prompt:
  mode: dual_one_shot
  stable_base: review-base.md
  atoms: review-atoms.json
  role_delta: review-role.md
timeouts: {startup_sec: 300, idle_sec: 180, total_sec: 900}

profile_policy:
  default_mode: homogeneous
  profiles:
    claude: {reviewers: [claude]}
    codex: {reviewers: [codex]}
  unavailable: not_run_continue

# Requirements management (optional — skip if not applicable)
requirements:
  dir: ""  # directory containing REQ-{NNN}-*.yaml files
  file_pattern: "REQ-*-{kebab}.yaml"  # {kebab} = kebab-case title fragment

stages:
  planning:
    reviewers: []  # empty means use the active profile's eligible adapter
    roles: [source_fidelity, baseline_preservation, implementation_test, authority_release]
    arbiter: null
    convergence: 2
    lenses: [source_fidelity, design_coherence, feasibility, preservation_setup, context_output_separation, audience_surface_fit, unjustified_product_surface]
    lenses_no_req: [source_fidelity, design_coherence, feasibility, preservation_setup, context_output_separation, audience_surface_fit, unjustified_product_surface]
  development:
    reviewers: []
    arbiter: null
    convergence: 2
    lenses: [correctness, completeness, consistency, pattern_compliance, req_to_code, structural_complexity, context_output_separation, audience_surface_fit, unjustified_product_surface]
    lenses_no_req: [correctness, completeness, consistency, pattern_compliance, structural_complexity, context_output_separation, audience_surface_fit, unjustified_product_surface]
  test:
    reviewers: []
    arbiter: null
    convergence: 2
    lenses: [test_validity, coverage, assertion_quality, req_to_test, test_structure, context_output_separation, audience_surface_fit, unjustified_product_surface]
    lenses_no_req: [test_validity, coverage, assertion_quality, test_structure, context_output_separation, audience_surface_fit, unjustified_product_surface]
  integration:
    reviewers: []  # empty means use the active profile's eligible adapter
    roles: [source_fidelity, baseline_preservation, implementation_test, authority_release]
    arbiter: null  # all tools are independent roles; user resolves semantic vetoes
    convergence: 2
    lenses: [source_to_release, cross_stage_consistency, baseline_preservation, authority_release, complexity_release, context_output_separation, audience_surface_fit, unjustified_product_surface]
    lenses_no_req: [source_to_release, cross_stage_consistency, baseline_preservation, authority_release, complexity_release, context_output_separation, audience_surface_fit, unjustified_product_surface]
```

The active `claude` profile schedules Claude headless review; the active `codex`
profile schedules Codex headless review. Do not auto-add another provider merely
because its binary is present. CLI presence does not prove authentication.

If the selected adapter is missing, unauthenticated, exits, or times out, record
the external pass as `NOT_RUN` and continue ordinary deterministic validation.
Never ask an ADK user to install another CLI or create another provider account.
When a governed delivery explicitly requires independent review evidence, keep
that delivery `REVIEW_ONLY` without cancelling the underlying authorized work.

### 10.3 Per-Project Override

Create `./review-pass.yaml` in the project root:

```yaml
tools:
  opencode:
    command: 'opencode run --dir "{repo}" --format json -m provider/model'
    stdin: true
requirements:
  dir: ".agents/requirements"
stages:
  development:
    reviewers: [codex, opencode]
    convergence: 1
```

### 10.4 Environment Detection

Auto-detect only the adapters eligible for the active profile. Detection is a
best-effort preflight; authentication failures are handled by the same
`NOT_RUN` degradation policy.

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
