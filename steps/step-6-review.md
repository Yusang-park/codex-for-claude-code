# Step 6: Local Agent Review

## Goal
Specialized review agents catch bugs before broader tests.

## Actions
1. Invoke `code-reviewer` on changed files.
2. Invoke `security-reviewer` if changes touch auth, input validation, secrets, network I/O, file I/O.
3. Record findings in `features/<slug>/decisions.md` under `## Risks`.
4. Fix CRITICAL + HIGH issues immediately.

## Agents
- `code-reviewer` (sonnet) — always
- `security-reviewer` (sonnet) — conditional

## Gate signals (REQUIRED — you must write these together)
Atomic Read→Write of `.smt/features/<slug>/state/workflow.json` (see `steps/step-4-tdd.md` for the pattern):

- Passing: `signals.review_clean = true`
- Failing: `signals.review_clean = false` AND `signals.failure_category = <category>` — BOTH keys in the SAME Write.

Valid `failure_category`: `code_quality`, `bug`, `security`, `plan_mismatch`, `edge_case`.
- `code_quality` / `bug` / `security` → route to step-5
- `plan_mismatch` / `edge_case` → route to step-3

**If you write `review_clean: false` WITHOUT `failure_category`, the engine will re-prompt you to add it.** Best to write both atomically the first time.

## Next
→ step-7 (Utility Test)
