# 영구 벤치마크 계약 패키지

`@naia-adk/benchmark-contract`는 모델 성능, `naia-agent` 실행 품질,
`naia-adk` 개발 계약을 서로 섞지 않고 반복 측정하기 위한 공유 스키마와 결정론적
검증기를 제공합니다. 제품 코어에는 특정 모델이나 프로젝트 규칙을 넣지 않습니다.

주요 원칙:

- 예정 과제·필수 지표·필수 조건을 빠짐없이 기록하며 누락은 무효로 처리합니다.
- 실패·재시도·fallback·상향 호출을 비용에서 빼지 않습니다.
- 지시부터 증거까지의 추적, 구현 전 재사용 판단과 동시 작업 예약을 검증합니다.
- 작성자의 셀프 체크를 독립 리뷰로 인정하지 않습니다.
- Windows 검증은 WSL, Bash, 심볼릭 링크 없이 Node로 실행됩니다.

스키마는 과제·실행뿐 아니라 라우팅 정책, 계층별 paired comparison,
비용 필드 상태, 자산·holdout·judge 보정, 전체 추적·재사용 예약,
듀얼 컨텍스트 번역 증거, 독립 리뷰 동결, baseline manifest를 함께 다룹니다.

검증:

```powershell
pnpm --filter @naia-adk/benchmark-contract test
```

## 빠른 적용 프로파일

모델 이름과 개발 역할을 분리한 네 프로파일을 제공합니다. Claude 또는 Codex
하나만 있는 사용자는 추가 provider 없이 기존 프로파일을 그대로 사용할 수 있습니다.

- `control`: all-Sol 기준선과 고위험 폴백
- `balanced`: Sol이 계획·통합을 맡고, 정확한 자동 검증기가 있는 제한 구현은 Luna가 수행하며, 검증기가 없으면 Terra로 되돌아가는 opt-in 기본값
- `economy`: `balanced`와 같은 안전 경계를 유지하면서 Luna의 저위험 기계 작업 범위를 후속 실험으로 확장하는 프로파일
- `delegated`: 선택 설치한 외부 구현 워커에 범위가 제한된 중위험 이하 구현을 맡기고 Sol이 계획·통합을 유지하는 프로파일. 현재 스모크 자격을 얻은 파일럿 `implementation_worker` 바인딩은 OpenCode의 Azure DeepSeek V4 Pro이며 새 모델은 이 바인딩만 같은 절차로 재검증해 교체합니다.

```bash
node packages/benchmark-contract/src/development-profiles.mjs show --profile balanced
node packages/benchmark-contract/src/development-profiles.mjs select \
  --profile balanced --role bounded_worker --risk medium --bounded-scope --exact-validator
node packages/benchmark-contract/src/development-profiles.mjs select \
  --profile delegated --role bounded_worker --risk medium --bounded-scope \
  --available-bindings sol,terra,implementation_worker
```

범위가 제한되지 않았거나 위험도가 높으면 Sol로 되돌아갑니다. 제한 구현에서
Luna는 `--bounded-scope --exact-validator`가 모두 있어야 선택되고 검증기가 없으면
Terra로 되돌아갑니다. 기계 작업은 여기에 `--risk low`까지 필요합니다. 이 1차
프로파일은 즉시 opt-in 사용할 수 있지만 전체 개발 비용 절감을 증명했다는 뜻은
아닙니다. 새 모델은 프로파일을 바꾸지 않고 `bindings`의 역할 자격을 다시 검증한
뒤 교체합니다.

정본 계약과 동결 증적은 `.agents/decisions/`와 `.agents/reviews/`에 있으며,
계약 SHA-256은 `fc1801cfc9bf91403a4bf854d271d57ee2a91e9f4afb42ce22da8c532f7b1b43`입니다.
