---
name: verify-product-preservation
description: 기존 제품의 경로·진입점·내비게이션·사용자 여정·운영 표면이 기능 추가 뒤에도 유지되는지 기준 버전과 보존 계약으로 검증합니다. 기존 프로젝트의 기능 추가·통합·리팩터링 후, planning/integration 리뷰와 release 전에 반드시 사용합니다.
---

# 제품 보존 검증

## 목적

다음을 파일 존재가 아니라 실제 도달 가능성으로 검증합니다.

1. 원요청과 파생 요구사항의 권한 구분
2. 변경 전 제품 표면과 현재 제품 표면 비교
3. 승인 없는 교체·제거·숨김 탐지
4. 거짓 양성 테스트와 검토 전용 배포 차단

## 필수 입력

- 변경 전 immutable commit/tree인 `preservation.baseline_ref`
- 원요청 source artifact 또는 governed request-contract bundle
- top-level `preservation.version`, `preservation.baseline_ref`, `preservation.intent`,
  `preservation.surfaces`, `preservation.vendor_sources`를 담은 request contract
- immutable baseline에서 전체 surface exact-set을 독립 산출하고 before/current capability probe를 실행하는 preservation adapter
- 실제 entry 실행 뒤 runner/command/exit/result/subject를 서명하는 allowlisted trusted adapter-runner receipt
- vendor origin repository identity·immutable commit/tree·origin tree digest attestation
- 각 surface의 `id`, `directive_id`, `kind`, `locator`, `disposition`,
  `baseline_paths`, `current_paths`, `baseline_evidence_id`, `current_evidence_id`
- 현재 변경 ref, planning 네 역할과 integration의 새 네 역할 review 결과

`disposition`은 schema와 동일한 lowercase
`preserve|extend|replace|remove|disable|redirect|migrate` 중 하나입니다.
`preservation.intent`는 `add|integrate|extend|modify|migrate|replace|remove` 중 하나입니다.
`replace|remove|disable|redirect|migrate`에는 해당 surface의 실제 diff와 일치하는
`expected_diff_digest`와 유효한 `authority_id`가 모두 필요합니다.

## Workflow

### 1. 입력과 기준 버전 검증

```bash
git cat-file -e <preservation.baseline_ref>^{commit}
git status --short
```

PASS:

- 기준 버전이 immutable Git object로 존재합니다.
- 원요청 source, preservation contract, 현재 ref가 모두 식별됩니다.
- 외부 소스는 attested origin repository+commit/tree에서 계산한 digest와 수정본이 구분됩니다.

FAIL:

- AI 요약이나 수정 가능한 이슈 본문만 원요청 근거로 사용합니다.
- 외부 원본 인수와 재작성을 같은 신규 파일 상태로만 남겨 원본 대비 diff를 재현할 수 없습니다.
- URL/commit 형식과 local subtree digest만으로 vendor origin을 증명했다고 주장합니다.

### 2. 표면과 권한 완전성 검증

preservation contract를 보기 전/독립적으로 프로젝트 adapter가 immutable baseline에서 전체 표면
exact-set을 산출하게 하고, 그 집합과 contract surface 집합이 정확히 같은지 확인합니다.

- UI route/navigation/entry와 사용자 여정(해당하는 경우)
- API, CLI command, library export, data/schema contract
- background job, package/deployment target, 운영·복구·handoff 경로
- 적용되지 않는 종류의 N/A 근거

PASS: adapter-derived exact-set의 모든 표면에 lowercase `disposition`, 기준/현재 경로와 trusted-runner 증거 ID가 있습니다.

FAIL:

- 누락 표면이 있습니다.
- contract 작성자가 선택한 subset을 baseline inventory로 다시 사용합니다.
- `replace|remove|disable|redirect|migrate`에 exact user authority를 가리키는
  `authority_id` 또는 실제 변경을 고정한 `expected_diff_digest`가 없습니다.
- AI가 작성한 REQ·이슈 댓글·요약을 사용자 승인으로 사용합니다.

### 3. 구조적·기능적 삭제 탐지

```bash
git diff --name-status <preservation.baseline_ref>...HEAD
git diff --summary <preservation.baseline_ref>...HEAD
git diff <preservation.baseline_ref>...HEAD -- . ':!*.lock'
```

다음을 CRITICAL preservation finding으로 기록합니다.

