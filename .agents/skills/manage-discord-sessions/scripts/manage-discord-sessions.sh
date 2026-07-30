#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
adk_root="$(cd -- "$script_dir/../../../.." && pwd -P)"

exec node "$script_dir/../helper/cli.mjs" --adk-root "$adk_root" "$@"
