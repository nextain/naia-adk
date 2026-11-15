# 고치기 전 상위 구조·최초 요구 적합성 확인

문제를 고치거나 새 장치를 넣을 때 눈앞의 이슈 카드·서버·파일 하나만 보고 임시로 덮으면, 같은 땜빵이 쌓여 상위 구조와 어긋납니다. 어떤 해결책이든 적용 전에 **최초 요구**와 **우리 상위 구조가 이 해결을 받아들이는 방식**을 먼저 적고 검사합니다.

- 규칙 정본: `.agents/context/agents-rules.json` (`conventions.architecture_fit_before_fix`)
- 자동 검사기: `.claude/hooks/lib/deploy-plan.js` (`architectureFitProblems`), `.agents/scripts/approval-plan.mjs`
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

## 검사가 막히는 경우

`deploy-plan.js`의 `formProblems(plan)`와 `approval-plan.mjs check`는 다음 중 하나라도 걸리면 진행을 막습니다.

1. `architecture_fit` 객체가 없거나 객체 형식이 아님
2. 세 칸 중 하나라도 비어 있거나 최소 길이(`original_request` 10자, `parent_structure` 8자, `acceptance_rationale` 10자)보다 짧음
3. 견본 양식의 `<...>` 자리표시자를 그대로 남겨 둠
4. `parent_structure`가 `services` 키와 같거나, 서버/호스트명·IP·단일 파일 경로(및 `서버`, `파일`, `수정` 등 형식어)만으로 채워져 있고 붙는 플랫폼·ADK·제품 구조 설명이 없음

적대 리뷰(`review`)에서도 10번째 기준 `architecture_fit`과 차단 분류 `구조이탈`로 이 세 칸의 실질 적합성을 다시 확인합니다.
