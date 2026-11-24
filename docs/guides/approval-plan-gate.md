[English](approval-plan-gate.en.md) | [한국어](approval-plan-gate.md)

# 승인 계획 관문 사용법 (Approval Plan Gate)

운영 서버·클라우드 자원을 바꾸는 명령은 AI가 바로 실행할 수 없습니다. 모든 운영 변경 명령은 **계획서 작성 → 적대 리뷰 → 관문 발급 승인 코드(preapprove) → 사람에게 코드 요청 → 실행 때 바이트·고정 파일 SHA-256 대조** 순서로만 통과합니다.

---

## 0. 인스턴스 확장 설정 (`config/deploy-gate.json`)

업스트림(`naia-adk`)에는 공통 관문 뼈대만 들어 있으며, 회사·서버 이름·IP·구독 ID·채널 ID 같은 인스턴스 전용 정보는 넣지 않습니다.
각 인스턴스 저장소는 `config/deploy-gate.json`(예시: `config/deploy-gate.example.json`)과 선택 플러그인 모듈(`plugin`)로 자신의 운영 서비스 목록과 결합 규칙을 등록합니다.

- **기본 동작(Fail-Closed)**: `config/deploy-gate.json`이 없거나 명령의 운영 서비스 키가 인스턴스 설정·플러그인에 등록되어 있지 않으면 **"알 수 없는 운영 명령은 막음"** 규칙에 따라 즉시 차단됩니다.
- **명령 앞 전역 옵션 건너뛰기 및 미지 옵션 차단**: `gcloud`(`run deploy`, `run services update|replace`, `builds submit`, `app deploy`, `functions deploy`, `compute scp|ssh`), `kubectl`, `helm`, `terraform`, `fly`/`flyctl`, `wrangler`, `railway`, `supabase` 분류기는 하위 명령 앞의 알려진 전역 옵션(값을 받는 옵션은 그 값 토큰까지)을 건너뛰어 하위 명령을 찾으며, 하위 명령 앞에 모르는 옵션이 오면 승인 필요(`*:unknown-option`)로 판정해 차단합니다. `bash release.sh` 등 감싼 셸 대본 실행도 본문을 재귀 분류합니다.
- **옛 승인(`approvals.json`) 분기 방어**: 저장소에 승인 계획 관문(`config/deploy-gate.json`, `.agents/scripts/approval-plan.mjs`, `gates/deploy-plan.json`)이 설치된 환경에서는 유효한 옛 `approvals.json` 항목이 있어도 옛 분기를 타지 않고 새 승인 계획 관문으로 검사합니다. 관문 파일이 없는 순수 옛 환경에서만 옛 `PROD_PATTERNS` 범위 명령에 한해 `approvals.json` 흐름을 허용하며, 그 밖의 운영 명령(`az`, `kubectl` 등)은 항상 차단합니다. 옛 `.claude/deploy/config.json`의 개발 서비스(`dev_service`·`-dev`) 예외는 복합 명령에서 해당 절(clause)에만 적용됩니다.
- **관문 루트 기준 확장 설정 로드**: `config/deploy-gate.json`은 명령이 하위 폴더에서 실행되거나 `cd <하위폴더>` 뒤 실행되더라도 정책이 찾은 관문 루트(저장소 루트)에서 읽습니다.
- **인스턴스 확장 오류 시 차단**: `config/deploy-gate.json`의 `prodPatterns` 정규식 오류나 `plugin` 모듈 로드 실패가 나면 이미 모은 `prodPatterns` 적중을 보존한 채 `unclassified` 적중을 내어 즉시 차단합니다.
- **설정 항목**:
  - `services`: 운영 서비스 키(`azure:containerapp:<이름>`, `gcp:cloudrun:<이름>`, `vercel:deploy:prod` 등)별 준비 기록(`gates/deploy.json`) 요구 여부, `ops`/`rollback` 허용 여부, 명령 결합 규칙(`commandMustContain` 등)
  - `local:systemd:<유닛>`: `services`에 등록한 로컬 시스템 유닛을 운영 서비스로 분류합니다. 예: `"local:systemd:sample-web": { "requireDeployGate": false, "allowOps": true, "paths": ["/opt/sample-web"] }`. `.service`·`.socket` 접미, 실행파일 절대 경로, `sudo`·`env`·`sh -c` 같은 셸 감싸기를 인식합니다. 다음 변경은 같은 서비스의 계획·승인을 요구합니다.
    - `systemctl` 변경 동사: `stop`, `start`, `restart`, `reload`, `enable`, `disable`, `mask`, `kill`, `daemon-reload`, `try-restart`, `reload-or-restart`, `reload-or-try-restart`, `reenable`, `unmask`, `revert`, `edit`, `set-property`, `preset`, `link`, `add-wants`, `add-requires`. `service <유닛> <동사>`도 같은 변경 동사로 분류하고, `link`의 경로 인자는 파일 이름으로 유닛을 맞춥니다.
    - 시스템 범위의 인자 없는 `systemctl daemon-reload`는 등록된 로컬 서비스 전체를 대상으로 봅니다. `daemon-reload <유닛>`은 실제 문법이 아니므로 시험은 인자 없는 형태를 사용합니다. `systemctl --user ...`는 시스템 유닛 분류에서 제외합니다.
    - 등록 서비스가 하나라도 있을 때 변경 대상의 `$변수`·`${변수}`·명령 치환을 정확히 풀 수 없거나, 대상이 비어 stdin·`xargs`에서 올 수 있으면 등록 서비스 전체를 대상으로 보아 차단합니다. 글롭(`*`·`?`·`[`)은 등록 유닛에 맞춰 보고, 대상을 확정할 수 없으면 차단합니다. 정확히 풀리는 미등록 유닛과 읽기 동사(`status`, `show`, `cat` 등)는 기존대로 처리합니다.
    - `/etc/systemd/system/<유닛>.service`, `.socket`, 각 유닛의 `.d/` 및 선택 항목 `paths`(절대 경로 배열)의 경로 자체와 하위 파일 변경도 같은 서비스로 분류합니다. 대상 도구는 `install`, `cp`, `mv`, `tee`, `sed -i`, `rm`, `ln`, `dd`의 `of=`, `truncate`, `rsync`의 목적지, `chmod`, `chown`입니다. `>`·`>>`·`>|`·`&>` 리다이렉트도 포함하므로 `echo`·`printf`·`cat`으로 쓰는 경우도 검사합니다. 경로는 디렉터리 경계로 맞추므로 `/opt/sample-web2`는 `/opt/sample-web`에 속하지 않습니다. 등록 서비스가 있을 때 쓰기 대상 경로에 풀리지 않는 변수·명령 치환·글롭이 남으면 등록 서비스 전체를 대상으로 보아 차단합니다.
    - 이 분류는 유닛과 파일 경로를 기준으로 합니다. PID를 직접 지정하는 `kill`이나 프로세스 문자열을 찾는 `pkill -f`는 유닛 소유 관계를 조회하지 않으므로 이 로컬 분류의 보장 범위 밖에 남습니다. `systemctl kill <등록 유닛>`은 위 변경 동사에 포함합니다.
  - `prodPatterns` / `sshAlwaysGated`: 인스턴스 추가 운영 명령·SSH 호스트 분류 패턴
  - `testHosts`: 비운영(시험) 기기 호스트·IP 문자열 목록. 소문자·끝 점(`.`)을 정규화하여 와일드카드 없이 정확히 같은 이름만 비운영으로 판정하며, 설정이 없거나 깨졌으면 빈 목록으로 동작합니다. 비운영 호스트로 판정되어도 `ssh` 원격 본문은 다시 분류하므로 시험 기기 안에서 실행하는 운영 변경(`az vm delete` 등)과 `-F`·`-o HostName` 대상 덮어쓰기는 그대로 차단됩니다.
  - `readOnlyScripts`: `[{ "sha256": "<64자리 hex>", "path": "<저장소 상대 경로>", "service": "<정확한 서비스 키>", "note": "<설명>" }]` 배열. `gates/deploy.json`이 `kind: "ops"`이고 아래 허용 명령 꼴의 대본이 등록된 `{sha256, path, service}` 셋과 모두 맞으면, **관문이 `config/deploy-gate.json`과 대본 파일이 심볼릭 링크 없이 git으로 추적되고 작업 트리·인덱스 내용이 HEAD 블롭과 동일한지 직접 검증하며** 적대 리뷰(PASS) 통과 이후 `PLAN`/`STEP` 사람 승인 코드 입력 단계를 건너뜁니다.
    - `service` 와일드카드 금지: `service`에는 `*`, `?`, `[`, `{` 등 글롭을 쓸 수 없으며 정확한 서비스 키 하나만 적어야 합니다(글롭 발견 시 설정 검사 오류). 같은 `sha256`이라도 다른 `path`나 다른 `service`로 재사용하면 무코드가 되지 않습니다.
    - 허용 명령 꼴(정확한 형태만 무코드 인정, 의심 시 기존 승인 코드·차단 경로로 복귀):
      - `az vm run-command invoke -g|--resource-group <RG> -n|--name <VM> --command-id RunShellScript --scripts @<등록 경로>` (허용 읽기·출력 옵션만 추가 가능: `--subscription`, `--query`, `-o|--output` [`tsv|json|jsonc|table|yaml|yamlc|none`], `--only-show-errors`; 각 옵션 최대 1회, `--command-id`는 `RunShellScript`만, `--scripts`는 `@<등록 경로>` 1개만)
      - 또는 정확히 2토큰 `bash <등록 경로>` / `sh <등록 경로>` (옵션·인자 추가·`sudo bash ...`·`bash <대본> <단계id>` 등 3토큰 이상은 무코드 아님)
      - `--parameters`, 둘 이상의 `--scripts` 또는 여러 인자를 받는 `--scripts`, 허용 목록 밖 옵션(`--ids` 등), 셸 연산자(`;`, `&&`, `||`, `|`, 백틱, `$( )`, `>`, `<`, `(`, `)`, 줄바꿈), 따옴표로 쪼갠 옵션·토큰(`--scr"i"pts`, `--"parameters"`, `--scripts=""@...`, `'--query'`)은 무코드로 받지 않습니다. `readonly-no-code` 판정이어도 기존 `opsProblem`(버전/이미지 변경 금지·길이 제한·외부 명령 안전 검사)과 `script:`/`package:` 금지는 건너뛰지 않습니다.
    - 리뷰 시점 바인딩: 계획서 단계 `files`에 대본 경로·SHA-256을 고정해 적대 리뷰 요청문에 대본 본문이 실리게 하고, 리뷰 영수증(`gates/deploy-plan-review.json`)·요청문·입력 목록 해시에도 리뷰 당시의 `readOnlyScripts` 항목(`sha256`·`path`·`service`)과 대본 `sha256`을 함께 묶습니다. 실행 시 현재 설정·대본이 리뷰 당시 묶음과 다르면(리뷰 뒤 `config/deploy-gate.json`에 항목을 새로 넣거나 고쳐 커밋한 경우 포함) 무코드가 되지 않고 기존 승인 코드 경로로 떨어집니다.
    - 심볼릭 링크·HEAD 대조: 대본 경로 및 상위 경로에 심볼릭 링크를 두지 않고(`lstat`), `realpath`가 저장소 안 등록 `path`와 같으며 git 추적·`HEAD` 블롭과 바이트가 같아야 합니다(쓰기 가능한 미추적 파일·작업 트리 수정본 거절).
    - 실행은 감사 기록(`audit.jsonl`)에 `"readonly-no-code"`(`approved_by: "readonly-no-code"`)로 남으며, 계획서·대본·설정이 리뷰 당시와 같은 동안만 승인 코드 없이 반복 실행할 수 있습니다.
    - 설정에 없는 `(sha256, path, service)`, `config/deploy-gate.json`이나 대본의 미추적·미커밋 변경, 인라인 명령(`bash -c`·`--scripts "..."`), `kind !== "ops"`, 적대 리뷰 미통과 시에는 기존 동작 그대로 차단되거나 사람 승인 코드를 요구합니다.
    - **남는 위험**: (1) 관문 훅은 실행 시점에 리뷰 영수증·HEAD 일치를 검사할 뿐 `git commit` 자체를 막지는 않으므로(범위 밖), 설정 파일(`config/deploy-gate.json`) 변경 커밋 통제는 PR 리뷰·브랜치 보호에 의존합니다. (2) 훅이 대본 `sha256`과 HEAD 일치를 검사한 시각과 실제 `az`/`bash` 프로세스가 대본을 여는 시각 사이에는 짧은 TOCTOU 창이 남습니다(실행 중 디스크 변경 시 다른 내용이 실행될 수 있음).
  - `approver.discordUserId`: 디스코드 승인 시 대조할 승인자 본인의 디스코드 사용자 ID(Snowflake)
  - `plugin`: 서비스별 세부 결합 검증(`assessService(service, ctx)`)이나 추가 명령 분류(`classifyCommand(ctx)`)를 수행하는 선택 모듈 경로

