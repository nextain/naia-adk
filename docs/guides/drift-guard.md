# 드리프트 방지 훅 (Drift Guard)

커밋되지 않은 로컬 대본으로 산출물을 굽거나, 기존 코드 파일 대신 변형 이름(`_v2`, `-copy` 등)으로 사본 파일을 늘리거나, 미커밋 변경을 장시간 방치해 저장소 `main`과 실제 산출물 경로가 어긋나는 드리프트를 막는다.

## 사고 배경

한 에이전트가 로컬에서 커밋하지 않은 `stream_render.py`의 수치를 캐릭터마다 수동으로 바꿔 `*-scale085.nva`, `*-scale082.nva` 등 산출물만 여러 벌 구웠다.
저장소 `main`에는 해당 코드가 남지 않고 제품(나이아스튜디오) 공통 경로도 그 파일을 거치지 않아 재현 불가능한 코드·산출물 드리프트가 발생했다.

## 구성 요소

| 구분 | 파일 | 시점 | 역할 |
| --- | --- | --- | --- |
| 산출물 관문 | `.claude/hooks/artifact-drift-guard.js` (`.agents/hooks/policies/bash.js`) | `PreToolUse` (`Bash`) | 미커밋(untracked/modified) 또는 저장소 밖(`/tmp` 등) 대본·산출물 생산 폴더 대본·인라인/표준입력 실행 및 미커밋 산출물 복사·개명 차단 |
| 사본 파일 관문 | `.claude/hooks/copy-file-guard.js` (`.agents/hooks/policies/edit.js`) | `PreToolUse` (`Edit\|Write\|NotebookEdit\|MultiEdit` 및 `Bash` 복사·개명) | 같은 폴더에 이미 있는 코드 파일의 변형 이름으로 새 코드 파일 생성 차단 |
| 미커밋 알림 | `scripts/check-stale-uncommitted.cjs`, `.claude/hooks/stale-uncommitted-notice.js` | `SessionStart` / CLI | 작업 공간과 `projects/*` 저장소의 `N`시간(기본 4) 초과 미커밋 변경 한 줄 경고 |
| 설정 파일 | `.agents/context/drift-guard.json` | 상시 | 산출물 확장자, 산출물 생산 폴더(`artifact_script_dirs`), 코드 확장자, 숫자 접미 정식 명칭(`allowed_numeric_stems`), 미커밋 경고 시간 설정 |

## 1. 산출물 관문 (`artifact-drift-guard.js`)

- 산출물 생산 폴더(`artifact_script_dirs`: 기본 `naia-labs/avatar`, `naia-labs/**/service`, `scripts/build*`, 저장소별 추가 가능)의 대본이 미커밋(`untracked`/`modified`)이면 명령줄에 산출물 토큰이 없어도 실행을 막고, 명령에 산출물 확장자(기본 `.nva`, `.exe`, `.msi`, `.dmg`, `.AppImage`, `.apk`, `.vrm`)가 있으면 어느 폴더든 미커밋·저장소 밖 대본 실행을 막는다.
- 서브셸·그룹(`()`, `{}`), 래퍼(`env`, `sudo`, `nohup`, `time`, `xargs`, `find -exec`)를 벗겨 대본을 찾으며, 산출물 토큰이 있는 `| bash`·`| sh`·`| python` 표준 입력 실행과 `python -c`·`node -e` 인라인 실행, 미커밋 원본을 산출물 확장자로 개명·복사(`cp`, `mv`, `ln`, `install`, `rsync`)하는 명령도 차단한다.
- 확장자 목록과 산출물 생산 폴더 목록은 `.agents/context/drift-guard.json`에서 변경·추가할 수 있다.

## 2. 사본 파일 관문 (`copy-file-guard.js`)

