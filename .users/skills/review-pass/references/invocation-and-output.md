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
via stdin. Never inline prompts in command arguments. The Grok adapter instead
writes the composed prompt to a freshly-created owner-only (`0600`) file and
passes that path with `--prompt-file`; it closes stdin without sending a second
copy of the prompt.

Set skill_dir/$skillDir to the directory containing the installed SKILL.md ('.agents/skills/review-pass' in this checkout) before using the examples below.

**PowerShell:**
```powershell
$promptFile = [System.IO.Path]::GetTempFileName()
Set-Content -Path $promptFile -Value $prompt -Encoding UTF8
Get-Content $promptFile -Raw | & $toolCommand
```

**Bash:**
```bash
node "$skill_dir/scripts/invoke-reviewer.mjs" \
  --tool codex --repo "$PWD" --base "$baseFile" \
  --atoms "$atomFile" --delta "$roleFile"
```

Pass `--request <file>` with the original ask, verbatim. Without it the reviewer
can only compare the change against the author's own summary of what was wanted,
and the prompt says so in place of the request.

A runnable minimal fixture is in `../examples/one-shot/`.

### 2.2a Reviewing the frame, not only the contents

The atom ledger is written by the author of the change. A reviewer confined to
it can answer "is this right within the stated scope" and can never answer "is
the stated scope right", which is where large reviews fail. Every invocation
therefore carries three obligations, and the output contract enforces them.

A finding outside the ledger is reported with `"atom_id": null` and
`"scope": "outside_declared_atoms"`. Previously such a finding was rejected as an
unknown atom, so a reviewer that saw something the author had not thought of had
no way to say it.

`frame_assessment` is required: `{ scope_is_sufficient, missing_concerns }`. An
insufficient scope must name what is missing, and `CLEAN` is unavailable while
the scope is insufficient. A scope objection alone is enough for `NOT_CLEAN`,
with no in-frame finding.

`runtime_observed` is required. Reading files is not observing behaviour, and
declaring which one happened keeps a text review from being quoted later as a
runtime result.

Invocations fail closed by default. When the selected external reviewer is
missing, unauthenticated, quota-limited, malformed, or timed out, the invocation
exits non-zero and produces no review object.

This is deliberate. A reviewer that could not run and a reviewer that ran and
found nothing are different outcomes, and they used to be indistinguishable to
the caller: both exited zero. An orchestrating agent reads a zero exit, records
that the review step completed, and reports cross-validation that never
happened. Quota limits and startup timeouts make that the *common* path, not the
rare one.

Pass `--require-review false` to accept a missing reviewer. That returns the
structured `NOT_RUN` object with a zero exit status, and the object carries
`cross_validation: false` and `usable_as_evidence: false` so a downstream reader
cannot mistake it for a completed review. CLI-facing failure reasons
use fixed diagnostic categories rather than provider output, and reviewer stdout
is capped at 1 MiB before the process tree is terminated.

### 2.3 Reviewer Invocation

Each reviewer is invoked as a headless CLI process. The bundled runner supports
the fixed adapter commands shown below; it does not read `tools.*.command`,
`stdin`, or `parse` to register arbitrary processes from config. Standard
patterns:

| Tool | Headless Command | Read-Only | Notes |
|------|-----------------|-----------|-------|
| `claude` | `claude -p --input-format text --output-format json --no-session-persistence --permission-mode plan --tools Read,Glob,Grep --strict-mcp-config --mcp-config '{"mcpServers":{}}'` | yes (restricted tools) | prompt on stdin |
| `opencode` | `opencode run --pure --agent adk-adversarial-review --title adk-adversarial-review --dir "$dir" --format json --model {model}` | yes (shared child-environment boundary) | use the shared Alpha child-environment helper for private HOME/XDG roots and sanitized provider/auth config; pin `model` and `small_model` to `{model}`, apply the helper's read-only policy to the selected agent, disable project config and inherited overrides, omit positional message, and pipe the prompt on stdin |
| `grok` | `grok --output-format json --permission-mode plan --verbatim --prompt-file {0600-prompt-file}` | yes (plan mode) | pass a temporary owner-only prompt path, close stdin, and remove the file after exit; do not pass `--no-subagents` so Grok can spawn subagents |
| `codex` | `codex exec --ephemeral --sandbox read-only --skip-git-repo-check -C "$dir" --model {model} -` | yes (sandbox) | `-` reads stdin |

**Adapter interface**: Each tool adapter implements:

```
invoke(prompt: string, config: ToolConfig) → raw_output: string
parse(raw_output: string, strategy: "json" | "text_fallback") → Finding[]
```

**Custom tool registration** is not implemented by the bundled runner. Adding a
`tools.*` entry does not make it executable; a new adapter must be added to
`commandFor` with tests before it can be documented as supported. The OpenCode
row is the required invocation: `--pure` and `--agent adk-adversarial-review`
select the managed read-only path, while the runner supplies the explicit
model, pins `model` and `small_model` to it, and pipes the prompt through the
child environment.

The runner extracts native JSON/JSONL or a JSON fenced block and rejects
successful-looking output unless it contains one structured coverage row for
every input atom, with no missing, unknown, or duplicate IDs. `CLEAN` additionally
requires all rows to be `COVERED` and an empty findings array. Structured stream
events with failure metadata in the event or its native `part` envelope are
rejected before review parsing. This includes `error`, `failure`, `incomplete`,
`aborted`, `cancelled`, `truncated`, and length/max-token finishes, even if a
valid review object is also present. A structured stream must also end with a
recognized successful terminal (normally `step_finish` with
`part.reason: "stop"`); a missing or unknown terminal is rejected. Direct raw
review JSON and provider result envelopes without stream markers remain
supported. Arbitrary text inside a message is not inspected as stream metadata,
so an illustrative quota or status-code example remains text.

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
        "$skillDir/scripts/invoke-reviewer.mjs",
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
    node "$skill_dir/scripts/invoke-reviewer.mjs" \
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
