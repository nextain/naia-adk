# Discord 엔진 껍질 — nextain/naia-adk#53

조율: nextain/naia-comm#13. 패키지 계약: nextain/naia-messaging#3.

라이브 지정 기기 전환은 이 브랜치에서 하지 않는다. lock 파일이 없으면 기존 git 스킬 트리를 그대로 쓴다.

## 기능요소 (FE)

| ID | 요구 |
|---|---|
| FE-MSG-1 | `engine-lock`은 `nextain/naia-messaging` + 40자 revision + 64자 snapshotSha256만 허용한다. |
| FE-MSG-2 | digest 불일치는 스냅샷 목적지를 만들지 않고 throw 한다. 이전 런타임을 유지한다. |
| FE-MSG-3 | 핀이 맞으면 `engine/discord`를 managed runtime의 `helper/`로 복사한다. `service.mjs`와 `supervisor-entry.mjs`가 있어야 한다. |
| FE-MSG-4 | lock이 없으면 `createManagedRuntimeArtifact`는 기존 git 스킬 트리를 쓴다. |
| FE-MSG-5 | 인스턴스 설정·토큰·채널 ID는 이 저장소에 넣지 않는다. 예제 lock만 추적한다. |

## 유저시나리오 (UC)

| ID | 시나리오 |
|---|---|
| UC-MSG-1 | 운영자가 예제 lock을 복사해 `NAIA_MESSAGING_ROOT`를 가리키면, 다음 managed artifact는 패키지 엔진을 담는다. |
| UC-MSG-2 | lock digest가 틀리면 설치가 거부되고 지금 돌아가는 수신기는 그대로다. |
| UC-MSG-3 | lock이 없는 개인 fork는 이전과 같이 git 스킬 헬퍼로 게이트웨이를 만든다. |

## 유닛테스트 (UT)

`tests/messaging-engine.test.mjs` — lock 스키마, digest 거부, 소스 해석.

## 통합테스트 (ET)

같은 파일 — 스냅샷을 helper로 실체화, `createManagedRuntimeArtifact({ messagingEngine })`가 유닛 ExecStart를 helper/service.mjs에 고정.

기존 `test:discord-sessions` git 경로 회귀.

## 품질케이스 (QC)

| 초안 | 기대 |
|---|---|
| QC-MSG-A | lock 없이 `pnpm test:discord-sessions` 통과 |
| QC-MSG-B | 이 파일의 messaging-engine 테스트 통과 |
| QC-MSG-C | 라이브 알파 인스턴스는 이 브랜치를 설치·cutover 하지 않은 채 healthy |

## 계획의 다음 칸 (이 브랜치 밖)

1. 지정 기기에서 예제 lock을 실 lock으로 복사하고 후보 cutover.
2. 알파 채널 한 턴 영수증을 naia-comm#13에 남긴 뒤에만 라이브 전환을 완료로 본다.
