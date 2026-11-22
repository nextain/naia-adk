이 문서가 답하는 질문: 각 요구사항을 어떤 단위 시험(UT)·통합 시험(IT)으로 검증하고 무엇을 PASS로 볼 것인가?
상태: 문서 적대 검수용 초안; 시험 미실행
기준판: 공개 저장소 ed104d328ff7870908d326df840e4b98a1718a03

# 역할별 ADK 프로파일과 한도 대체 실행 — 시험 계획

## 시험 원칙

- 이 문서는 시험 계획이며 실행 결과가 아니다. 구현이 범위 잠금된 뒤 테스트를 추가·실행한다.
- UT는 가짜 제공자 응답, 고정 난수원, 임시 ADK 디렉터리와 가짜 프로세스를 쓴다.
- IT는 실제 ADK 실행기·agent profile loader·group gate·Claude 훅 등록 경로를 연결하되, 외부 서비스·운영 칸·실계정·비밀값을 사용하지 않는다.
- 공통 PASS는 해당 시험 명령의 종료 코드 0, 실패·누락·skip 0, 각 명시 assertion 통과다. 예상 차단을 성공으로 판정하는 부정 시험은 자식 프로세스가 시작되지 않고, 차단 이유와 작업 ID가 기록될 때만 PASS다.
- 모든 결과는 테스트한 후보 commit SHA, RQ ID, fixture digest와 종료 상태에 연결한다. 아직 실행하지 않은 시험을 통과로 쓰지 않는다.

## RQ별 UT·IT와 판정 기준