- `Edit`, `Write`, `NotebookEdit`, `MultiEdit` 및 `Bash`(`cp`, `mv`, `ln`, `install`, `rsync`)로 새 코드 파일(`.py`, `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.rs`, `.go`, `.sh`)을 만들 때 동작하며, 기존 파일 수정은 통과한다.
- 같은 폴더에 있는 기존 코드 파일 이름의 변형(`_v2`, `-v3`, `_new`, `_old`, `_copy`, `-copy`, `_backup`, `_fixed`, `_final`, 숫자만 다른 이름, `" (1)"` 등)이면 사본 생성을 막고 `"원래 파일을 고치세요"`를 안내한다(판정 함수는 `edit.js` 한 곳에 두고 `bash.js`가 불러 쓴다).
- 시험 파일(`test_*`, `*.test.*`, `*_test.*`), `migrations/` 폴더, 숫자 접미 정식 명칭(`oauth2`, `http2`, `md5`, `sha256`, `base64`, `utf8`, `i18n`, `k8s` 등 `allowed_numeric_stems`)은 예외로 허용한다.

## 3. 오래된 미커밋 변경 알림 (`scripts/check-stale-uncommitted.cjs`)

- 작업 공간 루트와 `projects/*` 하위 git 저장소에서 파일 수정 시각(`mtime`) 기준 기본 4시간(`--hours <N>` 또는 `.agents/context/drift-guard.json`의 `stale_uncommitted_hours`) 넘게 커밋되지 않은 변경을 찾아 출력한다.
- 세션 시작 시 `.claude/hooks/stale-uncommitted-notice.js`가 `SessionStart` `additionalContext`로 한 줄 경고를 표시한다(깨움·디스코드 발송 없음).


## 4. 민감 파일 관문 (`sensitive-path-guard.js`)

Claude Code의 `PreToolUse`에서 `Read`, `Edit`, `Write`, `NotebookEdit`, `Grep`, `Glob`, `Bash`와 메신저·메일 보내기 도구의 입력을 검사한다. 기본 보호 대상은 대소문자에 관계없이 `NPKI`·`GPKI` 디렉터리와 그 아래 전체, `.pfx`·`.p12`·`.der`·`.key` 확장자, `signPri.key`·`signCert.der`·`kmPri.key` 파일명이다. 인스턴스별 SSH 폴더 등 추가 민감 경로도 설정으로 지정한다. 보호 파일을 열거나 보호 디렉터리를 나열해서 판정하지 않는다.

거부할 때는 다음 문구를 표시한다.

> 인증서·열쇠 파일은 에이전트 도구로 다루지 않습니다. 사람이 직접 하거나 서명용 크롬을 쓰십시오.

### 인스턴스 설정

로컬의 `.claude/hooks/sensitive-path-guard.config.json`(Git 제외) 또는 `SENSITIVE_PATH_GUARD_CONFIG`가 가리키는 JSON 파일에 설정한다. `directoryNames`, `extensions`, `fileNames`는 기본 목록에 추가하는 값이고, `additionalPaths`에는 `~/.ssh` 같은 인스턴스별 경로를 둔다. 공유 저장소에는 실제 운영 경로를 적지 않는다.

```json
{
  "additionalPaths": ["~/.ssh"],
  "signingScript": null
}
```

`signingScript`에는 사람이 검수한 서명 대본의 절대경로 하나를 넣는다. 공백·셸 메타문자가 없는 경로만 지원하며, 명령 전체가 설정된 경로와 정확히 같을 때만 허용한다. 따옴표·인자·추가 명령을 붙이면 예외를 적용하지 않는다. 기본값 `null`은 예외 없음이다.

### 경로와 보내기 검사

파일 도구의 경로·패턴과 셸 명령의 텍스트를 검사한다. `ls` 같은 목록 조회도 보호 경로를 직접 다루면 거부한다. 따옴표, 역슬래시 이스케이프, 변수 대입과 참조, `~`·`$HOME`, 상대경로, `N?KI`·`*Pri*`·`**/*.key` 같은 패턴을 검사하며 `find … -exec`, `base64`, `git add`, `curl -F`를 사용해도 같은 규칙을 적용한다. 파일명은 경계로 구분하므로 `keyboard.ts`와 `monkey.der.md`는 기본 확장자 규칙에 걸리지 않는다. `ls docs`, `cat README.md`, `git add src/a.ts`도 민감 토큰이 없으면 이 관문을 통과한다.

