# Output policy — invisibility constraint

이 skill 의 *모든* 출력 (rubric IDs, internal terminology, AI iteration vocabulary) 은 **PR-facing surface 에 절대 leak 안 됨**.

## PR-facing surfaces

- PR title / description
- Commit messages (squash-merge 후의 final commit message 도)
- Review reply comments
- Issue comments referencing the PR
- Documentation files committed in the PR

## Forbidden tokens (자동 검사 대상)

- Rubric IDs: `SCOPE-`, `AISLOP-`, `MECH-`, `DUPL-`, `QUALITY-`, `DOC-`, project-rubric IDs
- Skill terminology: `pass criteria`, `fail signal`, `evidence command`, `rubric audit`
- AI iteration phrasing: `Pass N`, `iteration N`, `review pass`, `adversarial review`, `13 rounds`
- Internal project terminology: `Phase Xd`, `cleanup-only commit`, `(찌꺼기)`

## Self-test (AISLOP-3)

skill audit 실행 시:
1. PR description draft 또는 최근 commit messages 에서 위 token grep
2. 1+ hits → AISLOP-3 FAIL
3. fix: rewrite as natural prose

## Permitted internal output

- skill 의 audit matrix 출력 (terminal, log file)
- `<fork>/.claude/skills/upstream-pr-review-*/` 내부 documents
- Conversation 내 사용자와의 dialog

## Why

Maintainer 가 *이 PR 이 AI 의 quality gate 를 통과한 결과* 라고 인지 가능한 신호 모두 = polished AI slop. *invisible audit, natural-prose PR* 이 목표.
