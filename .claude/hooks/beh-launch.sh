#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# BEH external launcher (§3.4, §6.4) — session-start handshake.
#
# The ROOT of fail-CLOSED enforcement: an unregistered hook cannot block itself,
# so this EXTERNAL check (run before/at the start of an agent session) verifies
# the required BEH hooks are registered + the cores load, then writes a handshake
# bound to a hash of the current hook registration (settings.json). beh-pretool.js
# blocks every tool until this handshake exists and matches.
#
# Usage:  bash .claude/hooks/beh-launch.sh [<cwd>]
# Exit:   0 = handshake written; 1 = verification failed (DO NOT proceed).
# ─────────────────────────────────────────────────────────────────────────────
set -u
CWD="${1:-$PWD}"
SETTINGS="$CWD/.claude/settings.json"
CORE="$CWD/.agents/hooks/core"

[ -f "$SETTINGS" ] || { echo "[beh-launch] FAIL: no $SETTINGS"; exit 1; }

# 1. required hooks registered in settings.json?
for h in beh-tick.js beh-record.js beh-stop.js beh-pretool.js; do
  grep -q "$h" "$SETTINGS" || { echo "[beh-launch] FAIL: hook '$h' not registered in settings.json"; exit 1; }
done

# 2. cores loadable (require self-probe)?
for c in beh-ledger beh-receipts beh-supervise-core beh-launch-core; do
  node -e "require('$CORE/$c.js')" 2>/dev/null || { echo "[beh-launch] FAIL: core '$c.js' not loadable"; exit 1; }
done

# 3. write handshake bound to the settings.json registration hash.
HASH="$(sha256sum "$SETTINGS" | cut -d' ' -f1)"
TS="$(date +%s)000"   # ms epoch (second precision is plenty for a 12h window)
mkdir -p "$CWD/.claude"
printf '{"ts":%s,"settings_hash":"%s"}\n' "$TS" "$HASH" > "$CWD/.claude/beh-handshake"
echo "[beh-launch] handshake OK — hooks registered, cores load, settings_hash=${HASH:0:12}"
exit 0
