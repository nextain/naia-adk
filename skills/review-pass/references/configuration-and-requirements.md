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
    command: "claude -p --input-format text --output-format json --no-session-persistence --permission-mode plan --tools Read,Glob,Grep --strict-mcp-config --mcp-config '{\"mcpServers\":{}}'"
    stdin: true
    parse: json
  codex:
    command: 'codex exec --ephemeral --sandbox read-only --skip-git-repo-check -C "{repo}" --model {model} -'
    stdin: true
    parse: text_fallback
  agy:
    command: 'agy --input-format stream-json --output-format stream-json --sandbox --mode plan --print-timeout 240s --model {model}'
    stdin: true
    parse: json
  grok:
    command: 'grok --output-format json --permission-mode plan --verbatim --prompt-file {prompt_file}'
    stdin: false
    parse: json

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
    agy: {reviewers: [agy]}
    grok: {reviewers: [grok]}
  unavailable: fail_closed

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

The Grok adapter substitutes `{prompt_file}` with a freshly-created owner-only
(`0600`) temporary file, closes stdin, and removes the file after the process
exits. A prompt must never be passed as an argument or through a world-readable
temporary file.

The OpenCode adapter uses the shared Alpha
`manage-discord-sessions/helper/backend-child-environment.mjs` boundary for
each invocation. That helper gives the child a fresh owner-only (`0700`) HOME
and XDG config/cache/state/data roots, strips inherited OpenCode environment
overrides, disables project configuration, and copies only the sanitized
provider/model fields and authentication file that the adapter needs. Its
owner-only (`0600`) overlay denies `*` and allows only `read`, `glob`, `grep`,
and `list`; the adapter applies that same helper policy to the selected review
agent and pins both `model` and `small_model` to the explicit reviewer model.
The child environment, provider copy, and overlay are removed after exit,
including failed invocations, so host HOME/XDG plugins and permissions cannot
be merged into a review.

If the selected adapter is missing, unauthenticated, exits, or times out, the
invocation fails closed and the review pass stops. Continuing with deterministic
validation alone is a choice someone has to make on purpose, by passing
`--require-review false`; the resulting `NOT_RUN` object declares itself unusable
as evidence so a later reader cannot count it as a review that happened.
Never ask an ADK user to install another CLI or create another provider account.
When a governed delivery explicitly requires independent review evidence, keep
that delivery `REVIEW_ONLY` without cancelling the underlying authorized work.

### 10.3 Per-Project Override

Create `./review-pass.yaml` in the project root:

```yaml
tools:
  opencode:
    command: 'opencode run --pure --agent adk-adversarial-review --title adk-adversarial-review --dir "{repo}" --format json --model {model}'
    stdin: true
requirements:
  dir: ".agents/requirements"
stages:
  development:
    reviewers: [codex, opencode]
    convergence: 1
```

The YAML `tools` entries document profile defaults. The bundled
`invoke-reviewer.mjs` selects one of the fixed adapters in `commandFor`; it
does not read `tools.*.command`, `stdin`, or `parse` to construct arbitrary
processes. A project file can select supported reviewers, requirements, and
stages, but custom tool registration is not implemented. For OpenCode, the
documented command includes `--pure --agent adk-adversarial-review`; the
runner supplies the explicit model and managed child-environment boundary,
pins `model` and `small_model`, and disables project configuration.

### 10.4 Environment Detection

Auto-detect only the adapters eligible for the active profile. Detection is a
best-effort preflight; a configured reviewer that is missing or unauthenticated
fails closed by default. An explicit `--require-review false` opt-out may record
`NOT_RUN` for ordinary local work, but that result cannot satisfy review evidence.

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
