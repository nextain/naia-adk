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
  - `prodPatterns` / `sshAlwaysGated`: 인스턴스 추가 운영 명령·SSH 호스트 분류 패턴
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
- `scenario[].covers`: 근거 정본 문서(`sourceDocs`)의 단계 ID 목록(`["1", "2"]` 등)을 적어, 정본의 어느 단계를 이 시나리오 단계가 수행하는지 대응시킵니다.

### 근거 정본 (`sourceDocs`)

운영 반영 절차가 담긴 정본 작업 문서(마크다운 등)를 요약해 배포 계획서를 만들 때 단계나 사후 인수 확인(acceptance)이 빠지는 사고를 막기 위해, `deploy-plan.json`에 `sourceDocs`와 `scenario[].covers`를 반드시 적습니다. 정본 대조 여부는 `sourceDocs` 선언만으로 결정하며 본문·rationale·steps의 자유 문장은 추정하지 않습니다. 계획서 또는 인스턴스 `config/deploy-gate.json`의 `sourcePolicy: "required"`는 선언을 필수화합니다. `null`이나 빈 배열은 잘못된 선언으로 거부합니다. 의도적 제외는 `excludedSourceSteps`에 이유를 적습니다.

```json
{
  "sourceDocs": [
    {
      "path": "docs/work/sample-rollout.md",
      "section": "운영 반영 단계",
      "acceptanceSection": "사후 확인",
      "sha256": "<정본 파일의 64자리 SHA-256>",
      "steps": [
        { "id": "1", "text": "DB 마이그레이션 반영" },
        { "id": "2", "text": "컨테이너 이미지 교체" },
        { "id": "6", "text": "시험 키 설정 주입" }
      ],
      "acceptance": [
        { "id": "acc-1", "text": "결제 3단계 화면에 시험 결제창이 뜸" }
      ]
    }
  ],
  "excludedSourceSteps": [
    { "id": "2", "reason": "이번 작업은 설정 주입 전용이라 이미지 교체를 제외함" }
  ]
}
```

- **정본 단계 추출 도우미 (`source-steps`)**: 마크다운 정본 문서의 지정 절(`--section <제목>`)에서 `(1)`·`1.`·`- [ ]` 꼴 단계 목록을 뽑아 `sourceDocs` 초안 JSON(`path`, `sha256`, `steps`)을 만듭니다.
  ```bash
  node .agents/scripts/approval-plan.mjs source-steps docs/work/sample-rollout.md --section "운영 반영 단계" --acceptance-section "사후 확인"
  ```
- **관문 검사 (`check` 및 승인 코드 발급 경로)**:
  1. **정본 파일 SHA-256 대조**: `sourceDocs[].path` 경로는 저장소 내 정규 상대 경로여야 하며 realpath가 밖을 가리키는 심볼릭 링크도 거부합니다. 파일의 현재 디스크 SHA-256(소문자 비교)이 `sourceDocs[].sha256`과 다르면 차단합니다.
  2. **정본 단계 누락 차단**: 지정 절을 원문에서 재추출해 `steps`와 `acceptance` 전체를 대조합니다. 두 절 밖에 지원 목록 형식의 단계가 있거나 절을 일부만 선택해도 거부합니다. 정본은 실행 단계와 인수 확인만 담은 전용 마크다운 파일로 관리합니다. `sourceDocs[].steps`의 모든 `id`가 어느 `scenario[]` 단계의 `covers` 배열에 들어 있거나, 계획서 최상위 `excludedSourceSteps: [{id, reason}]`에 이유(`reason`)와 함께 적혀 있어야 통과합니다. 하나라도 빠지면 `"정본 단계 누락: <id> <text>"`로 막고 승인 코드를 내주지 않습니다.
  3. **인수 확인(`acceptance`) 실측 검증**: `sourceDocs`를 선언한 계획서에서 되돌리기 갈림을 제외한 마지막 실행 단계의 `step-ok`는 현재 계획서 SHA-256에 묶인 완료 JSON 보고서를 반드시 검사합니다. 인수 확인 항목마다 실측 문자열이 필요하며 `-`, `N/A`, `TBD`, `확인함` 같은 빈말과 문자열이 아닌 값은 거부합니다. 허용 실측 키는 `실측`, `actual`, `observed`, `measured`, `measurement`, `evidence`, `result`, `value`입니다. 이 검사는 형식과 누락을 막으며 관측 내용의 진실성은 독립 검토와 증거 대조로 확인해야 합니다.
  4. **ID와 호환**: 모르는 ID, 중복 steps/acceptance/covers/excluded, covers와 제외의 동시 선언을 거부합니다. 여러 문서는 covers·제외·완료 실측에 `문서경로#ID`를 씁니다. 한 단계 ID를 여러 scenario에서 재사용할 수 없으며 되돌리기 단계의 covers로 실행 단계 누락을 대신할 수 없습니다. `sourceDocs` 선언이 없는 옛 계획서는 필수 정책이 없으면 본문 파일명과 무관하게 한 줄 경고로 통과하며 완료 보고를 강제하지 않습니다. 정본 대조를 도입할 때는 선언을 보강하고 재리뷰·재승인합니다.

