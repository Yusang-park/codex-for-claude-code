# Step 4: Test Design (TDD)

## Goal
Write tests FIRST. Verify they fail (RED) before any implementation.

## Actions
1. For each task, write minimum 10 tests per task surface:
   - Happy path (3+) / Boundary (2+) / Error (2+) / Edge (2+) / Integration (1+)
2. Test file MUST exist before any source file.
3. Run tests — they MUST fail with a meaningful error (not "not implemented").

## Exemption (qa mode only)
Skip TDD for: CSS/style, i18n/copy-only, typo in comments/docs, pure dialogue.
Record `TDD: exempt (<reason>)` in `features/<slug>/decisions.md`.

## Agents
- `tdd-guide` (sonnet) — enforces test-first discipline

## Gate signal (REQUIRED — you must write this)
When tests exist AND fail, update `.smt/features/<slug>/state/workflow.json` to set `signals.tests_exist_and_red = true`.

**How to write it (atomic — do NOT partial-edit):**
1. Read the full current workflow.json with the `Read` tool.
2. Write the full object back with the `Write` tool, merging your new signal into `signals`. Preserve `command`, `step`, `retry`, `version`, `updated_at`, and any other fields.

Example — starting state:
```json
{ "command": "feat", "step": "step-4", "retry": 0, "signals": {}, "version": 3 }
```
After your write:
```json
{ "command": "feat", "step": "step-4", "retry": 0, "signals": { "tests_exist_and_red": true }, "version": 3 }
```

The PostToolUse hook then reads the signal, bumps `version`, overwrites `updated_at`, and advances to step-5. Do NOT manually edit `step`, `version`, or `updated_at` — the engine owns those.

Set `tests_exist_and_red: false` if tests accidentally pass before implementation (rewrite them). Without any signal, the workflow waits forever — fail-closed by design.

## On fail
- If tests green before implementation: they're testing the wrong thing. Rewrite.
- If tests can't be written: the plan is wrong. Return to step-3.

## Next
→ step-5 (Implementation)
