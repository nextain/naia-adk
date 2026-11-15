# 고치기 전 상위 구조·최초 요구 적합성 확인

문제를 고치거나 새 장치를 넣을 때 눈앞의 이슈 카드·서버·파일 하나만 보고 임시로 덮으면, 같은 땜빵이 쌓여 상위 구조와 어긋납니다. 어떤 해결책이든 적용 전에 **최초 요구**와 **우리 상위 구조가 이 해결을 받아들이는 방식**을 먼저 적고 검사합니다.

- 규칙 정본: `.agents/context/agents-rules.json` (`conventions.architecture_fit_before_fix`)
- 공용 판정·운영 계획 게이트: `.claude/hooks/lib/deploy-plan.js` (`architectureFitProblems`), `.agents/scripts/approval-plan.mjs`
- 일반 고침·PR·기획 적대 리뷰: `.agents/skills/review-pass/SKILL.md` (`planning`·`development` 단계 `architecture_fit_assessment`, `.agents/skills/review-pass/scripts/validate-review-output.mjs` 가 위 공용 `architectureFitProblems` 를 호출)
- 지시서·개발 주기 견본: `.agents/workflows/development-cycle.yaml`, `.agents/workflows/issue-driven-development.yaml`, `.github/PULL_REQUEST_TEMPLATE.md`, `.agents/requirements/_template.yaml`, `scripts/work-ledger/drive.mjs`
- 승인 계획서 절차: [approval-plan-gate.md](./approval-plan-gate.md)

## 왜 먼저 적는가

- 이슈 카드나 장애 증상만 보고 서버 한 대 설정이나 파일 한 곳을 땜질하면, 플랫폼이나 ADK 업스트림의 공통 계층과 다른 예외 경로가 늘어납니다.
- 반대로 해결책이 우리 상위 구조 어디에 붙는지, 최초 요구에서 벗어나지 않았는지를 먼저 적으면 기존 확장이 맞는지 새 층이 필요한지 구현 전에 걸러집니다.

## 세 칸 (`architecture_fit`)

계획서(`deploy-plan.json`)에는 `architecture_fit` 객체 아래 다음 세 칸을 반드시 적습니다.

1. **`original_request` (a — 최초 요구 원문)**: 누가 무엇을 바랐는지 원문 요지나 요청 출처를 적습니다(최소 10자). 작업 도중 문제 범위를 임의로 줄이거나 바꾸지 않도록 기준을 고정합니다.
2. **`parent_structure` (b — 붙는 상위 구조)**: 이 고침이 붙는 플랫폼·ADK 업스트림·제품 구조의 어느 계층·표준인지 적습니다(최소 8자). **특정 서버 이름, IP, 서비스 키, 단일 파일 경로만 적으면 검사에서 막힙니다.**
3. **`acceptance_rationale` (c — 상위 구조가 받아들이는 방식)**: 기존 계층의 확장인지, 새 공통 층의 추가인지, 왜 단발 땜빵이 아닌지 적습니다(최소 10자).

## 좋은 예와 나쁜 예

### 좋은 예

```json
"architecture_fit": {
  "original_request": "운영 컨테이너 배포마다 수동 환경변수 패치를 반복하지 않고 ADK 표준 계획 게이트에서 공통 검증하고 싶다",
  "parent_structure": "naia-adk 승인 계획 게이트 및 azure 컨테이너 앱 공통 배포 파이프라인",
  "acceptance_rationale": "개별 서버 셸 패치 대신 기존 deploy-plan 양식 검사와 공통 배포 스키마를 확장하므로 모든 서비스가 같은 검증 계층을 타게 됩니다"
}
```

### 나쁜 예 (차단됨)

```json
"architecture_fit": {
  "original_request": "에러 수정",
  "parent_structure": "prod-app-01 서버 /etc/systemd/system/app.service",
  "acceptance_rationale": "당장 고침"
}
```

- `original_request`가 최초 요구 원문이 아닌 요약 단어 5자에 불과합니다.
- `parent_structure`가 특정 서버(`prod-app-01`)와 단일 파일 경로만 가리켜 상위 구조 관점이 빠졌습니다.
- `acceptance_rationale`이 기존 확장이든 새 층이든 구조적 수용 근거를 설명하지 않습니다.

### 나쁜 예 (filler 로 땜빵 가리기 — 적대 리뷰에서 차단됨)

단일 서버·파일 수정 뒤에 일반 문구(`공통 게이트 따름`, `플랫폼 기준 준수`)만 덧붙이면 형식 검사 토큰 수 조건을 지나갈 수 있어도, 실제 변경은 여전히 특정 서버·파일 단발 땜빵이므로 적대 리뷰(`architecture_fit` / `구조이탈` / `architecture_fit_assessment`)에서 차단합니다.

