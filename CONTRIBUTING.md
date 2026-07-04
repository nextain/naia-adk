<!-- Copyright 2026 Nextain Inc. -->

# Naia ADK 기여 가이드

Naia ADK에 기여하는 방법을 안내합니다. AI 에이전트와, AI 도구를 쓰는 사람 모두를 위한
문서입니다. AI가 참조하는 원본 규칙은 [`.agents/context/`](.agents/context/)에, 사람이 읽는
자세한 미러는 [`.users/context/`](.users/context/)에 있습니다.

## 언어

이슈, PR, 토론은 편한 언어로 써도 됩니다. AI가 소통을 중개합니다. 다만 git 기록은 영어로
남깁니다.

| 대상 | 언어 |
|------|------|
| 코드와 컨텍스트 파일 | 영어 |
| 커밋 메시지 | 영어 |
| 이슈 / PR / 토론 | 자유 |

## 시작하기 전에 읽을 것

새 기여자(AI 에이전트 포함)는 아래 파일을 순서대로 읽으세요.

1. `.agents/context/agents-rules.json` — 프로젝트 핵심 규칙 (단일 진실 공급원)
2. `.agents/context/ai-work-index.yaml` — 작업 유형별 워크플로우 색인
3. `.agents/context/project-index.yaml` — 서브모듈별 진입점 색인

서브모듈에서 작업할 때는 해당 서브모듈의 진입점 규칙 파일을 먼저 읽으세요.

## 개발 흐름

기능 단위 작업은 이슈 기반 개발을 기본으로 합니다. 큰 틀은 다음과 같습니다.

```
이슈 → 계획 → 구현(테스트 먼저) → 검증 → 정리 → 커밋
```

전체 14단계와 승인 게이트는 [AGENTS.md](AGENTS.md#개발-프로세스-development-process)와
[`.agents/workflows/`](.agents/workflows/)에 정리돼 있습니다. 핵심 규칙은 이렇습니다.

- **테스트 먼저** — 실패하는 테스트(RED)부터 쓰고, 최소 구현(GREEN) 뒤 리팩터합니다.
- **실제로 실행해 검증** — 타입 체크만으로는 부족합니다. 앱이나 서버를 띄워 확인합니다.
- **최소 변경** — 필요한 것만 고칩니다. 과도한 리팩터링은 피합니다.

## 기여 절차

1. **이슈 먼저** — 코딩 전에 GitHub 이슈를 만들거나 고릅니다.
2. **포크와 브랜치** — `issue-{번호}-{설명}` 형태의 브랜치에서 작업합니다.
3. **테스트** — 테스트를 쓰고, PR 전에 검증합니다.
4. **단일 PR** — 코드와 테스트, 관련 컨텍스트 변경을 하나의 PR로 묶습니다.

### PR 제목

```
type(scope): description
```

타입은 `feat`, `fix`, `refactor`, `docs`, `chore`, `test`를 씁니다.

### 체크리스트

- [ ] 테스트 통과
- [ ] 실제 실행으로 검증 완료
- [ ] 아키텍처가 바뀌었다면 컨텍스트 파일도 함께 업데이트

## 스킬 기여

스킬은 YAML frontmatter가 있는 `SKILL.md` 한 파일로 정의합니다.

- **위치** — `.agents/skills/{스킬명}/SKILL.md` (원본)
- **미러** — 사람이 읽어야 하는 스킬은 `.users/skills/{스킬명}/SKILL.md`에 미러를 둡니다. 모든 스킬을 미러하지는 않으며, 지금은 일부만 미러돼 있습니다.
- **이름** — kebab-case, 접두사 없이 (예: `review-pass`, `merge-worktree`)
- **등록** — 추가한 뒤 `/manage-skills`를 실행해 진입점 문서에 등록합니다.
- **검증** — 실제 세션에서 `/스킬명`으로 직접 호출해 확인합니다.

## 컨텍스트 기여

`.agents/`가 원본이고 `.users/`는 사람이 읽는 미러입니다. 규칙 파일을 바꾸면 미러도 함께
업데이트합니다(전파 순서: self → parent → siblings → children → mirror).

AI 컨텍스트 파일에 의도한 라이선스는 CC-BY-SA 4.0입니다([`.agents/context/contributing.yaml`](.agents/context/contributing.yaml)의 `license` 항목). 다만 현재 대부분의 컨텍스트 파일은 `Copyright 2026 Nextain Inc.` 형태의 헤더만 달고 있어 파일별 SPDX 헤더 표기와는 아직 일치하지 않습니다. 새 파일을 추가할 때는 기존 파일의 헤더 관례를 그대로 따르세요.

## 기여 유형

번역, 스킬, 기능, 버그 리포트, 코드/PR, 문서, 테스트, 디자인/UX, 보안 리포트, 컨텍스트 등
어떤 형태의 기여든 환영합니다.

## 라이선스

코드 기여는 Apache License 2.0을, 컨텍스트 기여는 CC-BY-SA 4.0을 따릅니다.
