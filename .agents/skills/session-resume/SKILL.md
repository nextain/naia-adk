---
name: session-resume
description: Claude Code / Codex / opencode 세션 기록을 열어 대화 흐름을 추출·요약한다. 다른 도구(또는 주간 한도 컷)에서 끊긴 작업을 현재 세션에서 이어하거나, 과거 세션이 무엇을 했는지 파악할 때 사용. "claude --resume <id>", "codex 세션 이어서", "opencode 세션 열어줘", "이전 세션 이어서", "저번 세션 뭐했지", "세션 기록 봐줘" 요청 시 사용.
argument-hint: "[session-id | 경로] [--tool claude|codex|opencode] [--cwd 경로] [--list]"
---

# 세션 재개 (Session Resume)

## 목적

다른 AI 코딩 도구(Claude Code / Codex / opencode)에서 진행하던 세션을 현재 세션에서
열어보고 이어한다. 특히 **주간 사용 한도로 중간에 끊긴 세션**을 복구하거나, 어떤 도구에서
무슨 작업을 했는지 빠르게 파악할 때 쓴다.

## 지원 도구 / 세션 저장소

| 도구 | 저장소 | 식별자 |
|------|--------|--------|
| **Claude Code** | `~/.claude/projects/<인코딩된-cwd>/<uuid>.jsonl` | uuid (예: `25f5abcc-...`) |
| **Codex** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `rollout-...` 파일명 또는 uuid |
| **opencode** | `opencode export` (SQLite `~/.local/share/opencode/opencode.db`) | `ses_...` |

인코딩된-cwd 규칙: `D:\alpha-adk` → `D--alpha-adk` (`:`와 `\` 각각 `-`).

## 핵심 스크립트

`parse-session.js` 가 세 포맷을 공통 digest로 정규화한다.

```bash
# 최근 세션 목록 보기 (세 도구 통합, 최신순)
node .agents/skills/session-resume/parse-session.js --list

# 특정 세션 열기 (도구 자동 감지)
node .agents/skills/session-resume/parse-session.js <id|경로>

# 도구 명시 / cwd 제한
node .agents/skills/session-resume/parse-session.js <id> --tool claude --cwd "D:\alpha-adk"

# 마지막 N턴만 (큰 세션 요약용)
node .agents/skills/session-resume/parse-session.js <id> --last 60
```

**출력**: stdout은 ASCII 안전(경로/카운트/도구/interrupt 종류만). 본문(한국어 포함)은
UTF-8 digest 파일로 나가며, `digest=<경로>` 라인에서 위치를 읽는다.

## 워크플로우

### Step 1: 세션 식별

- 사용자가 id/uuid/`ses_`/`rollout`/경로를 줬으면 그대로 Step 2.
- id 없이 "이전 세션"만 말하면 `--list` 로 최근 목록을 보여주고 가장 최근 또는 제목이
  맞는 것을 고른다. (사용자에게 목록을 보여 선택하게 하거나, 맥락상 명확하면 최근 것.)

### Step 2: 파싱

`parse-session.js` 실행 후 stdout의 `digest=<경로>` 라인에서 digest 파일 경로를 얻는다.

### Step 3: digest 읽기

Read 도구로 digest 파일을 읽는다. 핵심 섹션:
- **interrupt** — `QUOTA`(한도 컷) / `EXITED`(정상 종료) / `COMPACTED` / `MID-ACTION` / `NORMAL`
- **Conversation flow** — USER / AI / TOOL 턴 시퀀스 (요약됨)
- **Last user intent** — 마지막 사용자 요청 3개
- **Suggested next step** — 중단 지점 기반 재개 제안

### Step 4: 사용자에게 요약 + 이어할지 확인

2~4문장으로: 무슨 작업이 진행됐고, 어디서/왜 끊겼고(한도/에러/정상), 다음 단계가 뭔지.
그리고 "이 세션을 여기서 이어서 진행할까요?" 로 확인.

**주의**: 세션 기록은 "읽기 전용 참고자료"다. 실제 진실 SoT는 각 프로젝트의 코드·컨텍스트.
digest가 "코드를 변경했다"고 해도 워킹트리를 직접 확인하고 믿을 만한 사실만 이어받는다
(AI 자가-선언 금지 원칙).

### Step 5: 이어서 작업

사용자가 승인하면, digest의 "Last user intent" + 현재 워킹트리 상태를 결합해 다음 액션을
실행한다. (다른 도구의 세션이므로, 현재 도구의 컨텍스트 규칙을 따른다.)

## 인터럽트 종류 해석

| interrupt | 의미 | 재개 방침 |
|-----------|------|-----------|
| `QUOTA` | 주간/사용 한도로 컷 | 마지막 사용자 요청부터 재개 |
| `MID-ACTION` | 도구 호출 도중 중단 | 진행 중이던 변경이 완료됐는지 먼저 확인 |
| `MAYBE-ERROR` | 마지막 AI 응답이 에러/불능 | 원인 파악 후 재시도 |
| `COMPACTED` | 컨텍스트 압축 발생 | 요약 기준 재정립 |
| `EXITED` | 사용자 `/exit` 정상 종료 | 새 요청인지 이어하기인지 확인 |
| `NORMAL` | 정상 턴 종료 | 일반적 이어하기 |

## Key Files

| 파일 | 용도 |
|------|------|
| `parse-session.js` | 세 포맷 통합 파서 (node, 외부 의존성 무) |

## 참고

- node(node 18+) 필요. opencode 세션 읽기엔 `opencode` CLI가 PATH에 있어야 한다
  (스크립트가 npm 글로벌 위치를 자동 탐지).
- opencode는 세션을 SQLite에 저장하므로 JSONL이 아니지만 `opencode export` 로 JSON을 얻어
  동일 digest로 정규화한다.
- Codex의 `developer` 역할(permissions/skills 지시문)은 노이즈라 자동 필터링한다.
- Claude의 `<command-name>`, `<task-notification>`, `<local-command-*>` 도 user-role 이지만
  노이즈라 필터링한다(실제 사용자 입력만 USER 턴으로).
