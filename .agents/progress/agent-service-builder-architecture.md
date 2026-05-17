<!-- 설계 문서 v2 — 크로스리뷰 1회전(codex+gemini ISSUES_FOUND) 반영 전면 재작성.
     v1 의 CRITICAL 2 / MAJOR 4 / 누락 2 해소. 재크로스리뷰 대기.
     사용자 합의 게이트 전 코드 착수 금지.
     SoT 경계: 4-repo Part A(alpha-adk, F07 수정금지) 위에 얹는 확장.
     리뷰 산출물: .agents/reviews/agent-service-builder-{codex,gemini}.md (v1 라운드) -->

# Agent Service Builder — 아키텍처 설계 v2

> **목적**: naia-agent 풀셋(LLM + persona/system-prompt + naia-memory + RAG +
> orchestration)으로 **다양한 에이전트 서비스를 정의·운영·평가**하는 기반을
> 개인(naia-os) / 비즈니스(naia-business-adk) 2-layer 로.
> **계기**: 외부 에이전트 개발 의뢰 — 데모 제출 예정.
> **워크플로**: 설계 → 크로스리뷰(2x clean) → 합의·보고 → 개발.

---

## 0. v1 → v2 교정 요약 (크로스리뷰 반영)

| 결함(v1) | v2 교정 |
|---|---|
| C1 service.manifest "제4 계약" (Part A 3-계약 위배) | **신규 최상위 계약 0개 원칙** (§2). manifest = naia-adk *workspace 파일 포맷*(A.6), public contract 아님. loader = host-side 조립 코드 |
| C2 F08/#31 gate 우회 | **Phase 0 = gate 폐쇄가 deliverable** (§6). 미폐쇄 시 slice 차단 (F08 준수 명문화) |
| M1 B20/D1 stream-first 미정의 | **§4 orchestration 계약 구체화** — yield* 위임, reducer 없음, history append-only(D준수), interleave/cancel 규칙 |
| M2 Observability/ErrorEvent 누락 | **§5 교차관심사** — Event emit 지점 + ErrorEvent shape + audit/regression 명문 |
| M3 canonical/License 소유권 모순 | **§1.3** A.11 원문 준수 (공개4repo 계약만 canonical), A.6 License 원문 인용 정정 |
| M4 business governance 위치 | **§3** governance = operate layer (naia-business-adk host 주입), manifest 미확장 |
| m1 추상화 선행(karpathy) | **§6 MVP 축소** — "한 서비스가 실제 돈다" 최소증명 우선, orchestration/business 후속 |

---

## 1. 레포 관계 — 직교 2축

### 축1 — 런타임 의존 (Part A.3, 불변·변경 불가)

```
naia-os (host)  ──embeds(interface)──▶  naia-agent (Runtime SoT)
                                          │ 기존 계약(주입): LLMClient ·
                                          │ MemoryProvider · ToolExecutor ·
                                          │ SkillLoader · HostContext
                                          ├─ alpha-memory : MemoryProvider 구현
                                          └─ @naia-adk/skill-spec : 스킬 계약
```
- 계약 3개 = `@nextain/agent-types` · `@naia-agent/protocol` · `@naia-adk/skill-spec`
  (zero-runtime-dep). **본 설계는 이 3개 외 신규 계약 패키지를 만들지 않는다**(§2).

### 축2 — 워크스페이스 fork chain (거버넌스 상속, 문서 일관성 수준)

```
naia-adk (personal base, public Apache2.0) → naia-business-adk (business upstream)
   → {company}-adk → {member}-adk
```
- 이 chain 은 **fork/submodule 운영 모델**이지 *공개 계약의 canonical 선언이 아니다*.

### 1.3 canonical / License — Part A 원문 준수 (M3 교정)

- **A.11 원문**: "공개 4 repo(naia-os/naia-agent/naia-adk/alpha-memory)의 계약만
  canonical. private fork 의 계약 변종은 비공식." → 본 설계는 이 문구를 **수정·재해석하지
  않는다**. naia-business-adk/README 의 fork chain 은 *운영 모델 설명*이지 계약 canonical 이 아님.
