# 사용자 ADK (`member-a-adk`)

이 폴더는 Naia ADK 2.0 **사용자** 자리입니다(`kind: "user"`). 사람 한 명의 개인 설정, 개인 작업 문서, 속한 그룹 목록을 둡니다. 값은 역할 낱말 자리표시(`member-a`, `example-group`)로 채워 두었습니다.

## 반드시 읽을 것

1. `.agents/context/agents-rules.json`
2. `.agents/context/project-index.yaml`
3. `index.md`

## 구조

- `adk.json`: 사용자 매니페스트(`kind: "user"`). 속한 그룹과 권한(`user_config.groups`), 붙인 링크(`links`)
- `index.md`: 사람용 입구
- `docs/work/`: 개인 작업 문서(일 하나에 문서 한 장)
- `groups/<그룹>`: 같은 기기에 있는 그룹 ADK 로 가는 상대 소프트링크(붙였을 때만 생김)
- `projects/<프로젝트>`: 개인으로 붙인 프로젝트 ADK 로 가는 상대 소프트링크(붙였을 때만 생김)
- `keys/`: 개인 열쇠. git 에서 빼고 링크하지 않습니다.

## 지킬 것

1. 연락처·계정·기기 주소 같은 개인 정보와 비밀값을 저장소에 넣지 않습니다.
2. 그룹 일은 그룹 ADK 의 `docs/work/` 에, 개인 일은 이 폴더의 `docs/work/` 에 둡니다.
3. 다른 그룹의 자료·기억·채널·열쇠와 섞지 않습니다.
4. 운영 변경·결제·외부 발송은 사람 승인 뒤에만 합니다.
