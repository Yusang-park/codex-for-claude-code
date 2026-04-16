# Smelter: /qa — Narrow Execution Command

Run steps 4–8 + 10 on $ARGUMENTS. Covers bug fixes (scenario 3) and style/text/dialogue edits (scenario 4).

Internally drives `workflows/qa.yaml` via the step engine. Per-step prompts live in `steps/step-*.md`.

## Task
$ARGUMENTS

## Protocol

1. The step engine seeds `.smt/features/<slug>/state/workflow.json` at `step: step-4` on first run (qa skips steps 1–3).
2. If no task file exists for this change, create one under `features/<slug>/task/` BEFORE the engine advances. (/qa does NOT do Steps 1–3 — that is /tasker's job.)
3. Follow the injected step prompt.

## Surface-based exemption

| Surface | E2E | TDD |
|---------|-----|-----|
| CSS / style / typography | no | exempt |
| i18n / copy-only | no | exempt |
| Typo in comments/docs | no | exempt |
| Pure dialogue (no code) | no | exempt |
| Bug fix with testable logic | yes if interface | required |
| Existing-feature behavior change | yes if user-visible | required |
| New logic | yes if interface | required |

When exempt, record `TDD: exempt (<reason>)` in `features/<slug>/decisions.md`.

## Magic-keyword branches

- `fix` / `bug` / `버그` → E2E forced on for interface surface
- `style` / `typo` / `텍스트` / `i18n` → TDD exemption auto-applied

## Iron law

- No completion claim without fresh evidence
- Validation is scoped to the selected task / changed surface first; run only the tests and type/build checks relevant to that scope
- Repo-wide `tsc --noEmit` / full-suite runs are forbidden unless the user explicitly asks or a later step explicitly requires them
- Do NOT delete failing tests to pass
- Do NOT silently widen scope (extras → new task via /tasker)
