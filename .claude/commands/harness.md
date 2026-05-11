---
description: HARNESS 세션 바인딩/opt-out 명시적 제어
argument-hint: <status|off|on|bind|unbind> [args]
allowed-tools: Bash, Read, Edit, Write
---

# /harness — 세션 컨텍스트 명시 제어

`session-inject.js` 훅은 세션을 자동 바인딩하지 않습니다 (2026-04-26부터). 이 명령어로 명시적으로 켜고/끄고/바꿉니다.

## 현재 세션 ID 확인

직전 prompt에 inject된 컨텍스트의 `Session: <id>` 라인 또는 `UNBOUND` 안내 메시지의 "현재" ID를 사용. 컨텍스트에 없으면(첫 턴/HARNESS 끔) 사용자에게 물어봐 받기.

## 서브명령

### status

현재 바인딩 상태를 보고:

1. `<cwd>/.claude/no-harness` 존재 여부 → opt-out 상태
2. `<cwd>/.agents/progress/.session-map.json` 읽고 현재 세션 ID 항목 → P1 바인딩
3. `<cwd>/.agents/progress/*.json` 스캔 (서브모듈 1단계 포함, `.session-map.json` 제외) — `session_id` 필드 == 현재 세션 ID 인 것 → P0 바인딩
4. 활성 후보 (mtime 24h 이내, `current_phase != "close"`) 목록도 표시

출력 형식:
```
세션 ID: <id>
opt-out : (yes — .claude/no-harness 있음 / no)
P0 anchor: <file path | none>
P1 entry : <file path | none>
활성 후보: <list>
```

### off

`<cwd>/.claude/no-harness`를 생성 (`touch`). 다음 턴부터 hook은 조용히 종료해 HARNESS 컨텍스트를 inject하지 않음. 보고: "HARNESS off — no-harness 마커 생성됨".

### on

`<cwd>/.claude/no-harness`가 있으면 삭제, 없으면 안내만. 보고: "HARNESS on — 마커 제거됨" (또는 "이미 활성 상태").

### bind &lt;arg&gt;

인자 해석 후 해당 progress 파일의 `session_id` 필드에 현재 세션 ID를 기재 (P0 anchor):

- **숫자만 (`219`)**: progress 파일들의 `issue` 필드(또는 파일명)에서 매칭. 1개 → 사용. 0개/다중 → 후보 보고하고 사용자 선택 받기.
- **`.json` 포함 경로 (`.agents/progress/foo.json`)**: 그대로 파일로 사용. 존재 확인 후 진행.
- **이슈 URL 또는 `org/repo#123` 형식**: 마지막 `#` 또는 `/` 뒤 숫자 추출 후 위 숫자 케이스로 위임.

파일 편집은 `Edit` 사용. 기존에 `session_id` 키가 있으면 값만 교체, 없으면 키-값 라인 추가 (JSON 구조 유지). 보고: "bound: &lt;file&gt; ← session_id=&lt;id&gt;".

### unbind

현재 세션의 모든 바인딩 흔적 제거:

1. `<cwd>/.agents/progress/.session-map.json`에서 현재 세션 ID 항목 제거. 변경 시 atomic write (`Write`로 전체 덮어쓰기 OK — hook이 다음 턴에 stale prune 이미 함).
2. 모든 progress 파일 스캔, `session_id == <현재 세션 ID>`인 것의 해당 필드 라인 제거 (`Edit`).

보고: 어떤 파일/항목이 제거됐는지 한 줄씩.

## 안전 가이드라인

- 모든 파일 조작은 Edit/Write 사용 (sed/bash 직접 편집 금지)
- 사용자가 `bind`로 지정했으나 매칭되는 파일이 없으면 새 progress 파일을 만들지 말고 사용자에게 확인 요청
- 세션 ID를 모를 땐 추측하지 말고 사용자에게 직접 물어보기
- `unbind` 후 사용자가 다른 작업을 시작할 의도가 명확하지 않으면 새 작업 진행 전 한 번 더 확인
