import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone

SPEC = importlib.util.spec_from_file_location("quota", Path(__file__).with_name("codex-quota-signal.py"))
quota = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(quota)


class SignalTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name)
        self.rollout = self.home / "sessions/2026/01/02/rollout-test.jsonl"
        self.rollout.parent.mkdir(parents=True)
        self.logs = sqlite3.connect(self.home / "logs_2.sqlite")
        self.logs.execute("CREATE TABLE logs(ts, ts_nanos, target, feedback_log_body)")
        self.addCleanup(self.logs.close)
        self.at = 1800000000

    def sample(self, at, used, slot="primary", minutes=10080, bucket="codex"):
        entry = {"timestamp": datetime.fromtimestamp(at, timezone.utc).isoformat(),
                 "type": "event_msg", "payload": {"type": "token_count",
                 "rate_limits": {"limit_id": bucket, slot: {"window_minutes": minutes,
                 "used_percent": used, "resets_at": self.at + 3600}}}}
        with self.rollout.open("a") as f:
            f.write(json.dumps(entry) + "\n")
        os.utime(self.rollout, (at, at))

    def denial(self, at, target="codex_core::session::turn", text="trace}: Turn error: You’ve hit your usage limit."):
        self.logs.execute("INSERT INTO logs VALUES (?,?,?,?)", (at, 0, target, text))
        self.logs.commit()

    def state(self, now):
        return quota.signal(self.home, now, 95)["state"]

    def test_threshold_rejection_and_manual_reset_in_order(self):
        self.sample(self.at, 96, slot="secondary")
        self.sample(self.at + 1, 100)
        self.denial(self.at + 2)
        self.denial(self.at + 3)
        self.sample(self.at + 4, 0)
        self.assertEqual([self.state(self.at + n) for n in range(5)],
                         ["near", "near", "denied", "denied", "ok"])

    def test_repeated_full_sample_preserves_denial_until_recovery(self):
        self.sample(self.at, 100)
        self.denial(self.at + 1)
        self.sample(self.at + 2, 100)
        self.assertEqual(self.state(self.at + 2), "denied")
        self.sample(self.at + 3, 0)
        self.sample(self.at + 4, 100)
        self.assertEqual(self.state(self.at + 4), "near")

    def test_quoted_chat_and_nonweekly_buckets_do_not_alert(self):
        self.sample(self.at, 10)
        self.sample(self.at + 1, 100, minutes=300)
        self.sample(self.at + 2, 100, bucket="another-model")
        self.denial(self.at, target="tool.result")
        self.denial(self.at + 1, text="prompt: You’ve hit your usage limit.")
        self.assertEqual(self.state(self.at + 3), "ok")

    def test_missing_rejection_log_keeps_a_weekly_warning_and_marks_a_blind_check(self):
        self.logs.close()
        (self.home / "logs_2.sqlite").unlink()
        self.sample(self.at, 92)
        self.assertEqual(self.state(self.at), "unknown")
        self.sample(self.at + 1, 99)
        info = quota.signal(self.home, self.at + 2, 95)
        self.assertEqual(info["state"], "near")
        self.assertFalse(info["rejection_log_available"])

    def test_unknown_without_measurement_and_old_windows(self):
        self.assertEqual(self.state(self.at), "unknown")
        self.denial(self.at)
        self.assertEqual(self.state(self.at + 2), "denied")
        self.sample(self.at + 3, 99)
        self.assertEqual(self.state(self.at + 3601), "unknown")


if __name__ == "__main__":
    unittest.main()
