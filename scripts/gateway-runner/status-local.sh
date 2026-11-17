#!/usr/bin/env bash
# Direct status, including live verification after a completed deployment/restore.
set -euo pipefail
[[ $# == 2 || ( $# == 3 && ( "$3" == recent || "$3" == full-log || "$3" == env-names || "$3" == installed-hashes ) ) ]] || exit 64
PHASE=status
case "${3:-}" in env-names|installed-hashes) PHASE="$3" ;; esac
exec bash "$(dirname -- "${BASH_SOURCE[0]}")/operation-local.sh" "$1" "$2" "$PHASE"
