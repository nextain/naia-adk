# `@naia-adk/artifacts-spec`

RBAC + SDLC artifact 표준. naia-agent / naia-os / naia-business-adk adapter 가 공유하는 산출물 스키마.

> **Status**: v0.0.1 스캐폴딩 (MVP). naia-adk #8 트래킹. 본 패키지는 어제(2026-05-19~20) 시작된 ADK 진화의 일부.

## 사상

본 패키지는 *schema*(JSON Schema, 항상 git-tracked) 와 *instance*(런타임 데이터) 를 구분한다. 모든 15 schema 는 git-tracked. instance lifecycle 은 산출물별로 다름:

- **stable declarative** (8): instance 가 git-tracked·버전관리 가능. fork chain 상속·재정의.
- **schema-declarative · instance-hybrid** (3): schema 는 git-tracked, instance 는 세션·시점 종속(만료/append-only/세션바운드). 본 묶음은 schema 만 fork chain 으로 공유, instance 는 host 가 운영.
- **runtime control-state** (4): instance 가 항상 ephemeral·세션 종속. git 아닌 ephemeral 스토어.

두 카테고리 (schema-declarative · runtime control-state) 가 같은 스키마 묶음에 들어가지 않도록 분리 — codex/opencode 피어리뷰 합의. instance-hybrid 묶음은 *schema 는 stable declarative 와 같이, instance lifecycle 은 host 정책에 위임* 한다.

## 산출물 15종

### stable declarative (8) — schema + instance 모두 git-tracked 가능
| # | 파일 | 역할 |
|---|---|---|
| 1 | `actor-identity.yaml` | NAIA_ACTOR_CLASS·tgt_role 명세 |
| 2 | `ownership-table.yaml` | 자원·세션·소유 매핑 |
| 3 | `risk-matrix.yaml` | 4축 위험 분류 (Track A reference impl) |
| 4 | `sdlc-stage.yaml` | plan→...→operate per-feature |
| 5 | `review-spec.yaml` | REVIEW_SOURCES + semi-automatic 게이트 |
| 6 | `deploy-spec.yaml` | env·verify·snapshot·rollback |
| 7 | `capability-profile.yaml` | 세션이 할 수 있는 일 |
| 8 | `cost-budget.yaml` | multi-session 토큰 비용 추적 |

### schema-declarative · instance-hybrid (3) — schema 는 git, instance lifecycle 은 host 정책
| # | 파일 | 역할 | instance lifecycle |
|---|---|---|---|
| 9 | `breakglass-marker` | scope/expiry/nonce | 사용자 발급 → expiry/nonce 소비 시 ephemeral (token 만료) |
| 10 | `audit-log.jsonl` | append-only audit trail | host 정책 (retention/rotation) — schema 항상 stable |
| 11 | `session-manifest.yaml` | 세션 = projects/<name> 바인딩·tool 권한·LLM 모델 | declarative core(id·bound_project·persona·capability_profile·llm) + 런타임 annotation(started_at·ephemeral_paths) |

### runtime control-state (4) — instance 항상 ephemeral
| # | 파일 | 역할 |
|---|---|---|
| 12 | `mutation-lock` | 워크트리·origin·서버 변경 직렬화 |
| 13 | `inbox/<session>.jsonl` | 세션 간 메시지 큐 |
| 14 | `transcript/<topic>.jsonl` | 세션 간 대화 (peer↔peer 시각화 입력) |
| 15 | `lane.yaml` | 세션 레인 정의 (operational 가드레일) |

## 정직 framing (불변)

본 spec = **advisory · defense-in-depth · 협업·조정 모델**.
- 권한 = 운영적 가드레일 + 호스트 정책 + 사용자 통제.
- "닫힘 / 안전 / runtime enforce / 자동 강등" 표현 금지.
- "advisory / mitigation / semi-automatic / 측정 후 결정" 사용.
- "보안 경계" 프레이밍 자체 회피 (negative 사용도 회피) — 그 단어를 중심축으로 세우면 독자가 다시 그 프레임으로 읽음. [codex P1 v2 redline]

실 안전망 = 사용자 본인 + 호스트 훅 + Track A 야간 8라운드 over-claim 경험에서 얻은 정직 종착선언.

## Reference impl

`projects/naia-business-adk/templates/service-ops/` (Track A 2026-05-19~20 산출):
- `policy/risk-matrix.yaml` (machine-readable, 5-tier RULE first-match, 122 테스트 PASS)
- `lib/_risk.sh` (해석·집행, 규칙 하드코딩 X)
- `verify-clean.sh` (READ-ONLY 진단, 4 acceptance criterion)

본 패키지는 그 impl 의 산출물 스키마를 *workspace 표준* 으로 끌어올린 것. fork chain (`naia-adk` → `{org}-adk`) 의 모든 adapter 가 공유.

## naia-adk `projects/` 컨벤션 연계

`projects/` 1-path 패턴 [user 2026-05-20] 이 세션-바인딩 입력. `session-manifest.yaml` 의 `bound_project` 필드가 `projects/<name>` 참조.

## 사용 (예정)

```typescript
import { validateArtifact, RiskMatrixSchema } from "@naia-adk/artifacts-spec";

const result = validateArtifact("risk-matrix", loadedYaml);
// → { ok: true, value: RiskMatrix } or { ok: false, errors: [...] }
```

(구현체 = naia-agent artifact API 또는 host adapter — Interfaces, not dependencies.)

## 관련 이슈

- nextain/naia-adk#8 — 본 패키지 design
- nextain/naia-agent#46 — artifact API + audit-log lifecycle (이 spec 소비)
- nextain/naia-agent#42 — meta epic (단일 사용자 personal AI 멀티세션)

## 진행 (2026-05-20)

- [x] 15 종 JSON Schema 작성 (Draft 2020-12)
- [x] 15 종 YAML/JSONL example
- [x] codex + opencode 피어리뷰 round 1 (DIRTY → 통합수정) → round 1.1 (opencode CLEAN, codex DIRTY 잔재 정정)

## 다음 산출 (TODO)

- [ ] codex + opencode round 2 (2차 클린 → P5 진행)
- [ ] TypeScript types (선택)
- [ ] validator 함수 (선택, host adapter 가 구현해도 무방)
- [ ] CI: schema lint + example 검증

## License

Apache-2.0
