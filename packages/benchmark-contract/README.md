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
- `balanced`: Luna Max가 비서·이슈 리더를 맡고, Sol Medium의 별도 분석·설계·리뷰를 거쳐 제한 구현과 테스트는 Luna가 수행하는 bound Codex 기본값
- `economy`: `balanced`와 같은 안전 경계를 유지하면서 Luna의 저위험 기계 작업 범위를 후속 실험으로 확장하는 프로파일
- `delegated`: 선택 설치한 외부 구현 워커에 범위가 제한된 중위험 이하 구현을 맡기고 Sol이 계획·통합을 유지하는 프로파일. 공개 정본은 공급자 중립 바인딩만 유지하며 실제 공급자·모델과 자격 증거는 배포별 비공개 오버레이에서 관리합니다.

```bash
node packages/benchmark-contract/src/development-profiles.mjs show --profile balanced
node packages/benchmark-contract/src/development-profiles.mjs select \
  --profile balanced --role bounded_worker --risk medium --bounded-scope --exact-validator
node packages/benchmark-contract/src/development-profiles.mjs select \
  --profile delegated --role bounded_worker --risk medium --bounded-scope \
  --available-bindings sol,terra,implementation_worker
```

Balanced에서는 L3 비서와 L2 이슈 리더가 Luna Max이고, 별도 분석·설계·리뷰는
Sol Medium, 구현·테스트·번역은 Luna 계열입니다. 범위가 제한되지 않았거나 위험도가
높으면 Sol로 되돌아갑니다. 제한 구현에서 Luna는 `--bounded-scope --exact-validator`가
모두 있어야 선택되며 조건을 충족하지 못하면 Sol로 상향합니다. Bound Codex
기본값에서 역할에 필요한 Luna 또는 Sol 바인딩이 없으면 fail closed이며, Terra는 명시적으로
사용 가능한 경우에만 선택할 수 있습니다. 기계 작업은 여기에 `--risk low`까지 필요합니다. 이 1차
Codex bound 세션에는 `balanced`가 기본 활성화되며 명시적 프로파일 override도 가능하지만, 전체 개발 비용 절감을 증명했다는 뜻은
아닙니다. 새 모델은 프로파일을 바꾸지 않고 `bindings`의 역할 자격을 다시 검증한
뒤 교체합니다.

Balanced의 분석·설계·리뷰 선택은 생산·분석·설계·리뷰에 역할별 세션 ID와 실행 ID가
모두 제공되고 네 역할의 두 ID 집합이 각각 전부 다를 때만 허용됩니다. 역할 선택기는
독립 실행 신원을 확인할 수 없으면 fail closed합니다. `delegated`의 외부 구현 워커는
`CODEX_HOME/adk-development-worker-trust.json`에 등록된 Ed25519 공개키로 검증되는
배포별 단기 자격 영수증이 있어야 활성화되며, 공개 카탈로그 문자열만으로는 선택할 수 없습니다.

## Codex 서브에이전트 비용 경계

`.codex/hooks.json`의 `PreToolUse` 가드는 hook에 보이는 spawn 호출만
차단한다. 일반 `exec` 래퍼 안에 숨은 spawn은 런타임 또는 래퍼 자체의
강제가 필요하다. 프로파일과 watchdog은 이 경계를 보완하는 defense in
depth이며, 감춰진 호출을 소급해 차단하지 않는다.

정본 계약과 동결 증적은 `.agents/decisions/`와 `.agents/reviews/`에 있으며,
계약 SHA-256은 `e9f298159975b78cd215de96733bd95bf98e26cea7a3bcb3f8246797df7b6222`입니다.
