---
name: manage-discord-sessions
description: Manage long-idle Discord AI conversations without keeping a Codex model session alive. Use when designing, operating, or testing Discord-to-Codex session history, prompt-cache cost controls, idle rotation, compaction, or resume behavior.
---

# Discord 세션 관리

Discord Gateway 대기와 모델 실행을 분리한다. 프롬프트 캐시를 유지하려고
모델 heartbeat를 보내지 않는다.

## 정책

1. 대기 중에는 경량 Discord Gateway만 연결한다.
2. 한 턴이 끝나면 Codex 프로세스 또는 app-server 연결을 종료한다.
3. 유휴시간 제한 안에서만 상한이 있는 임시 대화 기록을 재사용한다.
4. 제한 시각 이상이면 새 메시지를 전달하기 전에 임시 기록을 비운다.
5. 장기 작업 상태는 프로젝트 파일, Git 상태, 승인된 메모리 또는 명시적
   체크포인트로 보존한다. 살아 있는 터미널 프로세스는 체크포인트가 아니다.
6. 운영 기본 유휴시간은 별도 측정 근거가 없다면 30분으로 둔다.

## 구현 경계

- 공통 정책·스키마·운영 절차는 `naia-adk`에 둔다.
- Discord 수신·시계·기록 저장·회전 실행은 runtime agent에 둔다.
- 설정과 관측 화면은 client shell에 둔다.
- 봇 자격증명과 사용자 메시지 원문은 추적 파일과 진단 로그에 남기지 않는다.

## 검증

실제로 기다리지 말고 짧은 제한시간과 가짜 시계를 주입한다.

1. 제한시간 전 두 번째 메시지는 이전의 상한 있는 기록을 받는다.
2. 제한시간과 같거나 지난 메시지는 새 사용자 메시지만 받는다.
3. 다른 채널이나 사용자는 독립적인 기록과 시각을 유지한다.

대기 중 provider 호출이 없고, 회전 로그에는 사유와 이전 메시지 수 같은
제한된 메타데이터만 있는지도 확인한다.
