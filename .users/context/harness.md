<!-- Copyright 2026 Nextain Inc. All rights reserved. -->

# Harness 검증 체크리스트

`.agents/context/harness.yaml`에 대한 사람이 읽을 수 있는 가이드입니다.

## 목적

훅(hooks), 규칙(rules), 워크플로우를 추가/수정할 때 하네스의 올바름을 검증하기 위한 체크리스트입니다.

---

## 아키텍처 (G-OC01: 도구 비종속 하네스, 2026-05-18)

도구별 모놀리식 훅 → **도구 비종속 코어 + 정책 + 호스트 어댑터** 구조로 리팩터하고, 두 번째 호스트(pi)에서 실증.

- **core** `.agents/hooks/core/harness-core.js` — 호스트 중립 SoT(세션/anti-compact + 새니타이저). 호스트 결합 0.
- **policies** `.agents/hooks/policies/{bash,edit}.js` — 호스트 중립 가드 정책. `process.exit`·호스트 I/O 봉투 없음.
- **host adapters** — Claude(`.claude/hooks/_claude-{bash,edit}-*.js` + 얇은 어댑터, 리팩터 전과 byte-동일) / **pi**(`.pi/extensions/naia-harness.ts` — 동일 정책·코어 재사용, core 무변경).
- **fail-mode 불변식**: 가드별 **하드코딩**(데이터 아님) — pr-guard fail-CLOSED, 나머지 5 bash 가드 fail-OPEN. 양 호스트 보존(적대 검증 완료).

**상태**: part1+part2 **완료 & 적대 2-consecutive-clean(6라운드)** — 실 pi@0.74.1 런타임 게이트 20/20, Claude parity(golden 8/42/19 + E2E 64 + system 13) byte-동일. **cross-tool 목표(Claude+pi 동일 하네스, core 무변경) 달성·검증.** partB(선언적 guard_policies) = 3라운드 설계리뷰 → **DEFER 권고**(SoT-정책화에 건전한 무결성 루트 없음; 2/9 가드만 적합; cross-tool 목표 이미 달성). 상세 = `.agents/progress/g-oc01-partB-forbidden-actions-plan.md`.

### 원요청 무결성 계층 (Claude Code + Codex)

