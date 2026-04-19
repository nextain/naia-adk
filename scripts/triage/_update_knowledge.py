#!/usr/bin/env python3
"""Update knowledge.json with latest triage results."""
import json

with open('scripts/triage/knowledge.json', 'r') as f:
    data = json.load(f)

# Update last_updated
data['last_updated'] = '2026-04-09'

# Update standards monitoring SHAs
data['standards_monitoring']['sources'][0]['last_seen_sha'] = 'ca1e7dc'
data['standards_monitoring']['sources'][0]['last_checked'] = '2026-04-09'
data['standards_monitoring']['sources'][1]['last_seen_sha'] = '0dd7a90'
data['standards_monitoring']['sources'][1]['last_checked'] = '2026-04-09'

# Add new learned patterns
data['learned_patterns'].append({
    'pattern': 'temporal memory benchmark gap drives new issue creation',
    'detail': 'naia-os 221 created directly from benchmark finding (temporal 0/25 = 0 percent). Benchmark research directly generates actionable issues with quantitative acceptance criteria.',
    'learned': '2026-04-09'
})

data['learned_patterns'].append({
    'pattern': 'harness maturity analysis creates strategic meta-issues',
    'detail': 'member-luke 19/20 are meta-level analysis issues (not feature work). Gap analysis from external training material. Pattern: periodic self-assessment creates meta-issues that spawn child implementation issues.',
    'learned': '2026-04-09'
})

# Add triage history entry
data['triage_history'].append({
    'date': '2026-04-09',
    'type': 'delta',
    'total_issues': 133,
    'by_priority': {
        'P0': 5,
        'P1': 27,
        'P2': 63,
        'P3': 19,
        'NONE': 17
    },
    'changes_made': 3,
    'anomalies_flagged': 2,
    'new_issues': 3,
    'closed_since_last': 0,
    'report': 'scripts/triage/reports/2026-04-09.md'
})

with open('scripts/triage/knowledge.json', 'w') as f:
    json.dump(data, f, indent=2, ensure_ascii=False)

print('knowledge.json updated successfully')
