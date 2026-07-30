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
node -c scripts/validate-request-contract-requirements.cjs
node -c scripts/request-contract-review-scope.cjs
node -c scripts/request-contract-review-transcript.cjs
node -c scripts/issue-review-receipt.cjs
```

2. fault-injection 전체를 실행한다.

```bash
node scripts/run-request-contract-tests.cjs
```

PASS 기준: 종료코드 0이며 마지막 줄에 `request-contract orchestrator: PASS`가 있다. orchestrator는 실제 두 native adapter 프로세스의 전체 persisted lifecycle 동등성을 누적 fault fixture와 메모리 상태를 공유하지 않는 두 번째 프로세스에서 검증한다. 검사는 동시 전역 lineage 승계와 출발/도착 chain 교차 결박 quarantine, 거부된 prompt envelope와 중복 runtime binding 차단의 원문 보존, 원문 exact-partition obligation atom과 target·criterion·REQ·UC·UC-test·FE·FE-test→implementation→evidence의 atom별 7개 간선 연결, source 변조·누락·재분류, lifecycle state/baseline 단독 변조, 재귀 Git-tree clean genesis, 수정→되돌림→재수정 occurrence, native stdin event 누락·불일치, Claude/Codex `apply_patch` preflight parity, native `PreCompact` 완료평가·압축 차단·proof 생성과 `PostCompact` proof/workspace 재검증, trace 전체 tombstone 불변성, exact authority source/tombstone/change mapping, 종료 지시 재활성화와 target/criterion 부분 삭제 거부, operation별 metadata 소유권과 단일 mixed pending transaction, 비종료 상태 자율 전환, 권한 challenge·counter·replay, HEAD·index·재귀 submodule 실제 바이트·전 레포 변경 추적, 현재/과거 scope-version의 완전한 불투명 관계 매핑, reviewer stdout의 원문·경로·locator·요약·digest 부재, writer host와 다른 reviewer PID+kernel identity, 코어 발급 run ID와 verdict 일치 고정 finding code, 실제 reviewer stdout과 동일한 일회성 live-runner provenance, runner 고정 시각과 거부 출력 비반사, digest-verified reviewer+bundle 익명 descriptor snapshot과 실제 PID/network/repository/home bubblewrap 격리, 설정 고정 attestor snapshot digest+review payload digest 이중서명, direct review JSON 접수 거부, 발급 후 드리프트 접수 거부, 완료 직전 변조 재검증, review-bound completion proof와 위조 success 압축 거부, manifest/bundle tampering, compaction 뒤 전역 ID 재사용 거부, bind/review/resume/session crash 복구, session 소유 lease Stop 복구와 실행 중 lease의 리뷰 차단, 동일실패 Stop 제한, terminal lock, 무작위 재시도 고정 receipt 비민감 압축을 포함한다.

orchestrator는 시작 전에 RCI-001~RCI-011 파일과 인덱스의 ID·상태·제목·원요청 지시 연결·acceptance·실재 code/test trace 경로를 검사하고, 4단계 리뷰 증거가 **자유 문자열이 아니라 receipt** 임을 확인한다. receipt 는 실존해야 하고, 해당 단계 최소 인원의 서로 다른 리뷰어에게서 findings 0 인 Clean 판정을 받아야 하며, 각 리뷰어의 원문 전사를 보존하고 그 바이트로 재해시·재파싱해 receipt 의 주장과 일치해야 하고, 리뷰어가 실제로 COVERED 라고 적은 요구사항만 나열해야 하며, 리뷰어가 심사한 트리의 `scope_digest` 와 일치해야 한다. 서로 다른 두 receipt 가 같은 전사에 기대면 한 라운드를 두 번 쓴 것으로 보고 거부한다. 음성 테스트는 합성 fixture 위에서 항상 실행되므로 receipt 저장소 상태와 무관하게 회귀를 잡는다.

리뷰 라운드를 마치면 receipt 를 발급한다.

```bash
node scripts/issue-review-receipt.cjs <review-id> "$(date -Iseconds)" <tool>:<model>=<log> ...
```

리뷰어에게는 `node scripts/request-contract-review-scope.cjs` 결과를 프롬프트에 주고 전사의 `### Scope Digest` 절에 그대로 적게 한다. 리뷰 후 리뷰 대상 코드를 고치면 digest 가 움직여 receipt 가 무효가 된다 — review-pass 의 "이후 수정은 Clean 연속 기록을 리셋한다"가 기계적으로 강제된다.

