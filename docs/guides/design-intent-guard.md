# 설계 변경 산출물 의도 시험 관문 (Design Intent Guard)

요구사항(REQ)의 설계가 바뀌었을 때, 그 설계로 만들어지거나 그 설계를 쓰는 앞 단계 산출물(upstream/stage artifact)의 **의도 시험(intent test)** 이 적혀 있고 실제로 다시 돌았는지 확인하여 설계·산출물 의미 드리프트를 막는다.

## 1. 왜 필요한가 (배경)

다단계 파이프라인에서는 뒤 단계 설계가 바뀌면서 앞 단계 산출물이 맡아야 할 **의미적 역할(설계 의도)** 이 달라지는 일이 자주 일어난다.

- 예를 들어 가상의 **"배경 영상 (`clips/background-loop.webm`)"** 산출물을 생각하자.
  - **초기 설계**: 배경 영상 하나가 화면 전체의 움직임을 직접 보여주는 단일 클립이었다.
  - **변경된 설계**: 배경 영상 위에 전경 합성 조각을 고정 좌표로 얹는 2단계 합성 구조로 바뀌었다. 이제 앞 단계 산출물인 `clips/background-loop.webm`은 전경이 얹히는 영역이 흔들리지 않고 정적 상태를 유지하는 **"고정 배경 루프 영상"** 이어야 한다.
- 만약 뒤 단계 합성 구조만 바꾸고 앞 단계 배경 영상 생성 공정은 예전 그대로 두면, 배경 영상의 움직임이 전경 합성 조각 뒤로 비쳐 나오는 어긋남이 발생한다.
- 이때 기존 시험이 **파일 모양·개수(파일이 존재하는지, 확장자가 `.webm`인지, 프레임 수가 100개 이상인지)** 만 검사하면 모든 시험이 통과하여 한 달 넘게 아무 관문에도 걸리지 않는다.
- 또한 미커밋 대본 실행을 막는 `artifact-drift-guard`는 "커밋된 대본으로 만들었는가"만 볼 뿐, **"그 산출물이 바뀐 설계 의도대로인가"** 는 검사하지 않는다.

따라서 요구사항(REQ) 하나가 **이 설계로 만들어지는(또는 이 설계를 쓰는) 산출물**과 **그 산출물이 지켜야 할 기계적 의도 시험**을 명시하게 하고, 설계가 바뀔 때마다 앞 단계 산출물의 의도 시험을 다시 거치도록 강제한다.

## 2. 구성 요소

| 구분 | 파일 | 시점 | 역할 |
| --- | --- | --- | --- |
| 요구사항 양식 | `.agents/requirements/_template.yaml` | 요구사항 작성·변경 | `design` 칸과 `artifacts[].intent_test` (`condition`, `test_path`, `symbol`, `receipt`) 정의 |
| 정책 모듈 | `.agents/hooks/policies/design-intent-guard.js` (`.agents/hooks/policies/bash.js`) | `git commit` / CLI | 요구사항 설계 칸 변경 감지 및 산출물별 (a) 의도 시험 기재, (b) 실제 시험 파일 존재, (c) 동일 변경 내 재실행 확인 |
| 훅 및 CLI 검사기 | `.claude/hooks/intent-guard.js` | `PreToolUse` (`Bash`) / CI | 커밋 전 차단 및 `--check` (`--staged`, `--worktree`, `--commit <rev>`) 검사 실행 |
| 거버넌스 규칙 | `.agents/context/agents-rules.json` (`conventions.design_intent_guard`) | 상시 | 파일 모양·개수만 보는 시험 경고 및 설계 변경 시 앞 단계 산출물 의도 시험 의무화 |

## 3. 어떻게 쓰는가 (요구사항 작성 규칙)

`.agents/requirements/_template.yaml`에 추가된 `design` 및 `artifacts` 칸을 채운다(가상의 "배경 영상" 예시):

