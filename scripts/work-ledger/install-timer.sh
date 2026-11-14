#!/usr/bin/env bash
# Write user units only when invoked manually. Never starts or enables services.
set -euo pipefail
root="$(pwd)"
config=''
while (($#)); do
  case "$1" in
    --root|--config)
      (($# >= 2)) || { echo "Missing value: $1" >&2; exit 2; }
      if [[ "$1" == --root ]]; then root="$2"; else config="$2"; fi
      shift 2 ;;
    *) echo 'Usage: install-timer.sh [--root ADK_ROOT] [--config CONFIG_JSON]' >&2; exit 2 ;;
  esac
done
root="$(cd -- "$root" && pwd -P)"
if [[ -z "$config" ]]; then config="$root/config/work-ledger.json"; fi
if [[ "$config" != /* ]]; then config="$root/$config"; fi
[[ -f "$root/scripts/work-ledger/ledger-watch.mjs" ]] || { echo 'Watcher script not found' >&2; exit 2; }
[[ -f "$config" ]] || { echo 'Configuration file not found' >&2; exit 2; }
node_bin="$(command -v node)"
command -v flock >/dev/null || { echo 'util-linux flock is required' >&2; exit 2; }
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p -- "$unit_dir"
# systemd quoted arguments escape specifiers separately from shell syntax.
unit_quote() {
  local value="$1"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || { echo 'Newlines in paths are unsupported' >&2; exit 2; }
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//%/%%}"
  value="${value//\$/\$\$}"
  printf '"%s"' "$value"
}
node_arg="$(unit_quote "$node_bin")"
script_arg="$(unit_quote "$root/scripts/work-ledger/ledger-watch.mjs")"
root_arg="$(unit_quote "$root")"
config_arg="$(unit_quote "$config")"
cat > "$unit_dir/work-ledger-watch.service" <<UNIT
[Unit]
Description=Check the ADK work ledger

[Service]
Type=oneshot
ExecStart=$node_arg $script_arg --root $root_arg --config $config_arg
UMask=0077
UNIT
cat > "$unit_dir/work-ledger-watch.timer" <<'UNIT'
[Unit]
Description=Check the ADK work ledger every ten minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=10min
AccuracySec=1s
Unit=work-ledger-watch.service

[Install]
WantedBy=timers.target
UNIT
printf 'Wrote user units in %s\n' "$unit_dir"
printf '%s\n' 'Provide the configured token environment variable to the user service before starting.' 'To activate manually:' '  systemctl --user daemon-reload' '  systemctl --user enable --now work-ledger-watch.timer'
