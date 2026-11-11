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
- `services`: 관문이 분류한 운영 서비스 키를 빠짐없이 적습니다.
- `scenario`: 실행할 단계(`s1`, `s2`, …)와 되돌리기 갈림길(`branch: "rollback"`)을 순서대로 적습니다.
- `scenario[].commands`: **실제로 실행할 명령 문자열을 한 글자도 바꾸지 말고 그대로** 적습니다. 실행할 때 바이트 단위로 대조하므로 공백이나 따옴표가 달라도 막힙니다.
- `scenario[].files`: 명령이 읽거나 실행하는 스크립트·설정 파일(`bash ./deploy.sh`, `--yaml app.yaml`, `@body.json` 등)은 반드시 `"경로": "<sha256>"` 형태로 고정합니다. 파일 내용이 1바이트라도 바뀌면 실행이 차단됩니다(`bash scripts/rollout.sh` 재귀 검사는 스크립트 폴더로 자동 이동하지 않고 호출자 작업 디렉터리를 유지하며, 스크립트 안의 명시적 `cd`만 반영합니다).
- 사전승인 코드 일괄 발급(`preapprove`)을 쓰려면 최상위에 `"approval_mode": "preapprove_steps"`를 넣습니다.

**읽기 전용 계획(`read_only`).** 바꾸는 것 없이 운영 상태만 읽는 계획은 최상위에 `"read_only": true`를 적습니다. 양식 검사가 이 칸을 기계로 확인합니다. 모든 단계와 장애 선조치의 명령이 읽기 갈래(배포 준비 기록 ops 판정의 조회 갈래: `az … show·list·logs` 같은 조회 동사, VM·컨테이너 안 글이 조회·진단 명령뿐인 `az vm run-command invoke`·`az containerapp exec`·`ssh`, 로컬 조회 명령)여야 하고, 재시작·멈춤·설정 변경이나 안이 보이지 않는 글(`@파일`, 대본 파일 실행, 변수)은 읽기가 아닙니다. 되돌리기 단계(`branch: "rollback"`)를 두지 않고 `rollback.step_ids`는 `[]`로 둡니다. 하나라도 어기면 양식에서 막힙니다. 통과하면 리뷰 요청문의 기준이 바뀝니다. rollback 은 "계획서가 read_only 이고 바꾸는 것이 없으면, 복귀 단계 없음과 그 근거가 적혀 있는 것으로 충족한다", disconnect 는 "read_only 계획은 끊기면 결과를 버리고 다시 실행한다고 적혀 있으면 충족한다"입니다. 그래서 `rollback.method`에는 복귀 단계가 없는 근거를, `disconnect_safety`에는 끊기면 결과를 버리고 다시 실행한다는 것을 적습니다. `read_only`가 없거나 `false`이면 기준 문구는 그대로입니다.
`read_only` 명령의 리다이렉트는 해석하지 않고 거부합니다. 명령 원문과 따옴표를 벗긴 낱말에 `>`·`<`가 있으면 막고, 낱말 전체가 정확히 `2>/dev/null`·`>/dev/null`·`2>&1`·`>&2`이고 앞뒤에 따옴표·역빗금이 붙지 않을 때만 받습니다(원격 본문·`bash -c` 글 안도 같음, 따옴표가 붙으면 셸이 대상 이름에 이어 붙이기 때문). 그래서 `ssh … "cat x 2>/dev/null"`처럼 따옴표 글 끝에 붙은 꼴과 `az … --query "[?a > b]"`처럼 비교 연산자를 쓰는 조회도 `read_only`에서는 막힙니다. 받아들인 비용이며, 이런 조회는 `>`·`<` 없이 쓰거나 `read_only` 없이 계획합니다.
`read_only`의 `curl`과 DB 명령은 허용 목록으로 판정합니다. `curl`은 `-s -S -f -L -I -m -H -o /dev/null -w -X GET|HEAD`와 그 긴 이름, `--connect-timeout`만 받고(묶인 `-sfX`·붙은 값 `-dx=1`도 풀어서 봄) 주소는 `http://`·`https://`만 받으며(`gopher`·`dict`·`telnet`·`file`·`ftp`·스킴 없는 주소는 거부), `psql`·`mysql`·`mariadb`·`sqlite3`는 접속·출력 모양 옵션과 `select`·`show`·`describe`·psql `\d` 문장만 받으며, `explain`·역빗금·`/*` 주석과 집계 함수(`count`·`max`·`min`·`sum`·`avg`·`now`) 밖의 `(`를 거부합니다. 그래서 `curl -u`·`-b`·`-k`·`--compressed`, 함수를 쓰는 조회, `in (…)`·하위 질의, `mysql -p`도 `read_only`에서는 막힙니다(받아들인 비용). `psql`은 `-X`(`--no-psqlrc`)가 있어야 합니다(`-c`여도 psqlrc 를 읽기 때문).
`read_only` 명령은 환경 변수를 바꾸지 못합니다. 앞머리 대입(`CURL_HOME=… curl …`, `PSQLRC=… psql …`, `sudo LD_PRELOAD=… …`, 홀로 선 `A=…;` 절), `docker exec`·`docker compose exec`의 `-e`·`--env`·`--env-file`, 원격 본문·`bash -c` 글 안의 `VAR=` 앞머리를 모두 거부합니다. 명령 치환·변수 펼침도 해석하지 않고 거부합니다. 로컬 명령 원문에 `$(`·백틱·`${`가 있으면 막고(따옴표 안 글자도 막힘, 받아들인 비용), 원격 본문은 전처럼 `$VAR`까지 막습니다. 로컬의 맨 `$VAR`는 `sed -n '$p'` 같은 글자 때문에 보지 않습니다.