- 공통 코어: `.agents/hooks/core/request-contract.js`, `request-contract-adapter.js`, `request-contract-review-runner.js`, `preservation-contract.js`
- 얇은 어댑터: `.claude/hooks/request-contract.js`, `.codex/hooks/request-contract.cjs`
- 동일 생명주기: `PreToolUse`, `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PreCompact`, `PostCompact`, `Stop`
- 일반 계약 성공의 최소 바닥은 원문 프롬프트 해시체인과 8개 실체·7개 간선 전체에 결박된 외부서명 Clean 리뷰 2회입니다. 제품 보존 release는 별도로 planning 네 역할과 integration의 새 네 역할, 각 역할의 분리된 evidence view까지 요구합니다.
- 보존 코어는 프로젝트별 adapter가 선언한 제품 표면, 기준/current 경로, capability probe, 외부 원본 provenance를 검증합니다. UI route는 가능한 표면 종류 중 하나일 뿐이며 API·CLI·library export·data schema·background job·운영 경로도 같은 계약을 사용합니다.
- 리뷰 실행기는 호스트의 네이티브 격리를 사용합니다. Linux는 허용목록 reviewer와 발급 digest가 일치하는 bundle을 익명 descriptor로 고정해 `bubblewrap`에서 실행합니다. Windows는 저장소와 사용자 홈 밖의 봉인 staging에 digest 검증 snapshot을 만들며, 재분석 지점을 거부하고 현재 사용자와 SYSTEM만 접근하는 NTFS ACL을 상속시킵니다. sandbox 실행파일도 설정의 digest 허용목록과 일치해야 하며 snapshot 삭제 실패를 성공으로 숨기지 않습니다. 그 안에서 Codex elevated sandbox의 정확한 root 정책과 Node 권한 모델을 겹쳐 reviewer·bundle 읽기 및 scratch 쓰기만 허용합니다. 네트워크, 저장소, 사용자 홈은 차단되며 WSL·Cygwin·MSYS2·Linux VM·Linux container에 의존하지 않습니다. 접수는 같은 프로세스의 일회성 runner 증거를 소비하고 실제 reviewer stdout의 의미 필드와 저장 review가 정확히 같아야 하며, 임의 review JSON 직접 접수 명령은 없습니다. reviewer/runner attestor도 설정에 고정된 바이트 스냅샷만 실행하고 두 실행파일 digest와 review payload digest를 서명합니다. 작성 host와 reviewer의 PID 및 플랫폼 네이티브 process identity 충돌도 거부합니다. Linux는 kernel boot/start identity를 사용하고 Windows reviewer는 runner가 만든 실행별 고유 identity를 결박합니다. 리뷰 시각은 runner 증거로 덮어쓰며 거부 필드·값·stderr는 반사하지 않습니다.
- 전역 run/context/process/execution ID claim, digest-protected invocation manifest, owner 완성 후 원자적으로 공개되고 identity를 재확인하는 저장소/lineage lock, state+head를 포함한 crash-recovery transaction이 compaction·동시 세션·중단 뒤의 replay와 부분 커밋을 막습니다. stale 회수도 별도 reaper로 직렬화합니다. Windows host process identity는 SessionStart와 lock 회수에서 프로세스 시작 시각으로 새로 만들며, 이후 lifecycle hook은 계약에 결박된 identity를 재사용합니다. 쓰기 가능한 disk cache는 사용하지 않습니다. 읽을 수 없는 unit/quarantine 저장소, 잘못된 숫자 설정, Git 명령·파싱 실패, platform-native 경로 key 충돌은 빈 상태로 축소하지 않습니다. Windows 파일 mode는 의미 없는 POSIX stat 비트 대신 Git index의 0644/0755를 사용합니다. quarantine 채택은 출발 chain의 head/count/source ID를 도착 unit에 교차 결박하고 재시도 시 중복 기록하지 않습니다.
- 초기 계약과 범위 변경은 고정 공개키로 검증되는 외부 사용자-presence 서명을 요구합니다. 코어는 서명된 presence/non-exportable 주장을 확인하지만 실제 하드웨어 속성은 외부 signer provisioning 신뢰 경계입니다.
- `authorize_contract`는 최초 한 번뿐이며, 후속 추가·교정·종료 권한은 각 operation의 실제 변경분을 정확히 소유해야 합니다. 여러 operation이 동시에 필요해도 하나의 pending transaction으로 제시하고 전체 presentation을 소비한 뒤 닫습니다. 비종료 진행 상태 전환은 별도 승인 없이 진행됩니다.
- 종료 처분된 지시와 tombstone은 canonical 불변입니다. 격리 reviewer stdout은 verdict·고정 finding code와 불투명 관계 투영만 내보냅니다. 일반 Clean 2회는 서로 다른 context/process여야 합니다. 보존 검토의 역할 분리는 더 강한 별도 조건이며, 같은 전체 bundle에 role label만 바꾼 네 record는 planning×4와 integration×4를 증명하지 않습니다.
- lifecycle state와 baseline digest는 unit head에 결박되며, Git 기준선과 dirty submodule은 실제 파일·index·HEAD를 재귀 해시합니다. 성공 보존 정리는 최종 proof 검증 뒤 정확한 receipt를 journal하고 unit을 원자적으로 staging한 후에만 quarantine과 비공개 상태를 지우며, 중단된 staging은 다음 실행이 receipt의 전체 필드 결박과 비공개 proof를 다시 검증한 뒤에만 정리합니다. 취소된 mutating tool lease는 그 lease를 소유한 client/session의 Stop만 workspace를 재확인하고 닫을 수 있습니다. 다른 세션의 실행 중 lease가 하나라도 있으면 Stop과 리뷰 발급을 차단합니다.
- native stdin event가 없거나 명령행 event와 충돌하면 fail-closed 하며, prompt envelope가 거부돼도 원문 prompt는 실패 응답 전에 quarantine에 보존됩니다. 유효한 prompt가 중복 runtime binding 때문에 차단되는 경우도 같습니다. 각 source는 이어 붙이면 원문과 정확히 같은 `obligation_atoms`로 분할하며, directive·approval·authority atom은 매핑된 지시문에 원문 그대로 선언되고 target·acceptance criterion·모든 trace artifact와 7개 간선에 ID로 이어져야 합니다. Claude Code와 Codex 모두 `apply_patch`를 변경 전 lease 대상으로 등록합니다. 리뷰 접수는 현재 bundle과 모든 결박을 다시 계산해 발급 후 드리프트를 기록하지 않습니다. 완료 판정은 저장소·lineage lock 안에서 같은 검증을 재실행해 성공 proof를 만들며, 압축은 그 proof와 연속 Clean record hash를 다시 검증합니다.
- 최초 계약 전용 비공개 pending 입력 3종과 엄격히 파싱한 단일 Node 제어 명령만 product mutation lease 없이 허용합니다. 이 경로로 실제 native `PreToolUse`를 거친 `authority-challenge|bind|resume`과 고정 reviewer 실행기가 최초 binding/리뷰 발급 전에 자기 lease로 교착되지 않습니다. shell 연결·치환·redirection, 틀린 unit/session/path, 고정되지 않은 reviewer·attestor는 제어 명령으로 인정하지 않습니다.
- 설치와 강제는 분리합니다. 세 공개키·credential·실행파일 allowlist와 프로젝트 readiness가 준비되기 전에는 `REQUEST_CONTRACT=on`이나 저장소 enable을 사용하지 않고 `REVIEW_ONLY`로 유지합니다. `preservation.required`만으로 opt-in을 덮어쓰지 않으며, 명시적으로 `enforced`로 전환하기 전에는 shared project를 강제하지 않습니다.
- 보존 evidence도 **REQUIRED/PENDING**입니다. adapter는 immutable baseline의 전체 표면 exact-set을 산출하고, allowlisted trusted runner가 실제 entry를 실행한 서명 probe receipt를 내야 합니다. 에이전트 작성 JSON은 금지하며, vendor는 origin repository+commit/tree에서 계산한 digest attestation이 필요합니다.
- `REVIEW_ONLY` checkpoint는 local commit까지만 허용합니다. 원격 review push는 exact signed checkpoint operation이 구현될 때까지 금지합니다. 현재 보존 런타임은 외부효과 분류기가 없으므로 모든 shell/publication을 `external_effect_gate_pending`으로 차단합니다. 내장 release regex는 보조 탐지일 뿐입니다.
- unit이나 미수용 quarantine이 하나라도 생긴 뒤에는 opt-in 마커 삭제, `REQUEST_CONTRACT=off`, `disable` 명령으로 중간 해제할 수 없습니다. 성공 종료된 lineage도 보존 정리가 완료될 때까지 고정 대상입니다. 같은 session의 후속 lifecycle은 현재 proof를 재검증하고, 새 session은 기존 성공 proof를 검증한 시점의 workspace digest를 새 genesis에 handoff한 뒤 별도 요청을 시작합니다. 불완전 상태는 서명된 resume를 거쳐 계속 보호됩니다.
- 정직한 한계: 훅 비활성/비신뢰 등록, 모든 로컬 기록을 함께 바꿀 수 있는 행위자, 외부 signer의 거짓 속성 서명, 훅 경계 사이에 완전히 실행·복원된 변경, 외부 부작용은 이 로컬 계층만으로 완전 관측할 수 없습니다. 결정론 parity는 추적된 네이티브 어댑터 프로세스까지이며 설치된 호스트 dispatcher는 별도 smoke 범위입니다.
- `USR-001~007`은 불변 출처 장부보다 먼저 생겼고 로컬 세션 기록에서도 native 원문을 복구하지 못했습니다. AI가 쓴 요구사항 문장으로 사용자 원문을 재구성하지 않으며, validator는 이 공백을 명시적으로 차단합니다.
- Windows/Linux 공통 회귀 묶음은 Node 진입점만 허용하고 `shell=false`로 직접 실행하며 WSL/Bash/MSYS 환경값을 사용할 수 없게 오염시킵니다. 이는 묶음 자체가 WSL·Bash를 호출하지 않는다는 증거이며, 모든 하위 프로세스를 운영체제 수준에서 관찰했다는 뜻은 아닙니다. Linux의 셸 기반 E2E는 별도 추가 증거이고 Windows 통과를 대신하지 않습니다.

