#!/usr/bin/env bash
# Test blocking cases — uses node directly to avoid the hook
set -uo pipefail

HOOK="/var/home/luke/dev/.claude/hooks/deploy-guard.js"
PASS=0
FAIL=0

run_block_test() {
  local desc="$1"
  local input="$2"
  local expect_project="$3"

  result=$(echo "$input" | node "$HOOK" 2>/dev/null)

  if echo "$result" | grep -q '"decision":"block"'; then
    if echo "$result" | grep -q "$expect_project"; then
      echo "PASS: $desc → blocked (project: $expect_project)"
      PASS=$((PASS + 1))
    else
      echo "FAIL: $desc → blocked but wrong project (expected: $expect_project)"
      echo "  Got: $result"
      FAIL=$((FAIL + 1))
    fi
  else
    echo "FAIL: $desc → not blocked!"
    FAIL=$((FAIL + 1))
  fi
}

# Vercel prod with cwd
run_block_test "vercel prod (naia)" \
  '{"tool_name":"Bash","cwd":"/var/home/luke/dev/naia.nextain.io","tool_input":{"command":"vercel --prod"}}' \
  "naia.nextain.io"

run_block_test "vercel prod (aiedu)" \
  '{"tool_name":"Bash","cwd":"/var/home/luke/dev/aiedu.nextain.io","tool_input":{"command":"vercel --prod"}}' \
  "aiedu.nextain.io"

run_block_test "vercel production flag" \
  '{"tool_name":"Bash","cwd":"/var/home/luke/dev/about.nextain.io","tool_input":{"command":"vercel --production"}}' \
  "about.nextain.io"

# gcloud prod
run_block_test "gcloud prod gateway" \
  '{"tool_name":"Bash","tool_input":{"command":"gcloud run deploy naia-gateway --region asia-northeast3 --source ."}}' \
  "naia-gateway"

# gcloud app deploy
run_block_test "gcloud app deploy" \
  '{"tool_name":"Bash","tool_input":{"command":"gcloud app deploy"}}' \
  "gcloud"

# Quote evasion test — vercel '--p'r'o'd should still be detected after stripQuotes
run_block_test "quote evasion attempt" \
  "{\"tool_name\":\"Bash\",\"cwd\":\"/var/home/luke/dev/naia.nextain.io\",\"tool_input\":{\"command\":\"vercel '--p'r'o'd\"}}" \
  "naia.nextain.io"

echo ""
echo "Block results: $PASS passed, $FAIL failed"
exit $FAIL
