# Step 5: Implementation

## Goal
Make the RED tests GREEN with minimal code. Then refactor.

## Actions
1. Write the smallest change that turns RED tests GREEN.
2. Run tests — verify GREEN.
3. Refactor for clarity (tests stay GREEN).
4. Prefer `Edit` over `Write`. No scope creep — extras → new task via `/tasker`.

## Agents
- `executor` (sonnet) / `executor-high` (opus) — multi-file
- `designer` / `build-fixer` as needed

## Gate signal (REQUIRED — you must write this)
Set `signals.tests_green = true` in `.smt/features/<slug>/state/workflow.json` (atomic Read→Write — see `steps/step-4-tdd.md` for the exact pattern).

Set `true` only after fresh scoped validation for the selected task / changed surface. Run the RED→GREEN tests for that scope and any scoped build/type checks that apply to the changed files. Do not widen to repo-wide validation unless the user explicitly asks for it or the current step prompt explicitly requires it.

If the active scope is green, decide the workflow outcome autonomously. Do not ask the user to choose between continue, retry, or reroute when the rule already determines it. Set `false` if the scoped tests still fail (triggers retry up to 3, then routes to step-2).

## Retry budget
`max_retry: 3` — on 3 consecutive `tests_green: false`, engine routes to step-2 (approach is wrong).

## Next
→ step-6 (Local Agent Review)
