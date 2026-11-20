---
id: role-profile-quota-failover-20261118
title: 역할별 ADK 프로파일과 한도 대체 실행 관문
owner: 2층 문서 작업
status: done
source: "2026-11-18 사용자 요청 원문; RQ는 docs/design/role-profile-quota-failover-rq-20261118.md"
received: 2026-11-18
due: null
next: 사람 범위 잠금과 미해결 범위 결정
moved: 2026-11-18
calendar: no
progress: "docs/design/role-profile-quota-failover-rq-20261118.md; docs/design/role-profile-quota-failover-pl-20261118.md; docs/design/role-profile-quota-failover-test-plan-20261118.md"
defer_reason: ""
revisit: ""
defer_count: 0
result: "RQ·PL·시험 계획 문서 적대 검수 완료; 사람 범위 잠금 대기. 외부 RESULT.md에 기록"
마일스톤:
기한:
---
이 문서가 답하는 질문: 역할별 프로파일 한도 대체 실행과 실행 차단 기능의 문서 단계 범위는 무엇인가?
상태: 문서 작성 완료, 사람 범위 잠금 전
기준판: 공개 저장소 ed104d328ff7870908d326df840e4b98a1718a03

# 역할별 ADK 프로파일과 한도 대체 실행 관문

## 목표

에이전트별 실행 프로파일을 Naia ADK 구조에 두고, 한도에 닿은 프로파일을 다른 후보로 바꾸며, 더 높은 우선순위 프로파일은 제공자 신호로 복구가 확인된 뒤 다시 사용한다. 일꾼과 역할 세션의 시작, 독립 검수, 문서 진입 조건도 ADK 실행 관문이 실제로 막는다.

이번 작업은 업무 카드, 요구사항(RQ), 구현 계획(PL), 요구별 시험 계획 문서까지다. 코드, 운영 세션, 서비스, 칸, 비밀 파일, 외부 게시, 커밋·푸시·PR은 건드리지 않는다.

## 요청의 경계

- 3층은 오케스트레이션, 일꾼의 진행·드리프트 감시, 결과 판정과 사용자 소통을 맡는다.
- 2층은 구현·시험과 별도 리뷰어의 독립 검수를 맡는다. 3층이 직접 구현하는 구조로 바꾸지 않는다.
- 3층 프로파일은 순서 있는 후보 사슬로 대체 실행하고, 2층 프로파일은 현재 사용 가능한 동등 후보를 균등 무작위로 고른다.
- 기한 경과 같은 시각 타이머만으로 한도 소진이나 복구를 판정하지 않는다.
- 프로파일 없는 실행, 필수 문서가 없는 구현 일꾼, 중복 작업과 모델·계정 쏠림을 실행 관문에서 차단한다.

## 정본 절차와 현재 단계

1. 업무 카드 작성 — 완료.
2. 기획 및 기술 조사 — 사용자 목표, Naia ADK 2.0 구조, 현재 작업자 실행기와 Claude Code 훅을 대조했다.
3. RQ·PL·시험 계획 작성 — 연결 문서 참조.
4. 문서 적대 검수 — 독립 검수 결과를 외부 작업 결과에 기록한다.
5. 사람의 범위 확인과 범위 잠금 — 미완료. 범위 잠금과 사람 승인 칸을 대신 채우지 않는다.
6. 구현 — 시작하지 않았다. 유효한 범위 잠금과 구현 이슈가 생긴 뒤에만 가능하다.

## 조사 기준

