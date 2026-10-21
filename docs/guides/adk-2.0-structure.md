범위: 공통
상태: 1판(2026-10-21). Naia ADK 2.0 의 공통 부분, 인스턴스가 덮어쓰는 부분, 1~4층 역할 구조, naia-shell 이 받는 약속을 한 곳에 모은 문서

# Naia ADK 2.0 구조 한눈에 보기

Naia ADK 는 "AI 가 읽고 따르는 일하는 방식"을 저장소 하나에 담은 기준판입니다. 회사·팀·개인은 이 기준판을 받아 자기 인스턴스를 만들고, 기준판이 좋아지면 다시 받아 맞춥니다. 2.0 에서 달라진 점은 세 가지입니다.

1. 함께 일하는 단위를 **네 갈래**(사용자·그룹·에이전트·프로젝트)로 나누고, 매니페스트 `adk.json` 의 `kind` 로 구분합니다.
2. **공통**(이 저장소)과 **인스턴스 덮어쓰기**(각 회사·개인 저장소)의 경계를 정했습니다. 공통에는 사람·회사·기기·모델 이름을 두지 않고 역할만 둡니다.
3. AI 작업을 **1~4층**으로 나눴습니다. 일은 아래층에서 먼저 하고, 못 푸는 것만 위층으로 올립니다.

## 1. 네 갈래

| 갈래 | `kind` | 뼈대 | 무엇을 두나 |
|---|---|---|---|
| 사용자 | `user` | `templates/user-skeleton/` | 사람 한 명의 개인 설정·작업 문서·속한 그룹 |
| 그룹 | `group` | `templates/group-skeleton/` | 회사나 팀: 구성원·권한·프로젝트 목록·에이전트 자리·채널 표·일정 |
| 에이전트 | `agent` | `templates/agent-skeleton/` | 역할 하나를 맡은 AI 의 역할 문서·성격·기억(업무 장부 없음) |
| 프로젝트 | `project` | `templates/project-skeleton/` | 만드는 것 하나의 명세 사슬·소스·검사 |

자세한 연결 방법은 [네 갈래 ADK 뼈대와 연결](adk-four-kinds.md), 에이전트 자리를 실제 세션으로 띄우는 방법은 [역할 세션 운영](agent-role-sessions.md)에 있습니다.

## 2. 공통과 인스턴스 덮어쓰기

| 구분 | 공통(이 저장소) | 인스턴스가 덮어쓰는 곳 |
|---|---|---|
| 입구 | `AGENTS.md`(정본), 한 줄 `CLAUDE.md`·`GEMINI.md` | 인스턴스의 `AGENTS.md` 에 자기 색인만 더함 |
| 규칙 | `.agents/context/`(한 줄 규칙·경로표·용어), `rules/`(규칙 카탈로그) | `FORK.md`: 그 인스턴스에만 맞는 안정된 사실 |
| 역할별 모델 | 역할과 모델이 갖출 조건만 정함(예: "구현과 다른 계열의 검수 모델") | `FORK.md` 같은 덮어쓰기 위치에 실제 모델·계정을 적음 |
| 스킬·스키마·뼈대 | `skills/`, `.agents/skills/`, `schemas/`, `templates/` | 인스턴스 전용 스킬은 인스턴스 저장소에 따로 둠 |
| 검사 도구 | `scripts/`(연결 검사·문맥 예산·공개 준비 검사 등) | 고치지 않고 그대로 씀 |
| 화면 기본값 | `naia-settings/`(캐릭터·배경·음악 기본 묶음) | 인스턴스가 파일을 바꾸거나 더함, 폴더 이름은 유지 |
| 회사·사람 자료 | 없음(역할 낱말 자리표시만) | `data-company/`, 그룹 ADK 의 구성원·채널 표 |
| 열쇠·비밀 | 없음 | `keys/`(git 에서 빼고 링크하지 않음) |
| 작업 기록 | 없음 | `.agents/progress/`, `docs/` 의 작업 문서 |

경계를 지키는 방법:

- 공통에 사람 이름·회사 이름·기기 이름·실제 모델 이름을 쓰지 않습니다. 문서 머리에 `범위: 공통` 을 적고, 예시는 `alice`, `company-a`, `<member>` 같은 자리표시를 씁니다.
- 인스턴스에서 공통 규칙을 고치고 싶으면 인스턴스 쪽 파일을 바꾸지 말고 이 저장소에 제안해 공통을 고칩니다. 그 인스턴스에만 맞는 값은 `FORK.md` 로 보냅니다.
- 공개하기 전에는 `node scripts/oss-readiness.mjs .` 의 필수 검사(비밀값·개인정보·개인 경로·내부 누출·추적 중인 무시 파일)가 모두 통과해야 합니다.

## 3. 1~4층