| RQ | 단위 시험(UT) | UT PASS | 통합 시험(IT) | IT PASS |
| --- | --- | --- | --- | --- |
| RQ-01 | 구조화된 한도 응답, 오류 분류, 3층 우선순위 이동, `any_of` 복구 전이, provider event와 다음 admission 경로, 시각만 바뀌는 입력 | 복구 증거 두 종류를 각각 단독 입력했을 때 복귀하고 둘 다 없으면 복귀하지 않는다. event가 없으면 다음 admission에서 status API 또는 승인된 probe가 조회된다. 타이머만으로 복구된 후보가 없다. | 가짜 adapter에서 우선 후보 소진→다음 후보 실행→provider event, event 없는 다음 admission의 status API 성공, 허용된 probe 성공을 각각 실행; 안전 경계 뒤 복귀와 전 후보 소진도 실행 | 기록에 한도 사건·복구 증거·조회 trigger가 남는다. `any_of`의 증거 하나만으로 복귀하고, 이벤트 없는 adapter는 다음 admission까지 대기하며 주기 호출은 없다. 전 후보 소진은 대기이며 성공 종료가 아니다. |
| RQ-02 | 네 kind와 agent profile 유효성; 3층 허용 작업·금지 작업; 3층 priority; 2층 3개 동등 후보에 RNG 입력 `(i+0.5)/300` 300개 주입; 0, 1/3 경계 양쪽, 2/3 경계 양쪽, `1-epsilon`; 중복 후보 제거 | 300개 입력은 후보별 100회씩 선택되고 경계 입력은 반열린 구간 기준대로 배정된다. 항상 첫 후보만 반환하는 selector는 실패한다. 네 kind를 유지하고 org 별칭을 새 kind로 만들지 않는다. | group agent reference를 독립 agent-skeleton 사본 profile에 연결하고 역할별 executor까지 전달 | agent ID의 profile만 읽는다. 역할·층 규칙 밖 요청은 child process 전에 차단된다. |
| RQ-03 | 독립 developer-agent profile과 reviewer-agent profile fixture; 같은 agent ID, 같은 모델 계열, reviewer 후보 없음, 분리 후보 조합 | group mapping의 developer/reviewer agent ID가 달라야 한다. 서로 다른 agent 파일을 사용하고, 같은 agent·모델 계열 조합은 거부된다. 독립 후보가 없으면 리뷰 완료 판정이 막힌다. | group mapping → 두 agent ADK → 각각의 local profile selection → 독립 review 실행을 연결 | 실제 실행 기록에서 agent ID와 모델 계열이 모두 다르고, 리뷰 결과가 없거나 developer 재사용이면 완료가 차단된다. 후보 목록의 교차 agent profile 참조는 schema validation에서 실패한다. |
| RQ-04 | PreToolUse Bash·파일 변경 입력의 직접 실행 파일·모델/도구 인자·`cli_args` override, inline system prompt의 고정 provider/model/tool 지시, `Task|Agent`, Claude binary version/build allowlist·effective hook 설정, worker-runner·role-session launcher·supervisor ticket signature/audience/document-bundle/review-evidence/profile/tool-policy digest/active admission/stage/nonce | v2.1.295 미만·allowlist 밖 version/build·버전 확인 실패·effective `onFailure: "block"` 등록 누락은 CLI 0개다. allowlist에 든 기준 이상 build만 통과한다. native `Task|Agent`는 ticket 유무와 무관하게 deny한다. hook deny는 exit 2 또는 exit 0 + 유효한 JSON deny다. hook 오류·timeout은 tool call을 막는다. invalid signature, 변조 claim, 다른 audience, stale document-bundle/review-evidence/lock/profile/tool-policy digest, 변경·취소된 admission/stage, 이미 소비된 nonce는 세 managed 진입점 각각에서 child process/pane 0개다. 동시 nonce redemption에서는 정확히 하나만 target child를 만들고 나머지는 0개다. | 실제 PreToolUse matcher와 hook 등록을 역할 세션 경로에 연결한다. group executor가 세 audience별 ticket을 발급하고 worker-runner·role-session launcher·supervisor가 각각 redeem하게 한다. 허용된 version/build, v2.1.295 미만, 버전 판독 불가 및 최소 버전 이상이나 allowlist 밖 build를 각각 실행한다. ticket 발급 뒤 입력 문서 묶음·검수 evidence·lock/stage/admission을 바꾸거나 admission을 취소해 redemption하는 사례, 세 audience 각각에서 ticket 1회 사용 후 재사용, payload 변조, signature 위조, 잘못된 audience, stale digest 및 동일 nonce 동시 claim을 실행한다. | allowlist된 기준 이상 build + 유효한 effective hook 설정만 CLI 전 단계 gate를 통과한다. hook deny는 실제 tool call을 막고, 누락·오류·timeout은 `onFailure`로 막힌다. 세 audience 모두 최신 입력 document-bundle/review-evidence/lock digest 및 active admission/stage와 원자적으로 일치할 때만 ticket redemption이 commit되고, 그 전 target child/pane은 0개다. 동시 동일 nonce claim이 N개면 launch lease와 target child는 정확히 1개이고 나머지 N-1개는 거부된다. stale/취소/재사용/위조/변조 ticket은 process 미생성으로 끝난다. ADK 밖 OS 직접 실행은 별도 범위다. |
| RQ-05 | 카드·RQ·PL·시험 계획 누락, 다른 work ID, broken link, stale document-bundle digest, 리뷰 FAIL, 사람 잠금 누락·오래됨; PC/SP/UC/FE 원문·digest 또는 N/A 제안 disposition 누락·변경 | 모든 결함 조합이 fail-closed다. 입력 manifest digest, 이를 대상으로 한 review evidence digest, 두 digest를 승인한 사람 잠금의 3단계 chain만 통과한다. review/lock이 입력 bundle에 포함되지 않아 순환 참조가 없고 “완료” 문자열만 있는 fixture는 실패한다. | 유효 입력 manifest부터 review evidence·scope lock·executor ticket redemption까지 연결한 뒤 각 문서·검수·잠금·PC/SP/UC/FE disposition을 하나씩 제거·변경해 요청 | 입력 문서 manifest, review evidence와 scope lock 각각의 digest가 독립 계산된다. scope lock은 정확한 입력 및 review digest를 승인하고 ticket은 각 digest를 별도 claim한다. 유효 fixture만 worker를 시작한다. ticket 발급 뒤 문서·disposition이 바뀌어 입력 digest가 stale한 요청, 재검수·재잠금 전 요청 및 disposition 누락은 child process 전에 거부된다. |
| RQ-06 | 중복 작업 키 동시·순차 요청, retry_of 유무·잘못된 회차, 중복 후보 참조, 모델·계정·프로파일별 active 및 batch cap | 활성 중복은 기존 실행 ID를 반환한다. 승인 없는 재시도는 거부된다. 23 작업/3 적격 단위 시험에서 profile·model-family·account-ref 각 축의 합계가 23이고 단위당 최대 8이다. 용량 8인 단일 단위에 23개를 넣으면 8개 시작·15개 대기다. | sanitized 23 worker fixture의 canonical work/role/phase 키 관계를 재생; 별도 23개 합성 작업을 3개 고유 profile·model-family·account-ref에 배분; 단일 적격 단위 cap-8도 실행 | 기존 fixture의 같은 키에는 child process가 1개 이하이고 중복 요청은 기존 ID를 받는다. 합성 fixture의 각 축은 정확히 8/8/7이다. 단일 단위 시험은 8개만 실행되고 15개 대기다. cap 초과나 모델/계정 집중 우회가 없다. |

