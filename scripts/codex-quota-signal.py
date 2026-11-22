#!/usr/bin/env python3
"""Report the weekly Codex allowance and confirmed turn rejection for one local account."""
import argparse
import datetime as dt
import json
import re
import sqlite3
import time
from pathlib import Path

WEEK_SECONDS = 7 * 24 * 60 * 60
DENIAL = re.compile(r"\}: Turn error: You['’]ve hit your usage limit\b[^\n]*$", re.I)


def reverse_lines(path):
    with path.open("rb") as stream:
        end = stream.seek(0, 2)
        rest = b""
        while end:
            size = min(end, 65536)
            end -= size
            stream.seek(end)
            parts = (stream.read(size) + rest).split(b"\n")
            rest = parts[0]
            yield from reversed(parts[1:])
        if rest:
            yield rest


def weekly_sample(path, now):
    for line in reverse_lines(path):
        if b'"token_count"' not in line or b'"rate_limits"' not in line:
            continue
        try:
            row = json.loads(line)
            info = row["payload"]
            if row["type"] != "event_msg" or info.get("type") != "token_count":
                continue
            stamp = dt.datetime.fromisoformat(row["timestamp"].replace("Z", "+00:00")).timestamp()
            if stamp > now:
                continue
            if stamp < now - WEEK_SECONDS:
                break
            rates = info.get("rate_limits") or {}
            if rates.get("limit_id") not in (None, "codex"):
                continue
            for window in (rates.get("primary"), rates.get("secondary")):
                if not window or window.get("window_minutes") != 10080:
                    continue
                used, resets = window.get("used_percent"), window.get("resets_at")
                if isinstance(used, (float, int)) and 0 <= used <= 100 and isinstance(resets, int):
                    return (stamp, used, resets)
        except (ValueError, TypeError, AttributeError, KeyError, UnicodeError):
            continue
    return None


def latest_week(home, now):
    recent = []
    for path in (home / "sessions").glob("*/*/*/rollout-*.jsonl"):
        try:
            modified = path.stat().st_mtime
        except FileNotFoundError:
            continue
        if modified >= now - WEEK_SECONDS:
            recent.append((modified, path))
    latest = None
    for modified, path in sorted(recent, reverse=True):
        if latest and modified + 1 < latest[0]:
            break
        try:
            sample = weekly_sample(path, now)
        except FileNotFoundError:
            continue
        if sample and (latest is None or sample[0] > latest[0]):
            latest = sample
    return latest


def latest_denial(home, now):
    uri = (home / "logs_2.sqlite").resolve().as_uri() + "?mode=ro"
    with sqlite3.connect(uri, uri=True, timeout=3) as db:
        rows = db.execute(
            """SELECT ts, ts_nanos, feedback_log_body FROM logs
               WHERE ts BETWEEN ? AND ? AND target = 'codex_core::session::turn'
                 AND feedback_log_body LIKE '%: Turn error: %hit your usage limit%'
               ORDER BY ts DESC, ts_nanos DESC""",
            (int(now) - WEEK_SECONDS, int(now)),
        )
        for seconds, nanos, body in rows:
            stamp = seconds + nanos / 1_000_000_000
            if stamp <= now and DENIAL.search(body):
                return stamp
    return None


def signal(home, now, warning_percent):
    weekly = latest_week(home, now)
    try:
        denied = latest_denial(home, now)
        log_available = True
    except sqlite3.Error:
        denied = None
        log_available = False
    sample_at, used, resets_at = weekly or (None, None, None)
    valid = resets_at is not None and now < resets_at
    rejection_is_current = denied is not None and (sample_at is None or denied >= sample_at)
    if not valid and resets_at is not None and denied is not None and denied <= resets_at:
        rejection_is_current = False
    if rejection_is_current:
        state = "denied"
    elif not valid:
        state = "unknown"
    elif used >= warning_percent:
        state = "near"
    else:
        state = "ok" if log_available else "unknown"
    return {"state": state, "rejection_log_available": log_available, "weekly_used_percent": used if valid else None,
            "sample_at": sample_at, "window_ends_at": resets_at, "last_denial_at": denied}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex-home", type=Path, default=Path.home() / ".codex")
    parser.add_argument("--at", type=float, help="UTC Unix time for incident replay")
    parser.add_argument("--warning-percent", type=float, default=95)
    args = parser.parse_args()
    if not 0 < args.warning_percent <= 100:
        parser.error("warning percent must be greater than zero and at most 100")
    print(json.dumps(signal(args.codex_home, time.time() if args.at is None else args.at, args.warning_percent)))
