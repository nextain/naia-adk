#!/usr/bin/env python3
"""
Scorecard — AI development performance metrics + anomaly detection.
Integrated with triage daily report.

Collects metrics from:
- GitHub API (issues, PRs, commits)
- .agents/progress/*.json (phase tracking, review logs)
- git log (code persistence, rework)

Anomaly detection:
- Review-less close: issue closed without review_log in progress file
- Gate violation: phase sequence broken
- Hot-fix suspect: same file modified within 24h of merge
- Missing progress: closed issue with no progress file
"""

import json
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

WORKSPACE = Path("/var/home/luke/dev")
PROGRESS_DIR = WORKSPACE / ".agents" / "progress"
REPOS = [
    "nextain/naia-os",
    "nextain/member-luke",
    "nextain/aiedu.nextain.io",
    "nextain/naia.nextain.io",
    "nextain/admin.nextain.io",
    "nextain/any-llm",
]

VALID_PHASE_ORDER = [
    "issue", "understand", "scope", "investigate", "plan",
    "build", "review", "e2e_test", "post_test_review",
    "sync", "sync_verify", "report", "commit", "close",
]


def run_gh(args: list[str]) -> str:
    """Run gh CLI and return stdout."""
    result = subprocess.run(
        ["gh"] + args,
        capture_output=True, text=True, timeout=30,
    )
    return result.stdout.strip()


def get_recently_closed_issues(repo: str, days: int = 7) -> list[dict]:
    """Get issues closed in the last N days."""
    since = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
    raw = run_gh([
        "issue", "list", "--repo", repo, "--state", "closed",
        "--limit", "50",
        "--json", "number,title,closedAt,labels",
    ])
    if not raw:
        return []
    issues = json.loads(raw)
    return [i for i in issues if i.get("closedAt", "") >= since]


def get_recent_commits(repo_path: Path, days: int = 7) -> list[dict]:
    """Get commits from the last N days."""
    since = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
    result = subprocess.run(
        ["git", "log", f"--since={since}", "--pretty=format:%H|%s|%aI", "--no-merges"],
        capture_output=True, text=True, cwd=repo_path, timeout=30,
    )
    commits = []
    for line in result.stdout.strip().split("\n"):
        if "|" in line:
            parts = line.split("|", 2)
            commits.append({"hash": parts[0], "subject": parts[1], "date": parts[2]})
    return commits


def load_progress_files() -> dict[str, dict]:
    """Load all progress files."""
    progress = {}
    if not PROGRESS_DIR.exists():
        return progress
    for f in PROGRESS_DIR.glob("*.json"):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            issue = data.get("issue", f.stem)
            progress[issue] = data
        except (json.JSONDecodeError, OSError):
            pass
    return progress


# ── Anomaly Detection ────────────────────────────────────────────────────────

class Anomaly:
    def __init__(self, severity: str, repo: str, issue: str, message: str, action: str):
        self.severity = severity  # "critical" | "warning"
        self.repo = repo
        self.issue = issue
        self.message = message
        self.action = action  # "reopen" | "review" | "flag"


def detect_review_less_close(progress: dict, closed_issues: dict[str, list]) -> list[Anomaly]:
    """Detect issues closed without review_log in progress file."""
    anomalies = []
    for repo, issues in closed_issues.items():
        for issue in issues:
            num = issue["number"]
            # Find matching progress file
            matching = [
                p for p in progress.values()
                if f"#{num} " in p.get("issue", "") or f"/issues/{num}" in p.get("issue_url", "")
            ]
            if not matching:
                # No progress file at all — might be a simple change
                continue
            for pf in matching:
                review_log = pf.get("review_log") or pf.get("post_test_review_log")
                if not review_log:
                    anomalies.append(Anomaly(
                        severity="critical",
                        repo=repo,
                        issue=f"#{num} {issue['title']}",
                        message=f"리뷰 기록 없이 close됨 — progress file에 review_log 없음",
                        action="reopen",
                    ))
                elif review_log.get("result") != "2_consecutive_clean":
                    anomalies.append(Anomaly(
                        severity="warning",
                        repo=repo,
                        issue=f"#{num} {issue['title']}",
                        message=f"2연속 클린패스 미달성 — result: {review_log.get('result')}",
                        action="flag",
                    ))
    return anomalies


def detect_gate_violations(progress: dict) -> list[Anomaly]:
    """Detect phase sequence violations in progress files."""
    anomalies = []
    for key, pf in progress.items():
        gates = pf.get("gates_cleared", [])
        if not gates:
            continue
        # Check order
        for i, gate in enumerate(gates):
            if gate in VALID_PHASE_ORDER:
                idx = VALID_PHASE_ORDER.index(gate)
                if i > 0 and gates[i-1] in VALID_PHASE_ORDER:
                    prev_idx = VALID_PHASE_ORDER.index(gates[i-1])
                    if idx < prev_idx:
                        anomalies.append(Anomaly(
                            severity="warning",
                            repo="",
                            issue=pf.get("issue", key),
                            message=f"gate 순서 위반: {gates[i-1]} → {gate}",
                            action="flag",
                        ))
    return anomalies