---

## 2. 적대 리뷰 받기 (`review`)

계획서 양식과 고정 파일 SHA-256이 모두 맞으면 차례상 다음 모델(`argon`→`codex`→`muse`→`argon`) 한 명에게 아홉 가지 기준(`correctness`, `disconnect`, `rerun`, `rollback`, `irreversible`, `security`, `impact`, `honesty`, `incident_safety`) 적대 리뷰를 받습니다. 작성자는 셋 중 누구나 될 수 있고, 첫 후보가 한도에 걸리면 남은 하나로 넘어가며 넘긴 기록은 `skipped`로 남깁니다.

Muse 리뷰어는 읽기 전용 호출(`--disable-write --disable-shell`)로 그대로 돌리고, Codex·Argon 리뷰어 실행에는 복구 모드 여부와 관계없이 `bwrap` 읽기 전용 격리가 필요합니다. 고정 `planReview`가 없으면 차례상 다음 모델이 먼저 리뷰합니다. 승인자 결정으로 인스턴스의 `.claude/deploy/config.json`에 다음 `planReview`를 추가하면 지정한 시각 전까지 그 리뷰어를 먼저 쓰고, 한도 실패일 때만 남은 하나로 넘어갑니다. 한도 실패는 종료 코드가 0이 아닌 정수이고 실행기 stderr·실행 오류에 한도 문구(rate limit, quota, usage limit, 429, RESOURCE_EXHAUSTED, exhausted)가 있을 때입니다. 리뷰 본문은 판별에 쓰지 않습니다. 신호로 끝난 실행(종료 코드 없음)은 한도로 보지 않습니다. 기존 설정의 다른 항목은 유지합니다.

```json
"planReview": {
  "reviewer": "codex",
  "until": "2026-11-13T23:40:00Z",
  "reason": "승인자 결정에 따른 임시 대체"
}
```

