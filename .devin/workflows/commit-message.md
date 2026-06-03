---
description: Generate a conventional commit message for the current staged changes
---

# Commit Message Generator

Reads the staged diff and outputs a ready-to-use Conventional Commits message.
Does NOT stage, commit, or touch the repo — output only.

## Steps

1. **List staged files with sizes** — Run `git diff --staged --stat` first.
   This shows every file and its line-change count. If nothing is staged, stop.
   **Do NOT skip this step** — the stat output is the ground truth for which
   file carries the most weight. Never assume from the diff order alone.

2. **Read the full staged diff** — Run `git diff --staged` to understand the
   actual content of each change.

3. **Rank changes by impact** — For every staged file, note:
   - Lines added/removed (from the stat)
   - Functional category: source code, tests, generated artifact, docs
   - Whether it is the *cause* or a *consequence* of another change
     (e.g. a recompiled `plutus.json` or an updated README are consequences;
     the validator `.ak` file that triggered them is the cause)
   **The subject line must describe the highest-impact cause, not the first
   file in the diff list.**

4. **Identify type and scope** — Based on the ranked analysis:
   - Type: `feat` / `fix` / `docs` / `chore` / `refactor` / `test` / `ci` / `style` / `perf` / `build`
   - Scope: the project area of the primary change (`contracts`, `offchain`, `cli`, `docs`, etc.)

5. **Output the message** in this exact format:

   ```
   <type>(<scope>): <short summary, imperative mood, ≤72 chars>

   <body: what changed and why, wrapped at 72 chars>

   - bullet list of secondary changes (omit if only one change)
   ```

6. **Rules:**
   - Subject line: imperative mood ("add", "fix", "update" — never "added", "fixes")
   - Subject line: ≤ 72 characters
   - Body: explain *what* and *why*, not just filenames
   - Mention every meaningfully changed file or area in the body or bullets;
     do NOT omit a file just because it appears later in the diff
   - Generated artifacts (compiled outputs, lock files) and docs updates that
     are direct consequences of a code change should be noted in bullets, not
     promoted to the subject line
   - If the staged changes clearly belong to **multiple unrelated concerns**,
     warn the user and suggest splitting before committing
