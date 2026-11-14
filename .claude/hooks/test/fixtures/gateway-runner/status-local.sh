#!/usr/bin/env bash
# Direct status, including live verification after a completed deployment/restore.
set -euo pipefail
[[ $# == 2 || ( $# == 3 && ( "$3" == recent || "$3" == full-log ) ) ]] || exit 64
exec bash "$(dirname -- "${BASH_SOURCE[0]}")/operation-local.sh" "$1" "$2" status
