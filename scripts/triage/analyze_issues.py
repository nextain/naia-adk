#!/usr/bin/env python3
"""Analyze fetched issues for delta, triage, and reporting."""
import json, sys
from datetime import datetime, timezone

with open('/tmp/triage_issues.json') as f:
    all_issues = json.load(f)

with open('/var/home/luke/dev/scripts/triage/last-run.json') as f:
    last_run = json.load(f)

last_run_time = datetime.fromisoformat(last_run['last_run'].replace('Z', '+00:00'))
issues_seen = last_run.get('issues_seen', {})

# Find delta (new or updated since last run)
delta = {}
total = 0
new_issues = []
updated_issues = []

for repo, issues in all_issues.items():
    total += len(issues)
    seen = issues_seen.get(repo, {})
    for issue in issues:
        num = str(issue['number'])
        updated = issue['updatedAt']
        updated_dt = datetime.fromisoformat(updated.replace('Z', '+00:00'))

        if num not in seen:
            issue['_status'] = 'new'
            new_issues.append((repo, issue))
        elif updated_dt > last_run_time:
            issue['_status'] = 'updated'
            updated_issues.append((repo, issue))

print(f"Total open issues: {total}")
print(f"New since last run: {len(new_issues)}")
print(f"Updated since last run: {len(updated_issues)}")
print()

print("=== NEW ISSUES ===")
for repo, issue in new_issues:
    labels = ', '.join(issue['labels']) if issue['labels'] else 'NO LABELS'
    print(f"  [{repo}] #{issue['number']}: {issue['title']}")
    print(f"    Labels: {labels}")
    print(f"    Updated: {issue['updatedAt']}")
    print()

print("=== UPDATED ISSUES ===")
for repo, issue in updated_issues:
    labels = ', '.join(issue['labels']) if issue['labels'] else 'NO LABELS'
    print(f"  [{repo}] #{issue['number']}: {issue['title']}")
    print(f"    Labels: {labels}")
    print(f"    Updated: {issue['updatedAt']}")
    print()

# Priority summary
print("=== PRIORITY BREAKDOWN ===")
priority_counts = {'P0': [], 'P1': [], 'P2': [], 'P3': [], 'NONE': []}
for repo, issues in all_issues.items():
    for issue in issues:
        labels = issue['labels']
        p = None
        for label in labels:
            if label.startswith('P0'):
                p = 'P0'
                break
            elif label.startswith('P1'):
                p = 'P1'
                break
            elif label.startswith('P2'):
                p = 'P2'
                break
            elif label.startswith('P3'):
                p = 'P3'
                break
        if p is None:
            p = 'NONE'
        priority_counts[p].append((repo, issue['number'], issue['title']))

for p, issues in priority_counts.items():
    print(f"  {p}: {len(issues)}")
    for repo, num, title in issues[:5]:
        repo_short = repo.split('/')[-1]
        print(f"    [{repo_short}] #{num}: {title[:60]}")
    if len(issues) > 5:
        print(f"    ... and {len(issues) - 5} more")

print()
print("=== ISSUES WITHOUT PRIORITY LABELS ===")
for repo, num, title in priority_counts['NONE']:
    print(f"  [{repo}] #{num}: {title}")

# Save for report generation
result = {
    'total': total,
    'new_count': len(new_issues),
    'updated_count': len(updated_issues),
    'new_issues': [(r, i) for r, i in new_issues],
    'updated_issues': [(r, i) for r, i in updated_issues],
    'priority_counts': {k: len(v) for k, v in priority_counts.items()},
    'priority_details': {k: v for k, v in priority_counts.items()},
    'by_repo': {repo: len(issues) for repo, issues in all_issues.items()}
}
with open('/tmp/triage_analysis.json', 'w') as f:
    json.dump(result, f, indent=2, default=str)
