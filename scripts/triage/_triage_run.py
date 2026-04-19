#!/usr/bin/env python3
"""One-shot triage helper: label delta issues + standards monitoring."""
import json, urllib.request, subprocess, sys

result = subprocess.run(
    ['git', 'credential', 'fill'],
    input='protocol=https\nhost=github.com\n',
    capture_output=True, text=True, cwd='/var/home/luke/dev'
)
token = None
for line in result.stdout.split('\n'):
    if line.startswith('password='):
        token = line[9:]

if not token:
    print("ERROR: no GitHub token found")
    sys.exit(1)

def api_call(url, method='GET', data=None):
    headers = {
        'Authorization': f'token {token}',
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'naia-triage/1.0',
    }
    if data:
        headers['Content-Type'] = 'application/json'
        data = json.dumps(data).encode()
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req) as resp:
        return resp.status, json.loads(resp.read())

def add_labels(repo, number, labels):
    url = f'https://api.github.com/repos/{repo}/issues/{number}/labels'
    status, _ = api_call(url, 'POST', {'labels': labels})
    return status

def get_commits(repo, per_page=5):
    url = f'https://api.github.com/repos/{repo}/commits?per_page={per_page}'
    _, data = api_call(url)
    return data

action = sys.argv[1] if len(sys.argv) > 1 else 'label'

if action == 'label':
    # Label delta issues
    label_tasks = [
        ('nextain/naia-os', 221, ['P2-medium', 'triaged-by: agent']),
        ('nextain/member-luke', 20, ['P1-high', 'triaged-by: agent']),
        ('nextain/member-luke', 19, ['P1-high', 'triaged-by: agent']),
    ]
    for repo, num, labels in label_tasks:
        try:
            status = add_labels(repo, num, labels)
            print(f'{repo} {num}: labeled {labels} (status {status})')
        except Exception as e:
            print(f'{repo} {num}: ERROR - {e}')
    print('Labeling done.')

elif action == 'standards':
    # Standards monitoring
    checks = [
        ('anthropics/skills', '98669c1', 'Agent Skills spec'),
        ('modelcontextprotocol/specification', '4e2552b', 'MCP spec'),
    ]
    results = {}
    for repo, last_sha, name in checks:
        try:
            commits = get_commits(repo)
            new = []
            for c in commits:
                if c['sha'][:7] == last_sha:
                    break
                new.append({
                    'sha': c['sha'][:7],
                    'msg': c['commit']['message'].split('\n')[0][:120],
                })
            latest = commits[0]['sha'][:7] if commits else last_sha
            results[name] = {
                'new_count': len(new),
                'latest_sha': latest,
                'new_commits': new,
            }
            print(f'\n=== {name} ({repo}) ===')
            if new:
                print(f'  {len(new)} new commits since {last_sha}:')
                for c in new:
                    print(f'  - {c["sha"]} {c["msg"]}')
            else:
                print(f'  No new commits since {last_sha}')
            print(f'  Latest SHA: {latest}')
        except Exception as e:
            results[name] = {'error': str(e)}
            print(f'\n=== {name} ({repo}) === ERROR: {e}')

    # AAIF (may 404)
    try:
        commits = get_commits('lfaidata/agentic-ai')
        latest = commits[0]['sha'][:7] if commits else 'N/A'
        new_commits = []
        for c in commits[:5]:
            new_commits.append({
                'sha': c['sha'][:7],
                'msg': c['commit']['message'].split('\n')[0][:120],
            })
        results['AAIF'] = {
            'new_count': len(commits),
            'latest_sha': latest,
            'new_commits': new_commits,
        }
        print(f'\n=== AAIF (lfaidata/agentic-ai) ===')
        print(f'  Latest SHA: {latest}')
        for c in new_commits:
            print(f'  - {c["sha"]} {c["msg"]}')
    except urllib.error.HTTPError as e:
        results['AAIF'] = {'error': f'HTTP {e.code}'}
        print(f'\n=== AAIF === Skipped (HTTP {e.code})')

    # Save results for report
    with open('/tmp/standards_results.json', 'w') as f:
        json.dump(results, f, indent=2)
    print('\nStandards monitoring done.')

elif action == 'scorecard':
    # Check recently closed issues (last 7 days)
    since = '2026-04-02T00:00:00Z'
    repos = [
        'nextain/naia-os',
        'nextain/member-luke',
        'nextain/aiedu.nextain.io',
        'nextain/naia.nextain.io',
        'nextain/admin.nextain.io',
        'nextain/any-llm',
    ]
    closed = {}
    for repo in repos:
        url = f'https://api.github.com/repos/{repo}/issues?state=closed&since={since}&per_page=100&sort=updated&direction=desc'
        try:
            _, data = api_call(url)
            repo_closed = []
            for i in data:
                if 'pull_request' not in i and i.get('closed_at', '') > since:
                    repo_closed.append({
                        'number': i['number'],
                        'title': i['title'][:80],
                        'closed_at': i['closed_at'][:10],
                        'labels': [l['name'] for l in i['labels']],
                    })
            if repo_closed:
                closed[repo] = repo_closed
        except Exception as e:
            print(f'{repo}: ERROR - {e}', file=sys.stderr)

    print('=== 7-Day Close Velocity ===')
    total = 0
    for repo, issues in closed.items():
        print(f'\n{repo} ({len(issues)} closed):')
        for i in issues:
            print(f'  {i["closed_at"]} {i["number"]} {i["title"]}')
        total += len(issues)
    print(f'\nTotal closed in 7 days: {total}')

    # Check hotfix suspects (3+ file edits in 24h)
    print('\n=== Recent Commits (24h) ===')
    for repo in repos:
        url = f'https://api.github.com/repos/{repo}/commits?since=2026-04-08T00:00:00Z&per_page=20'
        try:
            _, data = api_call(url)
            if data:
                print(f'{repo}: {len(data)} commits')
                for c in data[:5]:
                    msg = c['commit']['message'].split('\n')[0][:80]
                    print(f'  {c["sha"][:7]} {c["commit"]["author"]["date"][:10]} {msg}')
        except Exception:
            pass
