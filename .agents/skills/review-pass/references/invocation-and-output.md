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
}
```

### 3.3 Parsing Strategy

1. **Primary**: Parse JSON output when tool supports `--output-format json`
2. **Fallback**: Extract structured findings from freeform text:
   - Match lines containing `file:line [SEVERITY]` patterns
   - Extract REQ-ID references (REQ-\d+)
   - If no structured data extractable → health score LOW for that reviewer

---