---

## 1. 계획서 쓰기 (`deploy-plan.json`)

작업 폴더 아래 `.agents/progress/<작업ID>/gates/deploy-plan.json`에 계획서를 작성합니다.

```bash
# 1) 빈 양식 출력
node .agents/scripts/approval-plan.mjs template > .agents/progress/<작업ID>/gates/deploy-plan.json

# 2) 양식 칸과 명령별 정규화 SHA-256 확인
node .agents/scripts/approval-plan.mjs check .agents/progress/<작업ID>/gates/deploy-plan.json
```

### 작성할 때 주의할 점
- `architecture_fit`: 고치기 전 **최초 요구·붙는 상위 구조·수용 방식** 세 칸을 반드시 채웁니다([architecture-fit-before-fix.md](./architecture-fit-before-fix.md)). 단, 기준 시각(`2026-11-15T04:30:00Z`) 이전 생성(`createdAt`)이고 `version >= 2`가 아닌 기존 계획서는 막지 않고 경고(`check`·`report`·관문 안내)만 남깁니다. `template` 이 생성하는 새 양식(`version: 2`)과 기준 이후 계획서는 필수입니다.
  - `original_request` (a): 누가 무엇을 바랐는지 최초 요구 원문 요지(최소 10자).
  - `parent_structure` (b): 붙는 플랫폼·ADK 업스트림·제품 상위 구조(최소 8자). 특정 서버 이름, IP, 서비스 키, 단일 파일명만 적으면 막히며, `<...>` 부분 견본 문구도 차단됩니다.
  - `acceptance_rationale` (c): 기존 확장인지 새 층인지, 왜 일시 땜빵이 아닌지 적습니다(최소 10자).