```yaml
id: REQ-001-layered-composite-stage
title: "Two-stage composite rendering over steady background video"
title_ko: "정적 영역 배경 영상 위 전경 조각 합성"
status: active

description: |
  전경 합성 조각을 고정 영역에 얹을 때 경계 어긋남이 없도록 앞 단계 배경 영상과 합성 계약을 정의한다.

acceptance_criteria:
  - "합성 영역 내 배경 프레임 간 흔들림이 1.0px 이하여야 한다."

design: |
  전경 합성 레이어를 고정 사각형 영역에 덮어쓰므로, 앞 단계 산출물인 배경 영상(clips/background-loop.webm)은
  전 프레임에서 합성 대상 영역이 정적 기준 상태(입·윤곽 고정)를 유지해야 한다.

artifacts:
  - id: "background-loop-video"
    path: "clips/background-loop.webm"
    stage: "upstream-background-producer"
    intent_test:
      condition: "전 프레임에서 합성 영역의 기준 이미지 대비 평균 절대 픽셀 오차(MAE) <= 1.5 이고 상단 윤곽 흔들림 <= 1.0px"
      test_path: "tests/background-loop-intent.test.mjs"
      symbol: "background loop keeps composite region steady across all frames"
      receipt: null
```

### 의도 시험(`intent_test`) 작성 원칙

1. **파일 모양·개수만 보는 시험 금지**:
   - `"파일 존재 및 프레임 개수만 확인"`, `"check file shape and count only"`, `"file exists"`처럼 산출물의 겉모양·개수·확장자만 확인하는 문구는 `(a)` 단계에서 부적격으로 차단된다.
   - 반드시 픽셀 오차 한도, 좌표 흔들림 상한, 상태 불변식 등 **설계 의도를 기계로 재는 조건(`condition`)** 을 적어야 한다.
2. **실제 시험 파일 경로(`test_path`) 연결**:
   - 저장소 안에 실제로 존재하는 시험 파일 상대 경로를 적는다. `symbol`을 적으면 해당 시험 파일 안에 그 시험 이름(또는 심볼)이 실제로 들어 있는지도 함께 확인한다.

## 4. 검사기 동작 원리

요구사항 파일(`.agents/requirements/*.yaml`, `_index.yaml`·`_template.yaml` 제외)의 설계 칸(`design`, `description`, `acceptance_criteria`, `change_effect`, `preserves`, `must_not_change`, `decisions`, `artifacts`)이 바뀐 커밋 또는 작업 트리에서, 그 요구사항을 쓰는 산출물마다 아래 3가지를 검사한다.

1. **(a) 의도 시험 기재 확인**:
   - 산출물마다 `intent_test.condition`(기계로 재는 의미 조건)과 `intent_test.test_path`(시험 파일 경로)가 비어 있지 않고 템플릿 자리표시자(`{...}`)가 아니며, 파일 모양·개수만 보는 조건이 아닌지 확인한다.
2. **(b) 실제 시험 파일 존재 확인**:
   - `test_path`가 저장소 내부의 실제 파일로 존재하고 비어 있지 않으며, `symbol` 지정 시 해당 심볼이 파일에 포함되어 있는지 확인한다.
3. **(c) 같은 변경에서 다시 돌았는지 확인**:
   - 다음 둘 중 하나를 만족해야 한다:
     - **같은 커밋(변경 집합)에 시험 파일 변경 포함**: 바뀐 설계 의도에 맞춰 갱신·검증된 `test_path` 파일이 같은 커밋(또는 작업 트리 변경)에 함께 포함됨.
     - **시험 영수증(`receipt`) 확인**: `intent_test.receipt`(또는 `.agents/progress/intent-receipts/<REQ-ID>.json`)에 통과(`status: "pass"`) 결과와 현재 설계 해시(`design_sha256`)가 기록되어 있거나 같은 변경에서 영수증이 갱신됨.
4. **차단 메시지**:
   - 위 조건 중 하나라도 빠지면 커밋을 막고 **`다시 검사해야 할 앞 단계 산출물:`** 목록과 구체적인 누락 사유(`(a)`/`(b)`/`(c)`)를 출력한다.
   - `updated`, `status`, `priority`, `issue_url`, `trace.reviews` 등 설계와 무관한 메타데이터만 바뀐 경우에는 차단하지 않는다.

## 5. CLI 실행 방법

커밋 훅(`PreToolUse` `Bash`)으로 자동 실행될 뿐 아니라, 명령줄이나 CI에서 직접 실행할 수도 있다:

```bash
# 현재 스테이지/작업 트리 기준 검사
node .claude/hooks/intent-guard.js --check

# 작업 트리 전체(미스테이지 포함) 강제 검사
node .claude/hooks/intent-guard.js --worktree

# 특정 커밋(예: HEAD) 검사
node .claude/hooks/intent-guard.js --commit HEAD
```
