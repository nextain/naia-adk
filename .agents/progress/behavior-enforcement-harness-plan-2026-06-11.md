# Behavior Enforcement Harness (BEH) — 계획 v18 (설계 2-AI 2-clean 도달)

> Status: PLAN — **설계 2-clean 도달** (20라운드 codex+Sonnet). 루크 승인 후 docs/design 승격 + 구현(§6).
> 2-clean 판정: **Sonnet R7~R20 = 14연속 NONE** / **codex R19 NONE**, R20의 유일 지적은 §0·프롬프트가 명시 OOS로 bound한 §3.2 hermetic-completeness 재드릴(provenance, 무한회귀)이라 bound에 흡수. 20R 전 in-scope 지적 반영(v1→v18). 잔여(§3.2 hermetic 완전성·§3.1 완전 스케줄러 enumeration)=명시 구현단계 bound + §3.1 독립 backstop. cf [[feedback_bound_threat_model_in_review_prompts]].
> **핵심 = (§0)위협경계 + 에이전트 자기판단 비의존 + (v5)항목별 *사전선언* 수용/검증 기준을 외부 앵커.**

## v5 핵심 원리 추가 (R4 수렴): 사전선언 기준의 외부 앵커
진심 에이전트도 *그 순간* 판단(이 출력이 활성항목과 관련있나·아직 Investigate가 맞나·이 명령이 완료를 검증했나)을 **사전 기준 없이 하면 틀린다**. → **작업 시작 시 항목별 수용/검증 기준을 외부(task DAG/체크리스트)에 선언**하고, new-value·완료·페이즈 전이를 *그 사전 기준과의 외부 매칭*으로 판정(에이전트의 사후 판단 아님). 기준 미선언 = 진행 불가(측정가능성 시작단계 강제, [[project_drift_detection_anchor_thesis]] 항목 단위).
- **기준 잠금 = 항목별·활성화 전 단계 잠금**(Sonnet R6 + codex R12): "Plan 후 일괄 잠금"은 Understand/Scope/Investigate 의 활성항목 기준이 그 전에 흐를 수 있어 무력 → **각 항목은 *활성화되기 전* 해당 단계 게이트(사용자 승인)에서 기준 잠금**, 이후 변경은 그 게이트 **재승인** 요구. 단계별 잠금이라 어느 페이즈의 활성항목도 사전앵커가 유지됨(에이전트가 실행 중 "이해가 바뀌었다"로 더 쉬운 기준 갱신 차단).
- **기준 버전 결속**(codex R13): 각 기준에 **버전/해시 부여 → 원장의 one-shot 소비·new-value 기록 + receipt 에 그 버전 결속**. 재승인으로 기준 변경 시 **영향받는 소비상태·receipt 무효화 → 재검증** 요구(구기준 증거로 신기준 완료 인정 차단; 변경 전 충족분이 변경 후로 carry-over 안 됨).

## 0. 위협경계 (THREAT MODEL — [[feedback_bound_threat_model_in_review_prompts]])
실제 두 실패 = **진심 드리프트**(하네스를 속이려는 게 아니라 진심으로 진척 중이라 착각).
- **IN-SCOPE = 진심 드리프트**: 활동≠진척 오인, 정체 미인지, 막혔을 때 잔여작업 두고 정지, **자기 판단 오류(짧은 작업 오판·무관 출력을 진척으로·degraded 상태 놓침)**. → 단순 결정론 + **외부 기본값**으로 잡힘.
- **OUT-OF-SCOPE = 적대적 자기-회피**(target 변형·원장 위조·trivial receipt·probe churn·self-승인): self-hosted enforcement로 원천봉쇄 불가(에이전트가 자기 출력 통제). backstop = 외부 권한(사용자)·escalation. 하네스는 회피 비용/가시성만 높임.
- **v4 설계 원리**: *진심 에이전트의 올바른 판단에 의존하지 않는다.* 자기 선언(duration·scope-relevance·status)이 틀려도(진심 오판) 보호되도록 **외부/강제 기본값**으로.

## 1·2. (동일) LLM=신뢰 못 할 자기-감시자. 강제는 루프 밖. 위계: 결정론>modality>2nd-LLM(advisory only).