- `services`: 관문이 분류한 운영 서비스 키를 빠짐없이 적습니다.
- `scenario`: 실행할 단계(`s1`, `s2`, …)와 되돌리기 갈림길(`branch: "rollback"`)을 순서대로 적습니다.
- `scenario[].commands`: **실제로 실행할 명령 문자열을 한 글자도 바꾸지 말고 그대로** 적습니다. 실행할 때 바이트 단위로 대조하므로 공백이나 따옴표가 달라도 막힙니다.
- `scenario[].files`: 명령이 읽거나 실행하는 스크립트·설정 파일(`bash ./deploy.sh`, `--yaml app.yaml`, `@body.json` 등)은 반드시 `"경로": "<sha256>"` 형태로 고정합니다. 파일 내용이 1바이트라도 바뀌면 실행이 차단됩니다(`bash scripts/rollout.sh` 재귀 검사는 스크립트 폴더로 자동 이동하지 않고 호출자 작업 디렉터리를 유지하며, 스크립트 안의 명시적 `cd`만 반영합니다).
- 사전승인 코드 일괄 발급(`preapprove`)을 쓰려면 최상위에 `"approval_mode": "preapprove_steps"`를 넣습니다.

### 여러 절 고정 대본 돌리기
대본(예: `sudo bash <대본 절대 경로> <단계id>`)을 계획 단계 `commands` 에 그대로 적고, 대본과 대본이 원격에 올리는 본문까지 `files` 에 `{경로: sha256}` 로 고정합니다. 이런 대본은 **ops 로 받지 않습니다.** 대본 본문(변수·eval·here-doc·원격 본문·kubectl 등)이 판을 바꾸는지 관문 분류기가 다 읽을 수 없기 때문입니다. `kind: "ops"` 준비 기록(`deploy.json`)으로 `bash /…` 대본을 부르면 "계획 고정 대본은 ops 로 받지 않음" 으로 막힙니다(`config/deploy-gate.json` 에서 그 서비스에 `allowCustomCommands` 를 명시해 `PLAN`/`STEP` 사람 승인을 받거나, git 커밋된 `readOnlyScripts` 에 `{sha256, path, service}` 가 등록된 **정확히 2토큰** `bash <등록 경로>`/`sh <등록 경로>` 또는 허용 옵션만 쓰는 `az vm run-command invoke ... --scripts @<등록 경로>` 단일 읽기 대본을 적대 리뷰 PASS 뒤에 돌리는 경우만 예외; `sudo bash ...` 나 `bash <대본> <인자>` 3토큰 이상은 `readOnlyScripts` 무코드 대상이 아님).
고정 대본은 준비 기록 없이 계획 승인으로 돌립니다. 적대 리뷰·PLAN·STEP 승인을 받은 계획의 명령 바이트와 `files` 지문이 실행 때와 같으면 받고, 대본이나 고정 파일이 1바이트라도 바뀌면 `고정 파일 sha256 불일치` 로 막습니다. `config/deploy-gate.json` 서비스 규칙(`allowedCommands` 등)은 그대로 따로 요구하며, 계획 경로·지문은 계획에서 읽으므로 계획마다 코드를 고칠 필요가 없습니다. 같은 서비스로 12시간 안의 `deploy.json` 이 있으면 그 기록의 kind 로 판정하므로, ops 기록을 남겨 두면 대본이 막힙니다. 설정에 `requireReadiness: true` 가 있으면 계획 승인 경로를 쓸 수 없습니다.
한계: 지문은 훅 시점에 한 번 확인하고 bash 는 대본을 실행하면서 읽으므로, 계획 폴더(에이전트가 쓸 수 있는 곳) 안 대본을 실행 중에 다른 프로세스가 바꾸면 승인과 다른 글이 돌 수 있습니다(TOCTOU, 기존 `bash <파일>` 갈래와 같은 성질).

