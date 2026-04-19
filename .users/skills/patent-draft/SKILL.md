---
name: patent-draft
description: 특허 초안 생성 요청 시 반드시 사용. KIPO(한국특허청) 전자출원 양식 기반 특허 명세서 초안을 생성한다. 코드 분석 결과, 발명 아이디어, 또는 기존 기술 설명으로부터 출원 가능한 명세서 초안을 작성. "특허", "patent", "출원", "명세서", "청구항" 키워드 시 트리거.
argument-hint: "[slug or description]"
---

# patent-draft

## 목적

KIPO 전자출원 양식에 맞는 특허 명세서 초안을 생성한다. 한글 발명의 명칭과 영문 발명의 명칭을 모두 포함하며, patent-history.json에 등록까지 자동 처리한다.

## 워크플로우

### Step 1: 입력 확인

사용자로부터 다음 정보를 확인한다:
- 발명 대상 (코드베이스 경로, 기술 설명, 또는 아이디어)
- 발명자 (기본값: 양병석)
- 출원인 (기본값: (주)넥스테인)

### Step 2: 코드/기술 분석

대상 코드베이스 또는 기술 설명을 분석하여 특허 가능한 핵심 구성요소를 도출한다.

### Step 3: 초안 생성

아래 KIPO 양식 템플릿에 따라 초안을 생성한다.

### Step 4: patent-history.json 등록

`docs-business/05. 특허/patent-history.json`에 새 후보를 추가한다. `name`과 `name_en` 모두 필수.

### Step 5: PDF 렌더링

`docs-business/05. 특허/_render-pdf.mjs`로 PDF를 생성한다.

```bash
cd docs-business/05. 특허 && node _render-pdf.mjs <slug>/patent-draft.md
```

## KIPO 양식 템플릿

```markdown
## 【발명의 명칭】

{한글 발명의 명칭}

{English Title of Invention}

## 【출원인】

(주)넥스테인

## 【발명자】

양병석

## 【기술분야】

본 발명은 ... 에 관한 것으로, 더욱 구체적으로는 ...

## 【배경기술】

### 현재 ... 의 한계

...

### 기존 ... 의 한계

...

## 【발명의 내용】

### 【해결하려는 과제】

본 발명은 ... 문제를 해결하고자 한다.

### 【과제의 해결 수단】

본 발명은 ... 시스템 및 방법을 제공한다.

### 【발명의 효과】

본 발명에 의하면 ...

## 【도면의 간단한 설명】

- 도 1: ...
- 도 2: ...

## 【발명을 실시하기 위한 구체적인 내용】

### 1. 시스템 전체 구성

...

### 2. 핵심 모듈 상세

...

### 3. 실시예

...

## 【특허청구범위】

### [청구항 1] (독립항)

...

### [청구항 2] (종속항)

...

## 【요약서】

### 【요약】

...

### 【대표도】

도 1
```

## 영문 제목 작성 규칙

- 한글 명칭의 직역이 아닌, 영문 특허 관행에 맞는 자연스러운 표현 사용
- "System and Method for ..." 또는 "... System and Method" 패턴 권장
- 핵심 기술 키워드를 반드시 포함
- patent-history.json의 `name_en` 필드에 반드시 기록

## Key Files

| 파일 | 용도 |
|------|------|
| `docs-business/05. 특허/patent-history.json` | 특허 후보 DB (SoT) — `name`과 `name_en` 필수 |
| `docs-business/05. 특허/{slug}/patent-draft.md` | 초안 저장 경로 |
| `docs-business/05. 특허/_render-pdf.mjs` | PDF 렌더링 스크립트 |
| `docs-business/05. 특허/DASHBOARD.md` | 특허 현황 대시보드 |

## 참고

- 【발명의 명칭】 섹션에 한글과 영문을 모두 기재 (KIPO 전자출원 시 영문명 입력란 존재)
- 청구항의 종속항 헤더는 본문 텍스트로 작성 (마크다운 헤딩 X)
- Mermaid 다이어그램으로 시스템 구성도, 플로우차트 작성
- 기존 초안 참고: `docs-business/05. 특허/patent-pipeline/patent-pipeline-draft.md`