`until`이 없거나 지났을 때, 또는 `reviewer`가 작성자와 같을 때는 차례만 씁니다. 설정 JSON 파스 오류와 형식 오류(`reviewer`가 차례 셋 밖, `until`이 ISO 시각이 아님)는 거부합니다. 관문은 차례 기록(`rotation: true`)의 리뷰어 영수증 1명을 받습니다. 기록 시각(`reviewedAt`)의 차례를 다시 만들어, `skipped`가 앞에서부터 건너뛴 후보 그대로이고(각각 0이 아닌 `exit_code`) 실제 리뷰어가 그 다음 후보인지 대조합니다. `reviewedAt`은 UTC ISO 시각이어야 하고, 리뷰어 영수증 시작 시각(`started_at`) 이전 90분 안이어야 합니다. 시각을 옮겨 다른 차례를 만드는 기록은 막습니다. 작성자와 같은 모델, 차례 밖 모델, 한도 기록 없는 뒤 후보, 2인 기록은 막습니다. 옛 모양 기록(`rotation` 칸 없음)은 `reviewedAt`과 리뷰어 영수증 시작 시각이 모두 차례 도입 시각(`2026-11-10T10:00:00Z`)보다 앞설 때만 받습니다. 새 기록에서 `rotation` 칸을 지워 차례 대조를 건너뛰는 길을 막습니다. 리뷰 뒤 `planReview`를 바꾸면 차례가 달라져 다시 리뷰해야 할 수 있습니다. 작성자와 리뷰어는 같을 수 없습니다.

```bash
node .agents/scripts/approval-plan.mjs review .agents/progress/<작업ID>/gates/deploy-plan.json --author muse
```

- 모든 기준이 `PASS`이고 `남은 지적: 0`(차단 지적 0건)이어야 통과합니다.
- 예외는 좁은 위험 수용 하나입니다. 승인자가 결정 글로 받아들인 경우 계획서에 `risk_acceptance` 칸(`criterion: "security"`, `accepted_by`, `decision_url`, `same_value_as`, `no_new_exposure: true`, `reason`, `expires_at`)을 모두 적으면, `security` 기준 하나의 `FAIL`과 그 기준을 적은 차단 지적만 면제합니다. 다른 기준이 하나라도 `FAIL`이거나, `security`를 적지 않은 차단 지적이 남거나, `expires_at`이 지났거나 `createdAt` 뒤 7일을 넘으면 그대로 막힙니다. 모르는 칸은 거부합니다. 이미 나간 값과 같은 값을 다시 내보낼 때만 쓰고, 새 노출을 만드는 계획에는 쓰지 않습니다.
- 리뷰 영수증(`gates/deploy-plan-review.json`)에는 계획서 SHA-256, 요청문 SHA-256, 고정 파일·실행기 입력 목록 해시(`input_manifest_sha256`)가 함께 묶입니다.
- **리뷰 뒤에 계획서나 고정 파일을 고치면 이전 리뷰와 승인 코드는 즉시 무효**가 되며 다시 리뷰를 받아야 합니다.

