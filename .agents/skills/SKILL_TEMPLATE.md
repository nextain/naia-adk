---
# === Agent Skills Standard Fields (agentskills.io) ===
name: skill-name
description: 스킬이 하는 일과 언제 사용해야 하는지를 명확히 기술합니다. Claude는 이 필드로 스킬을 트리거합니다 — 구체적으로, 약간 pushy하게 작성해야 under-trigger를 방지할 수 있습니다. "~할 때 사용"보다 "~시 반드시 사용" 형태 권장.
# license: MIT
# compatibility: "Claude Code 2.x"

# === Claude Code Extension Fields ===
# argument-hint: "[선택사항: 인수 힌트]"
# disable-model-invocation: true
---

# [Skill Name]

## 목적

이 스킬이 하는 일을 2-3문장으로 설명합니다.

## 워크플로우

### Step 1: ...
### Step 2: ...

## Key Files

| 파일 | 용도 |
|------|------|
| `path/to/file` | 설명 |

## 참고

- 중요한 주의사항

---

<!--
## 스킬 구조 가이드 (새 스킬 작성 시 참고 후 삭제)

### Frontmatter 필드 규칙

**Agent Skills 표준 (agentskills.io/specification):**

| 필드 | 필수 | 규칙 |
|------|:----:|------|
| `name` | O | 1-64자, 소문자+숫자+하이픈만, 디렉토리명과 일치 |
| `description` | O | 1-1024자, 무엇을 하는지 + 언제 사용하는지 |
| `license` | - | 라이선스 명 또는 파일 참조 |
| `compatibility` | - | 1-500자, 환경 요구사항 |
| `metadata` | - | map(string→string), 커스텀 키-값 |
| `allowed-tools` | - | 공백 구분 도구 목록 (실험적) |

**Claude Code 확장 필드** (표준 외, Claude Code에서만 동작):

| 필드 | 용도 |
|------|------|
| `argument-hint` | 슬래시 커맨드 자동완성 힌트 (예: `"[file]"`) |
| `disable-model-invocation` | `true`면 모델이 Skill 도구로 직접 호출 불가. 절차형 스킬에 사용 |
| `user-invocable` | `false`면 `/` 명령어 목록에 안 나옴 (기본 `true`) |
| `model` | 스킬 실행 시 모델 오버라이드 |
| `context` | `"fork"`면 별도 컨텍스트에서 실행 |
| `agent` | 에이전트 설정 |
| `effort` | 실행 노력 수준 |
| `shell` | 셸 환경 지정 |
| `paths` | 스킬 적용 경로 필터 |
| `hooks` | 스킬별 훅 설정 |
| `arguments` | 인수 이름 목록 |
| `when_to_use` | 사용 시점 힌트 |
| `version` | 스킬 버전 |

### name 규칙 (필수)
- 소문자 영문(`a-z`), 숫자(`0-9`), 하이픈(`-`)만 사용 (스펙은 unicode lowercase 허용이나 실무상 ASCII 권장)
- 하이픈으로 시작/끝 불가, 연속 하이픈(`--`) 불가
- 반드시 부모 디렉토리명과 일치

### description 작성 팁
- Claude는 under-trigger 경향이 있음 → 트리거 조건을 구체적으로 나열
- 나쁜 예: "PDF 파일 처리 시 사용"
- 좋은 예: ".pdf 파일이 언급되거나, PDF 읽기/편집/생성 요청 시 반드시 사용"

### Progressive Disclosure 원칙
SKILL.md 500줄 이하 유지. 초과 시 하위 파일로 분리:

  skill-name/
  ├── SKILL.md              ← 진입점 (500줄 이하)
  ├── scripts/              ← 실행 전용. 절대 읽지 말고 실행만 할 것
  │   └── do-something.py  ← `python scripts/do-something.py <args>`
  ├── references/           ← 필요할 때만 로드
  │   └── detailed-guide.md ← SKILL.md에서 "필요 시 읽을 것" 명시
  └── assets/               ← 템플릿, 이미지, 데이터 파일 등 정적 리소스

### 언제 scripts/ 를 쓰는가
- 반복 실행되는 bash/python 코드가 30줄 이상이면 scripts/로 분리
- SKILL.md에 인라인 임베드하면 매번 context를 오염시킴
- scripts/는 black box — Claude가 읽지 않고 실행만 함

### 언제 references/ 를 쓰는가
- 항상 필요하지는 않은 상세 문서 (예: 포맷 레퍼런스, API 명세)
- 300줄 이상이면 TOC 포함

### Mirroring Policy
이 파일 수정 시 `.users/skills/[skill-name]/SKILL.md`도 동일하게 업데이트.
-->
