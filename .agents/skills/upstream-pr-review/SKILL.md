---
name: upstream-pr-review
version: "1.0"
description: >
  Pre-flight floor for OSS upstream PR submission. Catches AI-slop signals,
  scope creep, and dead-code rejections BEFORE the PR reaches the maintainer.
  Designed to be extended per-fork with project-specific lenses.
triggers:
  - "/upstream-pr-review"
  - "upstream pr review"
  - "PR-ready check"
input_schema:
  target:
    type: string
    required: false
    default: "upstream/main"
    description: "Compare base (default upstream/main)"
  head:
    type: string
    required: false
    default: "HEAD"
    description: "Branch / SHA to audit"
  mode:
    type: enum
    values: [audit, bootstrap-extension]
    required: false
    default: audit
output:
  records:
    - name: "audit_result"
      format: "ID-based PASS/FAIL/UNKNOWN matrix"
  side_effects:
    - description: "Reads, never writes to PR-facing surfaces"
      adapter: "git, gh"
---

# Skill — `upstream-pr-review`

## Purpose

PR 발송 *전* 의 internal pre-flight check. **floor, not ceiling**.

이 skill 이 PASS 했다고 PR 가 merge-ready 인 것 아님. 단지 다음 reject 사유를 *미리* catch:

- AI-slop signals (commit history iteration, AI co-author leak, rubric ID 가 PR-facing surface 에 leak)
- Scope creep (무관 file, fork-internal noise, 거대 PR)
- Dead code / commit hygiene
- Project PR template 미준수

이 skill 이 *답하지 않는 것*:
- *whether to submit at all* — 협업 상대 우선/대기, fork-stage 적절성. 사람 판단.
- *architectural fit* — maintainer 가 이 model/feature 를 원하는지, 다른 design 을 선호하는지. skill 모름.
- *non-GitHub feedback* — Slack/Discord/이메일. skill 보지 못함.
- *novel reject 사유* — adversarial peer review 필요. skill 은 *floor* 임.

## Architecture

**Layer 1 (this skill)**: 범용 OSS PR review mechanics + 15 generic IDs.

**Layer 2 (per-fork extension)**: 각 fork 안에 별도 skill 로 구성. 이 skill 이 Layer 2 의 *bootstrap* 도 안내.

```
<fork>/.claude/skills/upstream-pr-review-<project>/
├── SKILL.md                    # extends Layer 1, project lens
├── project-understanding.md    # PR template, CONTRIBUTING, model guide, sibling patterns
├── ai-slop-rejections.md       # closed PR 의 maintainer reject quote (AI-related)
├── project-rubric.yaml         # 위 두 자료에서 도출된 프로젝트-specific IDs
└── overrides.yaml              # disable / sticky-pass / severity 변경
```

## Invocation

### audit mode (default)

```
/upstream-pr-review audit
/upstream-pr-review audit --target upstream/main --head HEAD
```

진행:
1. Layer 1 의 `core-rubric.yaml` 로드.
2. 현재 fork 의 Layer 2 skill (`<fork>/.claude/skills/upstream-pr-review-*/project-rubric.yaml`) 로드 (있으면).
3. `<fork>/.../overrides.yaml` 적용 (있으면).
4. 각 ID 의 `evidence` 수집 → `pass` / `fail_signals` 와 비교 → `PASS` / `FAIL` / `UNKNOWN`.
5. Output: **FAIL-only by default**. `--full` 으로 matrix 전체.
6. Severity → action: `blocker` FAIL = 발송 차단 권고. `major` FAIL = 경고. `minor` FAIL / UNKNOWN = info.

### bootstrap-extension mode

```
/upstream-pr-review bootstrap-extension --upstream vllm-project/vllm-omni
```

새 fork 에서 Layer 2 skill 골격 생성:
1. Tier 1 자료 수집 (PR template, CONTRIBUTING, contributing/ docs).
2. Tier 3 raw archive 시작 (closed PR comments — verbatim, *NO rule extraction*).
3. `project-understanding.md` + `ai-slop-rejections.md` (빈 골격 또는 초안) 작성.
4. **dry-run preview**. 사용자가 manually `project-rubric.yaml` 작성 (Layer 2 skill 의 핵심).

## Output policy (invisibility)

- 이 skill 의 모든 output (rubric IDs, fail_signals 표현, "AISLOP-3" 같은 internal vocabulary) 은 **PR-facing surface 에 절대 안 나타남**.
- AISLOP-3 가 self-test: PR description / commit message / review reply 에 IDs 가 leak 됐는지 자동 검사.
- skill 출력 = terminal/log only.

## Workflows

- `workflows/audit.md` — 단계별 audit
- `workflows/extension-bootstrap.md` — Layer 2 skill 생성

## See also

- `core-rubric.yaml` — 15 generic IDs
- `output-policy.md` — invisibility constraint detail
