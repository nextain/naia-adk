#!/usr/bin/env bash
# Install the reviewed two-file runner and synchronously back up.
# This command never deploys the candidate. AI invokes deploy and verify separately.
set -euo pipefail
umask 077
[[ $# == 6 || $# == 7 ]] || exit 64
ENVIRONMENT="$1" RUN_ID="$2" TAG="$3" DIGEST="$4" CURRENT="$5" REVISION="$6" STAGE="${7:-backup}"
[[ "$RUN_ID" =~ ^[0-9]{8}T[0-9]{6}Z-[a-z0-9-]{1,32}$ && "$TAG" =~ ^[A-Za-z0-9_.-]{1,128}$ &&
   "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ && "$CURRENT" =~ ^sha256:[0-9a-f]{64}$ &&
   "$REVISION" =~ ^[A-Za-z0-9_.-]{1,128}$ ]] || exit 64
[[ "$STAGE" == backup || "$STAGE" == cleanup ]] || exit 64
case "$ENVIRONMENT" in
  prod) RG=RG-NAIA-PROD-KOREACENTRAL; VM=naia-gateway-prod-az ;;
  dev) RG=RG-NAIA-DEV-KOREACENTRAL; VM=naia-gateway-dev-az ;;
  *) exit 64 ;;
esac
SUBSCRIPTION=83b29893-2929-4593-bf1f-1f7b8aa53630
ACR=acrnaia83b29893
REPO=acrnaia83b29893.azurecr.io/naia/gateway
trap 'echo MOTIF_KEY_FILE_INVALID; exit 1' ERR
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
trap - ERR
SOURCE_PATH="$(realpath -m -- "${BASH_SOURCE[0]}")" || { echo MOTIF_KEY_FILE_INVALID; exit 1; }
[[ "$SOURCE_PATH" == "$HERE/$(basename -- "${BASH_SOURCE[0]}")" ]] || { echo MOTIF_KEY_FILE_INVALID; exit 1; }
if [[ "$STAGE" == cleanup ]]; then
  NAME="naia-gw-cleanup-$RUN_ID"
else
  NAME="naia-gw-prepare-$RUN_ID"