3. Claude Code와 Codex의 생명주기 등록을 대조한다.

```powershell
node -e "const core=require('./.agents/hooks/core/request-contract.js'); for(const [client,version] of [['claude','2.1.207'],['codex','0.144.1']]){if(!core.clientRegistrySupports(process.cwd(),client))throw new Error(client+': lifecycle registry mismatch');core.assertSupportedClient(process.cwd(),client,version)}"
```

4. 스키마와 예시의 JSON 문법 및 패키지 인덱스를 검사한다.

```powershell
pnpm --filter @naia-adk/artifacts-spec test
node -e "const fs=require('fs');if(fs.readdirSync('packages/artifacts-spec/schemas').filter(x=>x.endsWith('.schema.json')).length!==16)process.exit(1)"
```

예시는 AJV 구조 검증뿐 아니라 고정 evidence, exact source/scope/presentation digest, 테스트 공개키 authority receipt로 런타임 validator까지 통과해야 합니다. source·evidence·signature 드리프트 음성 테스트도 모두 거부되어야 합니다.

5. 등록 드리프트와 미러를 검사한다.

```powershell
node .claude/hooks/sync-entry-points.js --check
node -e "const fs=require('fs');const a=fs.readFileSync('.agents/skills/verify-request-contract/SKILL.md'),u=fs.readFileSync('.users/skills/verify-request-contract/SKILL.md');if(!a.equals(u)||fs.readFileSync('.claude/skills/verify-request-contract','utf8').trim()!=='../../.agents/skills/verify-request-contract')process.exit(1)"
git check-ignore .agents/harness/units/probe .agents/harness/quarantine/probe .agents/harness/receipts-v2/probe .agents/harness/claims/probe .agents/harness/locks/probe .claude/git-push-approved.marker
```

6. 기존 하네스 회귀를 실행한다.

```powershell
pnpm run test:harness-native
```

Linux CI는 별도로 `bash .claude/hooks/e2e/run.sh`와 `bash .claude/hooks/e2e/scenario.sh`를 실행한다. 이 Linux 증거를 Windows 통과로 재사용하지 않으며 Windows는 WSL, Cygwin, MSYS2, Linux VM·컨테이너를 요구하지 않는다.

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
| `.agents/requirements/RCI-*.yaml` | 원요청 무결성 요구사항과 단계별 리뷰 trace |
| `.agents/requirements/_index.yaml` | RCI ID·제목·상태 인덱스 |
| `.users/context/request-contract.md` | downstream 운영 문서 |
| `.agents/skills/review-pass/SKILL.md` | 완전 bundle 기반 적대 리뷰 규약 |
| `packages/artifacts-spec/schemas/request-contract.schema.json` | 공유 계약 스키마 |
| `.claude/hooks/test/run-request-contract-test.js` | 결정론 fault-injection |
| `scripts/run-request-contract-tests.cjs` | broad suite와 메모리 격리 parity suite 순차 실행 |
| `scripts/validate-request-contract-requirements.cjs` | RCI 요구사항·인덱스·실재 trace 검사 + 4단계 리뷰 증거를 receipt 에 결박 |
| `scripts/request-contract-review-scope.cjs` | 리뷰 대상 파일 집합(git ls-files + RCI trace 선언 경로)과 `scope_digest` |
| `scripts/request-contract-review-transcript.cjs` | 리뷰어 전사 파서 (발급기·검사기 공용). 절단·모순·프롬프트 템플릿 상속을 Clean 으로 읽지 않음 |
| `scripts/issue-review-receipt.cjs` | 전사에서 receipt 발급. 아무것도 지어내지 않음 |
| `.agents/requirements/reviews/` | receipt + 리뷰어 원문 전사(`logs/`). 커밋 대상 |
| `.gitignore` | private runtime unit·bundle·claim·lock 커밋 방지 |
