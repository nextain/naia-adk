#!/usr/bin/env bash
# Explicit operator-directed restore. No background slot or automatic recovery.
set -euo pipefail
[[ $# == 2 ]] || exit 64
exec bash "$(dirname -- "${BASH_SOURCE[0]}")/operation-local.sh" "$1" "$2" rollback