---

## 요구사항 리뷰 추적 (requirement_review_trace)

위 request-contract 런타임은 opt-in 이지만, **이 추적 게이트는 항상 켜져 있습니다.** RCI 요구사항 파일은
"4단계 리뷰를 받았다"고 주장하는데, 런타임을 켜지 않은 상태에서도 그 주장이 **반증 가능해야** 하기 때문입니다.

- 스크립트: `scripts/request-contract-review-scope.cjs`(범위·digest) ·
  `scripts/validate-request-contract-requirements.cjs`(검사) · `scripts/issue-review-receipt.cjs`(receipt 발급)
- 저장소: `.agents/requirements/reviews/` — receipt JSON + 리뷰어 원문 전사(`logs/`)
- 결박 방식: 각 단계는 **자유 문자열이 아니라 receipt id 목록**을 적습니다. receipt 는 실제로 존재해야 하고,
  해당 단계 최소 인원의 **서로 다른** 리뷰어에게서 findings 0 인 Clean 판정을 받아야 하며, 각 리뷰어의 원문
  전사를 보존하고 그 바이트로 다시 해시해 일치해야 하고, 리뷰어가 실제로 COVERED 라고 적은 요구사항만
  나열해야 하며, `Files Read`에 모든 필수 경로를 열거하고 자신이 심사한 트리의 `scope_digest` 와 일치해야 합니다.