- **Fork chain 문서 불일치**(naia-adk/AGENTS.md 3단계 vs README 4단계)는
  **계약 문제가 아니라 문서 일관성 문제**. 해소 = AGENTS.md 의 chain 설명을
  README 와 일치(문서 동기, Cascade rule). canonical 권위 부여 아님. (Sync phase)
- **License 검증 소유 — A.6 원문 인용**: Part A.6 표의 행 "License 검증
  (business-adk 유료 영역) = naia-business-adk (다운스트림)". → v1 이 "A.6"
  로만 적어 모호했던 것을 **이 행 원문으로 고정**. 개인 layer(naia-os)는
  License 검증 자체가 **부재**(Apache2.0 무과금) — bypass/mock 이 아니라
  "비즈니스 layer 에서만 존재하는 관심사". 개인 데모는 License 코드 경로를
  타지 않음(존재 안 함). gemini M-License 의 "충돌"은 *layer 분리로 비충돌*.

---

## 2. 핵심 원칙 — 신규 최상위 계약 0개 (C1 교정)

v1 의 치명 결함 = service.manifest / RAGProvider / OrchestrationPolicy 를
신규 계약처럼 다뤄 Part A 의 "계약 3개 고정 + capability=agent-types 소속"
(A.4/A.5/A.6) 위배. **v2 는 신규 패키지·신규 최상위 계약을 만들지 않는다.**
요소별 정착처:

| 요소 | v2 정착처 (Part A 정합 근거) |
|---|---|
| **service manifest** | naia-adk **workspace 데이터 파일 포맷** (A.6 "Workspace 파일 구조 = naia-adk"). **public 런타임 계약 아님 — 단정(가정 아님). Part A 3-계약 불변**. 스키마 SoT = `naia-adk/docs/service-manifest-schema.md`, 버전 = naia-adk semver, 호환규칙 = 해당 docs §호환표 |
| **manifest loader** | **naia-agent CLI** (= host 역할. A.4 "CLI 소유 = naia-agent" + direction-2026 "host = CLI 자체"). naia-os / naia-business-adk 는 embed 시 *각자* host loader 보유. **모두** manifest → 기존 HostContext(llm/memory/tools/persona-as-systemprompt) 조립. naia-agent 런타임 계약 무변경. SB-1 의 `naia-agent --service` = CLI-host 경로(모순 아님) |
| **persona / system prompt** | manifest 필드 → host 가 Agent 의 기존 system message 로 주입. 신규 계약 0 |
| **RAG** | **기존 `MemoryProvider.recall()` 흡수 + `RecallOpts.sources?` additive** — 매핑 계약 **확정**(codex v3 MAJOR 해소): manifest `rag.sources: string[]` → `RecallOpts.sources?: string[]` **1:1**. `RecallOpts`(현 `{topK?,context?,project?,sessionId?}`)에 `sources?: string[]` optional 필드 추가 = **Part A.5 additive**("shape 고정, 필드 추가 허용; 삭제/타입변경만 MAJOR") = `@nextain/agent-types` **MINOR** PR. 신규 계약/capability 0 (기존 RecallOpts 확장, RetrievalCapable 신설 폐기). alpha-memory 가 `opts.sources` 로 retrieval 필터. recall 시그니처 자체 무변경(opts 확장만) |
| **orchestration** | §4 — agent-loop D1~D8(F06 불변) 위 **직렬 step = 기존 `Agent.sendStream()` 연결**. 1차 신규 계약 0. 병렬/분기가 실측 필요 시에만 agent-types additive(A.5) |
| **LLM backend** | D44 Vercel AI SDK adapter (기존 §A 채택). qwen3.6-27b-dense = `@ai-sdk/openai-compatible`, minicpm = lab-proxy-live |

→ **결과**: Part A 계약 3개 불변, 의존방향(A.3) 불변, capability 거버넌스(A.5)
경유 = "제4 계약" 없음. **신규 계약 0** (RAG=recall 재사용, manifest=데이터 파일).
매트릭스 §D 항목은 `manifest workspace 포맷(비-계약)` · `orchestration §4 계약`
2건만 (RAG 제외 — recall 흡수로 §D 불요).