- 지정된 상위 개발 파이프라인의 `overview.md`와 `workflow.md`에 있는 업무 카드→기획→기술 조사→요구·시험 계획→문서 적대 검수→사람 범위 잠금 순서를 따른다.
- Naia ADK의 [`adk-2.0-structure.md`](../guides/adk-2.0-structure.md), [`agent-role-sessions.md`](../guides/agent-role-sessions.md), agent/group skeleton 및 P-13 2.0 구조 결정을 먼저 대조했다. 기존 user·agent·project·group kind를 유지하고, agent별 설정과 group 공통 정책을 분리한다.
- 제공된 미션·괴리 대조·하네스북은 작업 배경으로 대조했다. 정본 구조와 충돌하는 과거 실행 편의는 그대로 채택하지 않는다. 2026-11-18 최신 3층 폴백 요구와 P-13 §8 조정자 폴백 제외 조항의 충돌은 잠금 결정으로 남긴다.

## 할 일

| # | 할 일 | 담당 | 상태 |
| --- | --- | --- | --- |
| 1 | Naia ADK 2.0의 user·agent·project·group 경계와 현행 실행·훅 경로 조사 | 2층 문서 작업 | 완료 |
| 2 | 원문 인용을 포함한 RQ와 수용 기준 작성 | 2층 문서 작업 | 완료 |
| 3 | 프로파일 구성, 읽는 경로, 차단 경로와 기존 설정 이전 계획 작성 | 2층 문서 작업 | 완료 |
| 4 | RQ별 단위 시험(UT)·통합 시험(IT) 및 PASS 기준 작성 | 2층 문서 작업 | 완료 |
| 5 | 문서 적대 검수와 수정 반영 | 독립 검수자 | 완료 |
| 6 | 최신 문서 digest와 전체 범위에 대한 사람 승인·범위 잠금 | 사람 승인자 | 대기 |
| 7 | 잠금된 범위의 구현 이슈 연결 및 구현 | 후속 작업 | 잠금 전 차단 |

## 문서 연결

- [요구사항과 수용 기준](../design/role-profile-quota-failover-rq-20261118.md)
- [구현 계획](../design/role-profile-quota-failover-pl-20261118.md)
- [요구별 시험 계획](../design/role-profile-quota-failover-test-plan-20261118.md)

## 범위 잠금 질문

- PC·SP·UC·FE 각각의 원문 경로·digest를 연결할지, 어떤 항목을 어떤 근거와 재검토 조건으로 N/A 승인할지.
- 3층 조정 역할에 대한 신규 폴백 요구가 P-13 §8을 이 범위에서 재정의하는지, 정본 갱신 owner가 누구인지.
- 각 제공자에서 비용 없는 상태 조회 또는 성공 probe를 제공하는지, 없는 경우 자동 복귀를 어떤 상태로 둘지.
- 각 kind: agent ADK의 실제 위치·group 연결·역할 kit 전체 매핑과 model/account별 동시 용량값.
- ADK 밖 직접 provider CLI 실행도 이 작업에서 막을지. PreToolUse 및 ADK executor의 경계 밖이면 별도 제어 범위가 필요하다.
- 구현·문서 독립 리뷰 증거를 어떤 방식으로 남길지.
- Claude Code의 정확히 허용할 version/build pin, 배포·업그레이드 owner와 hook 설정 유효성 확인 방법.
- launch ticket 서명 키 owner·회전, 검증 공개키 배포와 문서 manifest digest를 원자적으로 확인할 group 원장 소유자.

## 완료 판정

문서 작업은 세 연결 문서가 준비되고, 독립 적대 검수의 지적을 반영한 뒤 완료로 본다. 문서 완료는 사람의 범위 승인, 범위 잠금, 구현 준비 또는 제품 수용을 뜻하지 않는다. 최종 잠금에서는 scope lock을 입력 bundle에 넣지 않는 manifest digest와 그 입력을 검수한 review evidence digest를 별도 승인한다. scope-lock digest는 ticket에 별도 결속하므로 순환 참조가 없다. PC·SP·UC·FE의 disposition 승인, P-13 차이 결정, 정확한 Claude Code build allowlist, 이 세 digest를 확인한 사람 승인 범위 잠금과 구현 이슈가 확인될 때까지 구현 일꾼 시작은 막힌 상태다.
