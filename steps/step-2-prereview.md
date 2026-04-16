# Step 2: Pre Review (Learning)

## Goal
Enumerate 2–4 candidate approaches, evaluate them, reach 95% consensus on the chosen approach.

## Actions
1. For each non-trivial task, list 2–4 candidate approaches
2. For each approach: pros, cons, complexity, risk, applicability
3. Record under `## Approaches` in `features/<slug>/task/plan.md`
4. If the winning approach is unclear: run the 95% consensus loop (advocate/critic/arbitrator agents)
5. Record rationale — WHY this approach wins

## Agents
- `architect` (opus) — architectural tradeoffs
- `critic` (opus) — pokes holes in each approach
- `analyst` (opus) — requirements fit

## Gate
- At least 2 approaches documented
- Winning approach marked clearly
- Consensus ≥95% OR a single obvious choice
- Rationale captured

## Skip condition
If the `extend` magic keyword was used (scenario 2), skip this step — the approach is determined by the existing feature.

## On fail
If consensus <95% after 3 rounds: pause, ask the user to break the tie.

## Next
→ step-3 (Planning)
