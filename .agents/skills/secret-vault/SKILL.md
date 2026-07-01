---
name: secret-vault
description: age 암호화 시크릿 볼트(`key.age` + 평문 `key/`)를 열고·수정하고·다시 잠글 때 반드시 사용. data-private 등 "암호화된 키 파일을 어떻게 푸는가", "키를 추가하고 다시 암호화", "복호화가 깨져 보인다", "key.age unlock/lock" 요청 시 사용. 비밀번호는 사람이 직접 입력해야 하므로 Claude는 복호화 명령을 대신 실행하지 않고, 사용자가 자기 실제 터미널 창에서 실행하도록 안내한다(Claude Code의 `!` 는 TTY가 없어 passphrase 입력 불가).
license: Apache-2.0
metadata:
  vault-scheme: "age scrypt (passphrase)"
---

# Secret Vault (age)

## 목적

민감 시크릿을 평문으로 git 추적하지 않기 위해, 디렉터리 하나(`key/`)를 통째로
tar로 묶어 **age passphrase(scrypt)** 로 암호화한 단일 파일(`key.age`)만 커밋하는
볼트 패턴을 관리한다. 열기(unlock) → 키 추가/수정 → 다시 잠그기(lock)의
반복을 안전하게 수행한다.

> **적용 대상**: `data-private` 서브모듈이 표준 소비자. 같은 패턴(`key.age` + gitignore된 `key/`)을 쓰는 어떤 repo에도 재사용 가능.

## 핵심 계약 (반드시 지킬 것)

1. **평문은 절대 커밋하지 않는다.** `key/` 만 `.gitignore` 되어 있으면 안전.
   복호화 산출물을 `key.plain`·`api-key.md` 같은 **다른 이름으로 저장하지 말 것**
   — gitignore를 벗어나 평문 시크릿이 추적될 위험이 있다. 항상 `key/` 로만 푼다.
2. **비밀번호는 사람이 TTY로 직접 입력한다.** Claude는 passphrase를 받지도,
   대신 입력하지도 않는다(로그·프로세스 노출 방지). ⚠️ Claude Code의 `!` 실행은
   **실제 TTY가 없어** age가 passphrase를 못 읽는다(`/dev/tty is not available`).
   따라서 unlock/lock 등 비번이 필요한 명령은 **사용자가 자기 실제 터미널 창에서
   직접 실행**하도록 안내한다(`!` 아님). `age -d ... | tar t` 같은 비번 없는
   조회만 `!` 로 가능.
3. **커밋 대상은 `key.age` 하나뿐.** lock 후 `git status` 로 확인.

## 사전 준비 (age 미설치 시, 1회)

이 워크스페이스(Bazzite/immutable OS)에는 시스템 `age` 가 없다. 홈에 설치:

```bash
go install filippo.io/age/cmd/age@latest    # go bin 디렉터리에 설치됨
# 또는 cargo install rage (rage 는 age 호환 Rust 구현, `rage -d` 사용)
```

설치 후 go bin 디렉터리를 PATH에 넣으면 아래 예시의 `age` 가 그대로 동작한다:
`export PATH="$(go env GOBIN 2>/dev/null || echo "$(go env GOPATH)/bin"):$PATH"`.
PATH에 넣지 않았다면 예시의 `age` 를 go bin 절대경로로 바꿔 부른다.

## 워크플로우

### Step 1 — 열기 (unlock)

`key.age` 는 여러 파일을 묶은 **tar 아카이브의 암호문**이다. 터미널에 직접 뿌리면
바이너리라 "깨져 보인다" — 정상이다. 반드시 `tar x` 로 파이프하거나 파일로 뽑는다.

사용자에게 안내(직접 실행):

```bash
! age -d key.age | tar x        # → key/ 디렉터리 복원 (평문, gitignore됨)
```

또는 스크립트:

```bash
! bash <skill>/scripts/vault.sh unlock
```

내용 목록만 미리 보려면: `! age -d key.age | tar t`

### Step 2 — 키 추가/수정

`key/` 안에 파일을 추가하거나 편집한다(에디터로 직접). 명명 관례는 기존 파일을
따른다(`*-key.env`, `*.env.local`, `*.txt`, 인증서 묶음 하위폴더 등).

### Step 3 — 다시 잠그기 (lock)

`key/` 를 다시 tar+age로 묶어 `key.age` 를 교체한다. 같은 비밀번호를 유지하려면
프롬프트에 **동일 passphrase를 다시 입력**한다(age가 확인용으로 두 번 물음).

```bash
! bash <skill>/scripts/vault.sh lock
# 내부: tar c key | age -p -a > tmp → 재복호화 검증 → 성공 시에만 key.age 교체
```

스크립트 없이 수동:

```bash
! tar c key | age -p -a > key.age.new \
  && age -d key.age.new | tar t >/dev/null \
  && mv key.age.new key.age        # 검증 통과 후에만 교체
```

### Step 4 — 커밋

```bash
git add key.age && git status --short   # key.age 만 보여야 정상
git commit -m "chore(vault): <추가한 키> 반영"
```

## 사고 복구 (troubleshooting)

| 증상 | 원인 | 조치 |
|------|------|------|
| 에디터에서 복호화 파일이 깨져 보임 | tar 바이너리를 텍스트로 열었을 뿐 | `tar tf <파일>` 로 확인, `tar x` 로 정상 복원 |
| `refusing to output binary to the terminal` | age가 바이너리 stdout를 TTY로 막음 | `\| tar x` 로 파이프하거나 `> 파일` 로 리다이렉트 |
| `too many INPUT arguments` | `> tar x key/` 처럼 리다이렉트 뒤 토큰이 age 인자로 감 | 파이프(`\| tar x`)를 쓴다. `>` 뒤엔 파일명 하나만 |
| `key.age` 가 0바이트로 잘림(작업트리) | 잘못된 리다이렉트로 원본 truncate | 커밋 전이면 `git restore key.age` 로 HEAD 정상본 복구 (평문 `key/` 는 그대로 있으니 손실 없음) |
| 평문이 `git status` 에 뜸 | `key/` 밖 이름으로 저장함 | 해당 파일 삭제, `.gitignore` 의 `key/` 만 사용 |

## Key Files

| 파일 | 용도 |
|------|------|
| `scripts/vault.sh` | unlock / list / lock 래퍼 (passphrase는 대화형) |
| `<repo>/key.age` | 커밋되는 유일한 암호문 (age scrypt) |
| `<repo>/key/` | 복호화된 평문 디렉터리 — `.gitignore` 필수, 절대 커밋 금지 |

## 참고

- 이 스킬은 **naia-adk(base SoT)** 와 **alpha-adk** 에 동일 내용으로 존재한다.
  규칙 변경 시 base(naia-adk)에서 고쳐 fork로 전파한다.
- 볼트 방식은 age passphrase(scrypt) — 키페어(공개키 recipient)가 아니다.
  비밀번호 분실 시 복구 불가하므로 사람이 안전하게 보관한다.
