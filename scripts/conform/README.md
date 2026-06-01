# conform — 계약↔코드 적합성 검사 (deterministic, 0 tokens)

## 무슨 기능인가
선언된 **계약**(인터페이스/헤더의 심볼 표)과 실제 **코드**가 어긋났는지를
**순수 함수(LLM 없음)**로 검출합니다. 세 종류의 드리프트를 잡습니다:

- **signature-drift** — 같은 이름이 양쪽에 있으나 *타입 수준* 시그니처가 다름
  (파라미터 이름·공백은 드리프트 아님; 타입·const·반환형·인자 수만).
- **contract-only** — 계약에 선언됐으나 코드에 없음(미구현).
- **code-only** — 코드에 있으나 계약에 없음(미문서). `static`(private)은 제외.

## 무엇을 방지하나
**"표면 게이트는 통과하는데 계약과 조용히 분기한 가짜 성공"** — 즉 빌드·테스트는
다 초록불인데 코드가 자기 계약을 더 이상 따르지 않는 상태(이 워크스페이스에서
실제로 겪은 naia-144 `daf35d0`: 자동 QA 16/16 통과 + 계약과 분기). 판정 기준(계약)을
**AI 루프 밖 결정론**에 고정하므로, 검사기가 약해도 *반증 가능한* 신호를 냅니다.

## 소스 위치 (이 repo)
| 경로 | 역할 |
|------|------|
| `scripts/conform/oracle.py` | 결정론 드리프트 오라클 (`drift_set_typelevel`) — 재사용 패키지, stdlib만 |
| `scripts/conform/evaluator.py` | 드리프트 맵 채점(자가검증/회귀용) |
| `scripts/conform/selftest_conform.py` | 모델 무관 자체 증명 (타입 규칙 + 실제 검증 사례) |
| `.agents/skills/verify-contract-conformance/SKILL.md` | 이 오라클을 쓰는 검증 스킬 |

## 어떻게 쓰이나
- **스킬**: `verify-contract-conformance`가 `verify-implementation`에 등록돼
  **IDD Review/Post-test 단계(phase 7·9)에서 자동 실행** — 기능 구현·PR·마이그레이션 시.
- **자체 증명**: `python3 scripts/conform/selftest_conform.py` → 타입 규칙 + 실제
  드리프트 사례(시그니처 1 + 계약만 6 + 코드만 8)를 LLM 0으로 재현 = 회귀 가드.

## 한계 (정직하게)
구조/타입 수준만 봅니다. "시그니처는 맞는데 *구현 행위*가 틀림" 같은 의미론적 적합성은
범위 밖 — 실행 테스트(E2E)·`review-pass`(다중 AI)·사람 게이트가 담당합니다.
conform = *값싼 1차 결정론 그물*.

> **편집-시점 상시 게이트**(매 편집 후 자동 검사 + 드리프트 루프 차단)는
> `naia-template-project`에 있어 새 프로젝트가 상속합니다. 이 repo는 *스킬+오라클* 공급.