---

## 2. 적대 리뷰 받기 (`review`)

계획서 양식과 고정 파일 SHA-256이 모두 맞으면 독립 리뷰어 모델(Argon)로 아홉 가지 기준(`correctness`, `disconnect`, `rerun`, `rollback`, `irreversible`, `security`, `impact`, `honesty`, `incident_safety`) 적대 리뷰를 받습니다.

```bash
node .agents/scripts/approval-plan.mjs review .agents/progress/<작업ID>/gates/deploy-plan.json --author muse
```

- 모든 기준이 `PASS`이고 `남은 지적: 0`(차단 지적 0건)이어야 통과합니다.
- 리뷰 영수증(`gates/deploy-plan-review.json`)에는 계획서 SHA-256, 요청문 SHA-256, 고정 파일·실행기 입력 목록 해시(`input_manifest_sha256`)가 함께 묶입니다.
- **리뷰 뒤에 계획서나 고정 파일을 고치면 이전 리뷰와 승인 코드는 즉시 무효**가 되며 다시 리뷰를 받아야 합니다.

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

## 완료 확인과 영수증

`report`는 실행 전 승인 요청문을 만드는 명령입니다. 완료 상태는 `sourceDocs`를 선언한 계획서의 마지막 본 단계 `step-ok`에서 검사합니다. `branch: "rollback"` 또는 `rollback.step_ids`에 든 단계는 되돌리기 단계이며 앞 단계 성공 기록을 요구하지 않습니다. 기본 보고서 경로는 계획서와 같은 폴더의 `deploy-completion.json`이며 `--report <파일>`로 지정할 수도 있습니다.

```json
{
  "plan_sha256": "<현재 deploy-plan.json 파일의 SHA-256>",
  "acceptance": [
    { "id": "acc-1", "actual": "12:00 UTC 가상 시험 화면에서 결제창 표시를 관측; 증거 sample-screen.txt" }
  ]
}
```

```bash
node .agents/scripts/approval-plan.mjs step-ok <계획서> <마지막단계> --evidence <성공출력> --report <완료보고.json>
node .agents/scripts/approval-plan.mjs complete-check <계획서> --report <완료보고.json>
node .agents/scripts/approval-plan.mjs complete <계획서> --report <완료보고.json>
```

정본 선언 계획서는 각 단계의 최신 실행 시도가 `executed`이고 해당 시도의 모든 명령이 실행되어야 성공을 기록합니다. 완료 검사에는 모든 본 단계의 성공 증거도 필요합니다. 같은 단계 재실행을 요청하거나 `step-ok`를 다시 시도하면 이전 단계 성공 기록과 완료 영수증을 무효화하며, `complete` 실패도 이전 완료 영수증을 지웁니다. 증거 파일과 완료 검사가 모두 통과한 뒤에만 새 기록을 씁니다.

마지막 `step-ok`와 `complete`는 검사가 통과하면 `deploy-completion-receipt.json`에 계획서 SHA-256, 보고서 SHA-256, 판정 시각을 기록합니다. `complete-check`는 검사만 합니다. `actual: "확인함"`, 보고서 누락, 이전 계획서 SHA-256을 담은 보고서는 실패하며 마지막 단계 성공 기록을 쓰지 않습니다. 마지막이 아닌 단계는 기존처럼 성공 증거만 기록합니다. 일반 대화문이나 이 도구 밖의 상태 기록은 이 CLI가 강제할 수 있는 범위가 아닙니다.

정본이 없는 호환 계획서의 경고는 `check`, `report`, `review`, `preapprove`, `step-ok`, `complete`, `complete-check`에서 표시합니다. 경고가 있어도 정본 선언 계획서의 필수 검사 실패를 승인으로 바꾸지는 않습니다.
