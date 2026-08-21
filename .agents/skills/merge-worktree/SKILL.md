---
name: merge-worktree
description: Squash-merge the current worktree branch into the main branch (or a specified target). Analyzes git history and source code to craft a comprehensive commit message. Use when finishing work in a git worktree, at issue-driven-development Commit phase, or whenever asked to merge or squash a worktree branch. Invoke with /merge-worktree.
argument-hint: "<worktree-path> [target-branch]"
disable-model-invocation: true
---

# Merge Worktree

Squash-merge the current worktree branch back into the target branch with a comprehensive, structured commit message.

## Where this runs

Run this from the governed repository root, not from inside the worktree.

The worktree is a path you operate on, not a place the session moves into. A
session whose shell sits below the governed root cannot produce valid relative
evidence — the harness rejects it with `login shell root mismatch` — and the
recovery helpers it may need are then only reachable by absolute path. Naming
the worktree as an argument keeps one session, one root, and one set of paths.

Every git call below is explicit about which repository it addresses:
`git -C <worktree-path>` for the branch being merged, and
`git -C <repo-root>` for the target branch that receives it.

## Instructions

Follow these phases exactly, in order. Do NOT skip phases.

---

### Phase 1: Validation

1. **Resolve the worktree path**: The first argument in `$ARGUMENTS` is the
   worktree path. Make it absolute. If no argument was given, fall back to the
   current directory — but only so an already-misplaced session still works;
   the argument form is the one to use.

   If `git worktree list` shows no worktree at that path, **stop** and tell the
   user:
   > "No worktree at <path>. Create one inside the repository:
   > `git worktree add worktrees/<project>-issue-<N>-<desc> issue-<N>-<desc>`"

   Worktrees belong under the repository, not beside it. A worktree at `../`
   or in a temp directory falls outside every path the contracts govern, and
   it is invisible to anyone who only has the repository.

2. **Confirm it is a worktree**: `git -C <worktree-path> rev-parse --git-dir`
   must contain `/worktrees/`. A plain clone is not a worktree and must not be
   squashed this way.

3. **Identify the branch to merge**: `git -C <worktree-path> branch --show-current`.

4. **Resolve target branch**:
   - If a second argument was given, use it as the target branch.
   - Otherwise, detect the default branch: check if `main` exists, else check `master`. If neither exists, stop and ask the user.

5. **Identify the repository root**: `git -C <worktree-path> rev-parse --git-common-dir`
   points back into the main repository; its parent is the repository root.
   Every later phase calls this `<repo-root>`.

6. **Clean working tree**: Run `git -C <worktree-path> status --porcelain`. If there are uncommitted changes, stop and tell the user to commit or stash them first.

---

### Phase 2: Research

This is the most critical phase. You must deeply understand what was done before writing any commit message.

1. **Commit history**: Run `git -C <worktree-path> log --oneline <target>..HEAD` to see all commits on this worktree branch.

2. **File change summary**: Run `git -C <worktree-path> diff <target>...HEAD --stat` to get an overview of what files changed and how much.

3. **Full diff**: Run `git -C <worktree-path> diff <target>...HEAD` to read the complete diff. Study it carefully.

4. **Read key files**: For the most significantly changed files (largest diffs, new files, deleted files), use the Read tool to understand the full context — not just the diff lines.

5. **Categorize changes**: Mentally group all changes into categories:
   - Features (new functionality)
   - Fixes (bug corrections)
   - Refactors (code restructuring without behavior change)
   - Tests (new or updated tests)
   - Docs (documentation changes)
   - Config/Chore (build, CI, tooling, dependencies)

6. **Identify the dominant type**: Determine which conventional commit type (`feat`, `fix`, `refactor`, `docs`, `chore`, `test`) best represents the overall body of work.

---

### Phase 3: Target branch preparation

1. **Get the repository root** (from Phase 1 step 5).

2. **Check target branch state**: Run `git -C <repo-root> log --oneline -10 <target>` to see recent commits on the target branch.

3. **Detect stray WIP commits**: If the target branch has commits that look like auto-generated WIP commits (e.g., messages starting with `wip:`, `auto-commit`, `WIP`), warn the user and ask if they want to reset to the last clean commit before merging.

4. **Fetch latest** (if remote exists): Run `git -C <repo-root> fetch origin <target> 2>/dev/null` to ensure target is up to date with remote. Do not fail if no remote.

---

### Phase 4: Squash merge

1. **Ensure target branch is checked out** in the repository root:
   ```
   git -C <repo-root> checkout <target>
   ```

2. **Perform the squash merge**:
   ```
   git -C <repo-root> merge --squash <worktree-branch>
   ```

3. **Handle conflicts**: If the merge reports conflicts:
   - List all conflicted files
   - Show the conflict markers
   - **Stop and report to the user** — do NOT attempt to auto-resolve
   - Tell them to resolve conflicts in the repository root and then run the skill again

4. If the merge succeeds (no conflicts), proceed to Phase 5.

---

### Phase 5: Craft commit message and commit

Based on your Phase 2 research, write the commit message following this **exact structure**:

```
<type>: <concise summary in imperative mood, under 72 chars, no period>

<2-4 sentence paragraph explaining what was done and WHY. Focus on the
motivation and high-level approach, not implementation details.>

Changes:
- <grouped bullet points of what changed>
- <use sub-bullets for details within a group>

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

**Rules:**
- `<type>` must be one of: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`
- If changes span multiple types, use the dominant one
- Summary line: imperative mood ("add", "fix", "refactor"), no period, max 72 chars
- Body paragraph: explain the *why* and *context*, not just *what*
- Changes: group related items together, most important first
- Always end with `Co-Authored-By`

**Create the commit** in the repository root using a heredoc:
```bash
git -C <repo-root> commit -m "$(cat <<'EOF'
<your commit message here>
EOF
)"
```

---

### Phase 6: Verification

1. **Confirm the commit**: Run `git -C <repo-root> log --oneline -3` and show the result to the user.

2. **Report summary**: Tell the user:
   - The final commit hash
   - The commit summary line
   - Which branch it was merged into
   - Remind them the worktree branch still exists — they can delete it with `git worktree remove <path>` if no longer needed
   - Remind them to `git push` if they want to push to the remote

---

## Important notes

- **Never force-push or use destructive git operations** without explicit user confirmation.
- **Never skip pre-commit hooks** (`--no-verify`).
- If anything unexpected happens at any phase, **stop and explain** rather than guessing.
- **Never move the session into the worktree** to make a command shorter. Address it with `git -C`. One session, one root.
- The commit message quality is paramount — take time in Phase 2 to truly understand the changes.
