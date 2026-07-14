---
name: verify-request-contract
description: 원요청 무결성 하네스의 원문 해시체인, 완전 범위 추적, 서명 권한, 2회 Clean 결박, Claude Code/Codex 등록·동등성을 결정론으로 검증합니다. request-contract 코어·어댑터·설정·스키마·review-pass를 수정한 뒤, Review/Post-test Review 및 커밋 전에 반드시 사용합니다.
---

# 원요청 무결성 검증

아래 순서를 그대로 실행한다. 하나라도 실패하면 PASS를 보고하지 않는다.

## Workflow

1. 코어와 두 어댑터의 문법을 검사한다.

```bash
node -c .agents/hooks/core/request-contract.js
node -c .agents/hooks/core/request-contract-adapter.js
node -c .agents/hooks/core/request-contract-review-runner.js
node -c .claude/hooks/request-contract.js
node -c .codex/hooks/request-contract.cjs
node -c scripts/request-contract.cjs
node -c scripts/request-contract-review-runner.cjs
```

2. fault-injection 전체를 실행한다.

```bash
node scripts/run-request-contract-tests.cjs
```

PASS 기준: 종료코드 0이며 마지막 줄에 `request-contract orchestrator: PASS`가 있다. orchestrator는 실제 두 native adapter 프로세스의 전체 persisted lifecycle 동등성을 누적 fault fixture와 메모리 상태를 공유하지 않는 두 번째 프로세스에서 검증한다. 검사는 동시 전역 lineage 승계와 출발/도착 chain 교차 결박 quarantine, 거부된 prompt envelope와 중복 runtime binding 차단의 원문 보존, 원문 exact-partition obligation atom과 target·criterion·REQ·UC·UC-test·FE·FE-test→implementation→evidence의 atom별 7개 간선 연결, source 변조·누락·재분류, lifecycle state/baseline 단독 변조, 재귀 Git-tree clean genesis, 수정→되돌림→재수정 occurrence, native stdin event 누락·불일치, Claude/Codex `apply_patch` preflight parity, native `PreCompact` 완료평가·압축 차단·proof 생성과 `PostCompact` proof/workspace 재검증, trace 전체 tombstone 불변성, exact authority source/tombstone/change mapping, 종료 지시 재활성화와 target/criterion 부분 삭제 거부, operation별 metadata 소유권과 단일 mixed pending transaction, 비종료 상태 자율 전환, 권한 challenge·counter·replay, HEAD·index·재귀 submodule 실제 바이트·전 레포 변경 추적, 현재/과거 scope-version의 완전한 불투명 관계 매핑, reviewer stdout의 원문·경로·locator·요약·digest 부재, writer host와 다른 reviewer PID+kernel identity, 코어 발급 run ID와 verdict 일치 고정 finding code, 실제 reviewer stdout과 동일한 일회성 live-runner provenance, runner 고정 시각과 거부 출력 비반사, digest-verified reviewer+bundle 익명 descriptor snapshot과 실제 PID/network/repository/home bubblewrap 격리, 설정 고정 attestor snapshot digest+review payload digest 이중서명, direct review JSON 접수 거부, 발급 후 드리프트 접수 거부, 완료 직전 변조 재검증, review-bound completion proof와 위조 success 압축 거부, manifest/bundle tampering, compaction 뒤 전역 ID 재사용 거부, bind/review/resume/session crash 복구, session 소유 lease Stop 복구와 실행 중 lease의 리뷰 차단, 동일실패 Stop 제한, terminal lock, 무작위 재시도 고정 receipt 비민감 압축을 포함한다.

3. Claude Code와 Codex의 생명주기 등록을 대조한다.

```bash
node - <<'NODE'
const core=require('./.agents/hooks/core/request-contract.js');
for (const [client, version] of [['claude','2.1.207'],['codex','0.144.1']]) {
  if (!core.clientRegistrySupports(process.cwd(), client)) throw new Error(`${client}: lifecycle registry mismatch`);
  core.assertSupportedClient(process.cwd(), client, version);
}
NODE
```

