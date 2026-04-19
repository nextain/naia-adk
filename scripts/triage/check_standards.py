#!/usr/bin/env python3
"""Check upstream standards repos for new commits."""
import subprocess, json, sys, urllib.request

# Get token
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

def fetch_commits(repo, n=5):
    url = f"https://api.github.com/repos/{repo}/commits?per_page={n}"
    req = urllib.request.Request(url, headers={
        'Authorization': f'token {token}',
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'naia-triage/1.0'
    })
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
    except Exception as e:
        return {'error': str(e)}

with open('/var/home/luke/dev/scripts/triage/knowledge.json') as f:
    knowledge = json.load(f)

sources = knowledge['standards_monitoring']['sources']
results = {}

for source in sources:
    repo = source['repo']
    last_sha = source.get('last_seen_sha')
    name = source['name']

    if repo == 'lfaidata/agentic-ai':
        results[name] = {
            'status': 'skipped',
            'reason': '404 for 3+ consecutive runs',
            'new_commits': []
        }
        continue

    commits = fetch_commits(repo)
    if isinstance(commits, dict) and 'error' in commits:
        results[name] = {
            'status': 'error',
            'reason': commits['error'],
            'new_commits': []
        }
        continue
    if not commits:
        results[name] = {
            'status': 'no_data',
            'reason': 'empty response',
            'new_commits': []
        }
        continue

    latest_sha = commits[0]['sha'][:7]
    new_commits = []

    if last_sha is None:
        # First run — treat all as new
        new_commits = commits
    else:
        # Find commits since last_seen
        for c in commits:
            if c['sha'][:7] == last_sha or c['sha'].startswith(last_sha):
                break
            new_commits.append(c)

    breaking_keywords = ['breaking', 'spec', 'schema', 'field', 'required', 'deprecated']

    commit_summaries = []
    has_breaking = False
    for c in new_commits:
        msg = c['commit']['message'].split('\n')[0]
        is_breaking = any(kw in msg.lower() for kw in breaking_keywords)
        if is_breaking:
            has_breaking = True
        commit_summaries.append({
            'sha': c['sha'][:7],
            'message': msg,
            'breaking': is_breaking
        })

    # Update knowledge
    source['last_seen_sha'] = latest_sha
    source['last_checked'] = '2026-04-05'

    results[name] = {
        'status': 'changes' if new_commits else 'no_changes',
        'latest_sha': latest_sha,
        'last_sha': last_sha,
        'new_commit_count': len(new_commits),
        'new_commits': commit_summaries,
        'has_breaking': has_breaking
    }

# Save updated knowledge
with open('/var/home/luke/dev/scripts/triage/knowledge.json', 'w') as f:
    json.dump(knowledge, f, indent=2)

print(json.dumps(results, indent=2))