---

## 2. 적대 리뷰 받기 (`review`)

계획서 양식과 고정 파일 SHA-256이 모두 맞으면 차례상 다음 모델(`argon`→`codex`→`muse`→`argon`) 한 명에게 열 가지 기준(`correctness`, `disconnect`, `rerun`, `rollback`, `irreversible`, `security`, `impact`, `honesty`, `incident_safety`, `architecture_fit` — 단 기준 시각 이전 옛 계획서는 기존 9기준 호환) 적대 리뷰를 받습니다. 작성자는 `argon`, `codex`, `muse`, `claude` 중 하나이며, 첫 후보가 한도에 걸리면 남은 하나로 넘어가며 넘긴 기록은 `skipped`로 남깁니다.

Muse 리뷰어는 읽기 전용 호출(`--disable-write --disable-shell`)로 그대로 돌립니다. Codex·Claude 리뷰어는 정상 모드와 복구 모드 모두에서 `bwrap` 읽기 전용 격리가 필수이며, `bwrap`이 없으면 실행이 거부됩니다. Argon(`agy`) 리뷰어는 복구 모드에서는 `bwrap` 읽기 전용 격리가 필수이고, 정상 모드에서는 `bwrap`이 있으면 `bwrap` 읽기 전용 바인드(`bwrap-ro-bind`)로 실행하고 `bwrap`이 없으면 스냅샷 전용(`snapshot-only`, `--mode plan --sandbox`)으로 대체됩니다. 고정 `planReview`가 없으면 차례상 다음 모델이 먼저 리뷰합니다. 승인자 결정으로 승인된 인스턴스 설정 `.claude/deploy/config.json`에 다음 `planReview`를 추가하면 지정한 시각 전까지 그 리뷰어를 먼저 쓰고, 한도 실패일 때만 남은 하나로 넘어갑니다. 한도 실패는 종료 코드가 0이 아닌 정수이고 실행기 stderr·실행 오류에 한도 문구(rate limit, quota, usage limit, 429, RESOURCE_EXHAUSTED, exhausted)가 있을 때입니다. 리뷰 본문은 판별에 쓰지 않습니다. 신호로 끝난 실행(종료 코드 없음)은 한도로 보지 않습니다. 기존 설정의 다른 항목은 유지합니다.