- 삭제, 대규모 축약, root redirect, route shadowing
- 기존 navigation/entry script 연결 제거
- 파일은 남았지만 정상 경로에서 도달할 수 없는 기능
- 기존 사이트 대신 별도 앱 URL을 대표 handoff URL로 전달
- vendor 원본을 별도 baseline 없이 재작성

승인 없는 항목은 단일 발견만으로 veto이며 합의 투표로 기각하지 않습니다.

### 4. before/after probe 실행

각 표면의 `baseline_evidence_id`와 `current_evidence_id`가 가리키는 capability probe를
allowlisted trusted adapter runner로 각각 기준 버전과 현재 버전에서 실행합니다. `baseline_paths`와 `current_paths`는 실제
workspace path와 일치해야 하며 `remove`가 아니면 `current_paths`가 비어 있으면 안 됩니다.
각 evidence의 `locator`와 `digest`가 가리키는 probe JSON은 `version: 1`, 동일한
`surface_id`, `phase: baseline|current`, 실제 표면 파일 집합의 `subject_digest`, boolean
`reachable`, 중복 없는 string `capabilities`, `execution.runner/executed_at/command_digest/result_digest`를
가져야 합니다. baseline probe는 현재 작업 폴더가 아니라 `baseline_ref` Git 객체에서 읽습니다.
probe JSON을 에이전트가 직접 작성하거나 기존 JSON의 필드·digest만 맞추는 것은 FAIL입니다.
receipt는 runner executable digest, 실제 command, exit code, result digest, subject digest를
서명해야 합니다. adapter는 표면 종류에 맞는 실제 entry를 실행합니다. 웹 표면이면 실제 서버와 브라우저로
route/navigation/완료 상태/console error/desktop-mobile을 비교하고, API·CLI·library·schema·
job·operations 표면이면 각각의 실제 호출·import·validation·job entry로 관찰 결과를 검증합니다.

보호 실행 영수증 코드가 바뀌면 다음 결정론 검사를 추가로 실행합니다.

```bash
node .agents/hooks/core/preservation-execution-runner.test.js
NODE_ENV=test node .agents/hooks/core/preservation-receipt-evidence.test.js
node scripts/preservation-attestor-service.test.cjs
node scripts/preservation-attestor-e2e.test.cjs
! rg -n 'PRESERVATION_EXECUTION_PUBLIC_KEY|preservation-execution\.pub' \
  .agents/hooks/core/request-contract.js .agents/context/request-contract.json
! rg -n -- '--test|tests/' .agents/skills/manage-discord-sessions/preservation-adapter.cjs
```

PASS는 고정 root 공개키와 verifier manifest만 신뢰하고, root policy에 사전 등록된
binding과 보호 SQLite의 terminal challenge에서 service-side decision을 만들며, seal
직전·직후 current snapshot을 다시 검증하는 경우입니다. Installed worker·execution
core·snapshot core는 각각 소유권·digest로 pin하고, adapter는 수정 가능한 테스트명이
아니라 실제 CLI/모듈을 challenge-bound nonce로 호출해야 합니다. 저장소 JSONL,
first-use registration, caller env/key/allowlist, stale current receipt만으로 성공을 만들 수
있으면 CRITICAL FAIL입니다.

PASS:

- `preserve`: 관찰 가능한 기존 동작이 동일합니다.
- `extend`: 기존 동작이 유지되고 새 동작만 추가됩니다.
- `replace|remove|disable|redirect|migrate`: `authority_id`의 승인 범위와
  `expected_diff_digest`가 실제 surface diff와 정확히 일치합니다.
- 모든 `vendor_sources`는 `disposition: import|preserve`, 정확한 directive/authority, attested
  origin repository identity와 immutable commit/tree, origin tree에서 계산한 digest를 가집니다.
  `import`는 baseline에 없고 attested origin/current digest가 일치하며, `preserve`는
  origin/baseline/current가 동일합니다. 현재 runtime의 ref 형식+local digest 검사만으로는 부족합니다.

### 5. 테스트의 거짓 양성 검사

변경된 테스트와 baseline 회귀 테스트를 함께 읽습니다.

FAIL 신호:

- 기존 entry/script/route가 없음을 승인 없이 assert합니다.
- 새 URL만 완주하고 기존 포털·navigation·handoff를 검사하지 않습니다.
- mock/API 직접 호출은 통과하지만 실제 사용자 경로는 실행하지 않습니다.
- 많은 테스트 통과 수를 preservation evidence로 대신합니다.

### 6. 전달 상태 판정

