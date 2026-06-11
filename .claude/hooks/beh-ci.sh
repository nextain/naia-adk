#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# BEH central CI / dependency-gate (§5, §6.7).
#
# Run by a SCHEDULED job (and/or in each fork's CI). Verifies the local managed
# harness region against the signed, epoch-stamped beh-manifest.lock — so a
# fork whose beh-* files drifted, that rolled back to a stale epoch, or that has
# no CI of its own is caught centrally (plan §5: "downstream CI 부재·미인지
# fork·stale 무기한 방지").
#
# Usage:  BEH_SIGN_KEY=... bash .claude/hooks/beh-ci.sh [<cwd>] [<min-epoch>]
# Exit:   0 = managed region intact + epoch ≥ floor; 1 = drift/rollback/bad-sig.
# ─────────────────────────────────────────────────────────────────────────────
set -u
CWD="${1:-$PWD}"
MIN_EPOCH="${2:-}"
HOOK="$CWD/.claude/hooks/beh-manifest.js"

[ -f "$HOOK" ] || { echo "[beh-ci] FAIL: $HOOK 없음"; exit 1; }

if [ -n "$MIN_EPOCH" ]; then
  node "$HOOK" verify "$CWD" --min-epoch "$MIN_EPOCH"
else
  node "$HOOK" verify "$CWD"
fi
RC=$?
if [ "$RC" -ne 0 ]; then
  echo "[beh-ci] FAIL: managed region 검증 실패 (drift/rollback/서명). 전파 게이트 차단."
  exit 1
fi
echo "[beh-ci] PASS: BEH managed region 무결 + epoch 유효."
exit 0