```json
"planReview": {
  "reviewer": "codex",
  "until": "2026-11-13T23:40:00Z",
  "reason": "승인자 결정에 따른 임시 대체"
}
```

`until`이 없거나 지났을 때, 또는 `reviewer`가 작성자와 같을 때는 차례만 씁니다. 승인되지 않았거나 읽을 수 없는 설정은 기본 차례를 씁니다. 승인된 설정의 형식 오류(`reviewer`가 승인된 목록 밖, `until`이 ISO 시각이 아님)는 거부합니다. 관문은 차례 기록(`rotation: true`)의 리뷰어 영수증 1명을 받습니다. 기록 시각(`reviewedAt`)의 차례를 다시 만들어, `skipped`가 앞에서부터 건너뛴 후보 그대로이고(각각 0이 아닌 `exit_code`) 실제 리뷰어가 그 다음 후보인지 대조합니다. `reviewedAt`은 UTC ISO 시각이어야 하고, 리뷰어 영수증 시작 시각(`started_at`) 이전 90분 안이어야 합니다. 시각을 옮겨 다른 차례를 만드는 기록은 막습니다. 작성자와 같은 모델, 차례 밖 모델, 한도 기록 없는 뒤 후보, 2인 기록은 막습니다. 옛 모양 기록(`rotation` 칸 없음)은 `reviewedAt`과 리뷰어 영수증 시작 시각이 모두 차례 도입 시각(`2026-11-10T10:00:00Z`)보다 앞설 때만 받습니다. 새 기록에서 `rotation` 칸을 지워 차례 대조를 건너뛰는 길을 막습니다. 리뷰 뒤 `planReview`를 바꾸면 차례가 달라져 다시 리뷰해야 할 수 있습니다. 작성자와 리뷰어는 같을 수 없습니다.

리뷰어별 기본 모델·최소 강도는 코드에 고정합니다(`argon`: `gemini-4-argon-medium`/`medium`, `codex`: `gpt-6.1-terra`/`high`, `muse`: `muse-spark-1.3`/`xhigh`, 옛 기록용 `sol`: `gpt-6.1-sol`/`high`). 인스턴스의 `.claude/deploy/config.json`에 `review_models`를 쓰면 승인된 설정에 한해 리뷰어 ID별 정확한 모델 이름(`model`), 최소 강도(`effort`), 실행기(`runner`: `agy`, `muse`, `codex`, `claude`)를 적용합니다. 승인된 `review_models`는 사용할 리뷰어의 전체 목록이며 기본 리뷰어를 함께 쓰려면 목록에 명시해야 합니다. Claude 실행기는 `claude -p --model <정확한 이름> --effort <강도>`으로 호출합니다. 모델 이름의 계통이나 단어로 승인 여부를 판단하지 않습니다. 승인 확인이 안 된 설정은 코드 기본값을 씁니다. 영수증의 `receipt.effort`도 필수이며 설정에 맞아야 합니다.

