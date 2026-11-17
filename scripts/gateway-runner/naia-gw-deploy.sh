#!/usr/bin/env bash
# Direct operator-observed stage, no worker or automatic recovery.
set -euo pipefail
exec python3 -I "$(dirname -- "${BASH_SOURCE[0]}")/gateway-operation.py" "$@"