## RQ-04 차단 입력 묶음

구현 시험 fixture는 hardcode-audit-20261118.md의 차단 사례를 원본 입력으로 사용하되 실제 실행기 이름과 모델명을 공개 결과에 노출하지 않고 민감한 텍스트를 로그에 남기지 않는다. 최소 변형은 직접 명령, 인자와 `cli_args`/환경 override, 모델·도구 선택을 고정한 inline system prompt, 여러 명령 연결, 따옴표·환경변수·별칭·명령 치환, 대본 호출, 역할 칸 시작 입력, native Task/Agent spawn, hook 설정 누락·오류·timeout, signature 위조·payload 변조·audience 불일치·stale digest·nonce 재사용이다.

대본 호출은 PreToolUse 입력에 대본 경로만 나타나는 경우를 별도 시험한다. 실행기를 우회하는 셸 대본을 검사할 수 없으면 허용하지 않는다. 각 managed entrypoint의 hook registration check와 executor gate 연결을 확인한다. 이는 문자열 정적 검색 결과만 PASS로 삼지 않기 위한 기준이다.

## RQ-05 문서 gate 입력 묶음

기준 fixture는 먼저 업무 카드·RQ·PL·시험 계획과 PC·SP·UC·FE 원문 또는 N/A 제안 disposition을 담은 입력 manifest를 만들고 그 canonical digest를 계산한다. review evidence는 그 입력 digest를 대상으로 한다. 사람 scope lock은 정확한 입력 digest, review evidence digest와 disposition 결정을 승인하고 별도 digest를 가진다. review와 lock은 입력 bundle에 넣지 않아 자기참조가 없음을 검증한다. executor ticket에는 입력·review·lock digest를 각각 별도 claim으로 넣는다. 각 단계에서 문서·disposition·review·lock 제거·이름 변경·내용 변경, 링크 단절, work ID 불일치, 오래된 digest를 따로 넣는다. 파일 존재만으로 worker spawn을 허용하지 않는다.

## RQ-06 실물 회귀 조건

두 지정 실물 자료 hardcode-audit-20261118.md 및 minho-workers-23-20261118.md에서 격리 회귀 fixture를 만든다. 하드코딩 사례는 직접·간접 실행으로 분류한다. 23 worker fixture는 canonical work/role/phase 중복 관계와 단일 모델·계정 집중을 보존하되 공개 로그에는 행 내용·이름·홈 경로를 출력하지 않는다. 별도 23개 합성 독립 작업은 세 profile·model-family·account-ref 단위마다 8/8/7로 분산한다. fixture digest·행 수·중복 수·차단 수와 축별 집계만 남긴다.

## 실행·판정 경계

- 테스트는 로컬 격리 디렉터리와 가짜 실행 어댑터만 사용한다. 실계정 호출, 운영 세션 재시작, 작업 칸 입력, 타이머 설정, 디스코드 전송을 하지 않는다.
- RQ-04와 RQ-05의 차단 시험은 프로세스 생성 전 차단 여부를 확인한다. RQ-04는 `onFailure: "block"`, exit 2 또는 명시적 deny, timeout·누락·오류 fail-closed 결과를 확인한다. 로그만 보고 차단을 추정하지 않는다.
- 실제 제공자의 복구 신호를 시험하지 못하면 해당 어댑터는 미검증으로 남고, 복구 자동화 수용을 주장하지 않는다.
- 각 RQ는 연결된 UT와 IT가 모두 PASS여야 통과다. UT만으로 end-to-end 실행 경로가 검증되었다고 선언하지 않는다.
