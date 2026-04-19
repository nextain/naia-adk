#!/usr/bin/env bash
# validate-skill-frontmatter.sh — Agent Skills 표준 + Claude Code 확장 검증
# Usage: bash validate-skill-frontmatter.sh [skills-root-dir]
#
# Agent Skills spec: https://agentskills.io/specification
# Claude Code extensions: argument-hint, disable-model-invocation, user-invocable,
#                          model, context, agent, effort, shell, paths, hooks, allowed-tools

set -euo pipefail

SKILLS_DIR="${1:-.agents/skills}"
USERS_SKILLS_DIR="${SKILLS_DIR/.agents/.users}"

# Guard: if .agents is not in path, mirror check would compare to self
if [ "$USERS_SKILLS_DIR" = "$SKILLS_DIR" ]; then
  echo "WARNING: skills dir '$SKILLS_DIR' does not contain '.agents/' — mirror checks will be skipped"
  SKIP_MIRROR=true
else
  SKIP_MIRROR=false
fi
EXIT_CODE=0
PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

# Agent Skills standard fields
STANDARD_FIELDS="name description license compatibility metadata allowed-tools"

# Claude Code extension fields (non-standard but functional)
CC_EXTENSION_FIELDS="argument-hint disable-model-invocation user-invocable model context agent effort shell paths hooks arguments when_to_use version"

ALL_ALLOWED="$STANDARD_FIELDS $CC_EXTENSION_FIELDS"

fail() { echo -e "  ${RED}FAIL${NC}: $1"; EXIT_CODE=1; FAIL_COUNT=$((FAIL_COUNT + 1)); }
pass() { echo -e "  ${GREEN}PASS${NC}: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
warn() { echo -e "  ${YELLOW}WARN${NC}: $1"; WARN_COUNT=$((WARN_COUNT + 1)); }

for skill_dir in "$SKILLS_DIR"/*/; do
  skill_name=$(basename "$skill_dir")
  skill_file="$skill_dir/SKILL.md"

  # Skip non-skill directories
  [ ! -f "$skill_file" ] && continue

  echo ""
  echo "=== $skill_name ==="

  # Extract frontmatter (first --- block only)
  frontmatter=$(awk '/^---$/{n++; next} n==1{print} n>=2{exit}' "$skill_file")

  if [ -z "$frontmatter" ]; then
    fail "No frontmatter found"
    continue
  fi

  # --- Standard required: name ---
  fm_name=$(echo "$frontmatter" | sed -n 's/^name: *//p' | head -1 | sed 's/[[:space:]]*$//')
  if [ -z "$fm_name" ]; then
    fail "Missing required field: name"
  elif [ "$fm_name" != "$skill_name" ]; then
    fail "name '$fm_name' does not match directory '$skill_name'"
  elif [ ${#fm_name} -gt 64 ]; then
    fail "name exceeds 64 chars (${#fm_name})"
  elif ! echo "$fm_name" | grep -qE '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'; then
    fail "name '$fm_name' has invalid format (must be lowercase+digits+hyphens)"
  elif echo "$fm_name" | grep -qF -- '--'; then
    fail "name '$fm_name' contains consecutive hyphens"
  else
    pass "name: $fm_name"
  fi

  # --- Standard required: description ---
  # Extract full description value (handles YAML multiline continuation)
  fm_desc=$(awk '
    /^---$/ { n++; next }
    n == 1 && /^description:/ {
      sub(/^description: */, "")
      # Handle YAML folded (>) or literal (|) scalars
      if ($0 == ">" || $0 == "|") { desc = ""; capturing = 1; next }
      desc = $0; capturing = 1; next
    }
    n == 1 && capturing && /^[a-z_-]+:/ { capturing = 0 }
    n == 1 && capturing && /^$/ { capturing = 0; next }
    n == 1 && capturing && /^  / { sub(/^  */, " "); desc = desc $0; next }
    n >= 2 { exit }
    END { print desc }
  ' "$skill_file")
  if [ -z "$fm_desc" ]; then
    fail "Missing required field: description"
  elif [ ${#fm_desc} -gt 1024 ]; then
    fail "description exceeds 1024 chars (${#fm_desc})"
  else
    pass "description: ${#fm_desc} chars"
  fi

  # --- Check for unknown fields ---
  field_names=$(echo "$frontmatter" | sed -n 's/^\([a-z0-9_-]*\):.*/\1/p' || true)
  for field in $field_names; do
    is_allowed=false
    for allowed in $ALL_ALLOWED; do
      if [ "$field" = "$allowed" ]; then
        is_allowed=true
        break
      fi
    done
    if ! $is_allowed; then
      fail "Unknown frontmatter field: '$field'"
    fi
  done

  # --- Check Claude Code extension fields usage ---
  for ext_field in $CC_EXTENSION_FIELDS; do
    if echo "$frontmatter" | grep -q "^${ext_field}:"; then
      warn "'$ext_field' is a Claude Code extension (not in Agent Skills standard)"
    fi
  done

  # --- Mirror check ---
  if $SKIP_MIRROR; then
    warn "mirror check skipped (no .agents/ in path)"
    continue
  fi
  users_file="$USERS_SKILLS_DIR/$skill_name/SKILL.md"
  if [ -L "$users_file" ]; then
    # Symlink — check target exists and points to correct .agents/ skill
    if [ ! -e "$users_file" ]; then
      fail "mirror: broken symlink at $users_file"
    else
      link_target=$(readlink -f "$users_file")
      expected_target=$(readlink -f "$skill_file")
      if [ "$link_target" = "$expected_target" ]; then
        pass "mirror: symlink OK → $skill_file"
      else
        fail "mirror: symlink points to '$link_target', expected '$expected_target'"
      fi
    fi
  elif [ -f "$users_file" ]; then
    # Regular file — check frontmatter name matches
    users_name=$(awk '/^---$/{n++; next} n==1{print} n>=2{exit}' "$users_file" | sed -n 's/^name: *//p' | head -1 | sed 's/[[:space:]]*$//')
    if [ "$users_name" = "$fm_name" ]; then
      pass "mirror: .users/ name matches"
    else
      fail "mirror: .users/ name '$users_name' != .agents/ name '$fm_name'"
    fi
  else
    warn "No .users/ mirror found at $users_file"
  fi
done

echo ""
echo "=============================="
echo -e "Results: ${GREEN}$PASS_COUNT passed${NC}, ${RED}$FAIL_COUNT failed${NC}, ${YELLOW}$WARN_COUNT warnings${NC}"
echo "=============================="

exit $EXIT_CODE
