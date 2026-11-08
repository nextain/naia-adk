# 설계 변경 산출물 의도 시험 관문 (Design Intent Guard)

요구사항(REQ)의 설계가 바뀌었을 때, 그 설계로 만들어지거나 그 설계를 쓰는 앞 단계 산출물(upstream/stage artifact)의 **의도 시험(intent test)** 이 적혀 있고 실제로 다시 돌았는지 확인하여 설계·산출물 의미 드리프트를 막는다.

## 1. 왜 필요한가 (배경)

다단계 파이프라인에서는 뒤 단계 설계가 바뀌면서 앞 단계 산출물이 맡아야 할 **의미적 역할(설계 의도)** 이 달라지는 일이 자주 일어난다.

- 예를 들어 문서 변환 파이프라인의 앞 단계 **"표 추출물 (`artifacts/extracted-tables.json`)"** 산출물을 생각하자.
  - **초기 설계**: 1단계 표 추출기는 원문 문서의 금액 열을 통화 기호가 섞인 원시 문자열(`"₩125,000"`) 그대로 내보내어 단순 열람 화면에 표시했다.
  - **변경된 설계**: 2단계 재무 집계 모듈이 금액 열을 직접 합산·비교하는 구조로 바뀌었다. 이제 앞 단계 산출물인 `artifacts/extracted-tables.json`의 각 행은 통화 단위가 정규화된 음수 아닌 정수(`amount_krw >= 0`)와 구문 분석 오류율 상한(`row_parse_error_rate <= 0.005`)을 보장해야 한다.
- 만약 2단계 집계 설계만 바꾸고 1단계 표 추출 공정은 예전 그대로 두면, 문자열 금액 때문에 뒤 단계 합산이 깨지거나 누락되는 의미 드리프트가 발생한다.
- 이때 기존 시험이 **파일 모양·개수(파일이 존재하는지, 확장자가 `.json`인지, 레코드 개수가 10개 이상인지)** 만 검사하면 모든 시험이 통과하여 오랫동안 아무 관문에도 걸리지 않는다.
- 또한 미커밋 대본 실행을 막는 `artifact-drift-guard`는 "커밋된 대본으로 만들었는가"만 볼 뿐, **"그 산출물이 바뀐 설계 의도대로인가"** 는 검사하지 않는다.

따라서 요구사항(REQ) 하나가 **이 설계로 만들어지는(또는 이 설계를 쓰는) 산출물**과 **그 산출물이 지켜야 할 기계적 의도 시험**을 명시하게 하고, 설계가 바뀔 때마다 앞 단계 산출물의 의도 시험을 다시 거치도록 강제한다.

## 2. 구성 요소

| 구분 | 파일 | 시점 | 역할 |
| --- | --- | --- | --- |
| 요구사항 양식 | `.agents/requirements/_template.yaml` | 요구사항 작성·변경 | `design` 칸과 `artifacts[].intent_test` (`condition`, `test_path`, `symbol`, `receipt`) 정의 |
| 정책 모듈 | `.agents/hooks/policies/design-intent-guard.js` (`.agents/hooks/policies/bash.js`) | `git commit` / CLI | 요구사항 설계 칸 변경·폐기 감지 및 산출물별 (a) 의도 시험 기재, (b) 실제 시험 파일·식별자 심볼·단언문·기준값·산출물 실독 정합성, (c) 관문 재실행 및 영수증 확인 |
| 훅 및 CLI 실행기 | `.claude/hooks/intent-guard.js` | `PreToolUse` (`Bash`) / CI | 커밋 전 차단, `--run-tests` 의도 시험 실행 영수증(`.agents/intent-receipts/<REQ-ID>.json`) 발급, `--check` (`--staged`, `--worktree`, `--commit <rev>`) 검사 실행 |
| 거버넌스 규칙 | `.agents/context/agents-rules.json` (`conventions.design_intent_guard`) | 상시 | 파일 모양·개수만 보는 시험 금지 및 설계 변경 시 앞 단계 산출물 의도 시험 의무화 |