```json
"architecture_fit": {
  "original_request": "운영 서비스 장애가 반복되지 않게 배포 검증 기준을 플랫폼 공통으로 맞추고 싶다",
  "parent_structure": "prod-app-01 서버 수정, naia-adk 공통 게이트 따름",
  "acceptance_rationale": "이번 수정은 플랫폼 기준을 준수하며 서버 한 대만 먼저 반영합니다"
}
```

- **왜 나쁜가**: 서술 뒤 filler 문구만 붙였지 실제 `prod-app-01` 단발 땜빵을 플랫폼 공통 계층(`config/deploy-gate.json`·공통 배포 템플릿)으로 흡수하는 구조와 수용 근거가 없습니다.
- **고치는 방향(좋은 예)**: `"parent_structure": "naia-adk 승인 계획 게이트 및 공통 배포 템플릿(config/deploy-gate.json)"` 처럼 실제로 붙는 상위 계층을 적고, `acceptance_rationale` 에는 왜 그 계층 확장이 단발 서버 패치보다 맞는지 구체적으로 적습니다.

## 검사가 막히는 경우

`deploy-plan.js`의 `architectureFitProblems` (`formProblems(plan)` 및 `review-pass` `validate-review-output.mjs` 공용 호출)와 `approval-plan.mjs check`는 다음 중 하나라도 걸리면 진행을 막습니다.

1. `architecture_fit` 객체가 없거나 객체 형식이 아님
2. 세 칸 중 하나라도 비어 있거나 최소 길이(`original_request` 10자, `parent_structure` 8자, `acceptance_rationale` 10자)보다 짧음
3. 견본 양식의 `<...>` 자리표시자를 전체 또는 일부(`"원문 <추가>"` 같은 부분 견본 포함)로 남겨 둠 (단, `<@12345>` 같은 메신저 멘션 표기는 견본으로 오인하지 않음)
4. `parent_structure`가 `services` 키와 같거나, 서버/호스트명·IP·단일 파일 경로(및 `서버`, `파일`, `수정` 등 형식어)만으로 채워져 있고 붙는 플랫폼·ADK·제품 구조 설명이 없음 (`"플랫폼공통배포계층표준"`처럼 공백 없는 정식 한국어 복합 구조명은 실질 토큰 판정으로 통과하되, `"특정서버호스트만수정"`처럼 형식어 조합만 남은 입력은 차단)

## 기존 계획서 호환과 일반 고침·PR·지시서 적용

- **승인 계획서 호환 (`deploy-plan.json`)**: `ARCHITECTURE_FIT_CUTOFF`(`2026-11-15T04:30:00Z`) 이전 생성(`createdAt`)이고 `version >= 2`가 아닌 기존 계획서는 막지 않고 경고(`formWarnings`)와 9기준 적대 리뷰 호환을 유지합니다. 기준 시각 이후 계획서와 `version: 2` 이상 새 양식은 `architecture_fit` 세 칸과 10번째 기준 `architecture_fit`이 필수입니다.
- **일꾼 지시서·PR 설명·기획(`review-pass`)**: `review-pass` 의 `planning`·`development` 단계는 모든 리뷰 대상(지시서·PR 설명·계획)에서 `architecture_fit_assessment`(`original_request`, `parent_structure`, `acceptance_rationale`, `fit_is_sufficient`, `problems`)를 의무로 검사하며, 세 칸이 없거나 빈칸·견본·좁은 설명이면 `CLEAN` 을 막고 `NOT_CLEAN` 차단 판정을 냅니다. 일꾼 지시서(`prompt.md`)와 PR 본문에도 세 칸을 함께 적습니다.

### 일꾼 지시서 (`prompt.md`) · 작업 계획 견본

```markdown
## architecture_fit
- **original_request** (최초 요구 원문): <요청자가 바란 원문 요지·출처, 최소 10자>
- **parent_structure** (붙는 상위 구조): <플랫폼·ADK 업스트림·제품 공통 계층/표준, 최소 8자>
- **acceptance_rationale** (상위 구조가 받아들이는 방식): <기존 계층 확장 vs 새 공통 층 추가, 단발 땜빵이 아닌 이유, 최소 10자>
```

적대 리뷰(`deploy-plan review` 및 `review-pass` `planning`/`development`)에서도 상위 구조 적합 기준과 차단 분류 `구조이탈`로 이 세 칸의 실질 적합성과 filler 회피 여부를 다시 확인합니다.
