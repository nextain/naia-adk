이 문서가 답하는 질문: 역할 프로파일 선택·한도 복구·차단 관문을 Naia ADK 구조에 어떻게 넣을 것인가?
상태: 문서 적대 검수용 초안
기준판: 공개 저장소 ed104d328ff7870908d326df840e4b98a1718a03

# 역할별 ADK 프로파일과 한도 대체 실행 — 구현 계획

## 1. 설계 경계

기존 네 종류 ADK 구조를 유지한다. schemas/adk-manifest.schema.json은 supported_kinds의 기본 목록으로 user·agent·project·group을 선언하고, org는 하위 호환 별칭이다. 인스턴스의 adk.json은 한 종류를 선언한다. 에이전트별 모델·도구 프로파일과 후보는 kind: agent에 둔다. Naia 업스트림은 공통 스키마·실행기·Claude 훅 구현을 제공한다. 그룹 ADK는 공통 실행 정책, 문서 진입 관문 설정, 중복 방지 원장, 전역 분배 한도와 실행 상태를 둔다. 그룹 ADK에는 runner/hook 실행 코드를 복사하지 않는다.

요청에 주어진 실물 구조에서 그룹 ADK는 현재 에이전트 ADK 사본을 담고 있고 독립 kind: agent ADK는 아직 없다. 구현 때 각 역할의 기존 role-kit 설정을 그룹 사본에 다시 복사하지 말고, 각 역할마다 별도 agent ADK를 준비해 프로파일 정본으로 삼는다. 그룹 ADK의 agent 항목은 agent ID와 실행 자리를 참조하며, 선택 후보 값을 복제하지 않는다. 기존 P-13 §8은 조정자를 돌림·폴백 대상에서 제외하지만, 2026-11-18 최신 사용자 원문은 3층 우선순위 폴백을 요구한다. 이 PL은 요청을 반영한 제안으로만 기록하며 P-13 자체를 조용히 덮지 않는다. 사람 범위 잠금에서 적용 여부와 P-13 갱신 owner를 정하기 전에는 구현 gate가 닫힌다.

공개 공통 스키마와 예시는 일반 참조만 둔다. 실사용 모델·계정·기기·자격증명은 공개 저장소 공통 파일에 적지 않는다. 자격증명은 agent ADK에 값으로 저장하지 않고 별도 보안 경계에서 참조 이름으로 주입한다.

## 2. 현재 기술 조사와 차이

| 조사한 정본 | 확인된 현재 상태 | 계획에 미치는 점 |
| --- | --- | --- |
| docs/guides/adk-2.0-structure.md §1–3 | 네 가지 ADK와 층별 역할 경계를 정의한다. 2층은 실행·검수, 3층은 조정이다. | 기존 구조를 유지하고 agent 단위 프로파일과 group 단위 관문을 추가한다. |
| schemas/adk-manifest.schema.json; templates/agent-skeleton/adk.json; templates/group-skeleton/adk.json | 에이전트 매니페스트와 그룹의 agent 자리 구조가 있다. supported_kinds는 스키마 기본값이며 개별 매니페스트의 필수 필드는 아니다. | 새 프로파일 스키마는 agent ADK에 연결하고, 네 kind 정의를 덮어쓰지 않는다. |
| docs/guides/agent-role-sessions.md | 역할 칸을 herdr로 띄우고 역할 지시를 직접 보내는 절차를 설명한다. 에이전트별 작업 폴더 연결은 미정이다. | 이 수동 시작 절차를 profile runner 호출로 대체하고 agent workspace 참조를 고정한다. |
| .claude/settings.json hooks.PreToolUse | 복수 Bash·파일 변경 matcher와 Task|Agent matcher가 있고 정책 훅 및 서브에이전트 수 제한 훅이 연결되어 있다. 프로파일 전용 차단 훅은 없다. | 기존 등록을 보존하고 직접 실행 검사와 native spawn 거부 훅을 추가한다. command hook에 `onFailure: "block"`을 지정한다. |
| scripts/worker-runner/spawn-worker.mjs | -- <command...>를 받아 임의 명령을 worker-runner와 systemd-run으로 전달한다. | 모델 실행용 호출에서 임의 명령 인자를 제거하고 profile reference만 받도록 바꾼다. |
| docs/developer/pipeline/work/P-13-naia-adk-2.md §8 | 조정자는 폴백 대상이 아니라고 정한다. | 최신 사용자 결정이 이 범위에서 기존 정책을 재정의하는지 범위 잠금에서 승인하고, 승인되면 P-13 정본과 변경 기록을 갱신한다. |

