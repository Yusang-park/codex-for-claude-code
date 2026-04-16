# Step 1: Problem Recognition

## Goal
Capture the raw problem/feature request and turn it into a feature folder with initial tasks.

## Actions
1. Find project root (nearest ancestor with `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, or `.git`)
2. Create a feature slug from the prompt (short, kebab-case)
3. Create `.smt/features/<slug>/task/plan.md` with:
   - Title, background, goal, `status: open`
   - Acceptance criteria (testable)
4. For each discrete issue, create `.smt/features/<slug>/task/<task-id>.md`:
   ```
   - [ ] Task {id}: {title}
   ```

## Agents
- `explore` (sonnet) — for ambiguous requests, gather codebase context before locking down scope

## Gate
At least one task file with a `- [ ]` entry exists at `features/<slug>/task/`.

## On fail
Re-prompt the user for clarification. Never proceed without a clear problem statement.

## Next
→ step-2 (Pre Review / Learning)
