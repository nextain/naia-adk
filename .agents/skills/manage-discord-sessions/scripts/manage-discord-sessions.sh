#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
adk_root="$(cd -- "$script_dir/../../../.." && pwd -P)"

if [[ "${1:-}" == "service" ]]; then
	shift
	exec node "$script_dir/../helper/service-manager.mjs" --adk-root "$adk_root" "$@"
fi

exec node "$script_dir/../helper/cli.mjs" --adk-root "$adk_root" "$@"
