#!/usr/bin/bash
set -eu

secret_absent=true
test -z "${LEAK_SECRET:-}" || secret_absent=false
home_blind=true
for home_entry in /home/*; do
  test "$home_entry" = /home/reviewer || home_blind=false
done
repository_blind=true
if test -r "${REQUEST_CONTRACT_REPOSITORY_PROBE}"; then repository_blind=false; fi
home_read_only=true
if printf x > /home/reviewer/probe 2>/dev/null; then home_read_only=false; fi
review_read_only=true
if printf x > /review/probe 2>/dev/null; then review_read_only=false; fi
network_blocked=true
if timeout 1 bash -c 'printf x >/dev/tcp/127.0.0.1/9' 2>/dev/null; then network_blocked=false; fi
scratch_writable=true
printf scratch > /scratch/probe || scratch_writable=false
bundle_readable=true
test -r "${REQUEST_CONTRACT_BUNDLE}" || bundle_readable=false
printf '{"secret_absent":%s,"home_blind":%s,"repository_blind":%s,"home_read_only":%s,"review_read_only":%s,"network_blocked":%s,"scratch_writable":%s,"bundle_readable":%s,"cwd":"%s"}' \
  "$secret_absent" "$home_blind" "$repository_blind" "$home_read_only" "$review_read_only" "$network_blocked" "$scratch_writable" "$bundle_readable" "$PWD"
