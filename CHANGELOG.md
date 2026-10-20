# 변경 기록 (CHANGELOG) — naia-adk

이 문서는 단일 통합 `naia-adk` 프레임워크의 판(버전)별 주요 변경 내역과, 기관 전산 담당자 및 개발자가 혼자서도 따라 할 수 있는 **옮기는 방법(마이그레이션) 및 확인 방법**을 기록합니다.

---

## [2.0.0] — 2026-10-20

### 1. 핵심 변경 요약 (5대 단위 재편: user · group · agent · project · schedule 및 `org` → `group` 전환)

- **5대 구성 단위로 ADK 체계 재정립**:
  - `user` (**한 사람 / 내 자리**): 개인 설정, 기기, 개인 키(`keys/`), 소속 그룹 목록(`user_config.groups[]`)을 가집니다.
  - `group` (**함께 일하는 팀·회사·고객 / 우리 그룹**): 구성원(`members[]`)과 권한(`owner` / `admin` / `member` / `viewer` / `unset`), 그룹 규칙·데이터, 절대 링크하지 않는 그룹 키(`keys/`), 메신저 채널 표(`channels`), 프로젝트 목록(`projects[]` 및 1단계 하위 `services[]`), 에이전트 자리(`agents[]`), 그룹 일정(`calendar`)과 업무 장부를 가집니다.
  - `agent` (**한 역할을 맡은 AI 직원** — 개발·마케팅·사업·고객지원 등): 성격(`persona/`), 기억(`memory/common/`, `memory/groups/<group>/`), 봇 키(`keys/`), 얼굴·목소리(`nva/`), 참여 그룹 식별자 배열(`agent_config.groups[]`)을 가집니다. **에이전트에는 업무 장부를 두지 않습니다.**
  - `project` (**만드는 서비스·제품**): 제품 저장소, 명세 사슬(`PC → SP/UC → RQ → FE → [UT → IT → E2E] → QC`), 검증 기록, 배포 경로를 가집니다.
  - `schedule` (**일정 및 작업 문서**): 마일스톤(`id`, `name`, `due`, `done_when`)과 작업 문서(`.md`)로 구성됩니다. 깃 이슈를 쓰지 않고 **작업 문서 자체가 업무 단위(문서 ID = 이슈 ID)**가 되며, 문서 머리말의 `마일스톤:`·`기한:`(`YYYY-MM-DD`)과 `## 할 일` 표(`할 일`, `담당`, `상태` 열 필수, `상태`가 `완료`인 줄을 완료로 집계)를 기준으로 일정을 확인하고 알림을 줍니다(권한은 부여하지 않음).
- **권한 계산 및 설정 우선순위 유지**:
  - 한 사람이 여러 그룹에 속할 수 있으며, 실제 권한은 **`그룹이 부여한 권한 ∩ 개인 상한 − 금지`**로 계산합니다.
  - 일반 설정 우선순위는 `실행 인자(cli_args) > 프로젝트(project) > 에이전트(agent) > 유저(user) > 그룹(group) > 틀(framework)` 순서를 유지합니다.
- **`org` → `group` 명칭 변경 및 하위 호환(`org` 읽기 전용 별칭)**:
  - 기존 `"org"` 종류(`kind`)와 `org_config` 블록은 `"group"` 및 `group_config`로 이름이 바뀌었습니다.
  - 기존에 만들어 둔 `kind: "org"` 및 `org_config`, `adk_version: "0.2.x"` 매니페스트는 **읽기 전용 별칭(legacy alias)으로 계속 읽히며**, 검사 시 안내 경고(warning)를 띄우고 내부에서 자동으로 `group`으로 정규화합니다. 새로 만드는 매니페스트와 스캐폴드는 모두 `"group"`을 기록합니다.