- digest 는 추적 파일과 무시되지 않은 신규 파일의 **현재 작업 트리 바이트**, 요구사항, 출처 장부에서 도출합니다.
  `reviews:` 줄과 receipt 저장소 자체만 제외해 판정을 기록하는 행위가 그 판정을 무효화하지 않게 합니다.
- 따라서 **리뷰 후 코드를 고치면 digest 가 바뀌어 receipt 가 무효**가 됩니다. review-pass 규약의
  "이후 수정은 Clean 연속 기록을 리셋한다"가 신사협정이 아니라 기계적으로 강제됩니다.

**정직한 한계**

- receipt 저장소는 평범한 Git 추적 디렉터리입니다. 쓰기 권한이 있는 에이전트는 receipt 와 그에 맞는
  가짜 전사를 함께 위조할 수 있고, 두 해시 검사 모두 통과합니다. 이 게이트가 막는 것은 **값싼 실패**입니다 —
  애초에 만들어진 적 없는 리뷰 증거를 선언하는 것, 그리고 리뷰 대상 코드를 고친 뒤에도 옛 판정을 계속
  쓰는 것. **위조 자체를 막으려면 위의 opt-in 런타임을 켜야 합니다** (리뷰어가 bubblewrap 격리에서 돌고,
  receipt 는 작성자와 다른 프로세스 정체성으로 서명됩니다).
- 리뷰 대상은 현재 staged/unstaged/무시되지 않은 신규 변경 전체, 기능 이름 경로, 요구사항의 모든 code/test trace,
  출처 장부, 지배 스킬·리뷰 기구의 짧은 명시 목록에서 도출합니다. reviewer가 `Files Read`에서 필수 경로를 하나라도
  빼면 receipt를 거부합니다. 변경되지 않은 의존 파일은 trace나 명시 목록으로 등록해야 합니다.
- `Files Read`는 리뷰어의 열람 진술이지 사람이나 모델이 각 바이트를 실제로 인지했음을 기계적으로 증명하지는 않습니다.
  새 receipt는 검토 가능하게 제공된 정확한 작업 트리 객체의 경로·유형·크기·SHA-256 목록과 scope digest를 함께 결박합니다. 심볼릭 링크는 링크 경로와 저장소 안 실제 대상 바이트를 모두 결박하고, 저장소 밖 대상은 거부합니다. opt-in 런타임은 이 진술을 서명할 수 있지만,
  일반 Git receipt는 위에서 밝힌 위조 한계를 그대로 가집니다.