## 3. 어떻게 쓰는가 (요구사항 작성 규칙)

`.agents/requirements/_template.yaml`에 추가된 `design` 및 `artifacts` 칸을 채운다(문서 변환 단계의 표 추출물 예시):

```yaml
id: REQ-001-table-schema-stage
title: "Two-stage document conversion over extracted table records"
title_ko: "문서 변환 파이프라인의 앞 단계 표 추출물 열 계약"
status: active

description: |
  뒤 단계 수치 집계기가 표 추출물을 곧바로 합산할 수 있도록 앞 단계 표 추출물과 열 의미 계약을 정의한다.

acceptance_criteria:
  - "표 추출물의 구문 분석 오류율이 0.005 이하이고 금액 열은 KRW 기준 0 이상의 정수여야 한다."

design: |
  2단계 수치 집계 모듈이 금액 열을 직접 합산하므로, 앞 단계 산출물인 표 추출물(artifacts/extracted-tables.json)은
  모든 행에서 amount_krw를 0 이상의 정수로 정규화하고 row_parse_error_rate <= 0.005를 유지해야 한다.

artifacts:
  - id: "extracted-tables-json"
    path: "artifacts/extracted-tables.json"
    stage: "upstream-table-extractor"
    intent_test:
      condition: "row_parse_error_rate <= 0.005 and amount_krw >= 0"
      test_path: "tests/extracted-tables-intent.test.mjs"
      symbol: "verifyExtractedTablesIntent"
      receipt: null
```

### 의도 시험(`intent_test`) 작성 및 판정 원칙

1. **내용 지표·비교 연산 기반 조건 판정 (파일 모양·개수 전용 조건 차단)**:
   - 판별기는 단순 금지어 블랙리스트에 의존하지 않고, `condition`이 **산출물의 내용 지표(속성·오차율·상태값)와 비교 연산자(`<=`, `>=`, `<`, `>`, `==`, `!=`, `=`, `이하`, `이상` 등) 및 구체적 기준값**을 포함하는지로 구조적 판정을 수행한다.
   - `"파일 존재 및 레코드 개수만 확인"`, `"파일이 존재한다"`, `"파일 있음"`, `"verify the file is present"`, `"file_count >= 1"`, `"파일 크기 >= 100B"`처럼 외형·존재·크기·개수만 가리키는 조건은 조사나 어미를 바꾸더라도 `(a)` 단계에서 차단된다.
2. **실제 시험 파일(`test_path`) 식별자·단언문·수치·산출물 실독 검증**:
   - 주석과 문자열 리터럴을 모두 제외한 실제 식별자 코드 위치에 `symbol`(지정 시)과 `condition`의 수치 기준값(예: `0.005`, `0`)이 등장해야 한다. 주석이나 문자열 리터럴에만 심볼·숫자를 적어 넣으면 `(b)` 단계에서 차단된다.
   - 단언문(`assert`/`expect`)은 단일 인자 동어반복(`assert.ok(true)`)뿐 아니라 다인자 상수-상수 비교(`assert.equal(1, 1)`, `assert.deepStrictEqual({}, {})`)도 차단하며, 최소 1개 단언의 피연산자에 비리터럴 식별자가 포함되어야 한다.
   - 산출물 경로(`artifact.path` 또는 단계 식별자)를 코드에서 참조·실독하지 않고 조건 지표 변수에 상수 리터럴만 대입하는 공허한 상수 시험은 `(b)` 단계에서 차단된다(정적 분석만으로는 임의 코드의 완전한 의미론적 동치까지 증명할 수 없으므로 관문의 시험 직접 재실행 및 코드 리뷰와 병행한다). 이때 거짓 차단을 피하려면 산출물 경로(예: `"artifacts/extracted-tables.json"`)나 단계 식별자는 헬퍼에 숨기지 말고 **리터럴로 직접 기재**하고, 기대값 상수는 조건 지표명과 같은 이름(`const amount_krw = 0`) 대신 **`const min_amount_krw = 0`처럼 지표명과 다른 이름**을 사용해야 한다.