Claude Code 공식 훅 계약에서 PreToolUse는 도구 실행 전에 입력을 받고 도구 호출을 차단할 수 있다. 이 훅은 Claude Code 내부의 호출 경계다. 따라서 서비스나 독립 셸 실행도 차단하려면 공통 ADK 실행기가 별도로 프로파일을 검증해야 한다. 공식 참조: [Claude Code hooks reference](https://code.claude.com/docs/en/hooks), [PreToolUse 입력과 결정](https://code.claude.com/docs/en/hooks#pretooluse).

## 3. 설정 파일 모양

각 kind: agent ADK는 자기 agent ID와 자신에게 배정된 역할의 후보 사슬만 가진다. 개발자 profile과 reviewer profile은 같은 파일이나 agent ADK에 함께 저장하지 않는다. 후보 참조는 해당 agent의 `profiles`에만 정의해 끊긴 참조와 교차 agent 참조를 막는다.

    {
      "schema_version": 1,
      "agent_id": "<this-agent-adk-id>",
      "role_profile": {
        "role": "<assigned-role>",
        "layer": 2,
        "persona_ref": "persona/<assigned-role>.md",
        "selection": "uniform_random",
        "candidates": ["<local-profile-a>", "<local-profile-b>"],
        "recovery": {
          "accept_any_of": ["provider_available_signal", "successful_probe"],
          "probe_trigger": "next_admission",
          "wall_clock_only": false
        }
      },
      "profiles": {
        "<local-profile-a>": {
          "adapter_ref": "<registered-adapter>",
          "model_family": "<family-ref>",
          "account_ref": "<account-ref-a>",
          "credential_ref": "<secret-store-reference>",
          "quota_signal_ref": "<provider-signal-ref>",
          "tool_policy_ref": "<agent-tool-policy-ref>"
        },
        "<local-profile-b>": {
          "adapter_ref": "<registered-adapter>",
          "model_family": "<family-ref>",
          "account_ref": "<account-ref-b>",
          "credential_ref": "<secret-store-reference>",
          "quota_signal_ref": "<provider-signal-ref>",
          "tool_policy_ref": "<agent-tool-policy-ref>"
        }
      }
    }

2층 agent 파일은 위처럼 `uniform_random`과 고유 local profile 참조를 둔다. 3층 agent 파일은 `layer: 3`, `selection: "priority"`, `candidates: [{"profile_ref": "<local-profile-a>", "priority": 1}, ...]`를 두고 같은 `accept_any_of` 복구 정책을 적용한다. 각 role은 `persona_ref`로 자기 agent ADK의 persona 문서를 가리키며 launcher는 인라인 system prompt를 선택 로직에 쓰지 않는다. 각 profile은 `adapter_ref`, 모델 계열·계정·한도 신호 참조와 `tool_policy_ref`를 가진다.

별도 group ADK 설정은 agent 역할 배정과 공통 gate만 가진다.

    {
      "role_agents": {
        "orchestrator": { "agent_id": "<orchestrator-agent-id>", "layer": 3 },
        "developer": { "agent_id": "<developer-agent-id>", "layer": 2 },
        "reviewer": { "agent_id": "<reviewer-agent-id>", "layer": 2 }
      },
      "review_gate": {
        "require_distinct_agent_id": true,
        "require_distinct_model_family": true
      },
      "dispatch_limits": {
        "max_active_by_model_family": "<instance-limit>",
        "max_active_by_account_ref": "<instance-limit>",
        "fair_share": "ceil(N/K)"
      }
    }

Group gate는 개발 agent ID와 reviewer agent ID가 다르고, 실제 선택 기록의 모델 계열도 다름을 검증한다. 한 agent ADK의 로컬 후보 맵은 다른 agent ADK의 profile 참조를 가질 수 없다. 도구 정책 정본은 각 agent ADK의 `policies/tools/<policy-id>.json`이며 등록된 `tool_ref`와 `tool_chain_ref`의 허용 목록만 둔다. 실행 가능한 도구/adapter 구현은 Naia 업스트림 registry가 제공하고, 실제 인스턴스 연결은 agent ADK가 참조한다. `agent-roles.json`의 `tool`, `tool_chain` 값은 이 참조 정책으로 이전한다. `restart_cmd`는 실행 문자열로 옮기지 않고 ADK executor가 제공하는 안전한 restart 동작 참조로 바꾼다. 프로파일에 실행 대본 문자열이나 비밀값을 넣지 않는다. CLI 인자·환경 변수는 ADK 실행기가 검증한 profile resolution 뒤에 설정을 덮어쓸 수 없도록 정규화·거부한다.

모든 managed 진입점(worker-runner, 역할 세션 launcher, supervisor)의 승인 증거는 group executor가 대상별 audience를 지정해 발급한 일회용 launch ticket이다. 각 target audience의 책임은 다음과 같다: worker-runner는 worker child, 역할 세션 launcher는 Claude Code 역할 칸, supervisor는 감시용 실행 칸을 시작한다. executor는 티켓 issuer이며 group ADK의 gate·원장을 사용한다. ticket은 공개키 검증이 가능한 Ed25519 서명을 사용하고 canonical serialization의 정확한 bytes에 서명한다. 서명 개인키는 Naia executor의 보호된 key store에만 두고 group ADK 정책·agent ADK·argv·환경 변수·로그에 복사하지 않는다. 각 진입점은 신뢰 설정에 고정한 검증 공개키를 사용한다. payload는 `audience`, `admission_id`, `work_id`, `role`, `stage`, `agent_id`, `profile_ref`, `profile_digest`, `tool_policy_digest`, `document_bundle_digest`, `review_evidence_digest`, `scope_lock_digest`, `nonce`만 가진다. `document_bundle_digest`는 업무 카드·RQ·PL·시험 계획과 PC·SP·UC·FE 각각의 원문 또는 승인 전 N/A 제안 disposition manifest를 정규화한 입력 묶음만 해시한다. 독립 적대 검수 evidence는 이 입력 digest를 참조해 별도 해시하고, 사람 승인 범위 잠금은 입력 digest와 검수 evidence digest를 명시적으로 승인해 별도 해시한다. 따라서 입력 묶음에는 검수·잠금 기록이 포함되지 않고 잠금 digest를 다시 입력에 넣는 순환 참조가 없다. manifest는 경로·문서 ID·digest를 고정하며 각 disposition 결정은 사람 범위 잠금에서 승인되어야 한다. 자격증명, 실제 모델·도구 이름, 전체 프롬프트는 ticket에 넣지 않는다. executor는 ticket을 명령 인자 대신 보호된 stdin/IPC로 대상 진입점에 전달한다. 각 대상은 서명, 자기 audience, 현재 입력 묶음·검수 evidence·잠금·profile·tool-policy digest, 요청 필드, group 원장의 active admission 및 stage를 대조한다. group 원장은 최신 manifest·검수·scope lock을 다시 읽고 scope lock이 정확한 입력 및 검수 digest를 승인했는지 확인한 뒤 비교와 nonce 소비 및 launch lease 생성을 한 원자적 transaction으로 수행한다. 이 redemption commit이 admission 선형화 지점이며 성공 전에는 Claude CLI·worker child·supervisor pane을 만들지 않는다. ticket 발급 후 문서·disposition·검수·lock·stage·admission이 바뀌거나 취소되면 거부한다. 동시 nonce redemption에서는 원자적 claim의 승자 하나만 lease와 자식 프로세스를 얻고 나머지는 모두 거부된다. 발급키·검증키나 group 원장을 사용할 수 없으면 fail-closed 한다.

그룹 ADK에는 문서 잠금 검증 정책, agent ADK 참조, 중복 방지 원장, 활성 lease와 전역 용량·분배 설정을 둔다. 공통 executor·hook 코드는 Naia 업스트림이 제공하고 그룹은 정책/configuration과 상태 저장소를 소유한다. 그룹의 실행 상태는 agent_id와 역할별로 분리하지만 모델 후보 설정을 복제하지 않는다. 상태 기록에는 선택 참조, 신호 출처, 관측 시각, 작업 ID와 결과를 남긴다. expires_at이나 “n분 뒤 복귀” 값으로 복구 여부를 계산하지 않는다.

## 4. 프로파일 읽기와 실행 흐름

1. 역할 세션 launcher 또는 구현 일꾼은 작업 카드 ID, 단계, agent ID와 역할을 Naia 공통 ADK executor에 전달한다. executor는 외부 세션/worker를 만들기 전 agent profile을 해석하고, profile의 `tool_policy_ref`만으로 tool set을 정한다. 호출자는 모델·도구 이름이나 직접 CLI override를 줄 수 없다.
2. 업스트림 executor는 그룹 ADK의 문서·검수·사람 승인 범위 잠금 gate, agent ADK 참조, 중복 실행 여부와 전역 계정·모델 계열 용량 정책을 읽는다. group ADK는 gate 설정과 상태를 소유하고, executor 구현은 업스트림이 소유한다.
3. 그룹 관문은 요청된 agent_id의 kind: agent ADK를 찾아 프로파일 스키마, 그룹 소속과 허용 역할을 검증한다.
4. 프로파일 선택기는 3층에서 우선순위 목록을, 2층에서 동일 확률 후보 집합을 사용한다. 차단 상태, 용량 초과, 개발·리뷰어 독립성 위반 후보는 집합에서 제외한다.
5. Naia 공통 실행기는 프로파일 참조를 등록된 실행 어댑터에 넘긴다. 현재 spawn-worker.mjs의 디스크 입장·worker 등록·로그 관리 기능은 유지하되, 모델 실행에 임의의 `-- <command>`를 받지 않고 executor가 발급한 profile-bound launch ticket만 받는다. worker-runner, 역할 세션 launcher, supervisor는 각자 audience를 확인하고 서명·active admission/stage·작업/agent/profile/tool-policy/document-bundle/review-evidence/scope-lock digest와 요청 일치를 group 원장에서 원자적으로 비교·claim한 뒤 실행한다. 원장은 ticket 직전의 최신 입력 묶음·검수 evidence와 scope lock의 결속 상태를 확인한다. 이는 ticket 발급과 child 생성 사이의 stale document/review/lock/stage/admission race를 막는 선형화 지점이다. 동시 nonce redemption은 정확히 한 claim만 성공한다. 재사용 nonce, 변조, stale digest, 취소 admission, 잘못된 audience는 CLI/worker child 전에 거부한다. supervisor도 별도 audience의 ticket을 사용하며 같은 일회성 원자 claim을 거친다. 모든 역할 세션 시작도 이 검증 경로를 사용한다.
6. 시작·종료·한도 감지·복구 확인·대기 전환은 작업 ID와 선택된 profile reference로 기록한다. 원시 토큰, 계정 자격증명, 전체 프롬프트는 상태·로그에 쓰지 않는다.

## 5. 한도 감지와 복귀 확인

1. 실행 어댑터가 응답 상태와 제공자 한도 신호를 정규화한다. 한도 소진은 제공자의 구조화된 사용량 상태 또는 명확한 한도 오류 근거가 있을 때만 확정한다. 일반 네트워크 오류·인증 실패·불명확한 제한은 한도 복구 신호로 재해석하지 않는다.
2. 한도 소진이 확정되면 해당 profile_ref를 사용 불가로 표시하고, 3층은 다음 순위로 이동한다. 2층은 같은 후보를 다시 뽑지 않고 나머지 적격 후보에서 균등하게 고른다.
3. 상태 전이 표현은 `accept_any_of: [provider_available_signal, successful_probe]`다. 둘 다 가능한 adapter도 둘 중 하나가 성공하면 복구로 인정한다. 둘 중 하나만 지원하는 adapter를 AND 조건으로 영구 차단하지 않는다.
4. 복구 감지는 두 event-driven 경로를 쓴다. 제공자 webhook/event가 있으면 수신 즉시 상태 원장을 갱신한다. 이벤트가 없는 adapter는 다음 작업 admission 때 상위 우선순위 후보의 usage/status API를 조회하고, 그런 API가 없을 때만 범위 잠금에서 안전성과 비용이 승인된 성공 probe를 시도한다. 새로운 작업이 없으면 probe를 돌리지 않으며, 이 경우 자동 복귀는 다음 admission까지 대기한다.
5. 벽시계 경과, 주기 타이머, 정해진 시각 도래, Retry-After 경과만으로 사용 가능 상태를 바꾸지 않는다. usage/status API나 안전한 probe가 정해지지 않은 adapter는 복귀를 fail-closed 한다. 비용이나 부작용이 있는 probe는 사람의 범위 잠금 전까지 허용하지 않는다.
6. 우선순위가 높은 프로파일이 복구된 뒤 현재 작업이 이미 실행 중이면 해당 작업의 안전한 인계 지점까지 진행하고, 다음 작업 또는 체크포인트 이후에 높은 우선순위로 돌아온다. 강제 종료·작업 유실을 복귀 조건으로 사용하지 않는다.

## 6. Claude Code 훅과 모든 실행 경로 차단

구현 시 Naia 업스트림의 `.claude/settings.json` `hooks.PreToolUse`에 `.claude/hooks/profile-execution-guard.js`를 등록한다. 현재 설정에 있는 `Bash|shell_command|Edit|Write|NotebookEdit|apply_patch` 및 `Task|Agent` matcher 그룹을 보존하고 검사 훅을 추가한다. 각 command hook에 `onFailure: "block"`을 지정한다. 공식 문서는 이 필드가 Claude Code v2.1.295 이상에서 지원된다고 명시한다. [Claude Code hooks reference](https://code.claude.com/docs/en/hooks#block-the-action-when-a-hook-fails). 관리 배포 설정은 검증된 정확한 Claude Code binary version/build allowlist를 고정한다. role-session launcher는 실행할 동일 binary의 version/build와 필수 PreToolUse matcher·hook command·effective `onFailure` 값을 사전 점검하고, v2.1.295 미만·allowlist 밖 버전/build·버전 판독 실패·effective 설정 누락이면 CLI를 실행하지 않는다. 기준 이상이라는 이유만으로 미검증 build를 허용하지 않는다. 기존 배열에 추가할 설정 조각은 다음과 같다.

    {
      "hooks": {
        "PreToolUse": [
          {
            "matcher": "Bash|shell_command|Edit|Write|NotebookEdit|apply_patch",
            "hooks": [{
              "type": "command",
              "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/profile-execution-guard.js\"",
              "timeout": 10,
              "onFailure": "block"
            }]
          },
          {
            "matcher": "Task|Agent",
            "hooks": [{
              "type": "command",
              "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/profile-execution-guard.js\"",
              "timeout": 10,
              "onFailure": "block"
            }]
          }
        ]
      }
    }

현재 저장소의 matcher와 Claude hook 입력 필드를 구현 시작 시 공식 계약과 대조한다. hook command의 `onFailure: "block"`은 v2.1.295 이상에서 nonzero exit, 오류 및 timeout에 대해 tool call 자체를 실패 처리한다. guard는 차단 시 exit code 2 또는 exit 0과 계약상 유효한 명시적 deny를 반환한다. 예시 두 그룹은 설정 병합을 설명하며 현재 파일을 수정한 것이 아니다. 실행기 연결은 업스트림 소유의 새 공통 파일 `scripts/agent-profile-executor.mjs`가 작업 ID·agent ID·역할·입력 묶음 manifest digest를 검증하고 검수 evidence digest와 그 두 digest를 승인한 잠금 digest까지 확인한 뒤 모든 launch 진입점에 audience별 profile-bound ticket을 전달하는 형태다. 역할 세션 launcher, worker-runner와 supervisor는 ticket을 검증한 뒤 최신 입력 묶음·검수·잠금 및 active admission/stage를 원자적으로 대조해 한 번만 nonce를 소비한다. 서명 개인키는 executor key store, 검증 공개키는 각 진입점 신뢰 설정에 두며 ticket을 argv·환경 변수로 전달하지 않는다. 검증기나 replay 원장을 사용할 수 없으면 차단한다. 새 실행기 파일은 계획 이름이며 현재 저장소에 구현되어 있지 않다.

훅은 셸 명령에 직접 나타난 모델/도구 실행, 모델·도구 CLI override, 허용되지 않은 세션·worker 시작을 거부한다. Claude의 `Task|Agent` native spawn은 프로파일 여부와 무관하게 모두 deny한다. PreToolUse는 spawn을 다른 실행기로 바꾸지 않으므로 ADK executor가 만든 별도 launch만 허용한다. Edit/Write 등의 입력에서는 launch script·설정의 하드코딩 실행 문자열을 거부한다. 대본을 호출하는 셸 명령은 실행 파일 경로와 profile-bound ticket을 확인한다. 대본 내용이나 실제 하위 실행을 증명할 수 없으면 차단한다. 훅 등록 확인·실행 오류·시간 초과도 차단이다.

managed role-session launcher는 Claude CLI를 시작하기 전에 해당 agent ADK profile, group gate, 필수 PreToolUse 등록과 문서 digest를 검증하고 audience-bound ticket을 소비한다. `role-start.sh`, `tier3-switch.sh`, `tier3-back.sh`, worker-runner와 supervisor는 모두 같은 executor만 호출한다. executor는 profile_ref, 작업 ID, 문서 digest가 없으면 ticket을 발급하지 않는다. Claude 훅은 Claude Code 도구 경계를 막고 executor ticket 검증은 ADK 관리 시작 경로의 최종 gate다. 이들은 ADK 밖 임의 셸에서 provider CLI를 직접 실행하는 것까지 막지 못한다. OS 권한·실행 경로 제한을 이 작업 범위에 포함할지는 사람 범위 잠금의 열린 결정이다.

## 7. 중복 작업과 쏠림 방지

- 실행 키는 작업 ID·역할·단계로 만든다. 같은 키가 실행 중이면 기존 작업 ID를 반환한다. 결과가 끝난 키를 새 프로세스로 다시 실행하려면 retry_of, 새 회차 번호, 사유와 승인된 작업 문서 digest가 필요하다.
- 2층 후보 목록은 동일한 profile/model-family/account 조합의 중복을 제거한 뒤 같은 선택 확률을 부여한다.
- 그룹 원장은 모든 agent ADK에 걸친 동시 실행 한도와 분배 묶음의 후보별 할당을 profile·model-family·account-ref 각 축으로 관리한다. 각 축의 허용량은 인스턴스에서 결정하며 누락 시 시작을 거부한다.
- 분배 묶음에 서로 다른 작업 N개와 해당 축의 적격 고유 용량 단위 K개가 있으면, 각 단위의 배정 수는 `ceil(N/K)` 이하로 제한한다. 예를 들어 23개 독립 작업과 축별 3개 적격 단위라면 최대 8/8/7개다. 모델 계열·계정 참조가 둘뿐인 축은 각 단위 최대 12개다. 한 후보가 소진되면 미실행 작업과 남은 후보로 상한을 다시 계산한다. 용량이 없으면 실행을 대기한다.
- 실행 lease를 만들 때 작업 ID, batch ID, agent ID, profile 참조, 모델 계열 참조, 계정 참조, reviewer 분리 상태를 원자적으로 검사한다. 두 실행이 동시에 검사해 같은 한도 자리를 얻지 못하도록 그룹 원장에서 원자적 claim을 수행한다.

## 8. 기존 role-kit 파일 이전

| 기존 파일 | 새 위치·책임 | 제거하거나 바꿀 내용 |
| --- | --- | --- |
| tier-profile.md | 공통 선택·층 규칙은 업스트림/그룹 ADK 규칙. 후보와 역할별 바인딩은 해당 kind: agent 프로파일 | 모델 이름·도구 명령을 실행 지시문에서 읽는 방식을 없애고 후보 참조로 분리 |
| tier-active.json | 그룹 실행기의 agent_id·역할별 런타임 상태 원장 | until 기반 시간 덮어쓰기 제거. provider 사건과 복구 증거로만 상태 변경 |
| role-start.sh | agent ADK 참조를 주는 얇은 역할 세션 실행기 호출 | 모델·도구·대체 순서·프롬프트 규칙을 직접 선택하지 않음 |
| tier3-switch.sh | 공통 실행기의 사건 기반 안전 인계 | PID·pane·날짜 대본·고정 실행 명령 제거 |
| tier3-back.sh | 공통 실행기의 복구 확인과 다음 안전 경계 복귀 | 시각 만료, pane·PID·모델 명령 고정 제거 |
| agent-roles.json | 그룹 ADK의 agent/workspace/session 참조. 프로파일 원문은 각 agent ADK에 위치 | tool, tool_chain, restart_cmd처럼 모델·도구를 선택하는 리터럴을 제거하고 agent ID·workspace 참조로 교체 |
| 각 *-kit의 역할 문서·시작 설정 | 역할 정체성·기억은 agent ADK의 index.md, persona/, memory/; 실행·분배 정책은 그룹 ADK | 그룹의 역할 사본과 agent ADK 사이에 모델 프로파일 정본을 두 벌 만들지 않음 |

이전 전에 모든 역할 kit의 파일 목록을 비공개 인스턴스 문서에서 조사해 소유 단위, 값 종류, 연결되는 agent ID를 표로 고정한다. 이 공개 계획은 요청에서 지정한 파일 종류만 일반적으로 매핑하며 개인·인스턴스 경로를 복사하지 않는다. 현재 요청에 명시되지 않은 역할 파일이나 미확인 프로파일은 임의로 삭제·재작성하지 않고 범위 결정으로 올린다. 기존 데이터는 대조 완료 전까지 역사 원본으로 보존한다.

## 9. 하드코딩 금지 검사와 구현 단계 관문

실행 코드의 profile loader, 선택기와 실행 어댑터만 프로파일 값에 접근한다. 시작 대본·셸 명령·작업 프롬프트·공통 역할 문서·모델별 분기문은 특정 모델·도구·계정 문자열을 선택 기준으로 갖지 않는다. 도구 선택은 agent ADK `tool_policy_ref`와 그 정책의 등록된 tool/tool-chain 참조를 거친다. 모든 managed entrypoint는 Claude 설정 우선순위의 `cli_args`를 포함해 호출 인자·환경 override를 검사하고 profile보다 우선하는 provider/model/tool 선택을 거부한다. 하드코딩 점검은 원시 grep 결과만 내지 않고, 발견 항목을 설정 참조인지 실행 리터럴인지 분류해 차단 시험으로 연결한다.

이 요구의 구현은 .claude/settings.json, .claude/hooks/, worker runner, role session launcher와 매니페스트·프로파일 스키마를 포함한다. 훅·정책 파일 수정에 필요한 session contract를 구현 전에 만들고 묶는다. 현재 문서 단계에서는 해당 파일을 수정하지 않는다.

## 10. 열린 기술·제품 결정

1. 사용량·한도 상태를 제공하는 adapter별 권위 있는 이벤트/API와 인증 방식을 조사해야 한다. 이벤트가 없을 때 다음 admission에서 호출할 상태 API 또는 성공 probe가 무엇인지 정해야 한다. 신호가 없고 probe가 사용량·비용·부작용을 만들면 허용하지 않고 복귀를 보류할지 사람이 결정한다.
2. 각 인스턴스의 계정·모델 동시 용량값은 사업자 제한과 서버 용량을 대조한 뒤 정한다. 값이 확정되기 전에는 안전한 기본값을 지어내지 않고 누락된 제한으로 시작을 막는다.
3. 각 역할 kind: agent ADK의 저장 위치·그룹 연결·작업 공간 소유자를 확정하고 *-kit 전체 대조표를 작성해야 한다. 현재 agent ADK가 없다는 사실을 변경 완료로 취급하지 않는다.
4. 동일한 profile reference가 서로 다른 agent ADK에 나타날 때 그룹 전역 용량을 공유할 방법과 계정 참조 네임스페이스를 정한다.
5. 문서 reviewer와 구현 reviewer의 서로 다른 agent_id 및 모델 계열 확인에 사용할 독립 실행 증거 형식을 정한다.
6. 상위 개발 파이프라인 정본의 PC·SP·UC·FE 원문과 digest를 연결하거나, 이번 범위에 적용되지 않는 항목마다 근거·owner·재검토 조건이 있는 승인 N/A disposition을 잠금에 기록한다. 이 문서 단계는 해당 네 문서를 새로 만들도록 요청받지 않았으므로 그 결정을 대신하지 않는다.
7. ADK 밖에서 실행되는 직접 provider CLI도 막으려면 OS 수준 실행 권한/경로 제한을 이 작업에 포함할지 결정한다. PreToolUse와 ADK executor의 보호 범위만으로는 이 경로를 통제하지 못한다.
8. 최신 사용자 요구가 P-13 §8의 조정자 폴백 제외 정책을 이 범위에서 재정의하는지 승인하고, 정본 갱신 owner를 지정한다.
9. executor 서명 개인키의 key-store owner·회전·공개키 배포를 범위 잠금에서 정한다. 이 항목은 ticket의 검증·일회성 계약을 바꾸지 않고 운영 소유권을 정한다.
10. Claude Code 검증 version/build allowlist의 정확한 pin, 업그레이드 owner, 배포 위치, effective settings 검증 방법을 정한다. allowlist 밖 build, v2.1.295 미만 또는 설정 검증 실패는 모든 managed 역할 세션 시작을 차단한다.

## 구현 순서

1. 사람 결정과 범위 잠금에서 역할 ID, agent ADK 위치, provider 신호, 실행 한도와 문서 gate 계약을 고정한다.
2. 공통 profile schema, agent skeleton 예시, manifest 검증을 추가한다.
3. event 기반 quota 상태기계·우선순위 선택·동등 무작위 선택·복구 확인을 분리 구현하고 단위 시험한다.
4. group dispatcher에 문서 digest gate, atomic claim, duplicate key와 글로벌 할당 한도를 추가한다.
5. 기존 worker-runner와 role session 실행을 profile reference 전용 경로로 바꾸고 직접 실행 경로를 차단한다.
6. Claude PreToolUse와 실행기 거부 시험을 추가한다.
7. 모든 RQ의 UT·IT 및 독립 코드 검수를 통과한 뒤 운영 반영을 별도 승인 요청한다.
