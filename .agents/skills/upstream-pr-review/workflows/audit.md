# Workflow — audit

## Inputs

- `target` (default `upstream/main`)
- `head` (default `HEAD`)
- Layer 1 `core-rubric.yaml`
- Layer 2 `project-rubric.yaml` (if exists)
- Layer 2 `overrides.yaml` (if exists)

## Steps

### 1. Load rubrics

```
generic = load core-rubric.yaml from this skill
project = load <fork>/.claude/skills/upstream-pr-review-*/project-rubric.yaml (optional)
overrides = load <fork>/.claude/skills/upstream-pr-review-*/overrides.yaml (optional)

all_items = generic.items + project.items
all_items = apply(overrides, all_items)
```

### 2. Apply overrides

`overrides.yaml` 형식:
```yaml
overrides:
  - id: AISLOP-3
    action: disable
    reason: "Draft PR for early review; rubric IDs intentionally visible"
    last_confirmed_pr: "2026-04-28"
  - id: SCOPE-2
    action: severity_change
    new_severity: minor
    reason: "Project's stated pattern is large model-addition PRs"
```

`action`:
- `disable` — skip this ID entirely
- `severity_change` — change blocker→major, etc.
- `sticky_pass` — force PASS with reason (audit log records as `STICKY-PASS`)

### 3. Evaluate each item

For each `item` in `all_items`:
1. Run `evidence` command (or LLM-judged if `evidence` is "manual:..." prefix).
2. Compare against `pass` / `fail_signals`.
3. Classify:
   - `PASS` — evidence matches `pass` criterion
   - `FAIL` — at least one `fail_signal` matched
   - `UNKNOWN` — evidence ambiguous, manual eval not done, command failed
4. If `FAIL`: include `fix_template` in output.

### 4. Output

#### Default (`--fail-only`)

```
=== upstream-pr-review audit (target=upstream/main, head=60465b28) ===

FAIL — blocker (3):
  SCOPE-1   side-model files outside PR purpose
            evidence: 7 files matching fork-noise-paths
            fix: Move out-of-scope changes to separate PR.

  SCOPE-3   fork-internal artifacts present
            evidence: .agents/, MEMORY.md, ko-finetune/
            fix: cherry-pick to a clean branch.

  MECH-2    not rebased on upstream/main (114 commits ahead)
            fix: git fetch upstream && git rebase upstream/main

FAIL — major (3):
  AISLOP-1  7 review-iteration commits ('Pass N')
  AISLOP-2  Co-Authored-By: Claude on all commits
  VLLM-OMNI-1  side-model touches matched maintainer-flagged paths
              (see ai-slop-rejections.md PR #2487)

UNKNOWN (4):
  DUPL-1    sibling helper comparison not run
  QUALITY-1 linter not run on PR diff
  DOC-1     public API docstring scan not run
  VLLM-OMNI-2  single-GPU yaml verification not run

PASS (8):
  ...
```

#### Full (`--full`)

전체 matrix 출력.

### 5. Exit code

- `0` — no `blocker` FAIL
- `1` — at least one `blocker` FAIL (PR 발송 차단 권고)
- `2` — skill internal error

### 6. UNKNOWN action

Default: warn, not block. user 가 manual evaluation 후 `overrides.yaml` 에 sticky_pass 또는 audit 재실행.

## Notes

- audit 결과는 *내부 only*. PR 에 leak 금지 (output-policy.md, AISLOP-3).
- `evidence` 가 LLM-judged 인 경우 (`manual:` prefix), audit 결과에 `[LLM]` 표시 — 결정론적이지 않음 명시.