- 리뷰어 정체성 = 도구+모델. 같은 모델을 두 번 돌린 것은 두 명으로 세지 않습니다(의도된 설계).
  정족수는 호출자가 서로 다른 리뷰어를 공급해야 채워집니다.

---

## 검증 항목

### H1 — False Positive 테스트
막으면 안 되는 것을 막고 있지는 않은가?
- 테스트 케이스 5개: 통과 3개 + 차단 2개
- `echo '<json>' | node .claude/hooks/<hook>.js`로 직접 검증
- **주의**: 인용 문자열 내 패턴 오탐, 경로 패턴 과도한 매칭

### H2 — 근본 원인 vs 증상 억제
훅이 증상을 억제하고 있는가, 근본 원인을 해결하고 있는가?
- "이 훅이 방지하는 행동은 무엇인가?"
- "다른 경로로 같은 결과가 생길 수 있는가?" → 있으면 증상 억제

| 구분 | 예시 |
|------|------|
| 증상 억제 | `git reset --hard` 차단 (되돌리기 어려운 행동) |
| 근본 원인 | 되돌리기 어려운 행동 전 사용자 확인 체크포인트 추가 |

### H3 — 스코프 확인
훅 시점(PreToolUse vs PostToolUse)이 의도와 맞는가?
- **되돌릴 수 없는 행동을 방지하는 훅**: 반드시 PreToolUse
- PostToolUse는 이미 실행된 후 → 되돌릴 수 없는 행동에는 너무 늦음

### H4 — 프로세스 제약 + 행동 제약 쌍
모든 "X 하면 안 된다" 규칙에 "대신 Y를 해라"가 함께 있는가?
- 없으면 규칙이 불완전

| 구분 | 예시 |
|------|------|
| 불완전 | "설계 결정을 절대 변경하지 말 것" |
| 완전 | "설계 결정을 절대 변경하지 말 것. 설계-구현 괴리 발견 시 → 에스컬레이션 경로 따를 것" |

### H5 — 권한 모델 커버리지
AI의 역할(구현자 vs 리뷰어)이 파일 유형별로 명확히 정의되어 있는가?
- `agents-rules.json` permission_model 확인
- design_doc_paths 최신 상태 확인
- design-doc-guard.js가 `docs/design/` 편집을 차단하는지 테스트

### H6 — 에스컬레이션 경로 정의
"멈추고 보고" 규칙마다 에스컬레이션 경로가 명시되어 있는가?
- 경로: **발견 → 보고 → 대기** (발견 → 조용히 수정 금지)
- 커버 대상: `design_gap_found_during_build`, `design_flaw_found_during_review`

### H7 — 리뷰 품질
반복 리뷰가 `/review-pass` 스킬로 적대적 프레임과 함께 실행되는가?
- IDD workflow review/post_test_review 단계 확인
- `/review-pass` 스킬 파일 존재 확인
- 일반 연속 Clean 2회 바닥 적용 확인
- 보존 작업은 planning×4와 integration×4의 새 역할 실행, 역할별 evidence withholding, stage 결박을 별도로 확인

### H8 — 원요청 무결성
리뷰나 완료 주장이 최초·후속 사용자 지시를 조용히 누락·재분류·축소할 수 있는가?
- genesis 누락, 원문 삭제/변조, 후속 지시, 범위 제거, stale 리뷰, Claude/Codex parity 결함을 fault-injection으로 재현
- 모든 실행 지시가 REQ→UC/UC-test→FE/FE-test→구현→증거로 이어지는지 확인
- 복합 원문을 인용만 하고 일부 atom을 target·criterion·trace artifact 또는 간선에서 누락할 수 없는지 확인
- 초기 결박과 모든 범위 epoch 변경에 사용자-presence 서명 요구
- 비공개 리뷰 bundle에 결박되고 작성 세션과 분리된 일반 외부서명 Clean 2회를 요구
- 보존 release에는 planning 네 역할과 integration 새 네 역할, 서로 다른 reviewer context/process/execution, 역할별 evidence view와 stage 결박을 추가 요구
- trusted adapter-runner receipt 없는 probe JSON, unattested vendor origin, baseline exact-set 누락, 원격 REVIEW_ONLY publication을 거부
- 부분 target/acceptance-criterion 삭제, 후속 genesis 재승인, operation 간 metadata 섞기, 변경 가능한 quarantine 소비 표식 위조를 거부하는지 검증
- 완료 직전 workspace 변조, native event 누락, review 없는 `success` state 압축을 거부하는지 검증