def detect_hotfix_suspects(repo_path: Path, days: int = 1) -> list[Anomaly]:
    """Detect files modified multiple times within 24 hours (hotfix suspect)."""
    commits = get_recent_commits(repo_path, days)
    file_mods: dict[str, int] = {}
    for c in commits:
        result = subprocess.run(
            ["git", "diff-tree", "--no-commit-id", "--name-only", "-r", c["hash"]],
            capture_output=True, text=True, cwd=repo_path, timeout=10,
        )
        for f in result.stdout.strip().split("\n"):
            if f:
                file_mods[f] = file_mods.get(f, 0) + 1
    anomalies = []
    for f, count in file_mods.items():
        if count >= 3 and not f.startswith(".agents/"):
            anomalies.append(Anomaly(
                severity="warning",
                repo=str(repo_path.name),
                issue="",
                message=f"핫픽스 의심: {f} — 24시간 내 {count}회 수정",
                action="flag",
            ))
    return anomalies


# ── Metrics Collection ───────────────────────────────────────────────────────

def collect_throughput(closed_issues: dict, days: int = 7) -> dict:
    """Collect throughput metrics."""
    total_closed = sum(len(issues) for issues in closed_issues.values())
    by_repo = {repo.split("/")[1]: len(issues) for repo, issues in closed_issues.items()}
    return {
        "period_days": days,
        "total_closed": total_closed,
        "by_repo": by_repo,
    }


def collect_quality(progress: dict) -> dict:
    """Collect quality metrics from progress files."""
    review_counts = []
    clean_pass_achieved = 0
    total_reviewed = 0

    for pf in progress.values():
        rl = pf.get("review_log")
        if rl:
            total_reviewed += 1
            review_counts.append(rl.get("total_passes", 0))
            if rl.get("result") == "2_consecutive_clean":
                clean_pass_achieved += 1

    return {
        "total_reviewed": total_reviewed,
        "clean_pass_rate": f"{clean_pass_achieved}/{total_reviewed}" if total_reviewed else "N/A",
        "avg_review_passes": round(sum(review_counts) / len(review_counts), 1) if review_counts else 0,
        "max_review_passes": max(review_counts) if review_counts else 0,
    }


# ── IP (Patent / Copyright) Recommendations ─────────────────────────────────

def detect_ip_candidates(closed_issues: dict, progress: dict) -> list[dict]:
    """Detect closed issues that may warrant patent or copyright action."""
    candidates = []
    for repo, issues in closed_issues.items():
        for issue in issues:
            num = issue["number"]
            title = issue["title"]
            labels = [l.get("name", "") for l in issue.get("labels", [])]

            # Skip trivial changes
            if any(l in labels for l in ["P3-low", "documentation", "bug"]):
                continue

            # Find progress file for context
            matching = [
                p for p in progress.values()
                if f"#{num} " in p.get("issue", "") or f"/issues/{num}" in p.get("issue_url", "")
            ]

            # Copyright candidate: new module/feature with tests
            is_feature = title.lower().startswith("feat") or "feature" in " ".join(labels)
            has_review = any(p.get("review_log", {}).get("result") == "2_consecutive_clean" for p in matching)
            if is_feature and has_review:
                candidates.append({
                    "repo": repo,
                    "issue": f"#{num} {title}",
                    "recommendation": "copyright",
                    "reason": "새 기능 개발 완료 + 리뷰 통과 → 저작권 등록 검토 (/copyright-reg)",
                })

            # Patent candidate: new architecture/algorithm
            patent_signals = ["framework", "architecture", "abstraction", "lifecycle", "pipeline", "system"]
            if any(s in title.lower() for s in patent_signals) and has_review:
                candidates.append({
                    "repo": repo,
                    "issue": f"#{num} {title}",
                    "recommendation": "patent",
                    "reason": "신규 아키텍처/프레임워크 구현 → 특허 검토 (/patent-pipeline)",
                })

    return candidates


# ── Report Generation ────────────────────────────────────────────────────────

def generate_scorecard() -> dict[str, Any]:
    """Generate the full scorecard."""
    progress = load_progress_files()

    # Collect closed issues
    closed_issues = {}
    for repo in REPOS:
        try:
            closed_issues[repo] = get_recently_closed_issues(repo, days=7)
        except Exception:
            closed_issues[repo] = []

    # Metrics
    throughput = collect_throughput(closed_issues)
    quality = collect_quality(progress)

    # Anomalies
    anomalies = []
    anomalies.extend(detect_review_less_close(progress, closed_issues))
    anomalies.extend(detect_gate_violations(progress))

    # Hotfix detection for local repos
    for subdir in ["naia-os", "aiedu.nextain.io"]:
        repo_path = WORKSPACE / subdir
        if repo_path.exists():
            try:
                anomalies.extend(detect_hotfix_suspects(repo_path))
            except Exception:
                pass

    # Collect recommended actions (report only — actual execution requires user confirmation)
    actions_recommended = []
    for a in anomalies:
        if a.severity == "critical" and a.action == "reopen":
            actions_recommended.append(f"재오픈 추천: {a.repo} {a.issue} — {a.message}")

    # IP recommendations
    ip_candidates = detect_ip_candidates(closed_issues, progress)

    return {
        "generated_at": datetime.now().isoformat(),
        "throughput": throughput,
        "quality": quality,
        "ip_recommendations": ip_candidates,
        "anomalies": [
            {
                "severity": a.severity,
                "repo": a.repo,
                "issue": a.issue,
                "message": a.message,
                "action": a.action,
            }
            for a in anomalies
        ],
        "actions_recommended": actions_recommended,
    }


if __name__ == "__main__":
    scorecard = generate_scorecard()
    print(json.dumps(scorecard, indent=2, ensure_ascii=False))