메신저·메일 입력과 Git 커밋·푸시에서 검사 가능한 내용에 DER 인증서의 base64 머리 `MII`, `BEGIN ENCRYPTED PRIVATE KEY`, `BEGIN PRIVATE KEY`, `signPri.key`가 있으면 보내기를 거부한다. 경로 이름을 바꿔도 인식 가능한 본문은 거부하지만, 이 검사는 암호화·인코딩된 모든 비밀을 알아내는 데이터 유출 방지 시스템은 아니다. `.gitignore`의 인증서 패턴은 실수로 추가하는 일을 줄이며, 이미 추적된 파일을 제거하거나 접근을 차단하지는 않는다.

Git 커밋 검사는 보호 파일명을 먼저 확인하고 변경된 인덱스 파일의 전체 내용도 검사한다. 푸시 검사는 HEAD·로컬 가지·태그에서 원격 추적 참조로 도달하지 않는 커밋과 객체를 검사하므로, 중간 커밋에서 추가했다가 지운 내용도 대상이다. 원격 추적 참조에 이미 도달하는 객체나 HEAD·가지·태그에 연결되지 않은 임의 객체 ID만으로 지정한 전송은 완전한 검사를 보장하지 않는다. 검사량 상한(인덱스 파일 256개, 미전송 객체 1,024개, Git 호출당 출력 32 MiB·10초)을 넘거나 Git 검사가 실패하면 거부한다. 작업 디렉터리·인덱스를 바꾸는 호출과 검사 뒤 인덱스를 바꿀 수 있는 복합 커밋 호출도 거부한다. 시험·관문 소스 자체에 거부 표식이 들어 있으면 그 변경의 커밋도 차단되므로 사람이 검토한 터미널에서 처리한다. 메시지 첨부 파일의 내부를 열어 검사하지는 않는다.

### 적용 범위와 남는 우회

이 관문은 등록된 Claude Code 세션 도구 호출의 입력을 검사한다. 같은 계정이 관문 코드나 설정을 고치거나 훅 등록을 끌 수 있으므로 자기 변조를 막는 경계도 아니다. 같은 OS 계정의 다른 도구(agy·codex·muse 일꾼), 사람이 실행한 셸 대본, 별도 프로세스의 파일 접근에는 이 관문이 적용되지 않는다. 같은 계정으로 실행하면 디렉터리 권한 `0700`도 계정 내부의 에이전트끼리 접근을 구분하지 못한다.

셸의 모든 실행 의미를 재현하거나 파일 시스템을 샌드박스로 격리하지 않는다. 민감 이름이 전혀 없는 기존 대본·실행 파일 내부의 읽기, 심볼릭 링크·하드 링크·파일 디스크립터 별칭, 런타임에 동적으로 조합하거나 복호화한 경로, 다른 프로세스의 메모리·이미 열어 둔 파일, 인식 표식을 없앤 전송 내용은 남는 우회다. 명령 치환과 해결하지 못한 셸 변수, 지원하지 않는 달러 인용·중괄호 문법은 보수적으로 거부한다. `Grep`·`Glob`의 넓은 패턴이 보호 이름에 닿을 수 있어도 거부하므로, 평범한 검색도 구체적인 비민감 경로로 좁혀야 할 수 있다. 디렉터리 내부를 순회하는 도구 자체의 모든 파일 접근을 격리하는 기능은 아니므로 OS 경계가 추가로 필요하다. 이 제한을 이유로 실제 인증서나 개인키를 이용해 시험하지 않는다. 시험은 임시 폴더의 가짜 이름·가짜 내용으로만 한다.

### 다음 단계: 서명 계정 분리 설계

인증서 폴더를 에이전트 계정과 다른 별도 OS 계정이 소유하고, 에이전트 계정에는 그 폴더를 읽을 권한을 주지 않는다. 사람이 사용하는 서명용 크롬만 그 별도 계정으로 실행하며 인증서와 개인키는 그 경계 안에 둔다. 에이전트는 서명 결과에 필요한 비민감 산출물만 별도 전달 경로로 받는다. 서명 대본을 예외로 둘 때도 사람이 검수한 정확한 실행 한 줄만 인스턴스 설정에 허용하며, 인자를 덧붙이거나 복합 셸 명령으로 확장한 호출은 예외가 아니다. 이번 변경은 이 계정 분리의 설계 안내까지이며 계정·권한·크롬 실행 환경을 변경하지 않는다.