- **그룹 골격 템플릿(`templates/group-skeleton/`) 및 CLI 요약·JSON 출력 추가**:
  - 역할 단어(`example-group`, `group-owner`, `member-a`, `developer-agent` 등)만 사용한 공개 그룹 골격 템플릿 `templates/group-skeleton/`을 추가했습니다.
  - **그룹 안 에이전트 자리(folder `agents/<id>-adk/` with `index.md`)**: 실제 돌아가는 운영 단위는 그룹 ADK이며, 각 에이전트 자리는 그룹 ADK 안의 `agents/<id>-adk/` 폴더와 그 안의 입구 문서 `index.md`(`agents/<id>-adk/index.md`, `group_config.agents[].seat` 생략 시 기본값 `agents/<id>-adk`)로 구성됩니다. 자리 폴더가 존재하는데 `file`이 자리 폴더 밖을 가리키면 `agent doc should live in its seat`(경고)를 띄우고, 자리 폴더가 아직 없으면 `seats not created`(경고), 폴더는 있으나 `adk.json`이 아직 없으면 `seats without manifest`(경고) 빈칸으로 집계하며, 유효한 `kind: "agent"` 매니페스트가 놓이면 준비 완료(`seats ready`)로 집계합니다.
  - **그룹 최소 표준 입구(`AGENTS.md` 및 `.agents/context/`)**: 그룹 ADK는 AI 입구 문서 `AGENTS.md`(`CLAUDE.md`·`GEMINI.md`는 `@AGENTS.md` 한 줄)와 `.agents/context/agents-rules.json`, `.agents/context/project-index.yaml`을 최소 표준으로 갖추며, 없으면 점검 모드에서 오류가 아닌 경고(`entry AGENTS.md missing`, `missing context`) 및 `open:` 줄로 안내합니다.
  - `adk-link.mjs --validate` 및 `--check` 실행 시 그룹 요약 한 줄(`group <id>: members ..., projects ..., agents N (bots planned ..., seats ready R/N), milestones ...`)과 아직 채우지 않은 빈칸(`open: unset access`, `open: undecided repos`, `open: planned bots`, `open: seats not created`, `open: seats without manifest`), 작업 문서 일정 검사 결과(`work docs: N checked, M errors`)를 출력하며, `--json` 플래그로 전체 결과를 JSON으로 받을 수 있습니다.

### 2. 옮기는 방법 (`org`에서 `group`으로 전환 안내)

1. **즉시 중단 없이 기존 `org` 그대로 읽기 가능**:
   - 기존 `adk.json`의 `kind: "org"`와 `org_config`는 바로 삭제하거나 고치지 않아도 검증기(`adk-link.mjs`)가 경고와 함께 `group`으로 읽어들입니다.
2. **`adk.json`을 2.0 `group` 규격으로 갱신**:
   - `adk_version`을 `"2.0.0"`으로, `kind`를 `"group"`으로 바꿉니다 (`links[]` 안의 `"kind": "org"`도 `"group"`으로, 기본 마운트 경로는 `groups/<id>`로 맞춥니다).
   - `org_config` 이름을 `group_config`로 바꾸고 `members[]`(`{ user_id, access }`), `projects[]`(`{ id, name, repo, repo_status }`), `agents[]`(`{ id, role, description, bot }`), `calendar`(`{ milestones, milestones_file, work_docs_dir }`)를 채웁니다. 아직 정해지지 않은 항목은 `access: "unset"`, `repo: null` + `repo_status: "undecided"`, `bot.status: "planned"`로 두면 오류가 아니라 열려 있는 빈칸(`open:`)으로 안내됩니다.
   - 주의: `group_config` 안에는 `token`, `secret`, `password`, `api_key`, `bot_token` 같은 실제 비밀값 칸이나 `keys/` 경로를 넣지 말고, 짧은 참조 이름(`credential_ref`)만 적습니다.
3. **작업 문서(`work_docs_dir/*.md`) 일정 머리말 점검**:
   - 각 작업 문서 상단에 `마일스톤: <마일스톤 ID 또는 이름>`과 `기한: YYYY-MM-DD`를 적고, `## 할 일` 표 머리글에 `할 일 | 담당 | 상태` 세 열을 포함시킵니다.

### 3. 확인 방법 (정상 동작 검증 명령)

```bash
# 1. 루트 ADK 매니페스트 검증
node scripts/adk-link.mjs --validate .

# 2. 그룹 골격 템플릿(templates/group-skeleton) 전체 점검 및 빈칸(open:) 요약 확인
node scripts/adk-link.mjs --check templates/group-skeleton

# 3. JSON 형식으로 점검 결과 출력
node scripts/adk-link.mjs --check templates/group-skeleton --json

# 4. 0.2.0 호환 및 2.0.0 그룹·일정 전체 자동 테스트 실행
node --test tests/adk-v020.test.mjs tests/channel-roles-gen.test.mjs tests/adk-v200.test.mjs
```