기본 회전은 작성자를 제외한 우선순위의 앞 두 후보만 사용하며, 다른 리뷰어는 유효한 `planReview.reviewer`로 먼저 지정할 수 있습니다. Claude 작성자의 리뷰에는 `claude` 실행기 리뷰어를 쓰지 않습니다.

관문 설정을 바꾼 뒤에는 다음 순서로 승인받습니다.

1. 설정을 바꾸고 `node .claude/hooks/gate-config-approval.js`를 실행해 설정 해시, 승인 코드, 풀린 리뷰어 전체 목록과 작성자별 실제 리뷰어 차례를 확인합니다. 승인된 이전 설정의 별도 디렉터리와 `--approved-root`, `--approver-id`, `--channel-id`, `--message-id` 및 환경 변수 `DISCORD_BOT_TOKEN`을 제공하면 디스코드 승인을 확인한 뒤 리뷰어 차이도 표시합니다.
2. 승인자가 이 변경을 살펴보고 본인 디스코드 글에 승인 코드를 남깁니다. 봇·웹훅 글은 인정하지 않습니다. 인스턴스 관문 코드는 설정 밖에 고정된 승인자 번호와 해당 글 참조를 승인 확인에 전달해야 합니다. 공통 저장소에는 승인자 번호가 없으므로 기본 CLI에서는 승인된 설정도 적용되지 않습니다. 인스턴스에서 승인 확인을 관문 실행에 연결한 뒤 사용합니다.
3. 관문은 코드에 고정된 설정 파일의 현재 내용으로 해시와 `CFG-` 승인 코드를 다시 계산해 본인 글과 대조합니다. 파일이 한 글자라도 바뀌면 새 승인 코드가 필요합니다. 로컬 발급 기록이나 발급 시각은 확인하지 않습니다. 확인할 수 없거나 승인이 없으면 기본값을 사용합니다.

인스턴스 코드는 `deploy-plan.js`의 `withGateConfig({root, approverId, refs, token}, () => evaluate(ctx))`로 관문 검사를 감싸고, CLI에는 `approval-plan.mjs`의 `runApprovedApprovalPlan(options, argv)`를 호출합니다. `approverId`는 인스턴스 관문 코드의 상수이고, `refs`에는 확인할 코드와 디스코드 `channelId`·`messageId`를 넣습니다. 두 경로가 같은 승인 맥락을 써야 승인된 리뷰어로 작성한 영수증을 관문에서도 확인할 수 있습니다.

```json
"review_models": {
  "argon": { "model": "gemini-4-argon-high", "effort": "high", "runner": "agy" },
  "codex": { "model": "gpt-6.1-terra", "effort": "high", "runner": "codex" },
  "muse": { "model": "muse-spark-1.3", "effort": "xhigh", "runner": "muse" }
}
```

확정 리뷰어 목록은 `input_manifest_sha256`에 묶입니다. 이 변경이 병합되면 실행기와 입력 목록이 달라지므로 **열린 계획은 다시 리뷰하고 판정받아야 합니다.** 승인된 설정을 바꿔 확정 목록이 바뀐 경우에도 이전 리뷰 영수증, 건너뛴 리뷰어 기록 및 장애 판정 기록을 다시 발급해야 합니다.

```bash
node .agents/scripts/approval-plan.mjs review .agents/progress/<작업ID>/gates/deploy-plan.json --author muse
```

- 모든 기준이 `PASS`이고 `남은 지적: 0`(차단 지적 0건)이어야 통과합니다.
- 예외는 좁은 위험 수용 하나입니다. 승인자가 결정 글로 받아들인 경우 계획서에 `risk_acceptance` 칸(`criterion: "security"`, `accepted_by`, `decision_url`, `same_value_as`, `no_new_exposure: true`, `reason`, `expires_at`)을 모두 적으면, `security` 기준 하나의 `FAIL`과 그 기준을 적은 차단 지적 한 건만 면제합니다(`남은 지적`도 1이어야 합니다). 다른 기준이 하나라도 `FAIL`이거나, 차단 지적이 두 건 이상이거나, `security`를 적지 않은 차단 지적이 남거나, `expires_at`이 지났거나 `createdAt` 뒤 7일을 넘으면 그대로 막힙니다. 모르는 칸은 거부합니다. 이미 나간 값과 같은 값을 다시 내보낼 때만 쓰고, 새 노출을 만드는 계획에는 쓰지 않습니다.
- 리뷰 영수증(`gates/deploy-plan-review.json`)에는 계획서 SHA-256, 요청문 SHA-256, 고정 파일·실행기·확정 `review_models`(리뷰어별 `model`·`effort`·`runner`) 입력 목록 해시(`input_manifest_sha256`), 건너뛴 리뷰어(`skipped`)의 모델·강도, 그리고 리뷰 시점의 `readOnlyScripts` 바인딩 목록(`read_only_scripts`, 항목별 `sha256`·`path`·`service`)이 함께 묶입니다.
- **리뷰 뒤에 계획서나 고정 파일을 고치면 이전 리뷰와 승인 코드는 즉시 무효**가 되며 다시 리뷰를 받아야 합니다.

