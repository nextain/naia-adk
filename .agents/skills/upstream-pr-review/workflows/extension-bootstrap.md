# Workflow — bootstrap fork-specific extension skill

새 fork 에서 처음 사용할 때, Layer 2 skill 의 골격 생성 가이드.

## Output

```
<fork>/.claude/skills/upstream-pr-review-<project>/
├── SKILL.md
├── project-understanding.md
├── ai-slop-rejections.md
├── project-rubric.yaml
└── overrides.yaml
```

## Steps

### 1. Tier 1 collection — `project-understanding.md`

자동 수집 (LLM extract OK, but verbatim-included sections preferred):

- `PULL_REQUEST_TEMPLATE.md` 의 checklist
- `CONTRIBUTING.md` 핵심 sections
- `docs/contributing/` (특히 model addition / 기능 추가 가이드)
- `ISSUE_TEMPLATE`
- `CODEOWNERS`
- 최근 *merged* PR 5-10개 의 title pattern (commit prefix convention 확인용)
- sibling implementation 의 directory layout (모델 추가 PR 인 경우)

### 2. Tier 3 raw archive — `ai-slop-rejections.md`

**No rule extraction**. *raw archive* 형식:

```markdown
# AI-slop rejection archive — <project>

## PR <number> (<closed-date>)
- **Author**: <username>
- **Closed by**: <username>
- **Maintainer reviewer**: <username>
- **Quote** (verbatim):
  > <full quote>
- **Context note** (human-curated, optional):
  - 이 reject 는 *이 PR specific* 한가, *general pattern* 인가? (사용자 판단)
  - 우리 PR 에 적용 가능한가?
- **Link**: https://github.com/.../pull/<number>#discussion_r<id>

## PR <number2> ...
```

수집 전략:
- 우리 fork 가 그 upstream 에 보낸 closed PR 모두 (있으면)
- 그 외 *AI-tooled PR 으로 알려진* closed PRs (검색 필요)
- maintainer 가 *명시적으로 AI-tooled PR* 에 한 reject comments

**중요**: 자동 수집 후 **사용자가 manually 'Context note' 작성**. *generalize 안 함*.

### 3. project-rubric.yaml — 위 두 자료에서 *human-curated* 추출

**자동 X**. 사용자가 (1) project-understanding 의 명시 contract + (2) ai-slop-rejections 의 *명백히 일반화 가능한* pattern (e.g., 같은 maintainer 가 동일 reject 사유를 3+ PR 에서 반복) 만 rubric 화.

```yaml
# vllm-omni 예시
version: "1.0"
items:
  - id: VLLM-OMNI-1
    title: "Side-model touches outside PR scope"
    evidence: "git diff --name-only includes any path under {known-side-model-paths}"
    pass: "no side-model files modified"
    fail_signals: ["mammoth_moda2/, qwen3_*/, mimo_audio/, qwen2_5_omni/, diffusion/ modified"]
    severity: blocker
    source_evidence: "PR #2487 hsliuustc0106 직접 'irrelevant' (verbatim in ai-slop-rejections.md)"
    fix_template: "Revert side-model changes; create separate PR if needed."

  - id: VLLM-OMNI-2
    title: "Single-GPU stage_config available (codex P1)"
    evidence: "stage_configs/*.yaml 에 모든 stage 가 device 0 으로 매핑되는 yaml 존재"
    pass: "1+ single-GPU yaml exists"
    fail_signals: ["all minicpmo*.yaml require >1 GPU"]
    severity: major
    source_evidence: "PR #2487 codex bot P1 'minicpmo.yaml 1-GPU 안됨'"
```

각 item:
- `source_evidence` — 어떤 closed PR / quote 에서 도출됐는지 명시 (audit trail)
- 자동 generalization 금지 — *반복 확인된 pattern* 만

### 4. overrides.yaml

빈 파일 또는 사용자가 추후 추가:

```yaml
overrides: []
```

### 5. SKILL.md (extension)

```markdown
---
name: upstream-pr-review-<project>
extends: upstream-pr-review
description: <project>-specific lens for upstream PR review
---

# <project> upstream PR review extension

이 skill 은 generic `upstream-pr-review` (Layer 1) 위에 *<project>-specific lens* 추가.

## Sources
- `project-understanding.md` — <project> 의 공식 contract 추출
- `ai-slop-rejections.md` — closed PR 의 maintainer reject quotes (raw, NOT rules)
- `project-rubric.yaml` — 위에서 human-curated 추출된 IDs

## Audit
Layer 1 skill 의 audit workflow 를 사용. 이 skill 은 input source 만 추가.

## Maintenance
- `ai-slop-rejections.md` 에 새 reject 받으면 verbatim append. 자동 rule X.
- `project-rubric.yaml` 의 업데이트는 *반복 확인된 pattern* 만 사용자 수동 추가.
```

## Dry-run preview

bootstrap 은 *최초 실행 시 dry-run preview* 후 사용자 confirm 받고 commit. 자동 commit 금지.
