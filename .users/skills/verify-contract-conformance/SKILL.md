---
name: verify-contract-conformance
description: 계약(선언된 API/인터페이스)과 코드 구현 사이의 드리프트를 결정론으로 검출합니다. 시그니처 드리프트·계약만 선언(미구현)·코드만 존재(미문서)를 잡아 "게이트는 통과하는데 계약과 분기한 가짜 성공"을 차단. 기능 구현 후·PR 전·마이그레이션 시·issue-driven-development Review/Post-test 단계에서 반드시 사용. /verify-contract-conformance로 호출.
disable-model-invocation: true
argument-hint: "[선택사항: 계약 파일 경로]"
metadata:
  family: verify
  judge: deterministic
---

# 계약↔코드 적합성 검증 (Contract Conformance)

## 목적

선언된 **계약**(인터페이스/헤더/사양의 심볼 표)과 실제 **코드**의 심볼 표를
대조해, 둘이 어긋난 지점을 **결정론 알고리즘**으로 보고합니다. 표면 테스트가
통과해도 계약과 코드가 조용히 분기하는 "가짜 성공"을 잡습니다.

드리프트 3종:
- **signature-drift** — 같은 이름이 양쪽에 있으나 *타입 수준* 시그니처가 다름.
- **contract-only** — 계약에 선언됐으나 코드에 없음(미구현).
- **code-only** — 코드에 있으나 계약에 없음(미문서).

판정은 LLM이 아니라 순수 함수입니다(생성 ≠ 채점). 파라미터 이름·공백은
시그니처의 일부가 아니므로 드리프트가 **아닙니다**; 타입·const·반환형·인자 수만
드리프트입니다. 기준(계약)을 AI 루프 밖 결정론에 앵커하므로, 검사기가 약해도
반증 가능한 신호를 냅니다.

## 실행 시점

- **Review 및 Post-test Review 단계마다** — `verify-implementation`이 자동 호출.
- 기능 구현 후 / PR 전 / 마이그레이션(기존→템플릿) 시 **cleanse-scan 게이트**.

## 워크플로우

### Step 1: 계약·코드 심볼 표 추출
- 계약 = 인터페이스 사양(`docs/contracts/*`, `*.h`, interface/타입 선언)에서 `{name, sig}` 추출.
- 코드 = 실제 구현 헤더/소스에서 `{name, sig}` 추출.
- 경로는 인수 또는 프로젝트 설정에서 결정. 추출 불가 시 사용자에게 보고하고 중단.

### Step 2: 결정론 드리프트 검출
- `scripts/conform/oracle.py`의 `drift_set_typelevel(contract, code)` 실행
  (`contract`/`code` = `[{"name":..., "sig":...}]`).
- 반환 = `{symbol_name: drift_type}` (드리프트 없으면 빈 맵).

### Step 3: 보고
- 드리프트 0 = PASS.
- 드리프트 있음 = 각 심볼·유형·근거를 표로 제시. **자율 수정 금지** — 화해안
  (계약 등재 / 구현 / 계약 축소)은 사람 결정.

```markdown
## 계약 적합성 검증
| 심볼 | 드리프트 | 계약 | 코드 |
|------|---------|------|------|
| scene_handle_key | signature-drift | int(int) | GameKey(GameKey) |
| scenario_load | contract-only | 선언됨 | (미구현) |
| battle_begin | code-only | (없음) | void(Battle*) |
→ 화해 결정은 사용자 게이트.
```

## Exceptions (false positive 방지)
- 파라미터 **이름**만 다름 (`keycode`→`key`) = 적합, 보고 금지.
- **공백/포매팅**만 다름 = 적합, 보고 금지.
- typedef 별칭(`uint32_t` vs `unsigned int`) = 현재 범위 밖(타입 표 필요) — 별도 표기.
- 의미론/행위 적합성(시그니처는 맞으나 구현이 틀림)은 이 스킬 범위 밖 — 실행
  테스트(E2E)·`review-pass`(다중 AI)가 담당. conform = *값싼 1차 결정론 그물*.

## Key Files
| 파일 | 용도 |
|------|------|
| `scripts/conform/oracle.py` | 결정론 드리프트 검출 (`drift_set_typelevel`) |
| `scripts/conform/evaluator.py` | 드리프트 맵 채점 (자가검증/회귀 테스트용) |
| `scripts/conform/selftest_conform.py` | 모델 무관 자체 증명 (타입 규칙 + 실제 사례) |

## 참고
- 앵커 철학: 기준(계약)을 AI 루프 밖 결정론으로 고정 → 검사기가 약해도 반증가능.
- 모델 교체 무관: oracle은 순수 함수(stdlib만), 어떤 타깃 모델에도 동일.
- `selftest_conform.py`는 실제 검증된 드리프트 사례(시그니처 1 + 계약만 6 + 코드만 8)를
  LLM 없이 재현 — 회귀 가드로 사용.