3. **관문 커밋 시점 블롭 직접 재실행 및 커밋 가능 영수증(`.agents/intent-receipts/`) 검증**:
   - 공개 상수나 해시만으로 영수증을 재계산해 위조하는 시도를 막기 위해, 관문은 커밋·검사 시점에 `node --test --test-reporter=tap <test_path>`를 **직접 다시 실행**하여 종료 코드(`exit_code === 0`)와 정규화된 TAP 판정·집계(`ok`/`not ok` 및 `tests`/`pass`/`fail` 집계 + `exit_code`) 출력 지문(`output_sha256`), 대상 파일 지문(`design_sha256`, `test_sha256`, `artifact_sha256`)이 모두 일치하는지 대조한다. 일반 `console.log` 진단·시각·임시 경로 출력은 정규화에서 제외되어 정상 시험의 영수증이 흔들리지 않으며, 의도 시험 자체도 외부 환경 변수나 비결정적 상태에 의존하지 않게 작성해야 한다.
   - `staged` 및 `--commit <rev>` 모드에서는 작업 트리 파일을 그대로 믿지 않고 **스테이지(인덱스)·커밋 블롭을 임시 디렉터리에 꺼내(materialize) 정적 검사와 실행을 수행**하며, `staged` 모드에서 작업 트리와 인덱스 내용이 어긋나 있으면 즉시 차단하고 `git add` 안내를 출력한다.
   - 기본 영수증 경로는 `.gitignore` 대상이 아닌 `.agents/intent-receipts/<REQ-ID>.json`이며, 영수증으로 통과하려면 영수증 파일도 같은 변경 집합(스테이지·커밋)에 함께 포함되어야 CI(`--commit HEAD`)에서 그대로 재현된다.
   - **신뢰 경계**: 관문은 의도 시험(`test_path`)을 커밋·검사 시점에 최소 허용 환경 변수(`PATH`, `TZ=UTC`, `LANG=C.UTF-8` 등)와 격리된 프로세스 그룹(종료·타임아웃 시 자손 프로세스 그룹 통째 종료)으로 자동 실행하므로, 모르는 브랜치나 외부 기여의 설계 변경을 커밋·검사하기 전에는 시험 파일을 먼저 읽고 확인해야 한다.

## 4. 검사기 동작 원리

요구사항 파일(`.agents/requirements/*.yaml`, `_index.yaml`·`_template.yaml` 제외)의 설계 칸(`design`, `description`, `acceptance_criteria`, `change_effect`, `preserves`, `must_not_change`, `decisions`, `artifacts`)이 바뀐 커밋 또는 작업 트리에서 아래를 검사한다.

1. **(a) 의도 시험 기재 및 요구사항·섹션 삭제 방어**:
   - 산출물마다 `intent_test.condition`과 `intent_test.test_path`가 유효한 내용 지표 비교 조건인지 확인한다.
   - 설계·산출물이 정의된 요구사항 파일을 직접 삭제하거나, `design`·`artifacts` 섹션을 통째로 지우는 2단계 삭제 우회 시도는 차단된다. 파일 이름 이동은 동일한 `id`와 설계를 유지해 `git mv`로 함께 스테이지해야 하며, 정당한 폐기는 `status: retired` 전환과 의도 시험 재검증으로만 가능하다.
2. **(b) 실제 시험 파일·심볼·단언문·기준값·산출물 실독 확인**:
   - `test_path`가 저장소 내부 일반 파일로 존재하고, 주석·문자열 리터럴을 제외한 코드에 선언된 `symbol`, 비리터럴 피연산자 단언문, `condition`의 수치 기준값, 산출물 참조가 포함되어 있는지 확인한다.
