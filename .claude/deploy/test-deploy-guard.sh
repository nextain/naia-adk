#!/usr/bin/env bash
# Test script for deploy-guard — run separately to avoid hook interference
set -uo pipefail

HOOK="/var/home/luke/dev/.claude/hooks/deploy-guard.js"
PASS=0
FAIL=0

run_test() {
  local desc="$1"
  local input="$2"
  local expect_block="$3"  # "block" or "pass"

  result=$(echo "$input" | node "$HOOK" 2>/dev/null)
  exit_code=$?

  if [ "$expect_block" = "block" ]; then
    if echo "$result" | grep -q '"decision":"block"'; then
      echo "PASS: $desc"
      PASS=$((PASS + 1))
    else
      echo "FAIL: $desc (expected block, got: $result)"
      FAIL=$((FAIL + 1))
    fi
  else
    if [ -z "$result" ] && [ $exit_code -eq 0 ]; then
      echo "PASS: $desc"
      PASS=$((PASS + 1))
    else
      echo "FAIL: $desc (expected pass, got: $result, exit: $exit_code)"
      FAIL=$((FAIL + 1))
    fi
  fi
}

# Test 1: vercel preview should pass
run_test "vercel preview" '{"tool_name":"Bash","tool_input":{"command":"vercel"}}' "pass"

# Test 2: vercel env ls should pass
run_test "vercel env ls" '{"tool_name":"Bash","tool_input":{"command":"vercel env ls"}}' "pass"

# Test 3: gcloud dev service should pass
run_test "gcloud dev service" '{"tool_name":"Bash","tool_input":{"command":"gcloud run deploy naia-gateway-dev --region asia-northeast3"}}' "pass"

# Test 4: non-bash tool should pass
run_test "non-bash tool" '{"tool_name":"Edit","tool_input":{"file_path":"test.js"}}' "pass"

echo ""
echo "Results: $PASS passed, $FAIL failed"
exit $FAIL