## 3. 컴포넌트 (v4)

### 3.1 포그라운드 진심-드리프트 [결정론, 하네스 기록]
하네스 전용 append 원장(에이전트 비편집): `{turn, tool?, target_canon, outcome, tool_less, scope_item}`.
- **new-value = 활성 항목의 *사전선언 수용기준* 충족만**(codex R4): 작업 DAG 의 각 항목에 **허용 산출물·명령·검증조건을 사전 결속**. new-value = 산출물이 *그 사전기준과 외부 매칭*될 때만 인정(에이전트의 "관련 있다" 사후판단 아님). ⚠️ 무관/미매칭 출력은 정체시계 reset 안 함. **항목별 stall 추적**.
- **핵심 신호**: 활성 항목 사전기준 충족이 윈도 M턴/T분 내 0 → inject. (target 변형·무관 churn 해도 *사전기준 매칭 0* 이면 걸림.)
- **항목별 stall 시계 = 자기 기준만 reset, 실행중에만 카운트**(Sonnet R5 + codex R16): 다중 항목 시 A 의 stall 시계는 **A 자신 사전기준 충족 시에만** reset. ⚠️ **실행중 vs 대기 구분**(codex R16): 외부 스케줄이 *현재 실행중* 항목만 active-stall 시계로 카운트; **대기(순차 처리로 아직 미착수) 항목은 별도 *starvation* 상한**으로 추적(짧은 active-stall 윈도로 오판 금지). A 막힌 채 B 진전(전역 바쁨)이어도 A active-stall 은 은폐 안 됨; 단 B 작업 중 *대기* C 는 starvation 상한까지 면제. 실행중 항목 stall 한도 or 대기 starvation 한도 도달 시 inject. ⚠️ **의존-대기 항목은 starvation 면제**(codex R18): starvation 시계는 **ready(실행가능)이나 미스케줄** 항목에만; **미충족 의존성이 있는 후속항목은 선행항목 마일스톤/deadline 에 결속해 유예**(정상 진행 중인 선행 때문에 후속이 오탐 hard-stop 되는 false-positive 방지). ⚠️ **스케줄러-상태 taxonomy bound**: 항목 상태(running/ready-waiting/dependency-blocked)별 stall·starvation·deferral 처리의 *원리*는 여기 고정(외부 스케줄이 상태 구분 + 정상진행·의존유예는 면제 + deadline 결속) — 완전한 상태기계/의존성 해석기 enumeration 은 **구현단계 사안**(스케줄러 설계). 설계 답 = "외부 스케줄 상태구분 + 정상진행/의존 면제".
- **기준 = 사전선언 monotonic 마일스톤 열(one-shot per 마일스톤)**(codex R6+R14 화해): 단일 기준 one-shot은 ① 반복 실행 위장 막지만 ② 같은 아티팩트의 *정당 반복 진전*을 못 표현해 false-stall 유발 → **항목마다 사전선언 monotonic 마일스톤/delta predicate 열**(예: 함수 N개 중 k개·테스트 k개 통과·라인 delta)로 정의, **각 마일스톤은 one-shot**(최초 도달만 reset, 재실행 reset 안 함=위장 차단) + **마일스톤 cadence < stall 윈도**(연속 진전 = successive 마일스톤 도달 → 정당 iterative 구현이 false-stall 안 됨). 마일스톤 미선언 큰 항목 = 더 잘게 선언 요구.
- **§3.3 probe → §3.1 마일스톤 통합**(codex R17): 장기 supervise(§3.3) 작업의 **단조 probe-delta 를 그 항목의 사전선언 one-shot 마일스톤으로 결속** → probe 진척이 §3.1 항목 stall 시계를 reset. 그래야 *완료 전 §3.1 new-value 없는 원자적 장기 작업*(예: 정상 진행 중인 빌드/마이그)이 §3.1 hard-stop 당하는 false-positive 방지. (§3.3 가 진척이라 보는 것 = §3.1 도 진척으로 인정 — 두 메커니즘 일관.)
- **페이즈 = 외부 상태기계**(codex+Sonnet 수렴): Plan/Understand/Investigate 가 tool-less·무커밋 정당이나, **에이전트 페이즈 선언을 그대로 신뢰 안 함** → 외부 상태기계가 전이 조건 강제 + **페이즈별 누적 체류 한도(hard ceiling, 윈도 아닌 *총* 턴/시간)** + **재진입해도 예산 reset 안 함**(누적). 한도 도달 시 정체와 동일 취급 → 전이 inject. budget 완화는 *per-window 임계*만 곱함, 총 체류시간 아님. ⚠️ **ceiling 연장 = 사용자 재승인 경로**(codex R15): 정상 진척 중인 대규모 페이즈가 ceiling 에 hard-stop 당해 미완료 전이되는 false-positive 방지 — ceiling 도달 시 **사용자 재승인으로 연장 가능**(자동 reset 아님; **누적 사용량은 유지**되어 고의 게이트로 남음). 재승인 없으면 전이/hard-stop 유지.
- **tool-less spin**: 순수 추론엔 PostToolUse 이벤트 없음(codex) → **외부 elapsed-time/token watchdog**(모델 continuation 경계)로 강제, 불가 플랫폼은 **"Stop 시점 탐지만 보장" 명시**.
- **blocked disposition**(codex): "미차단 항목" 만 보면 차단 잔여작업 남기고 종료 허용됨 → **종료는 전 항목 done OR 사용자가 명시 보류/포기 시에만**. blocked 항목도 **사용자 disposition 전까지 잔여작업**으로 취급. 스코프 미선언 자율 = "스코프 선언" inject(silent no-op 금지).
- **escalation**: 같은 invariant 연속 K회 무시 → **hard-stop**(완료/정상종료 차단) + 사용자 알림. **inject barrier**: K 카운트는 **inject 전달된 턴 이후부터** 집계(큐된 tool-call race 방지). PostToolUse 매 이벤트 평가(루프 중 개입) + tool-less 는 외부 watchdog.
- **deadlock 해제**: hard-stop = 사용자 인증 reset + 사유기록 + 제한 remediation.