---

## [0.2.0] — 2026-10-19

### 1. 핵심 변경 요약 (에이전트 중심 한 틀 + 네 종류 ADK 통합 및 채널·담당 표 생성기)

- **단일 `naia-adk` 정본 통합 및 에이전트 중심 전환**:
  - 기존에 `pj-adk`, `group-adk` 등으로 갈라져 있던 뼈대를 별도 프레임워크로 쪼개지 않고 **단일 `naia-adk` 정본(v0.2.0)**으로 통합했습니다.
  - **나이아쉘(`naia-shell`)은 유저 ADK(`adk.json`)를 읽고 붙은 에이전트 ADK들을 띄우는 그릇**이며, 뇌(`naia-agent`) 프로세스의 `SetWorkspace(adkPath)` 루트는 유저 ADK가 아니라 **에이전트 ADK 경로**입니다.
- **4종(`kind`) ADK 인스턴스 규약 및 스키마 (`schemas/adk-manifest.schema.json`)**:
  - 모든 ADK 인스턴스는 공통 매니페스트 `adk.json`(`adk_version`, `kind`, `id`, `owner`, `responsible_human`, `links[]`, `permissions`)을 가지며, 다음 4가지 종류(`kind`)로 동작합니다:
    1. `user` (**내 자리** / 개인 ADK — 예: `alpha-adk`): 나이아쉘 설정(`reads_user_adk`, `set_workspace_target_kind: "agent"`), 기기 목록, 계정, 유저 키(`keys/`), 붙은 ADK 링크 목록(`links[]`), 개인 업무 장부
    2. `agent` (**AI 직원** / 에이전트 ADK — 예: `naia-agent-adk`, `jina`, `minho`, `alpha`): `agent.json`(신원·소유자·책임자·`birth`[만든 때·만든 이·틀 판]·소속 조직 이름 문자열 `organizations[]`), `persona/`, `memory/`(`common/`, `groups/<org>/`), `nva/`(얼굴·목소리 아바타), 에이전트 키(`keys/` — 봇 토큰 및 에이전트 명의 계정), `public-room/`(공개 방 슬롯). **업무 장부(`.agents/work`, 진행 기록)는 에이전트 ADK에 두지 않습니다(`work_ledger_prohibited: true`).**
    3. `project` (**만드는 것** / 프로젝트 ADK — 예: `naia-arcade`, `naia-studio`): 제품 저장소 + `PC → SP/UC → RQ → FE → [UT → IT → E2E] → QC` 명세 사슬 + 결정론적 검증기 + 스튜디오 문서/플레이 개발 서버 + 제품 이슈·검증 장부
    4. `org` (**우리 회사/기관** / 조직 ADK — 예: `nextain-adk`, `onmam-adk`): 조직 규칙, 조직 데이터, 조직 키(`keys/`), 채널·역할 표(`channels.yaml`, `channel-ids.json`), 에이전트 실행 자리(`agents/<이름>/`), 프로젝트 링크(`projects/`), 조직 업무 장부
- **조직 실행 자리(`agents/<이름>/`)와 환경변수 키 주입 원칙 (`env_only`)**:
  - 다른 ADK에 비밀키 파일을 복사하지 않습니다. 에이전트가 조직 키가 필요한 일을 할 때는 회사 서버의 조직 실행 자리(`agents/<이름>/`)에서 뜬 세션에만 조직 실행기가 시작 시 환경변수(`env_only`)로 넣어 주고, 에이전트 ADK 파일에는 절대 기록하지 않습니다.
- **설정 우선순위 (`실행 인자 > 프로젝트 > 에이전트 > 유저 > 조직 > 틀`)**:
  - 항목별 소유를 먼저 나누고, 불가피하게 겹치는 일반 설정만 `실행 인자(cli_args) > 프로젝트(project) > 에이전트(agent) > 유저(user) > 조직(org) > 틀(framework)` 순서를 따릅니다. 권한·금지(`부여 ∩ 상한 − 금지`) 및 키 소유는 이 순서와 무관합니다.
