---
name: tagteam-review
description: Cross-AI code review. Have Codex, Claude and/or Antigravity independently review uncommitted changes, a branch, the last commit or specific files, then merge, verify and apply their findings. Use when the user asks for a review "from another AI", a "second pair of eyes", "have codex/antigravity check this", "multi-model review", or before shipping/committing important changes.
---

# Tag-Team review: several AIs, one verified list

Different models catch different bugs. Run independent reviews in parallel and trust what you can verify.

## Steps

1. **Pick the scope.**
   - `uncommitted` (default): the working tree vs HEAD.
   - `staged`: what's staged for commit.
   - `branch`: the current branch vs `base`, e.g. a PR.
   - `last_commit`: the most recent commit.
   - `files`: specific files. Use this for code that isn't in git.
2. **Call `review`.** Pass `cwd` (absolute) and the `scope`. Add `focus` (e.g. "auth and input validation") and `context`: what the change is supposed to do. Reviewers judge much better when they know the intent.
   - By default every installed agent except you reviews. Pass `agents` to choose, for example `["codex","antigravity"]` when you're Claude.
   - Large diffs can take several minutes. Pass `background: true`, then use `job` with `wait_sec: 600`.
3. **Read the merged findings.** Issues flagged by two or more reviewers come first, and they're the most likely to be real.
4. **Verify every finding yourself** before acting on it. Open the file and trace the failure scenario. Drop false positives and say why.
5. **Report or fix.** Give the user a short table: severity, file:line, the issue, who flagged it, and whether it's verified. Fix the confirmed issues if the user wants fixes. For big fixes, `ask` one reviewer to double-check your patch.

## Tips

- Run a second round on the fixed code for high-stakes changes: auth, payments, migrations, concurrency.
- When you're Codex or Antigravity, Claude is usually the most thorough reviewer. When you're Claude, Codex is good at spotting runtime and test failures.
- Reviewers work read-only. They never modify files.
- CLI: `{{CLI}} review --cwd <dir> --scope branch --base main --focus "error handling"`.
