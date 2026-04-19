#!/usr/bin/env python3
"""Fetch open issues from all Nextain repos for triage."""
import subprocess, json, sys, urllib.request

# Get GitHub token from credential helper
result = subprocess.run(
    ['git', 'credential', 'fill'],
    input='protocol=https\nhost=github.com\n',
    capture_output=True, text=True, cwd='/var/home/luke/dev'
)
token = None
for line in result.stdout.split('\n'):
    if line.startswith('password='):
        token = line[9:]
        break

if not token:
    print("ERROR: no GitHub token found")
    sys.exit(1)

def fetch_issues(repo):
    url = f"https://api.github.com/repos/{repo}/issues?state=open&per_page=200"
    req = urllib.request.Request(url, headers={
        'Authorization': f'token {token}',
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'naia-triage/1.0'
    })
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read())
    return [
        {
            'number': i['number'],
            'title': i['title'],
            'labels': [l['name'] for l in i['labels']],
            'updatedAt': i['updated_at'],
            'body': (i.get('body') or '')[:500]
        }
        for i in data if 'pull_request' not in i
    ]

def fetch_issue_comments(repo, number):
    url = f"https://api.github.com/repos/{repo}/issues/{number}/comments?per_page=10"
    req = urllib.request.Request(url, headers={
        'Authorization': f'token {token}',
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'naia-triage/1.0'
    })
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read())
    return [c.get('body', '')[:300] for c in data[-3:]]

repos = [
    'nextain/naia-os',
    'nextain/member-luke',
    'nextain/aiedu.nextain.io',
    'nextain/naia.nextain.io',
    'nextain/admin.nextain.io',
    'nextain/any-llm'
]

all_issues = {}
for repo in repos:
    try:
        issues = fetch_issues(repo)
        all_issues[repo] = issues
        print(f"{repo}: {len(issues)} open issues", file=sys.stderr)
    except Exception as e:
        all_issues[repo] = []
        print(f"{repo}: ERROR - {e}", file=sys.stderr)

with open('/tmp/triage_issues.json', 'w') as f:
    json.dump(all_issues, f, indent=2)

print("OK", file=sys.stderr)
