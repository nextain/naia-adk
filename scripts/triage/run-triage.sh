#!/bin/bash
# Daily Issue Triage — runs via cron, invokes claude -p headless
# Usage: ./run-triage.sh [--dry-run]
# Dependencies: claude CLI, python3, gh CLI, smtp.env

set -uo pipefail

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="/var/home/luke/dev"
REPORT_DIR="${SCRIPT_DIR}/reports"
TODAY=$(date +%Y-%m-%d)
LOG_FILE="${SCRIPT_DIR}/triage.log"

mkdir -p "$REPORT_DIR"

echo "[$(date -Iseconds)] Triage started" >> "$LOG_FILE"

# Build the full prompt
PROMPT="$(cat "${SCRIPT_DIR}/triage-prompt.md")

Today is ${TODAY}.
Working directory: ${WORKSPACE}
Knowledge file: scripts/triage/knowledge.json
Last run file: scripts/triage/last-run.json
Report output: scripts/triage/reports/${TODAY}.md

Execute the triage process now. Read knowledge and last-run files, scan all repos, evaluate issues, write the report, and update last-run.json and knowledge.json."

# Run claude headless with triage prompt
cd "$WORKSPACE" || { echo "[$(date -Iseconds)] ERROR: cannot cd to $WORKSPACE" >> "$LOG_FILE"; exit 1; }
if claude -p "$PROMPT" \
  --allowedTools "Read,Write,Bash(gh:*),Bash(date:*),Bash(python3 scripts/triage/scorecard.py),Glob,Grep" \
  --output-format text \
  2>> "$LOG_FILE" | tee "${REPORT_DIR}/${TODAY}-raw.txt"; then
  echo "[$(date -Iseconds)] Triage completed" >> "$LOG_FILE"
else
  echo "[$(date -Iseconds)] ERROR: claude exited with non-zero status" >> "$LOG_FILE"
fi

# Send email report if report file was generated
REPORT_FILE="${REPORT_DIR}/${TODAY}.md"
if [ -f "$REPORT_FILE" ]; then
  if [ "$DRY_RUN" = true ]; then
    echo "[$(date -Iseconds)] DRY RUN: skipping email, report at $REPORT_FILE" >> "$LOG_FILE"
  elif python3 "${SCRIPT_DIR}/send-report.py" "$REPORT_FILE" 2>> "$LOG_FILE"; then
    echo "[$(date -Iseconds)] Report emailed" >> "$LOG_FILE"
  else
    echo "[$(date -Iseconds)] ERROR: email sending failed" >> "$LOG_FILE"
  fi
else
  echo "[$(date -Iseconds)] WARNING: No report generated" >> "$LOG_FILE"
fi
