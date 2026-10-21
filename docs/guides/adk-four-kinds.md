범위: 공통
상태: 1판. 사용자·그룹·에이전트·프로젝트 네 갈래 ADK 뼈대의 자리와 서로 붙이는 방법

# 네 갈래 ADK 뼈대와 연결

Naia ADK 2.0 은 함께 일하는 단위를 네 갈래로 나눕니다. 갈래마다 뼈대가 `templates/` 아래에 있고, 매니페스트(`adk.json`)의 `kind` 로 갈래를 구분합니다. 검사는 모두 같은 명령으로 합니다.

```bash
node scripts/adk-link.mjs --check <ADK 폴더>
```

## 1. 네 갈래

| 갈래 | `kind` | 뼈대 | 무엇을 두나 | 업무 장부 |
|---|---|---|---|---|
| 사용자 | `user` | `templates/user-skeleton/` | 사람 한 명의 개인 설정, 개인 작업 문서, 속한 그룹 목록 | 둠(`docs/work/`) |
| 그룹 | `group` | `templates/group-skeleton/` | 구성원과 권한, 프로젝트 목록, 에이전트 자리, 채널 표, 일정과 작업 문서 | 둠(`docs/work/`) |
| 에이전트 | `agent` | `templates/agent-skeleton/` | 역할 하나를 맡은 에이전트의 역할 문서, 성격, 기억 | 두지 않음 |
| 프로젝트 | `project` | `templates/project-skeleton/` | 만드는 것 하나의 명세 사슬, 소스, 검사 | 둠 |

에이전트 ADK 에는 업무 장부를 두지 않습니다(매니페스트 `work_ledger_policy`). 에이전트가 한 일은 소속 그룹이나 프로젝트의 작업 문서에 적습니다.

## 2. 뼈대마다 공통으로 있는 것

- 입구 문서 `AGENTS.md`, 그리고 한 줄 `@AGENTS.md` 만 담은 `CLAUDE.md`·`GEMINI.md`
- 사람용 입구 `index.md`
- 매니페스트 `adk.json`: `owner`, `responsible_human`(사람), `permissions`(허락 폴더·금지 폴더·동작), `links`
- 최소 규칙 `.agents/context/agents-rules.json` 과 경로표 `.agents/context/project-index.yaml`
- `keys/` 격리: git 에서 빼고, 링크하지 않고, 금지 폴더에 `keys` 를 반드시 넣습니다.

## 3. 서로 붙이는 방법

| 어디에서 | 무엇을 | 방법 | 자리 |
|---|---|---|---|
| 그룹 | 에이전트 | 에이전트 뼈대를 그룹 안 자리 폴더로 복사 | `agents/<id>-adk/` |
| 에이전트 | 그룹 | 그룹 식별자 글자만 적음(링크 없음, 돌고 도는 연결 방지) | `adk.json` `agent_config.groups` |
| 사용자 | 그룹 | 식별자와 권한을 적고, 같은 기기에 있으면 상대 소프트링크 | `user_config.groups`, `groups/<그룹>` |
| 그룹·에이전트·사용자 | 프로젝트 | 상대 소프트링크 | `projects/<프로젝트>` |

### 3-1. 그룹에 에이전트 자리 만들기

1. 그룹 매니페스트 `group_config.agents[]` 에 식별자·역할·설명·봇 자리를 적습니다.
2. 에이전트 뼈대를 자리 폴더로 복사합니다.

   ```bash
   cp -r <naia-adk>/templates/agent-skeleton <그룹 ADK>/agents/<id>-adk
   ```

3. 복사한 `adk.json` 의 `id` 를 `<id>-adk`(또는 `<id>`)로, `owner`·`responsible_human`·`agent_config.groups` 를 그 그룹 값으로 바꿉니다. 역할 문서는 `index.md` 에 채웁니다.
4. 그룹 검사에서 그 자리가 `seats ready` 로 세어지는지 확인합니다. 매니페스트가 없는 자리는 `seat without manifest`, 폴더가 없는 자리는 `seat not created` 로 남습니다.

### 3-2. 프로젝트 붙이기

프로젝트 ADK(`kind: "project"`)가 같은 기기에 있으면 링크 명령으로 붙입니다. 명령은 상대 소프트링크와 `links[]` 항목을 함께 만듭니다.

```bash
node scripts/adk-link.mjs --link --from <그룹 또는 에이전트 ADK> --to <프로젝트 ADK>
```

- 링크 자리는 `projects/<프로젝트 식별자>` 입니다. 그룹의 `projects/<식별자>.md` 소개 문서와 이름이 겹치지 않습니다.
- 에이전트에서 붙였으면 `agent_config.projects` 에도 식별자를 적습니다.
- 다른 기기에서 받은 뒤에는 `node scripts/adk-link.mjs --link <ADK 폴더>` 로 `links[]` 에 적힌 링크를 다시 만듭니다.
- 아직 프로젝트 ADK 가 없으면 링크 없이 그룹 `projects/<식별자>.md` 와 `group_config.projects[]` 로만 관리합니다.

### 3-3. 사용자에게 그룹 붙이기

1. 사용자 매니페스트 `user_config.groups[]` 에 `group_id` 와 `access`(그룹 매니페스트의 권한과 같게)를 적습니다.
2. 같은 기기에 그룹 ADK 가 있으면 링크합니다.

   ```bash
   node scripts/adk-link.mjs --link --from <사용자 ADK> --to <그룹 ADK>
   ```

## 4. 지킬 것

- 링크는 상대 경로만 씁니다. 절대 경로 링크와 `keys/` 를 가리키는 링크는 검사에서 오류입니다.
- 공개 뼈대에는 역할 낱말 자리표시만 씁니다. 실제 사람 이름·연락처·계정·기기 주소·비밀값은 비공개 인스턴스에만 둡니다.
- 에이전트가 그룹 폴더로 가는 링크를 만들지 않습니다. 소속은 식별자 글자로만 적습니다.
- 다른 그룹의 기억·자료·채널·열쇠와 섞지 않습니다.

에이전트 자리를 실제 세션으로 띄우는 방법은 [역할 세션 운영](agent-role-sessions.md)에 있습니다.