**리뷰 회차 기억.** `review`는 리뷰마다 `gates/review-rounds/round-<NNN>.json`을 새로 쌓고 덮어쓰지 않습니다(계획서 사본, 기록, 기준별 판정, 차단 지적). `gates/deploy-plan-review.json`은 지금처럼 최신 판입니다. 회차 파일이 없을 때 앞서 받은 `deploy-plan-review.json`이 있으면 그것을 첫 회차로 옮깁니다. 같은 계획서 경로에 직전 회차(판정 PASS 또는 FAIL)가 있으면 요청문에 그 회차의 기준별 판정, 차단 지적, 그 뒤 바뀐 칸과 규칙 한 문장("바뀌지 않은 부분에서 이전에 PASS 한 기준을 FAIL 로 바꾸려면 이전 판정이 틀린 이유를 적을 것. 새 차단은 이번에 바뀐 부분에서 찾을 것.")을 붙입니다. 기록의 `prior_round`가 그 회차 파일과 sha256 을 가리키고, 관문은 그 파일로 같은 요청문을 다시 만들어 대조합니다. 같은 계획서가 연속 3회 FAIL 이면(리뷰어 실행 실패 회차는 세지 않음) 4회차 `review`는 리뷰어를 돌리지 않고 "사람 판정 요청"과 남은 차단 지적 목록을 내고 코드 4로 끝납니다. 이때 승인자가 지적마다 수용·수정을 판정합니다. 위험 수용은 위의 `risk_acceptance` 칸(`security` 기준 하나만)뿐이고 범위는 넓히지 않았습니다.
- 회차 확정: `review`는 회차 파일 → 최신 영수증 → 확정 표지 `round-<NNN>.ok`(방금 쓴 영수증 바이트의 sha256) 순서로 쓰고(표지는 임시 파일에 다 쓴 뒤 link 로 만들어, link 전 어느 오류든 표지가 남지 않음. 디스크 상태가 정본이라 link 가 오류를 내도 표지가 생겼으면 확정·성공), 어느 단계든 실패하면 코드 3으로 끝납니다. link 오류 뒤 확인용 stat 까지 실패해 확정됐는지 알 수 없으면 코드 5("확정 여부 불명")로 끝나고, 판정은 디스크를 따릅니다: `approval-plan check` 로 관문 상태를 보고 막히면 다시 리뷰합니다. 표지가 없거나 회차 안 기록과 맞지 않는 회차는 판정 "없음"으로 보아 직전 회차·연속 FAIL 에 쓰지 않습니다. 관문은 `gates/review-rounds/`가 있으면 가장 최근 회차의 표지가 지금 `deploy-plan-review.json` 바이트 sha256 과 같아야 통과합니다(폴더가 없는 옛 기록은 예전대로 판정).
- `deploy-plan.js`는 리뷰 입력 목록(`REVIEW_EXECUTOR_FILES`)에 들어 있어, 이 파일이 바뀌면 그 전에 받은 PASS 영수증은 모두 다시 리뷰해야 합니다.

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
   - 고정 파일(`files`) 및 명령이 참조하는 모든 파일의 **현재 디스크 SHA-256 일치**
   - 적대 리뷰 영수증(`deploy-plan-review.json`)과 입력 매니페스트 해시 일치
   - 인스턴스 서비스 준비 상태(`config/deploy-gate.json` 및 `gates/deploy.json`)
   - 사람의 `PLAN-xxxxxx` 및 해당 단계 `STEP-xxxxxx` 승인 확인(1회용, 실행 즉시 소진)
2. **단계 성공 확인 기록 (`step-ok`)**: 다음 본 단계(`s2`)로 넘어가기 전에 반드시 앞 단계(`s1`)의 모든 명령이 실제로 실행(`status === "executed"`)되었고 성공 확인 출력 파일이 `step-ok`로 기록되어 있어야 합니다(`s1`을 실행하지 않고 `step-ok`만 먼저 부른 뒤 `s2`를 실행하는 단계 건너뛰기는 차단됩니다).
   ```bash
   node .agents/scripts/approval-plan.mjs step-ok .agents/progress/<작업ID>/gates/deploy-plan.json s1 --evidence /tmp/s1-check.txt
   ```
3. **실패·장애 시**:
   - 단계 확인이 실패하면 계획서의 `on_failure` 갈림길(예: 되돌리기 단계 `r1`)대로 행동하고 보고합니다.
   - 운영 장애 기준(`incident.criteria`)에 해당해 선조치(`incident.actions`)를 실행해야 할 때는 다른 독립 세션 판정(`node .agents/scripts/approval-plan.mjs judge <계획서> --evidence <로그> --executor-session <세션ID>`)을 받아야 하며, 선조치 직후 `gates/deploy-incident-report-*.md` 보고서를 작성해야 다음 단계로 진행할 수 있습니다.