층 번호는 아래에서 위로 셉니다(2026-10-20 개편). 2026-10-20 전 문서의 옛 번호는 위에서 아래로 세어 1층↔4층, 2층↔3층이 뒤바뀌어 있습니다. 파일·스크립트·설정 키 이름(`layer4-*`, `l4-*`, `tier1_*`, `tier4_*`)은 호환을 위해 옛 이름을 그대로 둡니다.

| 층 | 하는 일 | 모델이 갖출 조건 | 규칙 |
|---|---|---|---|
| 1층 센서 | 메신저·작업 완료·무응답·문서 메모를 감시하고 필요할 때만 위층을 깨움 | 모델 없음 또는 가볍고 빠른 모델, 다른 공급자 두 개 교차 | [`rules/layer4-sensor-and-memo-loop.md`](../../rules/layer4-sensor-and-memo-loop.md) |
| 2층 실행·검수 | 구현과 독립 검수 | 구현 모델과 검수 모델은 서로 다른 계열 | [`rules/evidence-driven-process.md`](../../rules/evidence-driven-process.md) |
| 3층 조정 | 역할 세션: 분석·계획·맡기기·결과 판정. 직접 대량 구현하지 않음 | 상위 조율 모델 | [`rules/multi-cli-account-management.md`](../../rules/multi-cli-account-management.md) |
| 4층 자문 | 3층이 못 푼 난제나 사용자 요청 때만 상위 모델 적대 검토 | 상위 추론 모델(여러 계열 중 하나) | [`rules/evidence-driven-process.md`](../../rules/evidence-driven-process.md) §3.4 (`/top-model-review` 스킬은 아직 인스턴스에만 있음) |

## 4. 계보와 동기화

- 기준판 판 번호는 `VERSION` 과 `adk.json` 의 `adk_version` 에 있습니다(지금 `2.0.0`).
- 인스턴스는 `.agents/upstream-sync.yaml` 에 위 저장소(`upstream_repo`), 마지막으로 맞춘 커밋(`upstream_commit`), 그때 판 번호(`upstream_version`)를 적습니다. 이 값이 실제 공통 조상과 맞지 않으면 드리프트입니다.
- 그룹·사용자 ADK 매니페스트의 `base_commit` 에는 따라 만든 기준판 판 번호를 적습니다.
- 동기화는 `sync-upstream` 스킬로 하고, 충돌이 나면 위 저장소 구조를 먼저 따릅니다(`conflict_policy: upstream-structure-first`).

## 5. naia-shell 이 받는 약속

naia-shell(데스크톱 앱)은 이 저장소를 직접 복제하지 않습니다. 새 설치는 `nextain/naia-template-project` 를 받고, 이미 있는 작업 공간을 찾을 때 아래를 확인합니다. 공통을 고칠 때 이 목록은 바꾸지 않습니다.

1. 작업 공간 판정: `AGENTS.md` 또는 `CLAUDE.md`, `.agents/context/agents-rules.json`, 그리고 `package.json` 의 `name` 이 정확히 `naia-adk`. 셋이 모두 있어야 합니다.
2. 찾는 자리: `projects/naia-adk`, `naia-adk`, 홈 폴더, `~/dev` 아래.
3. 화면 자산: `naia-settings/` 아래 `vrm-files`, `background`, `bgm-musics`, `nva-files` 폴더 이름과 기본 캐릭터 파일 이름.
4. 스킬: `skills/<이름>/SKILL.md` 와 그 머리말 형식.
5. 경로표: `.agents/context/project-index.yaml` 이 읽을 수 있는 YAML 이어야 합니다.

`adk.json` 과 `VERSION` 은 naia-shell 이 읽지 않습니다. 공통 정리가 앱 사용자에게 닿으려면 `naia-template-project` 에도 같은 변경을 반영해야 합니다.

## 6. 인스턴스에 2.0 을 적용하는 순서

1. `VERSION`·`adk.json`(`kind`, `adk_version`, `base_commit`)을 둡니다.
2. `.agents/upstream-sync.yaml` 을 실제 공통 조상 커밋으로 맞춥니다.
3. 회사·팀이면 그룹 ADK(`kind: group`)를 만들고 에이전트 자리와 구성원을 적습니다.
4. 역할별 실제 모델·계정·기기는 `FORK.md` 에만 적습니다.
5. 공통에서 복사해 와서 고쳐 쓴 규칙 파일은 공통으로 되돌리고, 다른 부분만 `FORK.md` 로 옮깁니다.
6. 아래 검사를 돌립니다.

```bash
node scripts/adk-link.mjs --check <ADK 폴더>
node scripts/check-context-budget.mjs
node .claude/hooks/sync-entry-points.js --check
node scripts/oss-readiness.mjs .
```
