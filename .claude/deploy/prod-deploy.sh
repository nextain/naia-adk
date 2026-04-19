#!/usr/bin/env bash
#
# Production Deploy Script
#
# The ONLY allowed path for production deployments.
# Checks approvals.json → runs pre-deploy-check → countdown → execute → log.
#
# Usage: ./prod-deploy.sh <project-name> [--dry-run]
# Example: ./prod-deploy.sh naia.nextain.io
#          ./prod-deploy.sh naia.nextain.io --dry-run

set -euo pipefail

PROJECT="${1:?Usage: prod-deploy.sh <project-name> [--dry-run]}"
DRY_RUN=false
[ "${2:-}" = "--dry-run" ] && DRY_RUN=true

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$SCRIPT_DIR/config.json"
APPROVALS="$SCRIPT_DIR/approvals.json"
AUDIT="$SCRIPT_DIR/audit.jsonl"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

log_audit() {
  local event="$1"
  local extra="$2"
  echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"${event}\",\"project\":\"${PROJECT}\",${extra}}" >> "$AUDIT"
}

# Validate project name (alphanumeric, dots, hyphens only — prevent injection)
if ! echo "$PROJECT" | grep -qE '^[a-zA-Z0-9._-]+$'; then
  echo -e "${RED}ERROR: Invalid project name: $PROJECT${NC}" >&2
  exit 1
fi

# --- 1. Load config ---
if [ ! -f "$CONFIG" ]; then
  echo -e "${RED}ERROR: config.json not found${NC}" >&2
  exit 1
fi

PROJECT_CWD=$(node -e "
  const c = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
  const p = c.projects[process.argv[2]];
  if (!p) { process.exit(1); }
  console.log(p.cwd || '');
" "$CONFIG" "$PROJECT" 2>/dev/null) || {
  echo -e "${RED}ERROR: Project '$PROJECT' not found in config.json${NC}" >&2
  echo "Available projects:"
  node -e "Object.keys(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).projects).forEach(k => console.log('  - ' + k))" "$CONFIG" 2>/dev/null
  exit 1
}

PROD_COMMAND=$(node -e "
  const c = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
  console.log(c.projects[process.argv[2]].prod_command || '');
" "$CONFIG" "$PROJECT" 2>/dev/null)

PLATFORM=$(node -e "
  const c = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
  console.log(c.projects[process.argv[2]].platform || '');
" "$CONFIG" "$PROJECT" 2>/dev/null)

# --- 2. Check approval ---
echo -e "${BOLD}=== Production Deploy ===${NC}"
echo "Project:  $PROJECT"
echo "Platform: $PLATFORM"
echo "Command:  $PROD_COMMAND"
echo ""

APPROVAL=$(node -e "
  const a = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
  const project = process.argv[2];
  const found = (a.approvals || []).find(a =>
    a.project === project && new Date(a.expires_at) > new Date()
  );
  if (found) {
    console.log(JSON.stringify(found));
  } else {
    process.exit(1);
  }
" "$APPROVALS" "$PROJECT" 2>/dev/null) || {
  echo -e "${RED}BLOCKED: No valid approval for '$PROJECT'${NC}" >&2
  echo "" >&2
  echo "To approve, add entry to .claude/deploy/approvals.json:" >&2
  echo "  {" >&2
  echo "    \"project\": \"$PROJECT\"," >&2
  echo "    \"approved_by\": \"user:luke\"," >&2
  echo "    \"approved_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"," >&2
  echo "    \"expires_at\": \"$(date -u -d '+30 minutes' +%Y-%m-%dT%H:%M:%SZ)\"," >&2
  echo "    \"session_id\": \"<session-id>\"," >&2
  echo "    \"reason\": \"...\"" >&2
  echo "  }" >&2
  log_audit "blocked" "\"reason\":\"no_approval\""
  exit 1
}

echo -e "${GREEN}Approval found:${NC}"
echo "$APPROVAL" | node -e "
  const a = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log('  Approved by: ' + (a.approved_by || 'unknown'));
  console.log('  Reason:      ' + (a.reason || 'N/A'));
  console.log('  Expires:     ' + a.expires_at);
  console.log('  Session:     ' + (a.session_id || 'unknown'));
"
echo ""

# --- 3. Pre-deploy check ---
echo -e "${YELLOW}Running pre-deploy checks...${NC}"
CHECK_RESULT=$(bash "$SCRIPT_DIR/pre-deploy-check.sh" "$PROJECT" 2>&1) || {
  echo -e "${RED}Pre-deploy check FAILED:${NC}" >&2
  echo "$CHECK_RESULT" >&2
  log_audit "pre_check" "\"result\":\"fail\""
  exit 1
}
echo -e "${GREEN}Pre-deploy check passed.${NC}"
log_audit "pre_check" "\"result\":\"pass\""
echo ""

# --- 4. Dry run or countdown ---
if $DRY_RUN; then
  echo -e "${YELLOW}[DRY RUN] Would execute:${NC}"
  echo "  cd /var/home/luke/dev/$PROJECT_CWD && $PROD_COMMAND"
  log_audit "dry_run" "\"command\":\"$PROD_COMMAND\""
  echo ""
  echo "Dry run complete. No deployment executed."
  exit 0
fi

echo -e "${RED}${BOLD}⚠ PRODUCTION DEPLOY IN 10 SECONDS ⚠${NC}"
echo -e "Press Ctrl+C to cancel"
echo ""
for i in 10 9 8 7 6 5 4 3 2 1; do
  echo -ne "  $i...\r"
  sleep 1
done
echo -ne "           \r"

# --- 5. Execute ---
echo -e "${BOLD}Deploying...${NC}"
cd "/var/home/luke/dev/$PROJECT_CWD"

# Validate config command starts with trusted binary
if ! echo "$PROD_COMMAND" | grep -qE '^(vercel|gcloud)'; then
  echo -e "${RED}ERROR: Untrusted command in config: $PROD_COMMAND${NC}" >&2
  log_audit "blocked" "\"reason\":\"untrusted_command\""
  exit 1
fi

# Use bash -c for multi-word commands from config
EXIT_CODE=0
bash -c "$PROD_COMMAND" || EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  echo -e "${GREEN}✓ Deployment successful${NC}"
  log_audit "executed" "\"command\":\"$PROD_COMMAND\",\"exit_code\":0"
else
  echo -e "${RED}✗ Deployment failed (exit code: $EXIT_CODE)${NC}"
  log_audit "executed" "\"command\":\"$PROD_COMMAND\",\"exit_code\":$EXIT_CODE"
fi

# --- 6. Consume single-use approval (match by approved_at for precision) ---
APPROVED_AT=$(echo "$APPROVAL" | node -e "
  const a = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log(a.approved_at || '');
" 2>/dev/null)

node -e "
  const fs = require('fs');
  const approvals = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  const project = process.argv[2];
  const approvedAt = process.argv[3];
  const before = approvals.approvals.length;
  approvals.approvals = approvals.approvals.filter(app => {
    if (app.project === project && app.approved_at === approvedAt && app.single_use) return false;
    return true;
  });
  if (approvals.approvals.length < before) {
    fs.writeFileSync(process.argv[1], JSON.stringify(approvals, null, 2));
    console.log('Single-use approval consumed.');
  }
" "$APPROVALS" "$PROJECT" "$APPROVED_AT" 2>/dev/null

exit $EXIT_CODE
