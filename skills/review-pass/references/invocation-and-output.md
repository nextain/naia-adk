# Invocation and Output Contract

## Contents

- [CLI invocation protocol](#2-cli-invocation-protocol)
- [Encoding setup](#21-encoding-setup)
- [Prompt delivery](#22-prompt-delivery)
- [Reviewer invocation](#23-reviewer-invocation)
- [Timeout](#24-timeout)
- [Parallel execution](#25-parallel-execution)
- [Invocation cost recording](#26-invocation-cost-recording)
- [Output schema](#3-output-schema)
- [Reviewer output schema (canonical)](#31-reviewer-output-schema-canonical)
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
| `agy` | `agy --input-format stream-json --output-format stream-json --sandbox --mode plan --print-timeout 240s --model {model}` | yes (sandbox) | send one newline-terminated `event:"user"` NDJSON message with nested `message.role:"user"` and `message.content`; require a final `event:"result"` whose nested `result.status` is `"SUCCESS"` and whose response carries the review; the adapter keeps AGY's review inside the same coverage/fail-closed validation |

**Adapter interface**: Each tool adapter implements:

```
invoke(prompt: string, config: ToolConfig) → raw_output: string
parse(raw_output: string, strategy: "json" | "text_fallback") → Finding[]
```

For AGY, `--print` is intentionally omitted: the installed CLI treats that
flag as its single-prompt mode and does not consume the stream request. The
adapter sends exactly one newline-terminated user event on stdin. Successful
terminal evidence is the final result envelope with nested
`result.status:"SUCCESS"`; its response still has to pass the coverage and
frame validation below. A missing or malformed terminal, failed or truncated
stream, timeout, or nonzero exit fails closed.

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

### 2.6 Invocation Cost Recording

Every reviewer invocation records a single JSONL line upon termination (whether `reviewed`, `failed`, or `not_run`).

**Orchestrator convention:**
오케스트레이터는 리뷰어를 부를 때 `--review-id --stage --round --reviewer-index`를 넘긴다.

**Log file resolution hierarchy:**
1. Explicit CLI argument: `--cost-log <path>`
2. Environment variable: `REVIEW_COST_LOG`
3. Default path: `<workspace-root>/.agents/progress/review-cost/<YYYY-MM-DD>.jsonl` (local date)

Parent directories are created automatically if they do not exist. Any logging failure emits a warning to stderr without altering reviewer verdict, output structure, or process exit code.

**CLI arguments:**
- `--cost-log <path>`: Destination JSONL path
- `--review-id <id>`: Identifier for the current review session
- `--stage <stage>`: Review stage (`planning`, `development`, `test`, `integration`)
- `--round <round>`: Round number
- `--reviewer-index <index>`: Index of the reviewer in the round

**JSONL record schema:**
- `ts`: ISO 8601 UTC timestamp
- `review_id`: Review identifier or `null`
- `stage`: Review stage or `null`
- `round`: Round number or `null`
- `reviewer_index`: Reviewer index or `null`
- `tool`: Reviewer CLI tool name (`claude`, `codex`, `opencode`, `grok`, `agy`)
- `model`: Reviewer model identifier or `null`
- `repo`: Repository path
- `prompt_chars`: Total length of the delivered prompt string
- `duration_ms`: Wall-clock execution duration in milliseconds
- `outcome`: Terminal outcome category (`reviewed` | `failed` | `not_run`)
- `failure_reason`: Diagnostic safe error reason or `null`
- `verdict`: Final review verdict (`CLEAN` | `NOT_CLEAN`) or `null`
- `findings_count`: Count of findings or `null`
- `usage`: Exact token/cost metrics reported by the tool (`{ input_tokens, output_tokens, thinking_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost_usd }` with unknown fields set to `null`; never estimated or calculated) or `null`
- `usage_source`: Source of metrics (`result.usage`, `claude_json`, `tokens`) or `null`

Prompt text, review text, and credentials are never logged.

---

## 3. Output Schema

### 3.1 Reviewer Output Schema (Canonical)

리뷰어 출력은 스크립트(`invoke-reviewer.mjs`)가 모든 도구에 붙이는 JSON 형식이 정본입니다.
리뷰어는 마크다운 서식이나 추가 설명 없이 단 하나의 JSON 객체만 출력해야 합니다.
`validateReviewOutput` 검증기는 이 JSON 구조를 엄격하게 검증합니다.

#### Canonical Review JSON Schema

```json
{
  "verdict": "CLEAN" | "NOT_CLEAN",
  "coverage": [
    {
      "atom_id": "string",
      "status": "COVERED" | "NOT_COVERED"
    }
  ],
  "findings": [
    {
      "atom_id": "string | null",
      "scope": "outside_declared_atoms",
      "file_location": "string (file:line or file path)",
      "impact": "string (concrete harm or failure description)",
      "minimal_fix": "string (minimal patch or change)"
    }
  ],
  "frame_assessment": {
    "scope_is_sufficient": true | false,
    "missing_concerns": ["string"]
  },
  "runtime_observed": true | false
}
```

#### Output Rules & Constraints
1. **JSON Only**: 설명 텍스트, 인사말, 마크다운 코드 펜스(```) 없이 정확히 1개의 유효한 JSON 객체만 출력합니다.
2. **coverage**: 동적 아톰 원장의 모든 아톰에 대해 정확히 1개의 항목이 있어야 합니다. 중복, 누락, 미선언 ID는 검증 실패(`NOT_CLEAN` 처리)됩니다.
3. **findings**: 발견된 결함 목록. 결함이 없으면 빈 배열 `[]`.
   - `file_location`, `impact`, `minimal_fix`는 모두 비어있지 않은 문자열이어야 합니다.
   - 아톰 원장 밖의 결함인 경우 `atom_id: null` 및 `scope: "outside_declared_atoms"`로 보고합니다.
4. **frame_assessment**: 아톰 원장의 범위가 원래 요청을 충족하기에 충분한지 평가합니다.
   - `scope_is_sufficient`가 `false`이면 `missing_concerns` 배열에 최소 1개 이상의 누락 우려사항이 명시되어야 합니다.
5. **runtime_observed**: 코드를 실제 실행/관찰한 경우에만 `true`로 설정합니다. 정적 검토는 반드시 `false`여야 합니다.
6. **verdict**:
   - `CLEAN`: 모든 아톰이 `COVERED`이고, `findings`가 `[]`이며, `scope_is_sufficient`가 `true`일 때만 허용됩니다.
   - `NOT_CLEAN`: 미커버 아톰 존재, 결함 존재, 또는 범위 불충분 시 필수입니다.

#### Clean Review Example

```json
{
  "verdict": "CLEAN",
  "coverage": [
    {
      "atom_id": "ATOM-1",
      "status": "COVERED"
    }
  ],
  "findings": [],
  "frame_assessment": {
    "scope_is_sufficient": true,
    "missing_concerns": []
  },
  "runtime_observed": false
}
```

#### Finding / Not-Clean Review Example

```json
{
  "verdict": "NOT_CLEAN",
  "coverage": [
    {
      "atom_id": "ATOM-1",
      "status": "NOT_COVERED"
    }
  ],
  "findings": [
    {
      "atom_id": "ATOM-1",
      "file_location": "scripts/invoke-reviewer.mjs:42",
      "impact": "Missing null check causes crash on empty environment variable",
      "minimal_fix": "Add optional chaining before accessing property"
    },
    {
      "atom_id": null,
      "scope": "outside_declared_atoms",
      "file_location": "references/invocation-and-output.md:280",
      "impact": "Documentation lacks output schema causing model hallucination",
      "minimal_fix": "Add canonical JSON schema to documentation"
    }
  ],
  "frame_assessment": {
    "scope_is_sufficient": false,
    "missing_concerns": ["Output contract was not covered in original atom ledger"]
  },
  "runtime_observed": false
}
```

### 3.2 Finding Schema

Finding 데이터는 리뷰어가 직접 출력하는 필드와 오케스트레이터가 독립 검증 후 채우는 필드로 구분됩니다.

#### 1. Reviewer Output Fields (리뷰어 산출 필드)
리뷰어 프로세스가 JSON 응답의 `findings` 배열에 직접 담는 필드입니다:
- `atom_id`: string | null (동적 아톰 ID, 원장 밖이면 null)
- `scope`: string ("outside_declared_atoms", atom_id가 null일 때 필수)
- `file_location`: string (파일 경로 및 라인 번호, 예: `src/core.py:42`)
- `impact`: string (구체적 장애 영향 및 실패 양상 설명)
- `minimal_fix`: string (문제를 해결하는 최소 변경 방안)

#### 2. Orchestrator Enriched Fields (오케스트레이터 보강 필드)
리뷰어 출력은 신뢰되지 않은 가설(untrusted hypothesis)로 취급됩니다. 오케스트레이터는 리뷰어 출력을 검증하고 증거를 독립 검사한 뒤 다음 통합 데이터 모델로 보강합니다:

```typescript
Finding {
  // 리뷰어 산출 필드 매핑
  file: string           // file_location에서 파싱한 파일 경로
  line: number | null    // file_location에서 파싱한 라인 번호 (파일 레벨은 null)
  description: string    // impact 및 minimal_fix 기반 상세 설명
  req_id: string | null  // atom_id 기반 요구사항 ID 매핑

  // 오케스트레이터 검증 및 분류 필드
  symbol: string | null  // 함수/클래스/심볼 이름
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO"
  finding_class: "correctness" | "preservation" | "scope" | "authority" | "release" | "complexity"
  veto: boolean          // solo CRITICAL preservation/scope/authority/release 여부
  reviewer: string       // 보고한 리뷰어 도구 및 모델
  assumptions: string[]  // 주장이 유효하기 위한 전제 조건 목록
  evidence_status: ACCEPTED | REJECTED | UNRESOLVED | null  // 독립 증거 검증 결과
  evidence_checked: string[] // 오케스트레이터가 독립 확인한 1차 증거 목록
  rationale: string | null   // 증거 기반 최종 판정 근거
}
```

The orchestrator, not a reviewer or arbiter, fills the evidence fields after independently
checking the highest-authority available source, requirement, current code/runtime, and test evidence.

### 3.3 Parsing Strategy

1. **Primary**: Parse JSON output when tool supports `--output-format json`
2. **Fallback**: Extract structured findings from freeform text:
   - Match lines containing `file:line [SEVERITY]` patterns
   - Extract REQ-ID references (REQ-\d+)
   - If no structured data extractable → health score LOW for that reviewer

---