---

## 3. 개인 / 비즈니스 경계 (M4 교정 — governance = operate layer)

**원칙**: manifest 는 *서비스 정의*만 담는다(portable/reproducible). 거버넌스는
manifest 에 넣지 않는다(스키마 확장 불필요 → A.11 계약 미수정 보존). 거버넌스는
**operate layer = host 가 manifest 실행 시 주입·강제**.

| 관심사 | 위치 / enforce 주체 |
|---|---|
| service 정의(persona/skill/rag/memory/llm) | manifest (naia-adk workspace 포맷) |
| 개인 실행 | naia-os host. 단일 사용자 T0~T3 self. 승인=ApprovalBroker(기존) |
| RBAC(author/reviewer/approver/releaser/auditor) | **naia-business-adk host** 가 manifest 실행 래핑 시 강제. manifest 미확장 |
| tenant boundary / approval chain / retention | naia-business-adk **operate layer 정책 파일**(manifest 와 별도, naia-business-adk 소유) |
| License 검증 | naia-business-adk (A.6 원문). 개인 layer 부재 |
| audit / SDLC artifact | shell audit(A.6, 기존) + naia-business-adk SDLC 정책 |

**개인 자족성**: 외부 데모 = 개인 layer(naia-os host + manifest + 기존 계약)만으로
end-to-end 동작. 비즈니스 거버넌스 코드 경로 부재(존재 안 함, bypass 아님).

---

## 4. Orchestration — D1 stream-first 보존 계약 (M1/C-B20 교정)

B20 거부의 본질 = **reducer 중심 상태모델** (LangGraph StateGraph). D1/D8 =
`AsyncGenerator<AgentStreamEvent>` stream-first + history append-only.
v2 orchestration 은 다음을 **계약으로 명시**(이름만 X):

1. **step = `AsyncGenerator<AgentStreamEvent>`** — graph 노드는 자체 reducer
   상태를 갖지 않는다. 각 step 은 Agent.sendStream 과 동일 이벤트 타입을 yield.
2. **합성 = `yield*` 위임** — 상위 orchestrator 가 step 의 stream 을 `yield*`
   로 그대로 위임 전달. 별도 상태 채널/reducer 없음. chunk 실시간 보존.
3. **각 step = 독립 `Agent.sendStream()` 1회 호출** — history append·순서·
   중복방지는 **기존 D6 turn lifecycle 이 담당**(신규 물질화 경계 0). step 간
   전달 = 이전 step assistantText → 다음 step input(직렬). reducer/공유 상태
   채널 없음. (gemini 누락 지적 "step 간 history 오염" = turn 단위 보장 재사용으로 해소)
4. **concurrent branch** — 1차 범위에서 **직렬 step 만**(병렬 분기 제외, karpathy
   Simplicity). 병렬 interleave 는 후속 capability(별 §D). 1차에 reducer 도입 안 함.
5. **cancellation/backpressure** — 기존 Agent abort signal(D 결정) 재사용.
   step executor 는 signal 전파만, 자체 취소 모델 신설 X.
6. **위치** — host-side(manifest 의 orchestration 선언을 host 가 해석해 step
   순서로 Agent 호출). 런타임 신규 계약 0. 병렬·조건분기가 실측 필요해지면
   그때 agent-types capability additive(§D + sub-issue).

→ B20 회피를 *구체 계약(1~6)*으로 고정. "직렬 step + yield* 위임 + append-only"
= reducer 부재 증명. 크로스리뷰가 1~6 의 D1 보존을 재검증.

---

## 5. 교차 관심사 — builder layer 적용 (M2/누락 교정)

Part A.5/A.11 의무를 builder 요소에 명시:

- **Event emit 지점**(A.5 "주요 상태 전이"): `manifest.load.started/ended`,
  `manifest.validate.failed`, `retrieval.started/hit/empty`,
  `orchestration.step.started/ended`, `service.build.ended`. 전부 기존
  `Logger`/`Event` 계약으로 emit(신규 observability 계약 X).
