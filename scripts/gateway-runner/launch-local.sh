#!/usr/bin/env bash
# Install the reviewed two-file runner and synchronously back up.
# This command never deploys the candidate. AI invokes deploy and verify separately.
set -euo pipefail
umask 077
[[ $# == 6 || $# == 7 || $# == 8 ]] || exit 64
ENVIRONMENT="$1" RUN_ID="$2" TAG="$3" DIGEST="$4" CURRENT="$5" REVISION="$6" STAGE="${7:-backup}" ADDITIONS="${8:--}"
[[ "$RUN_ID" =~ ^[0-9]{8}T[0-9]{6}Z-[a-z0-9-]{1,32}$ && "$TAG" =~ ^[A-Za-z0-9_.-]{1,128}$ &&
   "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ && "$CURRENT" =~ ^sha256:[0-9a-f]{64}$ &&
   "$REVISION" =~ ^[A-Za-z0-9_.-]{1,128}$ ]] || exit 64
[[ "$STAGE" == backup || "$STAGE" == cleanup ]] || exit 64
case "$ADDITIONS" in
  -|azure-tts-key-v1|azure-tts-region-v1|app-signing-public-key-v1|\
  azure-tts-key-v1,azure-tts-region-v1|azure-tts-key-v1,app-signing-public-key-v1|\
  azure-tts-region-v1,app-signing-public-key-v1|\
  azure-tts-key-v1,azure-tts-region-v1,app-signing-public-key-v1) ;;
  *) exit 64 ;;
esac
[[ "$STAGE" != cleanup || "$ADDITIONS" == - ]] || exit 64
case "$ENVIRONMENT" in prod|dev) ;; *) exit 64 ;; esac
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
# The bundle may live at a different depth in an operator checkout.
ROOT="$HERE"
while [[ ! -e "$ROOT/.git" || ! -f "$ROOT/AGENTS.md" ]]; do
  [[ "$ROOT" != / ]] || { echo MOTIF_KEY_FILE_INVALID; exit 1; }
  ROOT="${ROOT%/*}"
  [[ -n "$ROOT" ]] || ROOT=/