4. 스키마와 예시의 JSON 문법 및 패키지 인덱스를 검사한다.

```bash
pnpm --filter @naia-adk/artifacts-spec test
test "$(find packages/artifacts-spec/schemas -maxdepth 1 -name '*.schema.json' | wc -l)" -eq 16
```

예시는 AJV 구조 검증뿐 아니라 고정 evidence, exact source/scope/presentation digest, 테스트 공개키 authority receipt로 런타임 validator까지 통과해야 합니다. source·evidence·signature 드리프트 음성 테스트도 모두 거부되어야 합니다.

5. 등록 드리프트와 미러를 검사한다.

```bash
cmp AGENTS.md CLAUDE.md
cmp AGENTS.md GEMINI.md
cmp .agents/skills/verify-request-contract/SKILL.md .users/skills/verify-request-contract/SKILL.md
test "$(cat .claude/skills/verify-request-contract)" = "../../.agents/skills/verify-request-contract"
git check-ignore .agents/harness/units/probe .agents/harness/quarantine/probe .agents/harness/receipts-v2/probe .agents/harness/claims/probe .agents/harness/locks/probe
git check-ignore .claude/git-push-approved.marker
```

6. 기존 하네스 회귀를 실행한다.

```bash
bash .claude/hooks/e2e/run.sh
```

## PASS / FAIL

| 판정 | 조건 |
|---|---|
| PASS | 1~6 모두 종료코드 0, 두 클라이언트가 7개 생명주기 이벤트를 공유, fault-injection 전부 통과 |
| FAIL | 명령 하나라도 실패, 등록 누락, 미러 차이, source/권한/review 우회 사례 하나라도 허용 |

FAIL이면 실패한 불변식과 파일을 수정하고 1번부터 전부 다시 실행한다.

## Exceptions

- `enabled_by_default: false`는 의도된 점진 도입이며 실패가 아니다.
- 런타임 인스턴스 `.agents/harness/**`가 gitignored인 것은 정상이다.
- 고정 공개키 파일이 upstream에 없는 것은 정상이다. 실제 운영 키는 downstream 경로나 환경변수로 공급한다.
- Claude CLI 로그인 부재는 네이티브 stdin replay가 통과하면 어댑터 결함으로 판정하지 않되, 실 클라이언트 smoke 미실행 사실은 보고한다.

## Related Files

| File | Purpose |
|---|---|
| `.agents/hooks/core/request-contract.js` | 도구 비종속 정책·상태 코어 |
| `.agents/hooks/core/request-contract-adapter.js` | 공통 envelope 변환 |
| `.agents/hooks/core/request-contract-review-runner.js` | 실제 격리 실행·프로세스 증거 수집 |
| `.claude/hooks/request-contract.js` | Claude Code 어댑터 |
| `.codex/hooks/request-contract.cjs` | Codex 어댑터 |
| `scripts/request-contract-review-runner.cjs` | 허용 reviewer + 별도 attestor 실행기 |
| `.claude/settings.json` | Claude Code 등록 |
| `.codex/hooks.json` | Codex 등록 |
| `.agents/context/request-contract.json` | product root·권한·보존 정책 |
| `.agents/context/harness.yaml` | 하네스 레지스트리 SoT |
| `.users/context/request-contract.md` | downstream 운영 문서 |
| `.agents/skills/review-pass/SKILL.md` | 완전 bundle 기반 적대 리뷰 규약 |
| `packages/artifacts-spec/schemas/request-contract.schema.json` | 공유 계약 스키마 |
| `.claude/hooks/test/run-request-contract-test.js` | 결정론 fault-injection |
| `scripts/run-request-contract-tests.cjs` | broad suite와 메모리 격리 parity suite 순차 실행 |
| `.gitignore` | private runtime unit·bundle·claim·lock 커밋 방지 |