- **사내 메신저 채널·담당 표 스키마 및 결정론적 생성기 (`schemas/channels.schema.json`, `scripts/channel-roles-gen.mjs`, `templates/org-channels/`)**:
  - 공통 표 `channels.yaml`(번호 없이 역할 이름·규칙만 기록)과 인스턴스 번호 매핑 `channel-ids.json`(다중 회사·다중 서버 `guildId`, 미생성 서버 `guildId: null` 건너뛰기 지원)으로부터 다음 셋을 한 번에 생성합니다:
    1. 역할별 봇 묶음(`instances/<role>/config.json`의 `discord.bindings` — `generatedBy: "channel-roles"` 표지 부여, 수동 묶음 보존)
    2. 4층 감시 대상(`discord-watch.json`의 `targets` — `generatedBy: "channel-roles"` 표지 부여, 수동 대상 보존, `archived: true` 채널 제외 및 읽기 전용 묶음 유지)
    3. 채널 설명 및 사람용 마크다운 표(`channels-and-wake.md`)
  - 7가지 결정론적 검사를 내장하여 하나라도 어기면 종료코드 `1`로 거절하며 아무 파일도 수정하지 않고, `--write` 시 기존 파일을 `.bak-<YYYYMMDD>`로 자동 백업합니다.
- **소유(`owner`)와 책임자 사람(`responsible_human`) 의무화 및 상대 경로 소프트링크 (`scripts/adk-link.mjs`)**:
  - 모든 ADK는 `owner`와 `responsible_human` 두 칸을 필수로 가지며, 같은 기기 안 연결은 상대 경로 심볼릭 링크로만 연결하고 `keys/`는 절대 링크·동기화하지 않습니다.
- **자동 프로젝트 ADK 스캐폴딩 (`scripts/adk-scaffold-project.mjs` & `templates/project-skeleton/`)**:
  - `00-USER-REQUESTS-traceability.ko.md`, `PC → SP/UC → RQ → FE → [UT → IT → E2E] → QC` 문서 체인, `validate-spec-chain.mjs`, `debug-logger.mjs`(`MAX=200`), 인터랙티브 Mermaid 뷰어(`dev-server.mjs`)를 자동 생성합니다.

### 2. 옮기는 방법 (전산 담당자용 쉬운 안내)

1. **기존 자료 백업 확인**:
   - 판을 올리기 전 기존 기억(`memory/`)과 작업 중인 미커밋 파일은 절대 삭제하지 않습니다.
2. **`adk.json` 매니페스트 점검**:
   - 각 ADK 루트에 `adk.json` 파일이 있는지 확인하고, `owner`(소유자)와 `responsible_human`(담당자 이름/ID) 칸이 채워져 있는지 확인합니다.
3. **사내 메신저 채널·담당 표 미리보기 및 반영**:
   ```bash
   # 1단계: 미리보기 (파일을 바꾸지 않고 이상 유무와 변경 요약만 확인)
   node projects/naia-adk/scripts/channel-roles-gen.mjs \
     --table channels.yaml \
     --ids channel-ids.json \
     --out-dir .

   # 2단계: 실제 반영 (기존 파일을 .bak-<날짜>로 백업한 뒤 기록)
   node projects/naia-adk/scripts/channel-roles-gen.mjs \
     --table channels.yaml \
     --ids channel-ids.json \
     --out-dir . \
     --write
   ```
4. **새 프로젝트 생성 시 (자동 스캐폴딩)**:
   ```bash
   node projects/naia-adk/scripts/adk-scaffold-project.mjs \
     --target ./projects/<프로젝트이름> \
     --name "<프로젝트이름>" \
     --owner "<소유조직또는유저>" \
     --responsible "<책임자사람이름>"
   ```

### 3. 확인 방법 (정상 동작 검증 명령)

```bash
# 1. 현재 ADK 매니페스트 및 키 격리·책임자 무결성 점검
node projects/naia-adk/scripts/adk-link.mjs --check projects/naia-adk

# 2. 4종 ADK 통합 및 채널·담당 표 생성기(channel-roles-gen) 전체 자동 테스트 실행
node --test projects/naia-adk/tests/*.test.mjs
```

---

## [0.1.0] — 2026-10-16 (되돌리기 기준점)

- **초기 단일 워크스페이스 기준점 (`package.json` 0.1.0)**:
  - 쉘 중심 단일 워크스페이스 구조(`AGENTS.md`, `.agents/context/`, 요청 계약 하네스, 기본 서버·대시보드 패키지).
  - 0.2.0 에이전트 중심 4종 ADK 통합 이전의 되돌리기(롤백) 기준점입니다.
