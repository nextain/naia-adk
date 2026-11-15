#!/bin/sh
# Usage: muse-result.sh LOG RESULT DONE CHILD_EXIT
log=$1 result=$2 done_file=$3 rc=$4
if [ ! -s "$result" ]; then
    awk '/^판정|^# /{f=1} f && !/^muse-ended/ && !/^\{"time":.*"trace":.*"event":/' "$log" > "$result"
    [ ! -s "$result" ] || echo result-from-log >> "$log"
fi
if [ ! -s "$result" ]; then
    echo "no-result rc=$rc" >> "$log"
    [ "$rc" -ne 0 ] || rc=1
else
    touch "$done_file"
fi
exit "$rc"
