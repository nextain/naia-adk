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
    lenses: [correctness, completeness, consistency, pattern_compliance, req_to_code, structural_complexity, context_output_separation, audience_surface_fit, unjustified_product_surface]
    lenses_no_req: [correctness, completeness, consistency, pattern_compliance, structural_complexity, context_output_separation, audience_surface_fit, unjustified_product_surface]
  test:
    reviewers: [gemini, opencode]
    arbiter: null
    convergence: 2
    lenses: [test_validity, coverage, assertion_quality, req_to_test, test_structure, context_output_separation, audience_surface_fit, unjustified_product_surface]
    lenses_no_req: [test_validity, coverage, assertion_quality, test_structure, context_output_separation, audience_surface_fit, unjustified_product_surface]
  integration:
    reviewers: []  # empty means schedule roles from any available adapter; distinct provider/model preferred
    roles: [source_fidelity, baseline_preservation, implementation_test, authority_release]
    arbiter: null  # all tools are independent roles; user resolves semantic vetoes
    convergence: 2
    lenses: [source_to_release, cross_stage_consistency, baseline_preservation, authority_release, complexity_release, context_output_separation, audience_surface_fit, unjustified_product_surface]
    lenses_no_req: [source_to_release, cross_stage_consistency, baseline_preservation, authority_release, complexity_release, context_output_separation, audience_surface_fit, unjustified_product_surface]
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
