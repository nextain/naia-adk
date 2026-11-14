# Retrospectives

Use a daily retrospective to record evidence for completed work, what worked,
what did not, and causes. Mark unverified causes as hypotheses. Record one or
two goal improvements, research with source URLs, open thoughts, and work that
keeps slipping. Where task cards are available, use their current report for
the last section and record a request for help or reassignment when needed.
Research includes an internet search; cite the sources used.
Do not put secrets, customer personal information, or private operational
addresses in a shared retrospective.

Copy the template below to a local document and replace every placeholder.
The date is the local period end date, chosen by the author. Role labels and
storage paths are instance configuration; this guide does not prescribe them.

```markdown
# <role> 매일 회고 — YYYY-MM-DD

쓴 역할: <role>

## 1. 회고
<work, evidence, successes, failures and causes>
## 2. 목표 개선
<next improvements>
## 3. 리서치
<findings and an HTTP(S) source URL>
## 4. 잡생각
<ideas>
## 5. 계속 밀리는 일
<repeatedly deferred work and a request for help when needed>
```

Alternatively, generate a blank template with
`node scripts/retro-create.mjs template <role> <YYYY-MM-DD> daily --output <file>`.
Blank templates intentionally fail validation until a research source is added.
The `--output` option creates a new file exclusively and fails if it exists;
without it, output goes to standard output. Parent directories must already exist.

Run `node scripts/retro-format-check.mjs <file> <role> <YYYY-MM-DD> daily`.
Use `-` as the file to read standard input. Exit 0 means the structure passes;
1 means the document needs corrections; 2 means the invocation or read failed.
The check verifies the exact title, an author line matching the requested role, ordered unique
section headings and an HTTP(S) research URL. It cannot verify content,
evidence, source quality, or whether a task was performed.

Weekly reviews gather the previous seven daily reviews; monthly reviews gather
the previous month's weekly reviews; yearly reviews gather the previous year's
monthly reviews. Record missing reviews as well. Use `주간`, `월간`, or `연간`
in the title instead of `매일`, add `## 6. 되풀이된 문제` and
`## 7. 다음 기간 목표`, and pass `weekly`, `monthly`, or `yearly` to the
checker. Extra second-level headings may appear between the required ones.

For a role-specific local work request, run
`node scripts/retro-create.mjs request <role> <YYYY-MM-DD> <period> <artifact-path> --output <request-path>`.
For an existing or missing document, use `repair` instead of `request`: it
checks the local file and creates a correction request if it is missing or has
format errors. If the document passes, no request file is written. Provide a
separate request path for each occurrence; neither command sends or delivers it.

To schedule reviews, add instance-specific roles, time zones, cadence and
artifact locations to the existing [regular schedule ledger](regular-schedule-ledger.md).
The existing execution observer supports daily and weekly cadences; monthly
and yearly monitoring needs an instance-specific calendar adapter, as the
ledger guide explains. Listing a review in the ledger does not schedule it.
The ledger describes scheduling and acceptance; this checker only reads a
file or standard input and does not install timers, wake agents, fetch, or send.
