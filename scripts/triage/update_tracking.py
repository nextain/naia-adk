#!/usr/bin/env python3
"""Update last-run.json and knowledge.json after triage."""
import json
from datetime import datetime, timezone

# Load current state
with open('/tmp/triage_issues.json') as f:
    all_issues = json.load(f)

with open('/var/home/luke/dev/scripts/triage/last-run.json') as f:
    last_run = json.load(f)

with open('/var/home/luke/dev/scripts/triage/knowledge.json') as f:
    knowledge = json.load(f)

# Update last-run.json
now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
issues_seen = {}
for repo, issues in all_issues.items():
    issues_seen[repo] = {str(i['number']): i['updatedAt'] for i in issues}

last_run['last_run'] = now
last_run['issues_seen'] = issues_seen

with open('/var/home/luke/dev/scripts/triage/last-run.json', 'w') as f:
    json.dump(last_run, f, indent=2)
print("Updated last-run.json")

# Update knowledge.json
# 1. Remove AAIF source (404 for 4+ runs)
knowledge['standards_monitoring']['sources'] = [
    s for s in knowledge['standards_monitoring']['sources']
    if s['repo'] != 'lfaidata/agentic-ai'
]

# 2. Add new learned pattern for Memory v2 sprint burst
new_patterns = [
    {
        "pattern": "alpha-memory sprint creates burst of dependent issues",
        "detail": "#210-#214 all created 2026-04-04 in chain: export→backup API→backup UI→npm publish→docs. Memory v2 sprint pattern: plan all children at once.",
        "learned": "2026-04-05"
    }
]

existing_pattern_keys = {p['pattern'] for p in knowledge.get('learned_patterns', [])}
for p in new_patterns:
    if p['pattern'] not in existing_pattern_keys:
        knowledge['learned_patterns'].append(p)

# 3. Add triage history entry
total = sum(len(v) for v in all_issues.values())
knowledge['triage_history'].append({
    "date": "2026-04-05",
    "type": "delta",
    "total_issues": total,
    "by_priority": {"P0": 3, "P1": 16, "P2": 57, "P3": 19, "NONE": 17},
    "changes_made": 0,
    "anomalies_flagged": 4,
    "new_issues": 7,
    "updated_issues": 2,
    "report": "scripts/triage/reports/2026-04-05.md"
})

knowledge['last_updated'] = "2026-04-05"

with open('/var/home/luke/dev/scripts/triage/knowledge.json', 'w') as f:
    json.dump(knowledge, f, indent=2)
print("Updated knowledge.json")
print(f"Total issues tracked: {total}")
print(f"Triage history entries: {len(knowledge['triage_history'])}")
