#!/usr/bin/env bash
# One synchronous, operator-observed remote operation. Never automatic recovery.
set -euo pipefail
[[ $# == 3 ]] || exit 64
ENVIRONMENT="$1" RUN_ID="$2" PHASE="$3"
[[ "$RUN_ID" =~ ^[0-9]{8}T[0-9]{6}Z-[a-z0-9-]{1,32}$ ]] || exit 64
case "$PHASE" in deploy|verify|status|rollback|env-names|installed-hashes) ;; *) exit 64 ;; esac
case "$ENVIRONMENT" in prod|dev) ;; *) exit 64 ;; esac
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SOURCE_PATH="$(realpath -m -- "${BASH_SOURCE[0]}")" || { echo REMOTE_OPERATION_UNVERIFIED; exit 1; }
[[ "$SOURCE_PATH" == "$HERE/$(basename -- "${BASH_SOURCE[0]}")" ]] || { echo REMOTE_OPERATION_UNVERIFIED; exit 1; }
ROOT="$HERE"
while [[ ! -e "$ROOT/.git" || ! -f "$ROOT/AGENTS.md" ]]; do
  [[ "$ROOT" != / ]] || { echo REMOTE_OPERATION_UNVERIFIED; exit 1; }
  ROOT="${ROOT%/*}"
  [[ -n "$ROOT" ]] || ROOT=/