3. **(c) 같은 변경에서 다시 돌았는지 및 관문 직접 재실행 확인**:
   - 관문은 커밋·검사 시점에 `test_path`를 직접 실행해 통과(`exit_code === 0`)함을 확인하며, 다음 둘 중 하나를 함께 만족해야 한다:
     - **같은 변경 집합에 시험 파일 갱신 포함**: 바뀐 설계 의도에 맞춰 갱신·검증된 `test_path` 파일이 같은 커밋(또는 스테이지 집합)에 함께 포함되고 관문 직접 실행을 통과함.
     - **커밋된 실행기 시험 영수증(`receipt`) 확인**: `--run-tests` 실행기가 기록한 `.agents/intent-receipts/<REQ-ID>.json`(또는 `intent_test.receipt`)이 같은 변경 집합에 스테이지·커밋되어 있고, `design_sha256`, `test_sha256`, `artifact_sha256`, `exit_code === 0`, `output_sha256`이 관문의 직접 재실행 결과와 일치함.
4. **거짓 차단 방지 및 범위 분리**:
   - 일반 `git commit`은 스테이지된 파일 집합만 검사하므로, 작업 트리에 미스테이지 상태의 요구사항 수정이 남아 있어도 무관한 파일만 스테이지한 커밋은 차단하지 않는다(`git commit -a` 또는 `--worktree` 실행 시에만 작업 트리 변경 포함).
5. **차단 메시지**:
   - 위 조건 중 하나라도 빠지면 커밋을 막고 **`다시 검사해야 할 앞 단계 산출물:`** 목록과 구체적인 누락 사유(`(a)`/`(b)`/`(c)`)를 출력한다.

## 5. CLI 실행 및 CI 최종 관문

셸 훅(`PreToolUse` `Bash`)은 `.claude/hooks/lib/git-command-parser.js`와 `.claude/hooks/lib/effective-argv.js`를 재사용하여 `bash -c`, `env`, `cd &&`, `git -C`(붙임형 포함), `--amend`, `alias`, `for/do`, `xargs`, `find -exec`(중첩 `sh -c` 포함), `node -e`, `npx`/`npm`/`pnpm`/`make` 대본, `git merge/cherry-pick/rebase/apply/pull` 등을 감시한다. 다만 `git pull`·`git checkout`·`git reset --hard`처럼 유입 diff를 실행 전에 알 수 없는 동작이나 비-`git` 외부 바이너리·컨테이너 경유 커밋, 어댑터의 예외 시 fail-open(stderr 경고 로그 출력) 경로까지 빈틈없이 막기 위해 **`.github/workflows/ci.yml` 및 `scripts/run-native-harness-tests.cjs`에서 `--commit HEAD`와 `--worktree` 검사를 실제 최종 관문으로 실행**한다:

```bash
# 의도 시험 실제 실행 및 커밋 가능 영수증(.agents/intent-receipts/<REQ-ID>.json) 발급
node .claude/hooks/intent-guard.js --run-tests
git add .agents/intent-receipts/<REQ-ID>.json

# 현재 스테이지/작업 트리 기준 검사
node .claude/hooks/intent-guard.js --check

# 작업 트리 전체(미스테이지 포함) 강제 검사
node .claude/hooks/intent-guard.js --worktree

# CI / post-merge 최종 관문: 특정 커밋(예: HEAD) 검사
node .claude/hooks/intent-guard.js --commit HEAD
```

### 성능 실측 (`naia-adk` 저장소 기준)

스테이지된 요구사항 변경 여부를 먼저 좁혀 검사하고 불필요한 전체 트리 스캔을 생략하므로, `node .claude/hooks/intent-guard.js --check` 3회 연속 실측 시간은 각각 `0.05s`, `0.05s`, `0.05s`(평균 약 50ms)다.