fi
TMP="$(mktemp -d "${TMPDIR:-/tmp}/naia-gw-prepare.XXXXXX")"
trap 'rm -f -- "$TMP/script.sh" "$TMP/protected.txt" "$TMP/protected-motif.txt" "$TMP/result.json"; rmdir -- "$TMP" 2>/dev/null || true' EXIT
PROTECTED=("@$TMP/protected.txt")
if [[ "$STAGE" == backup ]]; then
  # fit075 decision "가" (2026-10-24T23:43Z): the candidate container also gets MOTIF_API_KEY.
  # The value is read here with shell builtins only and leaves this PC solely as a Managed Run
  # Command protected parameter, like ACR_TOKEN: never argv, script literal, trace or log.
  # Checked before any Azure call, so a bad key file changes nothing anywhere.
  MOTIF_KEY_FILE="$(cd -- "$HERE/../../../../.." && pwd -P)/data-private/key/motif-api-key.env" || { echo MOTIF_KEY_FILE_INVALID; exit 1; }
  ROOT="${MOTIF_KEY_FILE%/data-private/key/motif-api-key.env}"
  [[ -e "$ROOT/.git" && -f "$ROOT/AGENTS.md" ]] || { echo MOTIF_KEY_FILE_INVALID; exit 1; }
  for KEY_DIR in "$ROOT" "$ROOT/data-private" "$ROOT/data-private/key"; do
    [[ -d "$KEY_DIR" && ! -L "$KEY_DIR" ]] || { echo MOTIF_KEY_FILE_INVALID; exit 1; }
    KEY_DIR_MODE="$(stat -c '%a' -- "$KEY_DIR")" || { echo MOTIF_KEY_FILE_INVALID; exit 1; }
    KEY_DIR_UID="$(stat -c '%u' -- "$KEY_DIR")" || { echo MOTIF_KEY_FILE_INVALID; exit 1; }
    [[ "$KEY_DIR_MODE" =~ ^[0-7]{3,4}$ && "$KEY_DIR_UID" =~ ^[0-9]+$ ]] &&
      (( (8#$KEY_DIR_MODE & 0022) == 0 )) &&
      { [[ "$KEY_DIR_UID" == "$(id -u)" ]] || (( (8#$KEY_DIR_MODE & 0200) == 0 )); } ||
      { echo MOTIF_KEY_FILE_INVALID; exit 1; }
  done
  [[ -f "$MOTIF_KEY_FILE" && ! -L "$MOTIF_KEY_FILE" && "$(stat -c '%a %u' -- "$MOTIF_KEY_FILE")" == "600 $(id -u)" ]] ||
    { echo MOTIF_KEY_FILE_INVALID; exit 1; }
  MOTIF_VALUE=''
  IFS= read -r MOTIF_VALUE <"$MOTIF_KEY_FILE" || true
  MOTIF_SIZE="$(stat -c '%s' -- "$MOTIF_KEY_FILE")"
  if [[ ! "$MOTIF_VALUE" =~ ^[A-Za-z0-9._-]{16,256}$ ]] ||
     { [[ "$MOTIF_SIZE" != "${#MOTIF_VALUE}" ]] && [[ "$MOTIF_SIZE" != "$(( ${#MOTIF_VALUE} + 1 ))" ]]; }; then
    unset MOTIF_VALUE; echo MOTIF_KEY_FILE_INVALID; exit 1
  fi
  printf 'MOTIF_API_KEY=%s' "$MOTIF_VALUE" >"$TMP/protected-motif.txt"
  unset MOTIF_VALUE MOTIF_SIZE
  PROTECTED+=("@$TMP/protected-motif.txt")
fi
ACTUAL="$(timeout 60 az acr repository show --subscription "$SUBSCRIPTION" -n "$ACR" --image "naia/gateway:$TAG" --query digest -o tsv)"
[[ "$ACTUAL" == "$DIGEST" ]] || { echo TAG_DIGEST_MISMATCH; exit 1; }
# Existing run-command names are never deleted/reused to make a retry fit.
EXISTS="$(timeout 30 az vm run-command list --subscription "$SUBSCRIPTION" -g "$RG" --vm-name "$VM" --query "[?name=='$NAME'].name" -o tsv)"
[[ -z "$EXISTS" ]] || { echo PREPARE_RESOURCE_ALREADY_EXISTS; exit 1; }
TOKEN="$(timeout 60 az acr login --subscription "$SUBSCRIPTION" -n "$ACR" --expose-token --query accessToken -o tsv)"
[[ -n "$TOKEN" ]] || exit 1
printf 'ACR_TOKEN=%s' "$TOKEN" >"$TMP/protected.txt"
unset TOKEN
{
  printf '#!/bin/sh\nset -eu\nexec bash -s <<\047NAIA_REMOTE_BASH\047\nset -euo pipefail\numask 077\n'
  printf "ENVIRONMENT='%s'\nRUN_ID='%s'\nSTAGE='%s'\nIMAGE='%s@%s'\nCURRENT='%s'\nREVISION='%s'\n" "$ENVIRONMENT" "$RUN_ID" "$STAGE" "$REPO" "$DIGEST" "$CURRENT" "$REVISION"
  for SOURCE in naia-gw-deploy.sh gateway-operation.py; do
    KEY=ENTRY; [[ "$SOURCE" != gateway-operation.py ]] || KEY=OPERATION
    printf "%s_B64='%s'\n%s_SHA='%s'\n" "$KEY" "$(base64 <"$HERE/$SOURCE" | tr -d '\r\n')" "$KEY" "$(sha256sum "$HERE/$SOURCE" | awk '{print $1}')"
  done
  cat <<'REMOTE'
DEPLOY_DIR='/opt/naia-gateway/deploy-runner'
TEMP_BASE='/run'
install -d -m 0755 "$DEPLOY_DIR"
AUTH="$(mktemp -d "$TEMP_BASE/naia-gw-acr.$RUN_ID.XXXXXX")"
STAGING="$(mktemp -d "$DEPLOY_DIR/.install-$RUN_ID.XXXXXX")"
AUTH_ID="$(stat -c '%d:%i:%u' "$AUTH")"
STAGING_ID="$(stat -c '%d:%i:%u' "$STAGING")"
cleanup() {
  if [[ -d "$AUTH" && ! -L "$AUTH" && "$(stat -c '%d:%i:%u' "$AUTH")" == "$AUTH_ID" ]]; then
    rm -rf -- "$AUTH"
  fi
  if [[ -d "$STAGING" && ! -L "$STAGING" && "$(stat -c '%d:%i:%u' "$STAGING")" == "$STAGING_ID" ]]; then
    rm -f -- "$STAGING/naia-gw-deploy.sh" "$STAGING/gateway-operation.py"
    rmdir -- "$STAGING" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
export DOCKER_CONFIG="$AUTH"
printf '%s' "${ACR_TOKEN:?}" | timeout 30 docker login acrnaia83b29893.azurecr.io --username 00000000-0000-0000-0000-000000000000 --password-stdin >/dev/null 2>&1
unset ACR_TOKEN
# Held unexported so docker never inherits it; only the backup operation receives it below.
MOTIF_SECRET="${MOTIF_API_KEY:-}"
unset MOTIF_API_KEY
timeout 240 docker pull "$IMAGE" >/dev/null 2>&1
timeout 10 docker logout acrnaia83b29893.azurecr.io >/dev/null 2>&1 || true
unset DOCKER_CONFIG
printf '%s' "$ENTRY_B64" | base64 -d >"$STAGING/naia-gw-deploy.sh"
printf '%s' "$OPERATION_B64" | base64 -d >"$STAGING/gateway-operation.py"
[[ "$(sha256sum "$STAGING/naia-gw-deploy.sh" | awk '{print $1}')" == "$ENTRY_SHA" ]]
[[ "$(sha256sum "$STAGING/gateway-operation.py" | awk '{print $1}')" == "$OPERATION_SHA" ]]
chmod 0750 "$STAGING/naia-gw-deploy.sh" "$STAGING/gateway-operation.py"
# Execute exactly the source just verified; an install from another run cannot
# replace this invocation's Python source. No app/DB mutation occurs here.
if [[ -n "$MOTIF_SECRET" ]]; then export MOTIF_API_KEY="$MOTIF_SECRET"; fi
unset MOTIF_SECRET
timeout 610 bash "$STAGING/naia-gw-deploy.sh" "$STAGE" "$ENVIRONMENT" "$RUN_ID" "$IMAGE" "$CURRENT" "$REVISION"
install -m 0750 "$STAGING/gateway-operation.py" "$DEPLOY_DIR/gateway-operation.py"
install -m 0750 "$STAGING/naia-gw-deploy.sh" "$DEPLOY_DIR/naia-gw-deploy.sh"
REMOTE
  printf '%s\n' NAIA_REMOTE_BASH
} >"$TMP/script.sh"
# Managed Run Command protected parameters carry the token. It is never an argv
# value, script literal, shell trace, or ordinary Docker config on either host.
CREATE_RC=0
timeout 1000 az vm run-command create --subscription "$SUBSCRIPTION" -g "$RG" --vm-name "$VM" \
  --run-command-name "$NAME" --location koreacentral --async-execution false --timeout-in-seconds 950 \
  --script "@$TMP/script.sh" --protected-parameters "${PROTECTED[@]}" \
  -o none || CREATE_RC=$?
rm -f -- "$TMP/protected.txt" "$TMP/protected-motif.txt"
if ! timeout 60 az vm run-command show --subscription "$SUBSCRIPTION" -g "$RG" --vm-name "$VM" --run-command-name "$NAME" --instance-view --query instanceView -o json >"$TMP/result.json"; then
  echo PREPARE_UNVERIFIED inspect_run_command_before_retry
  exit 1
fi
# Only a terminal receipt allows deletion of this command resource. Unknown or
# interrupted execution is left for explicit status inspection, never replayed.
python3 -I - "$TMP/result.json" "$STAGE" "$RUN_ID" "$CREATE_RC" <<'PY'
import json, re, sys
try:
    with open(sys.argv[1]) as f:
        raw = f.read()
    r = json.loads(raw) if raw.strip() else None
    if not isinstance(r, dict):
        raise ValueError('not-json-object')
except (OSError, ValueError) as exc:
    raise SystemExit('PREPARE_UNVERIFIED inspect_run_command_before_retry')
stage=sys.argv[2]
expected=('CLEANUP_OK' if stage=='cleanup' else 'BACKUP_OK')+' run_id='+sys.argv[3]
create_rc=sys.argv[4]
pattern=re.compile(r'^(PREFLIGHT_OBSERVED|CLEANUP_OBSERVED|CLEANUP_INVENTORY|CLEANUP_REMOVED) [A-Za-z0-9 ._:/@<>=,+%()-]{1,300}$')
for source in ((r.get('output') or ''), (r.get('error') or '')):
    for line in source.splitlines():
        if pattern.fullmatch(line):
            print(line)
if r.get('executionState','').lower()!='succeeded' or r.get('exitCode')!=0 or (r.get('error') or '').strip() or expected not in (r.get('output') or '').splitlines() or create_rc!='0':
    safe=re.search(r'^OPERATION_FAILED reason=([A-Za-z0-9_]+)$', r.get('error') or '', re.M)
    raise SystemExit('PREPARE_UNVERIFIED inspect_run_command_before_retry' + (' reason='+safe[1] if safe else ''))
print(expected)
PY
timeout 60 az vm run-command delete --subscription "$SUBSCRIPTION" -g "$RG" --vm-name "$VM" --run-command-name "$NAME" --yes -o none || { echo PREPARE_RESOURCE_DELETE_UNVERIFIED; exit 1; }
