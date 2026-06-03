---
description: Create well-structured grouped git commits with conventional commit messages
---

# Smart Commit Workflow

Create logically grouped git commits following Conventional Commits format, avoiding huge commits with too many files.

## Steps

1. **Check git status** — Run `git status` to see all staged, unstaged, and untracked changes. If there are no changes, stop and inform the user.

2. **List all changed files with sizes** — Run `git diff --stat` (unstaged) and
   `git diff --staged --stat` (staged) to get every file with its line-change
   count. **Do this before reading any diff.** The stat is the ground truth for
   which file carries the most weight — never judge importance by order of
   appearance in the diff.

3. **Read the full diff** — Run `git diff` and `git diff --staged` to understand
   the actual content. For each file, identify whether it is:
   - A **cause**: source code, validator, test, config that drives the change
   - A **consequence**: recompiled artifact (`plutus.json`, `dist/`), generated
     doc, or lock file that follows automatically from the cause
   The commit subject must name the highest-impact *cause*, not a consequence.

4. **Analyze the changes** — Group files into logical commit categories:
   - **chore**: scaffolding, config files, .gitignore, .gitkeep, tooling setup
   - **docs**: documentation, specs, requirements, architecture diagrams
   - **feat(component)**: new features scoped by component (e.g., `feat(contracts)`, `feat(offchain)`, `feat(api)`)
   - **fix(component)**: bug fixes scoped by component
   - **refactor(component)**: refactors scoped by component
   - **test(component)**: test additions or changes
   - **ci**: CI/CD pipeline changes
   - **style**: formatting-only changes

5. **Plan the commit groups** — Present the proposed grouping to the user before committing:
   - Each group should have a clear theme (e.g., all contract changes together, all CLI changes together)
   - Aim for 5–25 files per commit; split further if a group is too large
   - Order commits from foundational → dependent (scaffolding first, features last)
   - Ask the user to confirm or adjust the grouping

6. **Unstage everything** — If files are already staged, reset the staging area with `git reset` to start clean.

7. **For each commit group, sequentially:**
   - Stage only the files belonging to that group using `git add <files>`
   - Commit with a well-structured message following this format:

     ```
     <type>(<scope>): <short summary in imperative mood, max ~72 chars>

     <blank line>
     <optional body: what was done and why, wrapped at 72 chars>

     <blank line>
     <optional bullet list of key changes>
     ```

   - Conventional Commits types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`, `style`, `perf`, `build`
   - Scope should match the project area (e.g., `contracts`, `offchain`, `cli`, `api`, `infra`)
   - Subject line must be imperative mood ("add", "fix", "update", not "added", "fixes", "updated")
   - Body should explain **what** was added/changed at a meaningful level, not just list filenames
   - Mention every meaningfully changed area; do NOT omit a file because it appears later in the diff
   - Consequences (compiled artifacts, generated docs) belong in bullets, not the subject line

8. **Verify** — Run `git status` to confirm working tree is clean, then `git log` to show the created commits.

9. **Summarize** — Show a table of all commits created (hash, message) and remind the user to `git push` when ready.

## Conventions Reference

- **Conventional Commits**: https://www.conventionalcommits.org/
- Keep subject line under 72 characters
- Use imperative mood in subject ("add X" not "added X")
- Separate subject from body with a blank line
- Body should wrap at 72 characters
- Reference issue numbers in footer if applicable (e.g., `Closes #42`)
