# Step 3: Planning

## Goal
Turn the chosen approach into an executable checkbox tree that an agent can follow reading only the task file.

## Actions
1. In each `features/<slug>/task/<task-name>.md`, fill `## Plan` as a checkbox tree
2. Mark independent subtasks with `[parallel]`
3. Include TDD and E2E steps where the change surface warrants (UI/CLI/API/hook/public module)
4. Link related wiki pages under `## Wiki Links`
5. Leave `## Risks` empty (populated by Steps 6/9/10)

## Agents
- `planner` (opus) — for multi-task features or architectural decomposition

## Gate
- Every task file has a `## Plan` section with checkbox tree
- All acceptance criteria map to at least one checkbox
- 80%+ of claims cite file/line references
- No `{{...}}` placeholders

## On fail
Return to Step 2 (approach was too vague to plan).

## Next
→ step-3-interview (user approves plan before execution)