- **ErrorEvent shape**(A.11): manifest parse 실패 = `error_code:
  MANIFEST_INVALID`, `severity: error`, `retryable: false`. retrieval 실패 =
  `RETRIEVAL_FAILED`, `severity: warn`, `retryable: true`. orchestration step
  실패 = step 의 ErrorEvent 를 `yield*` 그대로 경계 밖 전파(기존 계약).
- **audit / tier**(A.6): T2+ 행위(외부 RAG fetch, tool exec)는 shell audit
  필수 기록 — 기존 shell audit 소유 그대로, builder 가 우회 안 함.
- **regression gate**(A.11): baseline = #31 평가 하니스 수치(컨텍스트 적중·
  한국어·실시간·안정). 공개 전 유의미 regression = release block(기존 원칙).

---

## 6. 구현 계획 — gate-닫힘 조건부 (C2 교정)

### Phase 0 — Gate 폐쇄 (이것이 deliverable. 코드 0줄. 미완 시 이후 전부 차단)

F08 = "OPEN P0 sub-issue 1건이라도 있으면 R1 plan 차단". 실측·게이트:

- [x] **G0-1 F08 실측 완료 (2026-05-16)** — `gh issue view 3·4·5·6 -R nextain/naia-agent`
      = #3·#4·#5·#6 [R0/P0] **전부 CLOSED**, OPEN P0 = **0건** (OPEN #7 은 R0/**P1**,
      F08 비대상). → **F08 통과**. (codex C2 "P0 실측 선행" 충족 — 가정 아닌 사실)
- [x] **G0-5 F01 실측 완료** — `bin/naia-agent.ts` 실존(16,205 B). #6(F01) CLOSED.
      → **F01 해제 확인** (추정 아닌 사실).
