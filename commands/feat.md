# Smelter: /feat — Full Workflow Command

Run the full 10-step workflow on $ARGUMENTS. Handles scenario 1 (new feature) and scenario 2 (extension).

Internally drives `workflows/feat.yaml` via the step engine (`scripts/step-injector.mjs` + `scripts/step-tracker.mjs`). Per-step prompts live in `steps/step-*.md` and are injected as you advance.

## Task
$ARGUMENTS

## Protocol

1. The step engine activates on the next user prompt. On first run, it seeds `.smt/features/<slug>/state/workflow.json` at `step: step-1`.
2. Follow the injected step prompt — do NOT re-read the whole workflow from `document/workflow.md`.
3. Each `PostToolUse` invocation of `step-tracker.mjs` evaluates the current step's gate and advances `workflow.json` if the gate passes.

## Magic-keyword branches

- `extend` / `add to` / `덧붙여` → `skip_if: extend_keyword` makes step-2 auto-skip
- Emit `[Magic Keyword: extend → /feat]` yellow tag when skipped

## Step map (reference)

| Step | Name | Gate |
|------|------|------|
| step-1 | Problem Recognition | task file exists |
| step-2 | Pre Review / Learning | ≥95% consensus |
| step-3 | Planning | checkbox tree complete |
| step-3-interview | User Interview | user approves |
| step-4 | Test Design (TDD) | tests red |
| step-5 | Implementation | tests green |
| step-6 | Local Agent Review | 0 CRITICAL |
| step-7 | Utility Test | scoped suite pass + tsc clean |
| step-8 | E2E Validation | artifacts saved |
| step-9 | Team Code Review | ≥95% consensus |
| step-10 | Human Review | user approves |

## Iron law

- No `- [x]` without fresh evidence (test/build output)
- Validation stays scoped to the selected task / changed surface
- Repo-wide `tsc --noEmit` / full-suite runs are forbidden before step-10 unless the user explicitly asks for them
- E2E artifacts saved under `.smt/features/<slug>/artifacts/` for interface-facing changes
- All task files updated only after step-10 approval
