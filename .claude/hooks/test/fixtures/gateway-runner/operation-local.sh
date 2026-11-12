#!/usr/bin/env bash
# One synchronous, operator-observed remote operation. Never automatic recovery.
set -euo pipefail
[[ $# == 3 ]] || exit 64
ENVIRONMENT="$1" RUN_ID="$2" PHASE="$3"
[[ "$RUN_ID" =~ ^[0-9]{8}T[0-9]{6}Z-[a-z0-9-]{1,32}$ ]] || exit 64
case "$PHASE" in deploy|verify|status|rollback) ;; *) exit 64 ;; esac
case "$ENVIRONMENT" in
  prod) RG=RG-NAIA-PROD-KOREACENTRAL; VM=naia-gateway-prod-az ;;
  dev) RG=RG-NAIA-DEV-KOREACENTRAL; VM=naia-gateway-dev-az ;;
  *) exit 64 ;;
esac
SCRIPT="bash /opt/naia-gateway/deploy-runner/naia-gw-deploy.sh '$PHASE' '$ENVIRONMENT' '$RUN_ID'; rc=\$?; printf '\\nREMOTE_EXIT=%s\\n' \"\$rc\"; exit 0"
OUTPUT="$(timeout 620 az vm run-command invoke --subscription 83b29893-2929-4593-bf1f-1f7b8aa53630 \
  --resource-group "$RG" --name "$VM" --command-id RunShellScript --scripts "$SCRIPT" \
  --query 'value[0].message' --output tsv)" || { echo REMOTE_OPERATION_UNVERIFIED; exit 1; }
python3 -I -c '
import re, sys
raw = sys.stdin.read().replace("\r\n", "\n")
m = re.fullmatch(r"\s*Enable succeeded:\s*\[stdout\]\n(.*?)\n\[stderr\]\s*(.*?)\s*", raw, re.S)
if not m:
    raise SystemExit("REMOTE_OPERATION_UNVERIFIED")
if m.group(2).strip() or not re.search(r"^REMOTE_EXIT=0$", m.group(1), re.M):
    safe = re.search(r"^OPERATION_FAILED reason=([A-Za-z0-9_]+)$", m.group(2), re.M)
    raise SystemExit("REMOTE_OPERATION_FAILED" + (" reason=" + safe[1] if safe else ""))
phase, run = sys.argv[1:]
expected = {"deploy":"DEPLOYED", "verify":"DEPLOY_OK", "rollback":"ROLLBACK_OK"}.get(phase)
if expected and (expected + " run_id=" + run) not in m.group(1).splitlines():
    raise SystemExit("REMOTE_OPERATION_RECEIPT_MISSING")
if phase == "status" and not re.search(r"^PHASE=[A-Z_]+ run_id=" + re.escape(run) + r"$", m.group(1), re.M):
    raise SystemExit("REMOTE_STATUS_RECEIPT_MISSING")
print(m.group(1).strip())
' "$PHASE" "$RUN_ID" <<<"$OUTPUT"
