#!/usr/bin/env bash
# secret-vault — age passphrase 볼트(key.age + 평문 key/) 열기/보기/잠그기.
#
# 비밀번호는 대화형(TTY)으로만 입력한다. Claude 세션에서는 반드시 프롬프트에
# `!` 를 붙여 사용자가 직접 실행할 것 (passphrase가 AI를 거치지 않도록).
#
# 사용법(볼트 repo 루트, 예: data-private/ 에서):
#   bash <path>/vault.sh unlock   # key.age -> key/ 복원
#   bash <path>/vault.sh list     # 내용 목록만 (복원 안 함)
#   bash <path>/vault.sh lock     # key/ -> key.age 재암호화 + 검증
#
# 환경변수 오버라이드: AGE_BIN, VAULT(기본 key.age), PLAIN_DIR(기본 key)
set -euo pipefail

# age 탐색: PATH → go bin → cargo(rage)
find_age() {
  if command -v age >/dev/null 2>&1; then command -v age; return; fi
  local gobin; gobin="$(go env GOBIN 2>/dev/null || true)"
  [ -z "$gobin" ] && gobin="$(go env GOPATH 2>/dev/null)/bin"
  [ -x "$gobin/age" ] && { echo "$gobin/age"; return; }
  command -v rage 2>/dev/null && return
  return 1
}

AGE_BIN="${AGE_BIN:-$(find_age || true)}"
VAULT="${VAULT:-key.age}"
PLAIN_DIR="${PLAIN_DIR:-key}"

die() { echo "✗ $*" >&2; exit 1; }

[ -n "$AGE_BIN" ] && [ -x "$AGE_BIN" ] \
  || die "age 미설치. 'go install filippo.io/age/cmd/age@latest' 후 go bin 을 PATH 에 추가."

case "${1:-}" in
  unlock)
    [ -f "$VAULT" ] || die "$VAULT 없음 (볼트 repo 루트에서 실행)"
    "$AGE_BIN" -d "$VAULT" | tar x
    echo "✓ $VAULT → $PLAIN_DIR/ 복원 (평문 — git 추적 밖이어야 정상)"
    ;;
  list)
    [ -f "$VAULT" ] || die "$VAULT 없음"
    "$AGE_BIN" -d "$VAULT" | tar t
    ;;
  lock)
    [ -d "$PLAIN_DIR" ] || die "$PLAIN_DIR/ 없음 — 먼저 unlock"
    tmp="$(mktemp ./.vault.XXXXXX.age)"
    # trap: 중단 시 임시파일 정리 (원본 VAULT 는 절대 건드리지 않음)
    trap '[ -f "$tmp" ] && rm -f "$tmp"' EXIT
    echo "→ 재암호화: 같은 비밀번호를 유지하려면 동일 passphrase 입력 (age 가 두 번 확인)"
    tar c "$PLAIN_DIR" | "$AGE_BIN" -p -a > "$tmp"
    echo "→ 검증: 방금 만든 암호문을 다시 복호화해 목록 확인 (passphrase 재입력)"
    "$AGE_BIN" -d "$tmp" | tar t >/dev/null || die "재암호화 검증 실패 — $VAULT 원본 유지"
    mv "$tmp" "$VAULT"
    trap - EXIT
    echo "✓ $PLAIN_DIR/ → $VAULT 재암호화 + 검증 완료. 이제 'git add $VAULT' 만 커밋."
    ;;
  *)
    echo "usage: vault.sh {unlock|list|lock}" >&2
    exit 1
    ;;
esac
