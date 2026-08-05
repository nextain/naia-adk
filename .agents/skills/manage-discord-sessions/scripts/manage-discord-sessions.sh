#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
adk_root="$(cd -- "$script_dir/../../../.." && pwd -P)"
instance="${NAIA_MESSENGER_INSTANCE:-default}"

if [[ "${1:-}" == "--instance" ]]; then
	instance="${2:?--instance requires a value}"
	shift 2
elif [[ -n "${1:-}" && "${1:-}" != --* && ! "${1:-}" =~ ^(status|health-check|jobs|job|watch|logs|monitor|cancel|restart|amend|history|latest|attachment|reply|service|cutover|artifacts)$ ]]; then
	instance="$1"
	shift
fi

if [[ "${1:-}" == "service" ]]; then
	shift
	exec node "$script_dir/../helper/service-manager.mjs" --adk-root "$adk_root" --instance "$instance" "$@"
fi

exec node "$script_dir/../helper/cli.mjs" --adk-root "$adk_root" --instance "$instance" "$@"