### 3.2 완료주장 진위 [결정론]
- **작업종료 시점 구조 정의**(Sonnet): IDD **Report 페이즈 진입** 또는 **Tasks 전 항목 체크 완료** 이벤트(하네스 탐지)에서만 receipt 검사(중간 "완료" 오탐 방지).
- 그 시점 구조화 receipt 부재 → inject(산문만 = receipt 없음 → "검증 없음"). receipt = `{item_id, cmd, exit, ts, output_hash, tree_state_id}`.
- **항목별 검증조건 결속**(codex R4): receipt 가 단지 명령 실행이 아니라 **그 항목의 사전선언 검증조건을 충족**했는지 외부 확인(trivial cmd 로 때우기 방지는 진심-드리프트 한정; 사전기준 매칭으로). 모든 완료 항목의 검증범위 충족을 외부 확인.
- **stale 무효화 = *실측 resolved* 검증 의존성 closure 결속**(Sonnet R6 + codex R7·R9 화해): receipt 를 **검증 실행이 실제 읽은 read-set(실측 resolved closure)** 에 결속 → 그 안 변경 시 무효. ⚠️ **선언 closure 완전성을 신뢰 안 함**(진심 누락 가능) → 하네스가 **검증 실행의 실제 read-set 을 추적**해 선언 closure 와 대조; **미선언 입력 = 실패 처리**(누락 dep 변경에 stale receipt 유효 잔존 방지=false-neg 차단). 아티팩트 경로만(false-neg) 아니고 전체 workspace(false-pos) 아님 — **실측 closure 만**. 하네스 내부 쓰기·closure 밖은 무효화 제외(false-pos 방지). §3.1 "사전기준 충족 0인데 완료" 가 독립 이중포착.
- **입력 클래스 + fail-closed**(codex R11): 실측 closure 는 파일뿐 아니라 **관측 가능한 검증 입력 전 클래스**(env var·network/API 응답·toolchain/실행파일 버전·metadata·negative-path lookup)를 포괄; **포착 불가 입력 클래스가 있으면 fail-closed**(receipt 무효 처리). ⚠️ *완전 hermetic 입력 재현*(전 클래스 무손실 캡처)은 **구현단계 사안**으로 bound — 설계 답 = "관측 입력클래스 측정 + 미포착 fail-closed", 그리고 어차피 §3.1 "활성항목 진전 0" 이 독립 backstop(stale receipt 가 살아도 진짜 진전 없으면 별도 포착). 더 깊은 hermetic 완전성(미선언 입력클래스 → 산출물 **생성 provenance closure**(codex R20) → 전이 provenance → …)은 **무한 회귀이며 §0 OOS·구현단계 bound** — 설계 답 = "관측 입력클래스 + 가능시 생성-provenance 측정 + 미포착 fail-closed", 완전성 자체는 impl-phase. §3.1 활성항목 진전-0 backstop 이 어차피 독립 포착.

