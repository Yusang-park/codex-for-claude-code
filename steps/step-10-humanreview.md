# Step 10: Human Review

## Goal
Final human approval. Present completion report and await explicit user decision.

## Actions
1. Produce completion report:
   - Tasks completed (✓ checklist)
   - Test results summary (pass/fail counts)
   - E2E artifact paths
   - Build status
   - Open risks / known limitations
   - Git diff summary (files, additions/deletions)
2. Pause. Wait for user decision.

## User options
- **Complete** → mark all tasks `- [x]`, append session log to `.smt/session/YYYY-MM-DD.md`, offer commit
- **Rework** → return to step-3 (Planning) with user feedback
- **Hold** → save state, end session

## Gate
Explicit user decision. Never auto-complete.

## On complete
1. Update all `features/<slug>/task/<task-name>.md` files — checkbox to `[x]`
2. Record artifact paths in `plan.md` or task files
3. Append session summary to `.smt/session/YYYY-MM-DD.md`
4. Offer git commit (do NOT commit without user approval)

## This is the terminal step.
No further workflow advancement.
