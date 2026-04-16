# Step 9: Team Code Review

## Goal
3-agent consensus review (advocate / critic / arbitrator) until 95% agreement. Final quality gate before human review.

## Actions
1. Spawn three agents in parallel:
   - `advocate` — argues for merging as-is
   - `critic` — argues against, finds issues
   - `arbitrator` — weighs both sides, decides
2. Collect verdict severity: CRITICAL / HIGH / MEDIUM / LOW / NONE
3. Iterate until 95% consensus (max 3 rounds).

## Agents
- `code-reviewer` (opus) as advocate
- `critic` (opus) as critic
- `architect` (opus) as arbitrator

## Gate signals (REQUIRED — you must write these together)
Atomic Read→Write of `.smt/features/<slug>/state/workflow.json` (see `steps/step-4-tdd.md` for the pattern):

- Passing: `signals.team_review_clean = true`
- Failing: `signals.team_review_clean = false` AND `signals.failure_category = <category>` — BOTH keys in the SAME Write.

Valid `failure_category`: `critical`, `high`, `medium`, `low`.
- `critical` / `high` → route to step-3 (plan rework)
- `medium` → route to step-5 (impl fix)
- `low` → continue to step-10 (log as known limitation in `decisions.md`)

**If you write `team_review_clean: false` WITHOUT `failure_category`, the engine will re-prompt you.** Write both atomically.

## Skip condition
Not run in qa mode (simpler review in step-6 is sufficient).

## Next
→ step-10 (Human Review)