done
CFG_FILE="$ROOT/config/deploy-gate.json"
for CFG_PATH in "$ROOT" "$ROOT/config" "$CFG_FILE"; do
  [[ -e "$CFG_PATH" && ! -L "$CFG_PATH" ]] || { echo REMOTE_OPERATION_UNVERIFIED; exit 1; }
  CFG_MODE="$(stat -c '%a' -- "$CFG_PATH")" || { echo REMOTE_OPERATION_UNVERIFIED; exit 1; }
  CFG_UID="$(stat -c '%u' -- "$CFG_PATH")" || { echo REMOTE_OPERATION_UNVERIFIED; exit 1; }
  [[ "$CFG_MODE" =~ ^[0-7]{3,4}$ && "$CFG_UID" =~ ^[0-9]+$ ]] &&
    (( (8#$CFG_MODE & 0022) == 0 )) &&
    { [[ "$CFG_UID" == "$(id -u)" ]] || (( (8#$CFG_MODE & 0200) == 0 )); } ||
    { echo REMOTE_OPERATION_UNVERIFIED; exit 1; }
done
[[ -f "$CFG_FILE" ]] || { echo REMOTE_OPERATION_UNVERIFIED; exit 1; }
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
envs = gw.get("environments")
target = envs.get(env_name) if isinstance(envs, dict) else None
if not isinstance(sub, str) or not re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", sub):
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
print(sub.lower(), rg, vm)
' "$CFG_FILE" "$ENVIRONMENT" 2>/dev/null)" || { echo REMOTE_OPERATION_UNVERIFIED; exit 1; }
SUBSCRIPTION='' RG='' VM='' EXTRA=''
IFS=' ' read -r SUBSCRIPTION RG VM EXTRA <<<"$TARGET_RAW"
[[ -z "$EXTRA" && "$SUBSCRIPTION" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ &&
   "$RG" =~ ^[A-Za-z0-9._()-]{1,90}$ && "$VM" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || { echo REMOTE_OPERATION_UNVERIFIED; exit 1; }
ENTRY_SHA="$(sha256sum "$HERE/naia-gw-deploy.sh" | cut -d' ' -f1)"
OP_SHA="$(sha256sum "$HERE/gateway-operation.py" | cut -d' ' -f1)"
SCRIPT="exec 9>/run/lock/naia-gateway-runner-install.lock; flock -s 9; test \"\$(sha256sum /opt/naia-gateway/deploy-runner/naia-gw-deploy.sh | cut -d' ' -f1)\" = '$ENTRY_SHA' && test \"\$(sha256sum /opt/naia-gateway/deploy-runner/gateway-operation.py | cut -d' ' -f1)\" = '$OP_SHA' || { printf 'REMOTE_EXIT=1\\n'; exit 0; }; bash /opt/naia-gateway/deploy-runner/naia-gw-deploy.sh '$PHASE' '$ENVIRONMENT' '$RUN_ID'; rc=\$?; printf 'REMOTE_EXIT=%s\\n' \"\$rc\"; exit 0"
if [[ "$PHASE" == installed-hashes ]]; then
  SCRIPT="exec 9>/run/lock/naia-gateway-runner-install.lock; flock -s 9; test \"\$(sha256sum /opt/naia-gateway/deploy-runner/naia-gw-deploy.sh | cut -d' ' -f1)\" = '$ENTRY_SHA' && test \"\$(sha256sum /opt/naia-gateway/deploy-runner/gateway-operation.py | cut -d' ' -f1)\" = '$OP_SHA' || { printf 'REMOTE_EXIT=1\\n'; exit 0; }; printf 'INSTALL_VERIFIED entry=$ENTRY_SHA operation=$OP_SHA\\nREMOTE_EXIT=0\\n'"
fi
OUTPUT="$(timeout 620 az vm run-command invoke --subscription "$SUBSCRIPTION" \
  --resource-group "$RG" --name "$VM" --command-id RunShellScript --scripts "$SCRIPT" \
  --query 'value[0].message' --output tsv 2>/dev/null)" || { echo REMOTE_OPERATION_UNVERIFIED; exit 1; }
python3 -I -c '
import re, sys
raw = sys.stdin.read().replace("\r\n", "\n")
m = re.fullmatch(r"\s*Enable succeeded:\s*\[stdout\]\n(.*?)\n\[stderr\]\s*(.*?)\s*", raw, re.S)
if not m:
    raise SystemExit("REMOTE_OPERATION_UNVERIFIED")
if m.group(2).strip() or not re.search(r"^REMOTE_EXIT=0$", m.group(1), re.M):
    raise SystemExit("REMOTE_OPERATION_UNVERIFIED")
phase, run, entry, operation = sys.argv[1:]
if phase == "installed-hashes":
    expected = "INSTALL_VERIFIED entry=" + entry + " operation=" + operation
    if m.group(1).splitlines() != [expected, "REMOTE_EXIT=0"]:
        raise SystemExit("REMOTE_OPERATION_UNVERIFIED")
    print(expected)
    raise SystemExit(0)
if phase == "env-names":
    names = ("AZURE_TTS_KEY", "AZURE_SPEECH_KEY", "AZURE_FOUNDRY_API_KEY",
             "AZURE_TTS_REGION", "AZURE_SPEECH_REGION", "AZURE_TTS_ENDPOINT",
             "APP_SIGNING_PUBLIC_KEY")
    lines = m.group(1).splitlines()
    if len(lines) != len(names) + 2 or lines[-2:] != ["ENV_NAMES_OK run_id=" + run, "REMOTE_EXIT=0"]:
        raise SystemExit("REMOTE_OPERATION_UNVERIFIED")
    states = []
    for name, line in zip(names, lines):
        match = re.fullmatch(re.escape(name) + r"=(ABSENT|EMPTY|PRESENT)", line)
        if not match:
            raise SystemExit("REMOTE_OPERATION_UNVERIFIED")
        states.append(match[1])
    for name, state in zip(names, states):
        print(name + "=" + state)
    print("ENV_NAMES_OK run_id=" + run)
    raise SystemExit(0)
lines = m.group(1).splitlines()
expected = {"deploy":"DEPLOYED", "verify":"DEPLOY_OK", "rollback":"ROLLBACK_OK"}.get(phase)
if expected:
    receipt = expected + " run_id=" + run
    allowed = {receipt, "DEPLOYING run_id=" + run, "RESTORING run_id=" + run, "REMOTE_EXIT=0"}
    if not lines or lines[-1] != "REMOTE_EXIT=0" or lines.count(receipt) != 1 or any(line not in allowed for line in lines):
        raise SystemExit("REMOTE_OPERATION_UNVERIFIED")
    for line in lines[:-1]:
        print(line)
    raise SystemExit(0)
if phase == "status":
    if (len(lines) not in (4, 5) or
        not re.fullmatch(r"PHASE=(BACKUP_OK|DEPLOYING|DEPLOYED|DEPLOY_OK|RESTORING|ROLLBACK_OK) run_id=" + re.escape(run), lines[0]) or
        not re.fullmatch(r"LIVE_DIGEST=(missing|sha256:[0-9a-f]{64}) RUNNING=(true|false)", lines[1]) or
        not re.fullmatch(r"STATUS_VERIFIED=[01]", lines[-2]) or lines[-1] != "REMOTE_EXIT=0" or
        (len(lines) == 5 and not re.fullmatch(r"SPEECH_SET_JOBS=(unread)|SPEECH_SET_JOBS open=[0-9]+ reserved=[0-9]+", lines[2]))):
        raise SystemExit("REMOTE_OPERATION_UNVERIFIED")
    for line in lines[:-1]:
        print(line)
    raise SystemExit(0)
raise SystemExit("REMOTE_OPERATION_UNVERIFIED")
' "$PHASE" "$RUN_ID" "$ENTRY_SHA" "$OP_SHA" <<<"$OUTPUT"