---

## 기존 훅 소급 검증 결과

| 훅 | 유형 | H1 | H2 | H3 | H4 | 검증일 |
|----|------|----|----|----|----|--------|
| `destructive-git-guard.js` | PreToolUse | PASS | PASS | PASS | PASS | 2026-03-20 |
| `design-doc-guard.js` | PreToolUse | PASS | PASS | PASS | PASS | 2026-03-21 |
| `pr-guard.js` | PreToolUse | PASS | PASS | PASS | PASS | 2026-03-22 |
| `commit-guard.js` | PreToolUse | PASS | PASS | PASS | PASS | 2026-03-22 |
| `cascade-check.js` | PostToolUse | PASS | INFO | PASS | PASS | 2026-03-22 |
| `session-inject.js` | UserPromptSubmit | PASS | PASS | PASS | PASS | 2026-04-26 |

**참고:**
- `pr-guard.js` H1: regex `(?:^|[;&|])\s*gh\s+pr\s+create\b` (2026-03-22). 체인 명령 catch + echo/body 인자 안의 텍스트 false positive 방지. T6-T10 5/5 PASS.
- `commit-guard.js`: PostToolUse → PreToolUse 전환 (2026-03-22). regex `(?:^|[;&|])\s*git\s+commit\b`. echo 인자 안 텍스트 false positive 방지. T1-T5 5/5 PASS.
- `cascade-check.js` H2 INFO: PostToolUse 알림이 차단이 아님 — 미러 업데이트는 AI 책임, 자동화 아님. 허용된 설계.
- `session-inject.js` H4: design-doc-unlock 파일 활성화 시 경고 출력 기능 추가 (2026-03-22).
- `session-inject.js` 동작 모델 재설계 (2026-04-26, 2026-07-31 보정): 자동 바인딩 제거, opt-out 메커니즘 추가, `/harness` 슬래시 명령어 도입. 미바인딩 상태는 사용자 프롬프트마다 노출하지 않고 조용히 종료하며, 변경 작업의 안전은 `session-contract-gate`가 실제 도구 실행 시점에 보장합니다. 아래 섹션 참조.

---

## session_inject 동작 모델 (2026-04-26 개정, 2026-07-31 출력 보정)

**해결 우선순위 (auto-bind 없음):**
1. **P0** — progress 파일 안의 `session_id` 필드가 현재 세션 ID와 일치하는 파일 (가장 권위적, session-map 손상에도 견고)
2. **P1** — `.session-map.json[session_id]`가 가리키는 파일
3. **둘 다 없으면 조용히 종료** — 절대 추측해서 자동 바인딩하지 않고, 내부 미바인딩 상태를 사용자에게 반복 노출하지 않음

**활성 후보 정의:** `mtime ≤ 24h` AND `current_phase != "close"` — 매 프롬프트가 아니라 사용자가 명시적으로 `/harness status`를 실행할 때만 표시됩니다.

**안전 경계:** 미바인딩 상태에서도 읽기 전용 조사는 허용합니다. 실제 변경 명령을 실행하려 할 때는 `session-contract-gate`가 차단하고, progress 파일에 현재 `session_id`를 기록하는 바인딩 작업은 항상 허용합니다. 따라서 사용자 화면의 반복 안내를 없애도 계약 없는 변경은 허용되지 않습니다.