done
MOTIF_KEY_FILE="$ROOT/data-private/key/motif-api-key.env"
for KEY_DIR in "$ROOT" "$ROOT/data-private" "$ROOT/data-private/key"; do
  [[ -d "$KEY_DIR" && ! -L "$KEY_DIR" ]] || { echo MOTIF_KEY_FILE_INVALID; exit 1; }
  KEY_DIR_MODE="$(stat -c '%a' -- "$KEY_DIR")" || { echo MOTIF_KEY_FILE_INVALID; exit 1; }
  KEY_DIR_UID="$(stat -c '%u' -- "$KEY_DIR")" || { echo MOTIF_KEY_FILE_INVALID; exit 1; }
  [[ "$KEY_DIR_MODE" =~ ^[0-7]{3,4}$ && "$KEY_DIR_UID" =~ ^[0-9]+$ ]] &&
    (( (8#$KEY_DIR_MODE & 0022) == 0 )) &&
    { [[ "$KEY_DIR_UID" == "$(id -u)" ]] || (( (8#$KEY_DIR_MODE & 0200) == 0 )); } ||
    { echo MOTIF_KEY_FILE_INVALID; exit 1; }
done
if [[ "$STAGE" == backup ]]; then
  # The candidate container also gets MOTIF_API_KEY; the value leaves this host
  # only as a Managed Run Command protected parameter.
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
CFG_FILE="$ROOT/config/deploy-gate.json"
for CFG_PATH in "$ROOT/config" "$CFG_FILE"; do
  [[ -e "$CFG_PATH" && ! -L "$CFG_PATH" ]] || { echo PREPARE_UNVERIFIED; exit 1; }
  CFG_MODE="$(stat -c '%a' -- "$CFG_PATH")" || { echo PREPARE_UNVERIFIED; exit 1; }
  CFG_UID="$(stat -c '%u' -- "$CFG_PATH")" || { echo PREPARE_UNVERIFIED; exit 1; }
  [[ "$CFG_MODE" =~ ^[0-7]{3,4}$ && "$CFG_UID" =~ ^[0-9]+$ ]] &&
    (( (8#$CFG_MODE & 0022) == 0 )) &&
    { [[ "$CFG_UID" == "$(id -u)" ]] || (( (8#$CFG_MODE & 0200) == 0 )); } ||
    { echo PREPARE_UNVERIFIED; exit 1; }
done
[[ -f "$CFG_FILE" ]] || { echo PREPARE_UNVERIFIED; exit 1; }
TARGET_RAW="$(python3 -I -c '
import json, re, sys
cfg_path, env_name = sys.argv[1:]
with open(cfg_path, encoding="utf-8") as f:
    cfg = json.load(f)
if not isinstance(cfg, dict):
    raise SystemExit(1)
candidates = []
if isinstance(cfg.get("gatewayRunner"), dict):
    candidates.append((cfg["gatewayRunner"].get("service"), cfg["gatewayRunner"]))
services = cfg.get("services")
if isinstance(services, dict):
    for svc, rule in services.items():
        if isinstance(rule, dict) and isinstance(rule.get("gatewayRunner"), dict):
            candidates.append((svc, rule["gatewayRunner"]))
if len(candidates) != 1:
    raise SystemExit(1)
svc, gw = candidates[0]
sub = gw.get("subscriptionId", "")
location = gw.get("location", "")
acr = gw.get("acrName", "")
repo = gw.get("imageRepo", "")
envs = gw.get("environments")
target = envs.get(env_name) if isinstance(envs, dict) else None
if not isinstance(sub, str) or not re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", sub):
    raise SystemExit(1)
if not isinstance(location, str) or not re.fullmatch(r"[a-z0-9]{1,64}", location):
    raise SystemExit(1)
if not isinstance(acr, str) or not re.fullmatch(r"[a-z0-9]{5,50}", acr):
    raise SystemExit(1)
if not isinstance(repo, str) or not re.fullmatch(r"[a-z0-9]{5,50}\.azurecr\.io/[a-z0-9._/-]{1,128}", repo) or not repo.startswith(acr + ".azurecr.io/"):
    raise SystemExit(1)
if not isinstance(target, dict):
    raise SystemExit(1)
rg, vm = target.get("resourceGroup", ""), target.get("vmName", "")
if not isinstance(rg, str) or not re.fullmatch(r"[A-Za-z0-9._()-]{1,90}", rg):
    raise SystemExit(1)
if not isinstance(vm, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", vm):
    raise SystemExit(1)
if env_name == "prod" and isinstance(svc, str) and svc.startswith("azure:vm:"):
    if vm.lower() != svc[len("azure:vm:"):].lower():
        raise SystemExit(1)
print(sub.lower(), location, acr, repo, rg, vm)
' "$CFG_FILE" "$ENVIRONMENT" 2>/dev/null)" || { echo PREPARE_UNVERIFIED; exit 1; }
SUBSCRIPTION='' LOCATION='' ACR='' REPO='' RG='' VM='' EXTRA=''
IFS=' ' read -r SUBSCRIPTION LOCATION ACR REPO RG VM EXTRA <<<"$TARGET_RAW"
[[ -z "$EXTRA" && "$SUBSCRIPTION" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ &&
   "$LOCATION" =~ ^[a-z0-9]{1,64}$ && "$ACR" =~ ^[a-z0-9]{5,50}$ &&
   "$REPO" =~ ^[a-z0-9]{5,50}\.azurecr\.io/[a-z0-9._/-]{1,128}$ && "$REPO" == "$ACR.azurecr.io/"* &&
   "$RG" =~ ^[A-Za-z0-9._()-]{1,90}$ && "$VM" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || { echo PREPARE_UNVERIFIED; exit 1; }
IMAGE_NAME="${REPO#"$ACR.azurecr.io/"}"
ACTUAL="$(timeout 60 az acr repository show --subscription "$SUBSCRIPTION" -n "$ACR" --image "$IMAGE_NAME:$TAG" --query digest -o tsv 2>/dev/null)" || { echo PREPARE_UNVERIFIED; exit 1; }
[[ "$ACTUAL" == "$DIGEST" ]] || { echo TAG_DIGEST_MISMATCH; exit 1; }
# Existing run-command names are never deleted/reused to make a retry fit.
EXISTS="$(timeout 30 az vm run-command list --subscription "$SUBSCRIPTION" -g "$RG" --vm-name "$VM" --query "[?name=='$NAME'].name" -o tsv 2>/dev/null)" || { echo PREPARE_UNVERIFIED; exit 1; }
[[ -z "$EXISTS" ]] || { echo PREPARE_RESOURCE_ALREADY_EXISTS; exit 1; }
TOKEN="$(timeout 60 az acr login --subscription "$SUBSCRIPTION" -n "$ACR" --expose-token --query accessToken -o tsv 2>/dev/null)" || { echo PREPARE_UNVERIFIED; exit 1; }
[[ -n "$TOKEN" ]] || exit 1
printf 'ACR_TOKEN=%s' "$TOKEN" >"$TMP/protected.txt"
unset TOKEN
{
  printf '#!/bin/sh\nset -eu\nexec bash -s <<\047NAIA_REMOTE_BASH\047\nset -euo pipefail\numask 077\n'
  printf "ENVIRONMENT='%s'\nRUN_ID='%s'\nSTAGE='%s'\nIMAGE='%s@%s'\nCURRENT='%s'\nREVISION='%s'\nADDITIONS='%s'\n" "$ENVIRONMENT" "$RUN_ID" "$STAGE" "$REPO" "$DIGEST" "$CURRENT" "$REVISION" "$ADDITIONS"
  for SOURCE in naia-gw-deploy.sh gateway-operation.py; do
    KEY=ENTRY; [[ "$SOURCE" != gateway-operation.py ]] || KEY=OPERATION
    printf "%s_B64='%s'\n%s_SHA='%s'\n" "$KEY" "$(base64 <"$HERE/$SOURCE" | tr -d '\r\n')" "$KEY" "$(sha256sum "$HERE/$SOURCE" | awk '{print $1}')"
  done
  cat <<'REMOTE'
# Keep protected parameters out of all unrelated child process environments.
MOTIF_SECRET="${MOTIF_API_KEY:-}"
AUTH_TOKEN="${ACR_TOKEN:?}"
export -n MOTIF_SECRET AUTH_TOKEN
unset MOTIF_API_KEY ACR_TOKEN
DEPLOY_DIR='/opt/naia-gateway/deploy-runner'
TEMP_BASE='/run'
# One exclusive lock serializes installations and blocks operations while switching.
exec 9>/run/lock/naia-gateway-runner-install.lock
flock -x 9
VERSIONS='/opt/naia-gateway/.deploy-runner-versions'
install -d -m 0700 "$VERSIONS"
[[ -d "$VERSIONS" && ! -L "$VERSIONS" && "$(stat -c '%u:%g:%a' "$VERSIONS")" == 0:0:700 ]] || exit 1
AUTH="$(mktemp -d "$TEMP_BASE/naia-gw-acr.$RUN_ID.XXXXXX")"
STAGING="$(mktemp -d "$VERSIONS/$RUN_ID.XXXXXX")"
INSTALLED=0
AUTH_ID="$(stat -c '%d:%i:%u' "$AUTH")"
STAGING_ID="$(stat -c '%d:%i:%u' "$STAGING")"
cleanup() {
  if [[ -d "$AUTH" && ! -L "$AUTH" && "$(stat -c '%d:%i:%u' "$AUTH")" == "$AUTH_ID" ]]; then
    rm -rf -- "$AUTH"
  fi
  if [[ "$INSTALLED" == 0 && -d "$STAGING" && ! -L "$STAGING" && "$(stat -c '%d:%i:%u' "$STAGING")" == "$STAGING_ID" ]]; then
    rm -f -- "$STAGING/naia-gw-deploy.sh" "$STAGING/gateway-operation.py"
    rmdir -- "$STAGING" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
export DOCKER_CONFIG="$AUTH"
printf '%s' "$AUTH_TOKEN" | timeout 30 docker login "${IMAGE%%/*}" --username 00000000-0000-0000-0000-000000000000 --password-stdin >/dev/null 2>&1
unset AUTH_TOKEN
timeout 240 docker pull "$IMAGE" >/dev/null 2>&1
timeout 10 docker logout "${IMAGE%%/*}" >/dev/null 2>&1 || true
unset DOCKER_CONFIG
printf '%s' "$ENTRY_B64" | base64 -d >"$STAGING/naia-gw-deploy.sh"
printf '%s' "$OPERATION_B64" | base64 -d >"$STAGING/gateway-operation.py"
[[ "$(sha256sum "$STAGING/naia-gw-deploy.sh" | awk '{print $1}')" == "$ENTRY_SHA" ]]
[[ "$(sha256sum "$STAGING/gateway-operation.py" | awk '{print $1}')" == "$OPERATION_SHA" ]]
chmod 0750 "$STAGING/naia-gw-deploy.sh" "$STAGING/gateway-operation.py"
# Execute exactly the source just verified; an install from another run cannot
# replace this invocation's Python source. No app/DB mutation occurs here.
# Scope the protected value to this child, and clear the shell copy before
# either continuing or entering the failure cleanup path.
BACKUP_RC=0
if [[ -n "$MOTIF_SECRET" ]]; then
  MOTIF_API_KEY="$MOTIF_SECRET" timeout 610 bash "$STAGING/naia-gw-deploy.sh" "$STAGE" "$ENVIRONMENT" "$RUN_ID" "$IMAGE" "$CURRENT" "$REVISION" "$ADDITIONS" || BACKUP_RC=$?
else
  timeout 610 bash "$STAGING/naia-gw-deploy.sh" "$STAGE" "$ENVIRONMENT" "$RUN_ID" "$IMAGE" "$CURRENT" "$REVISION" "$ADDITIONS" || BACKUP_RC=$?
fi
unset MOTIF_SECRET
[[ "$BACKUP_RC" == 0 ]] || exit "$BACKUP_RC"
# Cleanup runs the verified staged runner but does not install it.  The trap
# removes staging, leaving the same RUN_ID available for the backup switch.
if [[ "$STAGE" == cleanup ]]; then
  exit 0
fi
# Swap the whole version as one namespace operation, including on first migration
# from the legacy directory. Retain the displaced version for approved recovery.
INSTALLED=1 # Never remove a version once a switch may have started.
python3 -I - "$STAGING" "$DEPLOY_DIR" "$RUN_ID" <<'PYINSTALL'
import ctypes, os, sys
version, target, run_id = sys.argv[1:]
link = target + '.switch-' + run_id
if os.path.lexists(target + '.previous-' + run_id):
    raise SystemExit('INSTALL_UNVERIFIED')
os.symlink(version, link)
try:
    if os.path.lexists(target):
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.renameat2(-100, os.fsencode(link), -100, os.fsencode(target), 2) != 0:
            err = ctypes.get_errno()
            raise OSError(err, os.strerror(err))
        os.rename(link, target + '.previous-' + run_id)
    else:
        os.rename(link, target)
finally:
    if os.path.islink(link):
        os.unlink(link)
PYINSTALL
INSTALLED=1
[[ "$(sha256sum "$DEPLOY_DIR/naia-gw-deploy.sh" | awk '{print $1}')" == "$ENTRY_SHA" ]]
[[ "$(sha256sum "$DEPLOY_DIR/gateway-operation.py" | awk '{print $1}')" == "$OPERATION_SHA" ]]
printf 'INSTALL_OK run_id=%s entry=%s operation=%s\n' "$RUN_ID" "$ENTRY_SHA" "$OPERATION_SHA"
REMOTE
  printf '%s\n' NAIA_REMOTE_BASH
} >"$TMP/script.sh"
# Managed Run Command protected parameters carry the token. It is never an argv
# value, script literal, shell trace, or ordinary Docker config on either host.
CREATE_RC=0
timeout 1000 az vm run-command create --subscription "$SUBSCRIPTION" -g "$RG" --vm-name "$VM" \
  --run-command-name "$NAME" --location "$LOCATION" --async-execution false --timeout-in-seconds 950 \
  --script "@$TMP/script.sh" --protected-parameters "${PROTECTED[@]}" \
  -o none >/dev/null 2>&1 || CREATE_RC=$?
rm -f -- "$TMP/protected.txt" "$TMP/protected-motif.txt"
if ! timeout 60 az vm run-command show --subscription "$SUBSCRIPTION" -g "$RG" --vm-name "$VM" --run-command-name "$NAME" --instance-view --query instanceView -o json >"$TMP/result.json" 2>/dev/null; then
  echo PREPARE_UNVERIFIED inspect_run_command_before_retry
  exit 1
fi
# Only a terminal receipt allows deletion of this command resource. Unknown or
# interrupted execution is left for explicit status inspection, never replayed.
python3 -I - "$TMP/result.json" "$STAGE" "$RUN_ID" "$CREATE_RC" "$(sha256sum "$HERE/naia-gw-deploy.sh" | awk '{print $1}')" "$(sha256sum "$HERE/gateway-operation.py" | awk '{print $1}')" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as f:
        raw = f.read()
    r = json.loads(raw) if raw.strip() else None
    if (not isinstance(r, dict) or not isinstance(r.get('executionState'), str)
            or not isinstance(r.get('output') or '', str) or not isinstance(r.get('error') or '', str)):
        raise ValueError('invalid-result')
except (OSError, ValueError) as exc:
    raise SystemExit('PREPARE_UNVERIFIED inspect_run_command_before_retry')
stage=sys.argv[2]
expected=('CLEANUP_OK' if stage=='cleanup' else 'BACKUP_OK')+' run_id='+sys.argv[3]
create_rc=sys.argv[4]
install='INSTALL_OK run_id='+sys.argv[3]+' entry='+sys.argv[5]+' operation='+sys.argv[6]
if r.get('executionState','').lower()!='succeeded' or r.get('exitCode')!=0 or (r.get('error') or '').strip() or expected not in (r.get('output') or '').splitlines() or (stage == 'backup' and install not in (r.get('output') or '').splitlines()) or create_rc!='0':
    raise SystemExit('PREPARE_UNVERIFIED inspect_run_command_before_retry')
print(expected)
if stage == 'backup':
    print(install)
PY
timeout 60 az vm run-command delete --subscription "$SUBSCRIPTION" -g "$RG" --vm-name "$VM" --run-command-name "$NAME" --yes -o none >/dev/null 2>&1 || { echo PREPARE_RESOURCE_DELETE_UNVERIFIED; exit 1; }
