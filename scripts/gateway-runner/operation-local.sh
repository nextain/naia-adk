#!/usr/bin/env bash
# One synchronous, operator-observed remote operation. Never automatic recovery.
set -euo pipefail
[[ $# == 3 ]] || exit 64
ENVIRONMENT="$1" RUN_ID="$2" PHASE="$3"
[[ "$RUN_ID" =~ ^[0-9]{8}T[0-9]{6}Z-[a-z0-9-]{1,32}$ ]] || exit 64
case "$PHASE" in deploy|verify|status|rollback|env-names|installed-hashes) ;; *) exit 64 ;; esac
case "$ENVIRONMENT" in
  prod) RG=RG-NAIA-PROD-KOREACENTRAL; VM=naia-gateway-prod-az ;;
  dev) RG=RG-NAIA-DEV-KOREACENTRAL; VM=naia-gateway-dev-az ;;
  *) exit 64 ;;
esac
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ENTRY_SHA="$(sha256sum "$HERE/naia-gw-deploy.sh" | cut -d' ' -f1)"
OP_SHA="$(sha256sum "$HERE/gateway-operation.py" | cut -d' ' -f1)"
SCRIPT="exec 9>/run/lock/naia-gateway-runner-install.lock; flock -s 9; test \"\$(sha256sum /opt/naia-gateway/deploy-runner/naia-gw-deploy.sh | cut -d' ' -f1)\" = '$ENTRY_SHA' && test \"\$(sha256sum /opt/naia-gateway/deploy-runner/gateway-operation.py | cut -d' ' -f1)\" = '$OP_SHA' || { printf 'REMOTE_EXIT=1\\n'; exit 0; }; bash /opt/naia-gateway/deploy-runner/naia-gw-deploy.sh '$PHASE' '$ENVIRONMENT' '$RUN_ID'; rc=\$?; printf 'REMOTE_EXIT=%s\\n' \"\$rc\"; exit 0"
if [[ "$PHASE" == installed-hashes ]]; then
  SCRIPT="exec 9>/run/lock/naia-gateway-runner-install.lock; flock -s 9; test \"\$(sha256sum /opt/naia-gateway/deploy-runner/naia-gw-deploy.sh | cut -d' ' -f1)\" = '$ENTRY_SHA' && test \"\$(sha256sum /opt/naia-gateway/deploy-runner/gateway-operation.py | cut -d' ' -f1)\" = '$OP_SHA' || { printf 'REMOTE_EXIT=1\\n'; exit 0; }; printf 'INSTALL_VERIFIED entry=$ENTRY_SHA operation=$OP_SHA\\nREMOTE_EXIT=0\\n'"
fi
OUTPUT="$(timeout 620 az vm run-command invoke --subscription 83b29893-2929-4593-bf1f-1f7b8aa53630 \
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
             "AZURE_TTS_REGION", "AZURE_SPEECH_REGION", "AZURE_TTS_ENDPOINT")
    lines = m.group(1).splitlines()
    if len(lines) != 8 or lines[-2:] != ["ENV_NAMES_OK run_id=" + run, "REMOTE_EXIT=0"]:
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
