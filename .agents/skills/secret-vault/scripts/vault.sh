#!/usr/bin/env bash
# secret-vault — age passphrase 볼트(key.age + 평문 key/) 관리.
#
# 비밀번호는 대화형(TTY)으로만 입력한다. Claude 세션에서는 passphrase가 필요한
# 명령(unlock/list/lock/verify)을 사용자가 자기 실제 터미널에서 직접 실행할 것
# (Claude Code의 `!` 는 TTY가 없어 passphrase 입력 불가).
# status / sync 는 passphrase가 필요 없어 Claude가 대신 실행해도 안전하다.
#
# 사용법(볼트 repo 루트, 예: data-private/ 에서):
#   bash <path>/vault.sh init            # 새 repo에 볼트 구조 생성 (.gitignore + key/)
#   bash <path>/vault.sh unlock          # key.age -> key/ 복원
#   bash <path>/vault.sh list            # 내용 목록만 (복원 안 함)
#   bash <path>/vault.sh verify          # 내용 목록 + 파일별 수정시각 (스테일 의심 시)
#   bash <path>/vault.sh lock            # key/ -> key.age 재암호화 + 검증
#   bash <path>/vault.sh status          # 볼트/커밋/push 스테일 여부 점검 (비번 불필요)
#   bash <path>/vault.sh sync [메시지]   # key.age 커밋 + pull --rebase + push (비번 불필요)
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

die()  { echo "✗ $*" >&2; exit 1; }
warn() { echo "⚠ $*"; }
ok()   { echo "✓ $*"; }

need_age() {
  [ -n "$AGE_BIN" ] && [ -x "$AGE_BIN" ] \
    || die "age 미설치. 'go install filippo.io/age/cmd/age@latest' 후 go bin 을 PATH 에 추가."
}

# lock 이 중단되면 임시 암호문이 남는다. 0바이트면 마지막 시도가 실패한 것.
check_leftovers() {
  local f found=0
  for f in ./.vault.*.age "$VAULT".new; do
    [ -e "$f" ] || continue
    found=1
    if [ ! -s "$f" ]; then
      warn "잔여 임시파일 $f (0바이트) — 마지막 lock 시도가 중단됨. $VAULT 는 이전 내용일 수 있다. 삭제: rm '$f'"
    else
      warn "잔여 임시파일 $f — 검증/교체가 끝나지 않은 lock. 확인 후 삭제할 것."
    fi
  done
  return $found
}