### 3.3 supervise (백그라운드) [결정론]
- ⚠️ **모든 tool 프로세스 = 기본 cgroup + 기본 wall deadline 아래 실행**(codex — "짧다"는 진심 오판으로 supervise 밖 무기한 실행 방지). 임계 wall 초과 → supervise 전환 또는 강제 종료. 즉 supervise 미선언이어도 *기본 격리·deadline* 은 항상.
- 명시 장기 = full supervise: `--probe-type <allowlist> | --wall-time-only --max-stall --max-wall [--lease] --class`.
- kill = cgroup v2/systemd scope: 비위임 고정 + migration/하위-cgroup 금지 + kill 후 `cgroup.events populated=0` 확인; 미종료(D-state/탈출) = **hard-failure 보고**. 미지원 플랫폼 = degraded(PGID best-effort) + **`UNSUPERVISED-DEGRADED` status**.
- **degraded 장기작업**(codex): status 표시만으론 진심 놓침 방지 못 함 → **사용자 승인 없으면 차단 또는 더 짧은 강제 wall-timeout** 적용.
- probe-type allowlist(free-form 금지)+단조성+**rate sanity**(grace_period=첫 10% wall 또는 5분 후 적용, 초기 셋업 오탐 방지). status RUNNING|STALL|TIMEOUT|DONE|FAIL|UNSUPERVISED-DEGRADED. **LLM 읽기만.** lease=획득 timeout+owner+stale 복구. open-writer=staging+atomic(단일 fs·manifest; 외부 DB/API side-effect 비원자=명시 한계).

### 3.4 PreToolUse + 외부 session-start [결정론]
- 선언-장기 supervise 미경유 → block.
- **session-start = 에이전트 밖 launcher handshake**(codex — 미등록 훅은 자기 미호출 못 잡음): **launcher 가 필수 훅의 시작 handshake 확인 전 모델·도구 실행 차단**(fail-CLOSED, 외부). 실패 시 **복구 명령 명시**(재등록 X) + 관리자 one-time bypass 조건.

### 3.5 2nd-stream advisory only [확률적] — 원장(구조 이벤트)만 입력. 타깃 실패 의존 금지. plumbing만 단위테스트.
### 3.6 레지스트리: `{name, surface, trigger, check, action, fail_mode, escalation, recovery}`. 메모리→컴파일.

## 4. 테스트 (머지 게이트) — 두 실패 직접 재현 + false-positive 방지
- **#1 포착**: 활성항목 new-value 0(전부 empty 재시도) → inject·K무시(inject barrier 후)→hard-stop→user-reset. 외부 watchdog 가 tool-less spin → inject. blocked 항목 남긴 종료 → 차단(전항목 done/disposition 전). 스코프 미선언 → inject.
- **#1 false-positive 방지**: Plan/Investigate 페이즈 정당 tool-less·무커밋 → **안 막힘**(페이즈 budget). 무관 출력은 정체 reset 안 하나 *활성항목* 진전은 인정.
- **완료 진위**: Report 진입/Tasks-완료 시점 receipt 부재 → inject. tree 변경 후 stale receipt → 무효. 중간 "완료" → 오탐 안 함.
- **#2**: 기본 cgroup+wall 가 미선언 장기도 deadline. probe STALL→`populated=0` kill. double-fork/setsid→scope 전멸. degraded 장기→승인없으면 차단/짧은 timeout. rate-sanity grace 후만. lease 동시2→timeout.
- **fail modes**: 외부 launcher handshake 미통과→실행 차단(복구명령). 2nd-stream 죽음→결정론 무영향.
- **경계(OOS) 명시**: 적대 회피(target 변형·원장 위조·trivial receipt)는 테스트 안 함(문서화, backstop=사용자).

