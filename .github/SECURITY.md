<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->
# Security Policy

## Supported Versions

| Version | Security fixes |
|---|---|
| latest commit on `main` | Yes |

This project is pre-1.0; security fixes land on the `main` branch.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues** — public
disclosure before a fix lets the issue be exploited.

Instead, email **security@nextain.io** privately. (Conduct issues are handled separately,
see [Code of Conduct](CODE_OF_CONDUCT.md): `conduct@nextain.io`.)

A good report includes:

- **What the problem is** — a description of the vulnerability
- **How to reproduce it** — the steps to trigger it
- **What the impact could be** — what an attacker or user could do
- **A suggested fix** — if you have one

We aim to acknowledge reports within **48 hours** and send a detailed response within
**7 days**.

## Handling Secrets

Naia ADK is a workspace scaffold; forks place real data and credentials under tiered,
git-ignored directories:

- `data-private/` (personal), `data-business/` (sensitive), `data-company/` (general), and `projects/` are **per-fork and git-ignored** — never committed to the base repo.
- API keys, tokens, and passwords belong only in those git-ignored locations or an external secret manager — never in tracked files.

If you accidentally commit a secret, **revoke and rotate the key first** (assume it is
already exposed), then tell us so we can remove it from tracking and, if it reached a
remote, from the commit history.