| 조건 | 결과 |
|------|------|
| planning×4, integration×4, exact baseline inventory, trusted probe receipt, vendor-origin attestation, 권한, project external-side-effect gate가 모두 구현·current/CLEAN | `RELEASE_ELIGIBLE` |
| 하나라도 누락·미구현(PENDING)·실패·veto·NOT_CLEAN | `REVIEW_ONLY` |

`REVIEW_ONLY` checkpoint는 local commit까지만 허용합니다. 원격 review branch push는 exact
signed checkpoint-publication operation이 구현·검증될 때까지 금지합니다. merge, deploy,
release, issue close, 완료 표현은 실패입니다. 내장 release-command regex는 보조 탐지이며
프로젝트 adapter가 모든 external side effect를 엄격히 선언·차단해야 합니다.

### 7. Discord session orchestration regression

When the changed paths include `.agents/skills/manage-discord-sessions/**`,
`naia-settings/messenger-sessions/config.example.json`, or
`docs/design/discord-session-observability.md`, or
`docs/design/discord-unattended-supervision-plan.md`, run:

```bash
pnpm test:discord-sessions
rg -n 'approvalPolicy|permissionProfileEpoch|noProgressInterventionSeconds|operatorResponseSeconds|foreignAgentSupervision|conversationCoordinator' \
  naia-settings/messenger-sessions/config.example.json \
  .agents/skills/manage-discord-sessions/helper/{discord-config,discord-router,backend-runner,backend-child-environment,backend-owned-process,service,systemd,cutover-bundle,cutover-artifact-lock,cutover-artifacts,cutover-canary,cutover-managed-runtime,cutover-rollback,artifact-operation-lock-holder,service-manager,service-manager-shared,service-manager-launcher,service-manager-linux,service-manager-windows,service-cutover-controller,store,store-database,store-reader,store-conversation-writer,store-job-writer,store-event-writer,token-owner-lock}.mjs
```

PASS:

- The deterministic suite proves stale permission-profile replacement,
  no-prompt approval rejection, no-progress intervention, operator-channel
  response handoff, and explicit child workspace binding.
- Config, helper, requirements, design, and the user skill name the same
  execution-profile and watchdog contract.
- The external supervisor is a separate OS-scheduled one-shot, never an
  interactive model loop; coordinator activation and legacy recovery fail
  closed; stale Gateway or child evidence cannot be called healthy.
- The Linux managed service binds bot-token ownership to a kernel `flock`
  outside any per-unit `RuntimeDirectory`; process death releases ownership.
- Watchdog and supervisor hot paths project at most 256 nonterminal jobs oldest
  first, use aggregate counts for the full active set, and fail unattended
  health closed with `operational_jobs_truncated` when work exceeds the bound.
- Managed systemd service and supervisor launches require explicit mode and
  complete immutable-artifact markers before config reads, token ownership, or
  observation. Missing markers cannot silently select direct mode.
- A first install remains possible, but replacing an existing registration
  requires an active rollback bundle that verifies the installed source,
  deployed candidate, and separate clean candidate controller.
- Until Windows versioned cutover exists, first install rejects either a main
  service or supervisor registration before creating launchers.
- The one-time legacy adoption path accepts only the exact prior generated unit
  bytes and binds them before replacement; malformed config cannot disable
  status/stop/disable, and explicit artifact pruning retains the installed
  runtime plus active rollback bundle.
- Rollback materializes the prior Git revision, preserves prior registration
  state, validates the preserved config with that source runtime's actual
  loader, and checks idle/schema both before and after stop. Canary continuation
  requires exact candidate/target runtime, completed delivery, one confirmed
  acknowledgement, fresh healthy supervisor evidence, exact service generations,
  and host-recomputed schema-v2 instance, agent/workspace, context,
  participant-authority, config, and read-only access evidence.
- Entry-point mirrors and the workflow contain internal checkpoints rather
  than unconditional user-approval gates.

FAIL:

- Historical child command options are launched after a profile change.
- `suspected_stalled` remains only a displayed value with no bounded owner
  action, or a Discord job can execute without a channel response handoff.
- A helper trusts an ambient workdir instead of binding the requested child
  workspace explicitly.
- A Windows supervisor silently falls back to an unsupervised polling loop, or
  status claims foreign collaboration-agent lifecycle supervision.
- A canary can continue with missing/stale supervisor evidence, a nonterminal
  job, an unconfirmed delivery, a mismatched runtime, fabricated execution
  binding, or an acknowledgement miss.
- Historical-only attention permanently vetoes a new healthy canary, or a
  minute observer scans and projects all terminal job rows.
