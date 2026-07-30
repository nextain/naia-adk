# Issue #16 — Azure candidate role smoke

Date: 2026-07-30
Status: exploratory five-task smoke; not role qualification

## Azure state

Azure Foundry was used directly; OpenRouter was not used. Deployments for `gpt-5.4-nano`, `DeepSeek-V4-Flash`, and `grok-4.3` were created in Korea Central. Azure rejected a new GPT-4.1-nano deployment because the model is in a deprecating state.

## First five exact-output tasks

| Route | Exact passes | Worker wall time | Mean time | Model attempt turns | Runner retry turns | Token/accounting note |
|---|---:|---:|---:|---:|---:|---|
| `gpt-5.4-nano` | 3/5 (60%) | 7.087 s | 1.417 s | 5 | 0 | 339 uncached input + 108 output; outside-journal estimate $0.0002028 from the 2026-07-30 Azure Global PAYG rates |
| `DeepSeek-V4-Flash` | 4/5 (80%) | 23.762 s | 4.752 s | 5 | 0 | 340 total input + 99 output; cached split unavailable, so outside-journal estimate is $0.00006001-$0.00011509 |
| `grok-4.3` | not scored | >60 s first-request timeout | unavailable | 1 attempted | 0 wrapper retries | retry with a separately bounded latency experiment before quality testing |

GPT-5.4-nano used the published Korea Central Global rates of $0.20 per 1M input tokens and $1.25 per 1M output tokens. DeepSeek V4 Flash rates were visible ($0.028 cached input, $0.19 uncached input, and $0.51 output per 1M tokens); the range treats all input as cached versus all input as uncached. Grok 4.3 Global rates were visible ($1.25 input and $2.50 output per 1M tokens), but the timed-out request produced no qualifying result. These are explicitly outside-journal estimates: the Azure routes do not yet bind a frozen price snapshot, so their journal monetary fields correctly remain unavailable.

## Decision boundary

- GPT-5.4-nano is not a coding-worker candidate on this smoke. Test it separately on translation and exact structured extraction.
- DeepSeek V4 Flash remains a middle-cost candidate, but 4/5 is not enough to change the default.
- Grok 4.3 needs a latency/availability probe before spending on a full quality run.
- A smoke is not expected to be accepted below 100% when an exact validator is the safety boundary. Failed tasks therefore cause fallback/escalation rather than silent acceptance.

The ignored journals remain local evidence only. They do not contain credentials and are not committed.
