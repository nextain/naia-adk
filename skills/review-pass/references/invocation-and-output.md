# Invocation and Output Contract

## Contents

- [CLI invocation protocol](#2-cli-invocation-protocol)
- [Encoding setup](#21-encoding-setup)
- [Prompt delivery](#22-prompt-delivery)
- [Reviewer invocation](#23-reviewer-invocation)
- [Timeout](#24-timeout)
- [Parallel execution](#25-parallel-execution)
- [Output schema](#3-output-schema)
- [Reviewer prompt format](#31-reviewer-prompt-format)
- [Finding schema](#32-finding-schema)
- [Parsing strategy](#33-parsing-strategy)

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

Use dual prompting in one model call: a byte-stable, tool-neutral base prompt
followed by a dynamic atom ledger and the reviewer-role delta. The base must not
contain timestamps, paths, issue IDs, generated summaries, or role names; keeping
this prefix byte-identical enables provider prompt caching. Dual prompting means
two prompt components in one process, not two model calls.

The dynamic ledger is a mechanical review projection of the request-contract
source atoms, never a second authority model. Preserve `id`, `source_id`, exact
`text`, `directive_ids`, `subject`, `effect`, and `render_policy`; attach the
existing `target_ids`, `criterion_ids`, and `evidence_ids` trace sets. A trace
set may be empty when the contract has no such edge; reject missing fields,
empty identifier strings, duplicate identifiers, or extra projection fields
before invocation. Supersession remains
represented only by the contract's signed authority, directive state, and
tombstone; a review prompt cannot invent it.

Write the components to owner-only temporary files and pipe the composed prompt
via stdin. Never inline prompts in command arguments.

**PowerShell:**
```powershell
$promptFile = [System.IO.Path]::GetTempFileName()
Set-Content -Path $promptFile -Value $prompt -Encoding UTF8
Get-Content $promptFile -Raw | & $toolCommand
```

**Bash:**
```bash
node .agents/skills/review-pass/scripts/invoke-reviewer.mjs \
  --tool codex --repo "$PWD" --base "$baseFile" \
  --atoms "$atomFile" --delta "$roleFile"
```

A runnable minimal fixture is in `../examples/one-shot/`.

Ordinary invocations return a structured, non-blocking `NOT_RUN` object with a
zero exit status when the selected external reviewer is missing, unauthenticated,
quota-limited, malformed, or timed out. Add `--require-review true` only when the
active delivery contract explicitly requires review evidence; that mode preserves
the reviewer's non-zero exit status and fails closed. CLI-facing failure reasons
use fixed diagnostic categories rather than provider output, and reviewer stdout
is capped at 1 MiB before the process tree is terminated.

### 2.3 Reviewer Invocation

Each reviewer is invoked as a headless CLI process. Commands are configurable
via the tools section of the profile. Standard patterns:

| Tool | Headless Command | Read-Only | Notes |
|------|-----------------|-----------|-------|
| `claude` | `claude -p --input-format text --output-format json --no-session-persistence --permission-mode plan --allowedTools Read,Glob,Grep` | yes (restricted tools) | prompt on stdin |
| `opencode` | `opencode run --dir "$dir" --format json -m {model}` | yes (explicit permissions) | set `OPENCODE_CONFIG_CONTENT` to deny `*` and allow only lowercase read/glob/grep/list/lsp keys (verified with `opencode debug config`); omit positional message; prompt on stdin |
| `codex` | `codex exec --ephemeral --sandbox read-only --skip-git-repo-check -C "$dir" -m {model} -` | yes (sandbox) | `-` reads stdin |

**Adapter interface**: Each tool adapter implements:

```
invoke(prompt: string, config: ToolConfig) → raw_output: string
parse(raw_output: string, strategy: "json" | "text_fallback") → Finding[]
```

**Custom tool registration**: Add entries to the `tools` section in config.
Each entry requires a shell-free command, `stdin: true`, and a parse strategy.
`{prompt}` is forbidden in command templates.

The runner extracts native JSON/JSONL or a JSON fenced block and rejects
successful-looking output unless it contains one structured coverage row for
every input atom, with no missing, unknown, or duplicate IDs. `CLEAN` additionally
requires all rows to be `COVERED` and an empty findings array.

### 2.4 Timeout

Use three deadlines: 300s to first output, 180s idle after output, and 900s
absolute total. Silence before the startup deadline is not failure. Report the
exact timeout phase (`startup|idle|total`) before graceful degradation (R-1).

### 2.5 Parallel Execution

Run all reviewers for a round in parallel via temp-file-based output capture.

**PowerShell:**
```powershell
$jobs = @()
foreach ($reviewer in $reviewers) {
    $outFile = [System.IO.Path]::GetTempFileName()
    $args = @(
        ".agents/skills/review-pass/scripts/invoke-reviewer.mjs",
        "--tool", $reviewer, "--repo", $PWD,
        "--base", $baseFile, "--atoms", $atomFile, "--delta", $deltaFile
    )
    $jobs += Start-Process -FilePath "node" -ArgumentList $args `
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
    node .agents/skills/review-pass/scripts/invoke-reviewer.mjs \
        --tool "$reviewer" --repo "$PWD" --base "$base_file" \
        --atoms "$atom_file" --delta "$delta_file" \
        > "$out_file" 2>/dev/null &
    pids+=($!)
done
deadline=$((SECONDS + 900))
for pid in "${pids[@]}"; do
    while kill -0 "$pid" 2>/dev/null && (( SECONDS < deadline )); do sleep 1; done
    kill -0 "$pid" 2>/dev/null && kill -TERM "$pid"
    wait "$pid" || true
done
```

---

## 3. Output Schema

### 3.1 Reviewer Prompt Format

Each reviewer receives only the evidence view assigned to its role. Before the
common envelope, include the validated atom ledger. Every non-superseded atom
must appear in exactly one coverage row linking source → target → acceptance →
evidence. Missing, duplicated, or summary-only coverage is `NOT_CLEAN`.

The common envelope contains:

```
## Review Context
Stage: {stage}
Role: {source_fidelity | baseline_preservation | implementation_test | authority_release | standard}
Files: {file_list}
REQ-IDs: {req_ids or "N/A for this review"}
Deferred REQ-IDs: {deferred or "none"}
Known issues from previous rounds: {known_issues or "none"}
Deterministic complexity report: {complete current report; never a prose-only summary}
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
- `file:line [CRITICAL|HIGH|MEDIUM|LOW|INFO] [correctness|preservation|scope|authority|release|complexity] REQ-ID — description`
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
  finding_class: correctness | preservation | scope | authority | release | complexity
  veto: boolean          // true for solo CRITICAL preservation/scope/authority/release
  req_id: string | null  // associated REQ-ID (null if N/A)
  description: string    // what's wrong
  reviewer: string       // which reviewer found this
  assumptions: string[]  // premises that must hold for the claim to be valid
  evidence_status: ACCEPTED | REJECTED | UNRESOLVED | null
  evidence_checked: string[] // primary evidence independently inspected by the orchestrator
  rationale: string | null   // why the evidence supports the final status
}
```

Reviewer output begins as an untrusted hypothesis, so `evidence_status` is initially `null`.
The orchestrator, not a reviewer or arbiter, fills the evidence fields after independently
checking the highest-authority available source, requirement, current code/runtime, and test evidence.

### 3.3 Parsing Strategy

1. **Primary**: Parse JSON output when tool supports `--output-format json`
2. **Fallback**: Extract structured findings from freeform text:
   - Match lines containing `file:line [SEVERITY]` patterns
   - Extract REQ-ID references (REQ-\d+)
   - If no structured data extractable → health score LOW for that reviewer

---
