#!/bin/sh
# The installation's role manager supplies the native CLI and its profile arguments.
set -eu
if [ "$#" -eq 0 ]; then
  echo 'Usage: start-role-session.sh EXECUTABLE [ARGUMENT ...]' >&2
  exit 2
fi
entry=$(realpath "$0")
node "${entry%/*}/role-handoff.mjs" --check-start "$1"
exec "$@"