**승인창의 두 종류:** 디스코드 자동 실행 자식은 Codex의 `approval_policy=never` 또는 Claude의 `dontAsk`/읽기 전용 모드로 실행하고, 예전 관리형 권한 프로필은 재사용하지 않습니다. 반면 Codex 호스트가 샌드박스 밖 명령을 허용할지 묻는 플랫폼 승인창은 저장소 코드로 끌 수 없습니다. 운영 세션은 샌드박스 안 명령과 이미 제한적으로 허용된 명령을 우선하고, 피할 수 없는 호스트 권한 상승은 마지막 검증 단계에 한 번으로 묶어야 합니다. 자식 실행의 무승인 설정으로 플랫폼 승인창까지 해결했다고 보고하면 안 됩니다.

**Opt-out (HARNESS 끔):**
- `CLAUDE_HARNESS=off` (또는 `0`/`false`/`no`) 환경변수
- `<cwd>/.claude/no-harness` 마커 파일 (내용 무관, 존재만으로 opt-out)
- 위 둘 중 하나면 hook은 매 턴 조용히 종료

**명시적 제어 — `/harness` 슬래시 명령어:**

| 명령 | 동작 |
|------|------|
| `/harness status` | 현재 바인딩 상태(P0/P1/UNBOUND) + opt-out 여부 + 활성 후보 표시 |
| `/harness off` | `<cwd>/.claude/no-harness` 생성 → opt-out |
| `/harness on` | `no-harness` 마커 제거 → HARNESS 재활성 |
| `/harness bind <file or issue#>` | 지정 progress 파일에 `session_id` 기재 (P0 anchor) |
| `/harness unbind` | session-map + progress 파일 양쪽에서 현재 세션 흔적 제거 |

명세는 `.claude/commands/harness.md` 참조.

**왜 자동 바인딩(P2-singleton)을 제거했나:** 멀티세션 워크플로우에서 새 세션이 활성 작업 1개에 자동으로 끌려가면서 cross-session context drift가 발생. 새 세션이 자유 작업이거나 다른 이슈를 다루려는 경우에도 #N HARNESS가 강제 inject됐음. 명시적 바인딩만 허용하는 모델로 전환.

**왜 atomic write인가:** 동시 세션이 `.session-map.json`을 동시에 갱신하면 JSON 손상 가능. tmp 파일에 쓴 뒤 rename으로 원자성 확보.

---

## 설계/제안 검토 질문 (design_review_questions, A.8 흡수)

> 출처: harness-books Book1 부록 A.8 (제안 검토 8문). 흡수 검토 = `.agents/progress/harness-books-integration-findings-2026-06-18.md` A절.
> H1~H7은 **우리 훅의 품질**을 점검하고, 아래 질문은 **에이전트·하네스 설계 제안 자체**를 검토한다(대상이 다름). H5(권한 모델 커버리지)는 SA2와 일부 겹친다.
> 사용 시점: 새 하네스·에이전트 설계 PR, IDD Plan 게이트, 외부 하네스 흡수 검토.

| ID | 질문 |
|----|------|
| SA1 | 어떤 행동이 프롬프트로 제약되고, 어떤 행동이 런타임으로 강제되는가? |
| SA2 | 도구 오용을 누가, 어느 레이어에서 막는가? |
| SA3 | 컨텍스트는 언제 compact되며, 이후 작업 의미(계획·스킬·핵심 파일·도구 상태)는 어떻게 복원되는가? |
| SA4 | prompt-too-long과 max-output-tokens는 서로 다르게 복구되는가? |
| SA5 | 인터럽트 후 transcript와 도구 결과의 정합성은 어떻게 유지되는가? |
| SA6 | 멀티에이전트 흐름에서 누가 synthesis를, 누가 verification을 소유하는가? |
| SA7 | 실패 복구에 circuit breaker와 무한루프 방지 가드가 있는가? |
| SA8 | 팀은 에이전트가 무엇을, 왜 했는지 어떻게 감사(audit)하는가? |

**red flag:** 답이 자주 "나중에 추가하면 된다"로 수렴하면, 런타임이 아직 제대로 설계되지 않은 것.

---

## 업데이트 방법

1. `.agents/context/harness.yaml` 수정
2. 이 파일도 동기화 업데이트
