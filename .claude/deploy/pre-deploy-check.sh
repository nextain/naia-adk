#!/usr/bin/env bash
#
# Pre-deploy Environment Check
#
# Checks for common deployment safety issues before prod deploy.
# Inspired by Anthropic sourcemap leak incident.
#
# Usage: ./pre-deploy-check.sh <project-name>
# Returns: 0 = pass, 1 = fail
# Output: JSON result to stdout

set -euo pipefail

PROJECT="${1:?Usage: pre-deploy-check.sh <project-name>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$SCRIPT_DIR/config.json"
PASSED=true
CHECKS="{}"

# Validate project name
if ! echo "$PROJECT" | grep -qE '^[a-zA-Z0-9._-]+$'; then
  echo "{\"result\":\"error\",\"error\":\"invalid project name\"}" >&2
  exit 1
fi

# Helper: set a check result
set_check() {
  local name="$1" value="$2"
  if [ "$CHECKS" = "{}" ]; then
    CHECKS="{\"$name\":$value}"
  else
    CHECKS="${CHECKS%}},\"$name\":$value}"
  fi
}

# Get project config value (safe: uses process.argv instead of shell expansion)
get_config() {
  local key="$1"
  node -e "
    const c = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
    const p = c.projects[process.argv[2]] || {};
    console.log(p[process.argv[3]] || '');
  " "$CONFIG" "$PROJECT" "$key" 2>/dev/null || echo ""
}

PLATFORM=$(get_config "platform")
CWD=$(get_config "cwd")
ROOT="/var/home/luke/dev"
PROJECT_DIR="$ROOT/$CWD"

# Check 1: Sourcemap disabled in production (Vercel/Next.js)
check_sourcemap() {
  if [ "$PLATFORM" != "vercel" ]; then
    set_check "sourcemap_disabled" "true"
    return
  fi

  local config_file=""
  for f in "$PROJECT_DIR"/next.config.*; do
    [ -f "$f" ] && config_file="$f" && break
  done

  if [ -z "$config_file" ]; then
    set_check "sourcemap_disabled" "true"
    return
  fi

  if grep -q "productionBrowserSourceMaps.*:.*true" "$config_file" 2>/dev/null; then
    echo "FAIL: productionBrowserSourceMaps is enabled in $config_file" >&2
    set_check "sourcemap_disabled" "false"
    PASSED=false
  else
    set_check "sourcemap_disabled" "true"
  fi
}

# Check 2: No secrets in NEXT_PUBLIC_ variables
check_public_vars() {
  if [ "$PLATFORM" != "vercel" ]; then
    set_check "no_secrets_in_public" "true"
    return
  fi

  local env_files=("$PROJECT_DIR"/.env.production.local "$PROJECT_DIR"/.env.local)
  local found_secret=false

  for env_file in "${env_files[@]}"; do
    [ -f "$env_file" ] || continue
    if grep -qiE "NEXT_PUBLIC_.*(SECRET|PASSWORD|PRIVATE_KEY|TOKEN)" "$env_file" 2>/dev/null; then
      echo "FAIL: Sensitive value in NEXT_PUBLIC_ variable in $env_file" >&2
      found_secret=true
      PASSED=false
    fi
  done

  if $found_secret; then
    set_check "no_secrets_in_public" "false"
  else
    set_check "no_secrets_in_public" "true"
  fi
}

# Check 3: .gitignore has proper entries
check_gitignore() {
  local gitignore="$PROJECT_DIR/.gitignore"
  [ -f "$gitignore" ] || { set_check "gitignore_ok" "true"; return; }

  local missing=()
  for entry in ".env.local" ".env.production.local"; do
    grep -qF "$entry" "$gitignore" 2>/dev/null || missing+=("$entry")
  done

  if [ ${#missing[@]} -gt 0 ]; then
    echo "WARN: .gitignore missing: ${missing[*]}" >&2
  fi
  set_check "gitignore_ok" "true"
}

# Check 4: No .map files in public/ (sourcemap leak risk)
check_public_sourcemaps() {
  if [ "$PLATFORM" != "vercel" ]; then
    set_check "no_public_sourcemaps" "true"
    return
  fi

  local map_count
  map_count=$(find "$PROJECT_DIR/public" -name "*.map" 2>/dev/null | wc -l || echo 0)

  if [ "$map_count" -gt 0 ]; then
    echo "FAIL: Found $map_count .map files in public/" >&2
    set_check "no_public_sourcemaps" "false"
    PASSED=false
  else
    set_check "no_public_sourcemaps" "true"
  fi
}

# Run all checks
check_sourcemap
check_public_vars
check_gitignore
check_public_sourcemaps

# Output result
if $PASSED; then
  echo "{\"result\":\"pass\",\"project\":\"$PROJECT\",\"checks\":$CHECKS}"
  exit 0
else
  echo "{\"result\":\"fail\",\"project\":\"$PROJECT\",\"checks\":$CHECKS}"
  exit 1
fi
