#!/usr/bin/env bash
# POSIX entry point for the shared structural BEH registration validator.
set -eu
CWD="${1:-$PWD}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec node "$SCRIPT_DIR/beh-launch.cjs" "$CWD"