- [ ] **G0-2** 본 설계 크로스리뷰 2x clean (different-profile)
- [ ] **G0-3** 사용자 합의·보고 (사용자 명시 게이트)
- [ ] **G0-4** naia-agent ref-adoption-matrix **§D 신규 항목 PR** + sub-issue(#2 하위):
      `D-SB1 manifest workspace 포맷(naia-adk, 비-계약 단정)` /
      `D-SB2 orchestration §4 계약(직렬 step=Agent.sendStream, B20 회피)`.
      **RAG 는 §D 불요**(recall 흡수). #31 = 본 우산 sub-issue 로 재프레이밍.

**G0-1·G0-5 = 충족(실측). G0-2·G0-3·G0-4 미충족 = Phase 1 진입 금지.**
(F08 은 통과했으나 slice 착수는 크로스리뷰 clean + 사용자 합의 + §D PR 후)

### Phase 1 — qwen3.6-27b-dense, "한 서비스가 실제 돈다" 최소증명 (karpathy)

> v1 의 "추상화 선행" 교정: 6개를 한 번에 세우지 않는다. 최소 동작 먼저.

- **SB-1 manifest loader 최소** — `naia-adk/docs/service-manifest-schema.md`
  스키마 정의 + naia-agent CLI-host loader 가 manifest → 기존 HostContext
  (llm=qwen via D44 / memory=alpha-memory / persona=system msg) 조립.
  RAG·orchestration 없음.
  S01 `pnpm exec naia-agent --service <manifest>` · S02 unit(스키마 검증) ·
  S03 fixture-replay(qwen) · S04 CHANGELOG · §D-SB1(manifest 포맷) 인용
- **SB-2 RAG via recall** — (a) `@nextain/agent-types` `RecallOpts` 에 `sources?:
  string[]` additive PR(A.5, MINOR) (b) manifest `rag.sources` → `RecallOpts.sources`
  1:1 매핑 (c) alpha-memory 가 `opts.sources` 필터링. **신규 계약/capability 0**
  (RecallOpts 확장만, recall 시그니처 무변경). turn-전 context 조립.
  S01 `--rag <source>` · S02 unit(rag.sources→RecallOpts.sources 매핑) ·
  S03 실 alpha-memory(sources 필터 검증) · S04 · matrix §D50(RecallOpts additive 인용)
- **SB-3 #31 평가 결합** — manifest `eval.fixtures` → #31 하니스로 e2e 품질
  측정(fixture-replay 우선, G15). qwen backend e2e.
  S01 `--eval` · S02 unit · S03 fixture e2e(persona+RAG+memory+qwen) · S04 · #31
- **SB-4 orchestration §4(직렬 step only)** — 필요성이 SB-1~3 에서 실증된 경우만.
  아니면 백로그. (karpathy: 불필요 추상화 회피)

**외부 데모 MVP = SB-1~SB-3** (manifest→persona+RAG+memory+qwen3.6-27b e2e+평가수치).

### Phase 2 — minicpm backend
- SB-5 minicpm /v1/realtime connector (v2 계약 rev2.1, lab-proxy-live).
  ko-serve 트랙 PAUSED 해제 의존(gemini 누락 지적 반영 — Phase2 진입 = #31/ko-serve gate).

### Phase 3 — 비즈니스 layer (operate)
- SB-6 naia-business-adk operate layer 스캐폴드 — RBAC/SDLC/retention **정책
  파일**(manifest 미확장, host 주입). License 검증(A.6 원문).

---

## 7. 결정 / 미해결

1. **(결정)** §4 = 각 step 독립 `Agent.sendStream()` 직렬 연결, history/순서 =
   기존 D6 turn lifecycle 재사용 → reducer 부재·D1 보존 (가정 아닌 설계 결정).
2. **(결정)** RAG = `MemoryProvider.recall()` 흡수. 매핑 계약 **확정**(codex v3
   MAJOR 해소): manifest `rag.sources` → `RecallOpts.sources?: string[]` 1:1,
   RecallOpts 에 `sources?` additive(A.5, agent-types MINOR). RetrievalCapable
   폐기, 신규 계약 0. (codex/gemini 공통 지적 + codex v3 매핑 미정 모두 반영).
3. **(결정)** manifest = naia-adk workspace **데이터 파일**(A.6), public 계약 아님,
   Part A 3-계약 불변 → "제4 계약" 회피 (단정).
4. **(결정)** F08/F01 = §6 G0-1·G0-5 실측 완료(P0 0건·bin 실존) → gate 통과(사실).
5. **(미해결, 사용자)** 외부 데모 시한·"성공" 정의(무엇을 보여드릴지) — 합의 시 확정.

---

## 8. 합의 게이트
크로스리뷰 2x clean → 사용자 보고 → **합의 후에만** Phase0 G0 착수. 합의 전 코드 0줄.

## 변경 이력
- v1 (2026-05-16): 초안. codex+gemini ISSUES_FOUND (CRITICAL 2 / MAJOR 4 / 누락 2).
- v2 (2026-05-16): 전면 재작성. 신규계약0 / gate-닫힘 / orchestration §4 / 교차관심사 / 소유권정합 / governance=operate / MVP 축소.
- v2 재크로스리뷰: codex(C1/C2/M1/m1 FAIL·strict) / gemini(C1~m1 全 PASS). 공통 신규결함 = RAG capability vs recall 중복.
- v3 (2026-05-16): surgical 4건 — RAG=recall 흡수 / loader=naia-agent CLI / manifest SoT 고정 / step→D6 / F08·F01 실측.
- v3 재크로스리뷰: **gemini CLEAN(6 PASS)** / codex v3(한도회복 재실행) = C1·C2·M1·loader·manifestSoT **PASS**, RAG 1건만 FAIL(rag.sources→RecallOpts 매핑 미정, MAJOR 1, codex 해법 제시 "매핑 계약 1개 닫아라").
- **v4 (2026-05-17)**: codex v3 단일 MAJOR surgical 해소 — `rag.sources → RecallOpts.sources?: string[]` 1:1 매핑 **확정**, RecallOpts additive(Part A.5, agent-types MINOR), 신규 계약 0. §2/§6 SB-2/§7-2 반영. → codex 조건부 승인 조건 충족 + gemini CLEAN 유지. SB-1(manifest loader, RAG 무관)은 양쪽 PASS — 착수 가능.
