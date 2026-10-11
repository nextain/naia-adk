# Drift Recovery

When you find that work has departed from what the requester asked for (drift), follow this order before fixing anything: pin the goal, map the contaminated scope, quarantine-delete the wrong code and documents, and only then assess the current state, analyze gaps, design, and build. Changing direction or correcting a mistake follows the same order.

This procedure and `.agents/context/regression-prevention.json` complement the review-pass product-preservation preflight, which applies to all feature work including non-governed projects. They never replace or weaken it; its surface set, authority, and evidence requirements apply in full. "Entry point" here means every surface kind the preflight lists: UI route or navigation, screen, button, URL, API, CLI command, library export, data schema, job, package or deployment target, and operations or handoff path. A kind that does not apply needs an explicit N/A reason.

## 1. Pin the goal

Record the goal in one place the work already uses as its source of truth (the issue, or a goal file in the work's progress folder). Put only the requester's own words there, each with its source and date, and no interpretation or summary. Start with the one or two quotes that explain why this recovery exists, because subagents and other sessions may see only the first lines.

Every subtask and review request starts with a `Goal: "<quote>"` line that quotes that record verbatim. If the coordinator needs to restate or infer something, it goes in a separate `Coordinator interpretation:` field. After a conversation is compacted, re-read the goal record first.

## 2. Map the scope

Before deciding what to delete, survey the contamination read-only and write it down next to the goal. For each category, record present or absent and the evidence.

- Plans, designs, instructions, and gap analyses. Always include analysis documents the coordinator (AI) wrote itself; recontamination comes from these and from summaries more often than from old code.
- Conversation summaries, handoff documents, memory files, and work files.
- Commits, branches, and worktrees named as a baseline.
- Requirement documents and runbooks with sentences that contradict the requester's words.
- Test assertions and comments.

Also list, one per line, every entry point of the affected feature, covering both the paths that create things and the paths that view or play them. Scoping from a single flow lets the other flows drop out again.

## 3. Quarantine-delete

Delete what contradicts the requester's words instead of leaving it with a "deprecated" label, because the next agent will read it as a basis. Never delete the requester's words.

Before deleting, record a deletion list next to the goal:

- `Delete`: per line, the path, the reason, and the requester quote it rests on.
- `Keep`: what must not be deleted (requester words, working features, the baseline), each with its basis. If the only basis is "it worked", add a line on whether its approach matches the goal. Removing a user feature from `Keep` needs the requester's confirmation first.

Delete in a commit on the work branch and copy the same list into the change description's `Deletion basis` section. Deleting production data, shared databases, or infrastructure is not covered here; it follows the repository's authorization rules.

## 4. Assess, analyze, design, build

After the quarantine deletion, assess the current state and continue with gap analysis, design, and implementation. Instructions and reviews follow `.agents/context/regression-prevention.json`, in particular:

- Instructions carry an `Existing behavior to keep` section (baseline commit, and each entry point from step 2 marked applies or does not apply with a reason).
- Write a feature-removal instruction only with a requester quote.
- Do not override a review FAIL grounded in a requester quote; fix it and re-review.
- Report completion only with evidence that every entry point from step 2 was actually checked the same way as on the baseline.

After 5 review FAILs on the same target (every 4 after a triage), get a triage verdict from a stronger, different model before the next round, following `repeat_review_triage` in the rule file. Reserve stronger-model checkpoints for that case and for complex situations or long autonomous runs; using them at every stage costs more than it saves.