- A minute path scans an unbounded active set or silently omits active overflow,
  or Windows first install mutates launchers while a supervisor-only residue
  exists.

## 출력

```markdown
| Surface | Baseline | Disposition | Current probe | Authority | Result |
|---------|----------|-------------|---------------|-----------|--------|
| route:home | PASS | preserve | PASS | N/A | PASS |
| route:legacy | PASS | remove | FAIL | missing | VETO |

Review: CLEAN | NOT_CLEAN
Delivery: RELEASE_ELIGIBLE | REVIEW_ONLY
```

## Exceptions

- greenfield surface는 현재 runtime/schema에서 명시적으로 미지원이며 `preservation_inventory_invalid`로 차단합니다. surface별 absent-baseline 계약과 음성 테스트가 구현되기 전에는 예외로 인정하지 않습니다.
- 파일 이동 뒤 기존 URL·navigation·journey가 동일하고 probe가 통과한 경우
- 생성물·lock 파일이 제품 표면, 계약, 테스트 기준, release 설정 역할을 하지 않는 경우

## 현재 구현 경계

- runtime은 stage와 role별 evidence-view digest를 기록하고 planning×4를 첫 mutation 전에 봉인하며, 구현 변경 뒤 현재 work revision에 대한 integration×4를 새로 요구합니다.
- **IMPLEMENTED, NOT PROVISIONED:** Linux 보호 attestor는 고정 root 공개키·verifier manifest, root-policy 사전 등록, 보호 SQLite, 실제 제품 진입점 baseline/current 실행, seal 시 current snapshot 재검증, service-side evidence-set 결정을 구현했습니다. 전용 OS 계정·키·root-owned TCB가 설치되기 전에는 계속 `REVIEW_ONLY`입니다. 저장소 `receipts.jsonl`은 감사용이며 증명 정본이 아닙니다.
- **PENDING:** vendor `source_ref` 형식과 local tree digest는 named origin tree attestation이 아닙니다.
- **PENDING:** built-in release regex는 모든 external side effect를 열거하지 않습니다.
- **IMPLEMENTED, NOT PROVISIONED:** planning revision baseline과 current work revision은 별도 receipt로 보호 원장에 결박되고 짧은 수명 completion decision으로 봉인됩니다. 보호 서비스 미설치 환경에서는 이를 release 증명으로 사용할 수 없습니다.
- **PENDING:** publication/deployment의 protected external-effect broker는 아직 이 결정을 소비하지 않습니다. 저장소 소유 hook 자체는 same-user 보안 경계가 아니므로 외부 효과는 계속 차단합니다.
- **PENDING:** 선택된 incident directive는 전체 초기 지시·수정 이력을 대신하지 않습니다. 별도 incident-history artifact와 comparison/convergence receipt가 필요합니다.

따라서 현재 보존 review가 CLEAN이어도 runtime은 `REVIEW_ONLY`로만 기록하고, Stop 성공 proof와 모든 shell/publication을 차단합니다.

위 항목이 구현·적대 테스트되기 전에는 이 스킬이 `RELEASE_ELIGIBLE`을 반환할 수 없습니다.

## Related Files

| File | Purpose |
|------|---------|
| `.agents/workflows/issue-driven-development.yaml` | baseline·preservation·delivery gate |
| `.agents/skills/review-pass/SKILL.md` | 역할 분리 리뷰와 preservation veto |
| `.agents/requirements/_template.yaml` | source authority와 preservation trace 기본값 |
| `.agents/skills/verify-implementation/SKILL.md` | 통합 검증 등록 |
| `.agents/skills/manage-skills/SKILL.md` | 역할 기반 검증 커버리지 등록 |
| `.agents/hooks/core/preservation-{execution-runner,receipt-evidence,snapshot}.js` | Sealed execution, protected decision verification, immutable snapshot |
| `scripts/preservation-{attestor-service,execution-runner}.cjs` | Protected attestor and identifier-only client |
| `deploy/preservation-attestor/` | Dedicated-identity policy and systemd protection boundary |
| `.agents/skills/manage-discord-sessions/` | Discord execution profile, watchdog, and deterministic regressions |
| `naia-settings/messenger-sessions/config.example.json` | Operator-visible execution and watchdog defaults |
| `docs/design/discord-session-observability.md` | Discord session design contract |
| `docs/design/discord-unattended-supervision-plan.md` | Unattended supervision, no-prompt, and complexity contract |