case "${1:-}" in
  init)
    [ -e "$VAULT" ] && die "$VAULT 이미 존재 — init 불필요"
    mkdir -p "$PLAIN_DIR"
    if ! grep -qxF "$PLAIN_DIR/" .gitignore 2>/dev/null; then
      { [ -s .gitignore ] && echo; echo "# 평문 시크릿 — 절대 git 추적 금지. 암호문 $VAULT 만 올린다."; echo "$PLAIN_DIR/"; } >> .gitignore
      ok ".gitignore 에 $PLAIN_DIR/ 추가"
    fi
    ok "볼트 구조 생성: $PLAIN_DIR/ 에 시크릿을 넣고 'vault.sh lock' → 'vault.sh sync' 하면 된다."
    ;;
  unlock)
    need_age
    [ -f "$VAULT" ] || die "$VAULT 없음 (볼트 repo 루트에서 실행)"
    "$AGE_BIN" -d "$VAULT" | tar x
    ok "$VAULT → $PLAIN_DIR/ 복원 (평문 — git 추적 밖이어야 정상)"
    ;;
  list)
    need_age
    [ -f "$VAULT" ] || die "$VAULT 없음"
    "$AGE_BIN" -d "$VAULT" | tar t
    ;;
  verify)
    need_age
    [ -f "$VAULT" ] || die "$VAULT 없음"
    echo "→ 볼트 내용과 파일별 수정시각 — 평문 $PLAIN_DIR/ 의 최신 변경이 들어갔는지 날짜로 확인:"
    "$AGE_BIN" -d "$VAULT" | tar tv
    ;;
  lock)
    need_age
    [ -d "$PLAIN_DIR" ] || die "$PLAIN_DIR/ 없음 — 먼저 unlock"
    tmp="$(mktemp ./.vault.XXXXXX.age)"
    # trap: 중단 시 임시파일 정리 (원본 VAULT 는 절대 건드리지 않음)
    trap '[ -f "$tmp" ] && rm -f "$tmp"' EXIT
    echo "→ 재암호화: 같은 비밀번호를 유지하려면 동일 passphrase 입력 (age 가 두 번 확인)"
    tar c "$PLAIN_DIR" | "$AGE_BIN" -p -a > "$tmp"
    [ -s "$tmp" ] || die "암호화 결과가 비어 있음 (passphrase 입력 중단?) — $VAULT 원본 유지"
    echo "→ 검증: 방금 만든 암호문을 다시 복호화해 목록 확인 (passphrase 재입력)"
    "$AGE_BIN" -d "$tmp" | tar t >/dev/null || die "재암호화 검증 실패 — $VAULT 원본 유지"
    mv "$tmp" "$VAULT"
    trap - EXIT
    ok "$PLAIN_DIR/ → $VAULT 재암호화 + 검증 완료. 다음: 'vault.sh sync \"chore(vault): <무엇>\"'"
    ;;
  status)
    [ -f "$VAULT" ] || die "$VAULT 없음 (볼트 repo 루트에서 실행; 새 repo면 'vault.sh init')"
    stale=0
    check_leftovers || stale=1
    # 1) 평문이 볼트보다 새로운가 → lock 필요
    if [ -d "$PLAIN_DIR" ]; then
      newer="$(find "$PLAIN_DIR" -type f -newer "$VAULT" 2>/dev/null | sort)"
      if [ -n "$newer" ]; then
        stale=1
        warn "볼트보다 새로운 평문 파일 — 'vault.sh lock' 필요:"
        echo "$newer" | sed 's/^/    /'
      else
        ok "평문 $PLAIN_DIR/ 이 볼트보다 새 것 없음"
      fi
    else
      echo "· $PLAIN_DIR/ 없음 (이 기기에서는 unlock 안 함) — 볼트 파일 기준으로만 점검"
    fi
    # 2) 볼트가 커밋됐는가
    if ! git rev-parse --git-dir >/dev/null 2>&1; then
      warn "git repo 아님 — 온라인 백업 없음"
    else
      if ! git diff --quiet -- "$VAULT" 2>/dev/null || ! git diff --cached --quiet -- "$VAULT" 2>/dev/null; then
        stale=1; warn "$VAULT 가 커밋 안 된 상태 — 'vault.sh sync' 필요"
      else
        ok "$VAULT 커밋됨: $(git log -1 --format='%h %ad %s' --date=short -- "$VAULT")"
      fi
      # 3) push 됐는가
      upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
      if [ -z "$upstream" ]; then
        warn "upstream 브랜치 없음 — push 여부 확인 불가"
      else
        ahead="$(git rev-list --count "$upstream"..HEAD)"
        if [ "$ahead" -gt 0 ]; then
          stale=1; warn "push 안 된 커밋 ${ahead}개 ($upstream 대비) — 'vault.sh sync' 필요"
        else
          ok "$upstream 까지 push 완료"
        fi
      fi
    fi
    [ "$stale" -eq 0 ] && ok "온라인 백업 최신 상태" || { echo; die "백업이 최신이 아님 — 위 경고 참조"; }
    ;;
  sync)
    [ -f "$VAULT" ] || die "$VAULT 없음"
    git rev-parse --git-dir >/dev/null 2>&1 || die "git repo 아님"
    check_leftovers || die "잔여 임시파일 정리 후 다시 실행 (볼트가 이전 내용일 수 있음)"
    if [ -d "$PLAIN_DIR" ] && [ -n "$(find "$PLAIN_DIR" -type f -newer "$VAULT" 2>/dev/null)" ]; then
      die "볼트보다 새로운 평문 파일 있음 — 먼저 'vault.sh lock' ('vault.sh status' 로 목록 확인)"
    fi
    if git diff --quiet -- "$VAULT" && git diff --cached --quiet -- "$VAULT"; then
      echo "· $VAULT 변경 없음 — 커밋 생략, push 만 확인"
    else
      git add "$VAULT"
      staged="$(git diff --cached --name-only)"
      [ "$staged" = "$VAULT" ] || die "스테이징에 $VAULT 외 파일이 있음 — 평문 유출 방지 위해 중단: $staged"
      git commit -m "${2:-chore(vault): sync $VAULT}"
    fi
    branch="$(git rev-parse --abbrev-ref HEAD)"
    git pull --rebase origin "$branch"
    git push origin "$branch"
    ok "온라인 백업 완료 ($branch)"
    ;;
  *)
    echo "usage: vault.sh {init|unlock|list|verify|lock|status|sync [커밋메시지]}" >&2
    exit 1
    ;;
esac
