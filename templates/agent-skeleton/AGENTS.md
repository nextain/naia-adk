# 에이전트 ADK (`developer-agent-adk`)

이 폴더는 Naia ADK 2.0 **에이전트** 자리입니다(`kind: "agent"`). 역할 하나를 맡은 AI 에이전트 한 명이 이 폴더를 작업 기준으로 삼아 일합니다. 값은 역할 낱말 자리표시(`developer-agent-adk`, `example-group`, `group-owner`)로 채워 두었습니다.

## 반드시 읽을 것

이 폴더에서 일하기 전에 아래를 먼저 읽습니다.

1. `.agents/context/agents-rules.json`
2. `.agents/context/project-index.yaml`
3. `index.md`

## 구조

- `adk.json`: 에이전트 매니페스트(`kind: "agent"`). 소속 그룹(`agent_config.groups`), 맡은 프로젝트(`agent_config.projects`), 붙인 프로젝트 링크(`links`)
- `index.md`: 사람용 입구. 역할, 하는 일과 하지 않는 일, 보는 채널, 세션 기록
- `persona/`: 말투와 성격처럼 이 에이전트를 이 에이전트답게 하는 것
- `memory/common/`: 어느 그룹에서 일하든 쓰는 기억
- `memory/groups/<그룹>/`: 그 그룹에서만 쓰는 기억
- `projects/<프로젝트>`: 붙인 프로젝트 ADK 로 가는 상대 소프트링크(붙였을 때만 생김)
- `keys/`: 만들지 않습니다. 열쇠는 세션 시작 때 환경 변수로만 받습니다.

## 지킬 것

1. 업무 장부(작업 문서·진행 기록)는 여기에 두지 않고 소속 그룹 ADK 의 `docs/work/` 에 둡니다.
2. 다른 그룹의 기억·자료·채널·열쇠와 섞지 않습니다.
3. 비밀값을 저장소·지시·기록에 넣지 않습니다.
4. 여러 세션이 같은 작업 폴더를 쓰는 동안에는 지시 전에 읽기만 합니다.
5. 운영 변경·결제·외부 발송은 사람 승인 뒤에만 합니다.