### 2.1 리뷰 중 저장소 쓰기 잠금 (`plan-review.lock` + `plan-review-write-guard`)

적대 리뷰가 도는 동안 다른 세션(3층 역할 세션, 2층 일꾼, 서브에이전트, 저장소 직접 세션)이 같은 인스턴스 저장소 안 파일을 고치면 입력 매니페스트·작업 트리 스냅샷이 어긋나 리뷰가 무효가 되거나 PASS 직후 관문이 막힙니다. 이를 글 규칙이 아니라 장치로 막습니다(상세: `docs/guides/plan-review-write-guard.md`).

- **잠금 파일**: `approval-plan.mjs review` 실행기는 시작할 때 계획서가 속한 저장소 뿌리 아래 `.agents/state/plan-review.lock`(`schema: "plan-review-lock/v1"`, `pid`, `pidStartTicks`, `plan`, `repoRoot`, `startedAt`, `expiresAt`, 기본 시한 60분·`APPROVAL_PLAN_REVIEW_LOCK_TTL_MS` 조정 가능)을 배타 생성(`wx`)하고, 정상 종료·실패·신호 중단(`SIGINT`/`SIGTERM`/`SIGHUP`) 모두에서 잠금 파일과 비어 있는 `.agents/state` 폴더를 지웁니다. 이미 살아 있는 잠금이 있으면 중복 리뷰 시작을 거부합니다.
- **PreToolUse 차단**: `.claude/hooks/plan-review-write-guard.js`(저장소 `.claude/settings.json` 및 사용자 프로파일 `templates/claude-user-profile/settings.json` 동시 등록)가 잠긴 저장소 안을 바꾸는 `Write`/`Edit`/`NotebookEdit`/`MultiEdit`/`apply_patch` 와 쓰기 셸 명령(리다이렉션, `sed -i`, `rm/cp/mv/touch/mkdir`, `git add/commit/checkout/reset/stash`, 인라인 Python/Node 파일 쓰기, 심볼릭 링크 우회 포함)을 가로채어 `"계획 리뷰 중(<계획 경로>, <시작 시각>) — 끝난 뒤 다시"` 안내와 함께 막습니다.
- **통과 범위**: 읽기 도구와 읽기 전용 셸 명령(`git status`, `git diff`, `ls`, `cat`, `rg`, `node --test` 등), 잠긴 저장소 밖 경로 쓰기, 리뷰 실행기 자신(PID 계보), 그리고 `gates/` 아래 리뷰 기록(`deploy-plan-review.json`, `deploy-plan-review-*.md`, `deploy-plan-review-findings.md` — 단 `deploy-plan.json` 원본 수정과 잠금 파일 삭제는 차단)은 그대로 통과합니다.
- **죽은·만료 잠금과 시한 감시**: 이전 프로세스가 죽었거나(`pid` 부재·좀비·PID 재사용) `expiresAt` 시한이 지난 잠금은 쓰기를 막지 않고 한 줄 알림(`additionalContext`)을 내보냅니다. 반대로 관문 입력·잠금 JSON 손상, 내부 오류, 또는 관문 프로세스 멈춤 시에는 `lib/hook-watchdog.js`(기본 15초, `NAIA_PLAN_REVIEW_GUARD_WATCHDOG_MS`)가 자식을 종료하고 **막음(fail-closed)** 으로 판정합니다.

---

## 3. 승인 코드 발급 (`preapprove`)

적대 리뷰를 통과한 계획서에 대해 전체 계획 코드(`PLAN-xxxxxx`)와 각 단계 코드(`STEP-xxxxxx`)를 발급받습니다.

```bash
node .agents/scripts/approval-plan.mjs preapprove .agents/progress/<작업ID>/gates/deploy-plan.json --session <세션ID>
```

- 이 명령은 보고문과 함께 `PLAN-xxxxxx` 및 단계별 `STEP-xxxxxx` 코드를 출력합니다.
- 코드가 발급되었다고 해서 승인된 것이 아닙니다. 승인자(사람)가 직접 그 코드를 입력해야만 효력이 생깁니다.
- 단계마다 따로 승인받으려면 `preapprove` 없이 바로 보고문(`node .agents/scripts/approval-plan.mjs report <계획서>`)을 올리고, 첫 실행 시도 때 관문이 발급하는 `PLAN-xxxxxx` / `STEP-xxxxxx` 코드를 순서대로 입력받을 수도 있습니다.