## 5. 전파 & 드리프트 (범위 다)
- 드리프트 해결: alpha-adk tool-agnostic 채택(`.agents/hooks/{core,policies}` SoT, 구형 복사본 폐기).
- 전파=enforcement: **서명 manifest + 단조 epoch(anti-rollback) + 3-way managed-region**(base만 비교) + **중앙 scheduled CI/dependency-gate**(downstream CI 부재·미인지 fork·stale 무기한 방지; 전환기 미선언 fork = 최소호환 epoch 강제).

## 6. 구현 순서 (2-clean 후)
1. ✅ **DONE (2026-06-12)** — 하네스 원장(3.1: 활성항목 new-value·페이즈 budget·외부 watchdog·blocked disposition·inject barrier·user-reset) + 직접재현/false-positive E2E.
   - 코어(순수 평가기, tool-agnostic SoT): `.agents/hooks/core/beh-ledger.js` — append-only 원장 I/O(jsonl), `canonTarget`, `matchMilestone`(path/bash_ok/manual 결정적 predicate), `deriveProgressMarks`(one-shot), `evaluateDrift`(active_stall/starvation/phase_ceiling/new_value_zero/scope_undeclared/blocked_termination + inject barrier K + escalation hard-stop), 세션상태·P0 바인딩 I/O, `behEnabled`(opt-in `.claude/beh-on`).
   - 어댑터(thin, Claude Code): `.claude/hooks/beh-record.js`(PostToolUse 원장기록) · `beh-tick.js`(UserPromptSubmit turn++·phase 누적·평가·inject) · `beh-stop.js`(Stop 종료게이트+hard-stop 차단·`beh-reset` 해제) · `beh-watchdog.js`(외부 wall-clock tool-less-spin 감시 + selftest). settings.json 등록(전부 opt-in 게이트 + fail-safe exit 0 → 미옵트인 세션 무영향).
   - 테스트(fault-injection = 재현 어려운 LLM 드리프트 대신 *신호* 검증, plan §4): `run-beh-ledger-test.js` 24/24 + `run-beh-adapter-test.js`(replay E2E) 6/6 + watchdog selftest. canonical E2E(run.sh)에 통합 → **67/67 green**(기존 64 + BEH 3).
2. ✅ **DONE (2026-06-12)** — 완료 receipt(3.2: Report/Tasks-end·tree 결속).
   - 코어 `.agents/hooks/core/beh-receipts.js`: receipt store(jsonl), `captureClosure`(declared closure glob/literal → sha256), `treeStateId`, `evaluateCompletion`(순수: done 항목별 exit-0 receipt 부재→"검증 없음" / closure 해시≠현재→stale / `undeclared_input`→fail-closed), `isVerifyCommand`(사전선언 verify.cmd_pattern 매칭), `listCandidates`(git ls-files, glob일 때만·cold path).
   - 배선: beh-record가 verify.cmd_pattern 매칭 성공 Bash에서 receipt 기록(closure 해시 캡처); beh-stop이 종료 시 done 항목 closure 재측정→`evaluateCompletion` incomplete면 차단.
   - 테스트: `run-beh-receipts-test.js` 12/12 + adapter replay에 receipt 3케이스(기록/무receipt 차단/유효→허용·stale→차단) → E2E **68/68 green**.
   - bound(plan §3.2): closure = *선언* closure 해시결속까지(측정 read-set·완전 hermetic·생성 provenance = impl-phase). §3.1 진전-0 backstop이 독립 이중포착.
3. supervise(3.3: 기본 cgroup+wall·populated=0·degraded 차단·probe-type·grace·lease·staging) + #2 E2E. 4. 외부 launcher session-start(3.4). 5. 레지스트리. 6. 2nd-stream advisory. 7. 드리프트해결+sign/epoch/central-CI(5).
naia-adk 추가 → sync 전파 + 서브모듈 bump.