---

## 4. 사람에게 코드 요청 (`report` → 사람 입력)

승인자에게 계획 요약 보고문과 승인 코드를 올립니다.

```bash
node .agents/scripts/approval-plan.mjs report .agents/progress/<작업ID>/gates/deploy-plan.json
```

- **승인자에게 실행할 명령이나 스크립트를 복사·붙여넣기하게 넘기지 마십시오.**
- 승인자는 보고문을 검토한 뒤 두 가지 방법 중 하나로 승인합니다:
  1. **대화창 직접 입력**: 현재 세션 대화창에 사람이 직접 `PLAN-xxxxxx`와 허용할 단계의 `STEP-xxxxxx` 코드를 입력합니다(도구 출력·시스템 알림·AI 메시지는 인정되지 않음).
  2. **디스코드 본인 메시지**: 승인자 본인이 디스코드에 코드를 남기고, `gates/deploy-approval-discord.json`에 채널·메시지 ID를 기록하면 관문이 디스코드 REST API로 직접 작성자 ID(`approver.discordUserId`)와 시각을 대조합니다.

---

## 5. 실행 및 단계별 성공 확인 (`step-ok`)

승인자가 코드를 입력하면 계획서의 단계 명령을 순서대로 실행합니다.

1. **1단계 실행**: 관문(`deploy-guard.js`)이 명령을 가로채어 다음을 모두 대조합니다:
   - 계획서 존재 및 유효 기간(24시간 이내)
   - 계획서 `commands`와 실행 명령의 **정확한 바이트 일치** 및 정규화 SHA-256 일치
   - 단계 명령에 글자를 덧붙인 꼴(`… 2>&1 | tail`, `cd … && …`, `timeout …`, `> 파일`, `bash -c "…"`)은 승인된 명령이 아니라서 막힙니다. 읽기만 하는 단계도 같습니다. 덧붙여 돌리면 단계 승인과 실행 기록이 남지 않아 다음 단계가 막히므로, 출력이 길어도 계획서 글자 그대로 실행합니다.
   - 고정 파일(`files`) 및 명령이 참조하는 모든 파일의 **현재 디스크 SHA-256 일치**
   - 적대 리뷰 영수증(`deploy-plan-review.json`)과 입력 매니페스트 해시 일치
   - 인스턴스 서비스 준비 상태(`config/deploy-gate.json` 및 `gates/deploy.json`)
   - 사람의 `PLAN-xxxxxx` 및 해당 단계 `STEP-xxxxxx` 승인 확인(1회용, 실행 즉시 소진). 단, `gates/deploy.json`이 `kind: "ops"`이고 `config/deploy-gate.json`(git 추적·HEAD 일치, 와일드카드 금지)의 `readOnlyScripts`에 `{sha256, path, service}`가 리뷰 당시 영수증과 동일하게 묶여 있으며 대본 파일이 심볼릭 링크 없이 git 추적·HEAD 일치하고 명령이 허용된 정확한 꼴(`az vm run-command invoke ... --scripts @<등록 경로>` 또는 2토큰 `bash`/`sh <등록 경로>`)인 고정 읽기 대본이면 적대 리뷰 PASS 뒤 코드 단계만 건너뛰고 반복 실행할 수 있으며, 감사 기록(`audit.jsonl`)에 `"readonly-no-code"`(`approved_by: "readonly-no-code"`)로 남습니다.
2. **단계 성공 확인 기록 (`step-ok`)**: 다음 본 단계(`s2`)로 넘어가기 전에 반드시 앞 단계(`s1`)의 모든 명령이 실제로 실행(`status === "executed"`)되었고 성공 확인 출력 파일이 `step-ok`로 기록되어 있어야 합니다(`s1`을 실행하지 않고 `step-ok`만 먼저 부른 뒤 `s2`를 실행하는 단계 건너뛰기는 차단됩니다).
   ```bash
   node .agents/scripts/approval-plan.mjs step-ok .agents/progress/<작업ID>/gates/deploy-plan.json s1 --evidence /tmp/s1-check.txt
   ```
3. **실패·장애 시**:
   - 단계 확인이 실패하면 계획서의 `on_failure` 갈림길(예: 되돌리기 단계 `r1`)대로 행동하고 보고합니다.
   - 운영 장애 기준(`incident.criteria`)에 해당해 선조치(`incident.actions`)를 실행해야 할 때는 다른 독립 세션 판정(`node .agents/scripts/approval-plan.mjs judge <계획서> --evidence <로그> --executor-session <세션ID>`)을 받아야 하며(판정 모델·강도 `review_models.muse` 및 `input_manifest_sha256`이 현 설정과 일치해야 통과), 선조치 직후 `gates/deploy-incident-report-*.md` 보고서를 작성해야 다음 단계로 진행할 수 있습니다.
