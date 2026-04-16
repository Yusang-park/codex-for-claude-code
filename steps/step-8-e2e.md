# Step 8: E2E Validation

## Goal
Exercise the real interface end-to-end. Capture artifacts for human review.

## Actions
Surface-based routing:
- **UI** → Playwright + real dev server. Video + screenshots → `.smt/features/<slug>/artifacts/`
- **CLI** → subprocess + assert exit/stdout
- **API** → real server + curl/supertest
- **Hook script** → stdin JSON pipe → assert stdout JSON
- **Library** → real deps (no mocking the system under test)

## Skip condition
CSS/i18n/typo/dialogue with no user-visible behavior change → skip E2E.

## Agents
- `qa-tester` (sonnet) for critical user flows

## Gate signal (REQUIRED — you must write this)
Set `signals.e2e_pass = true` (atomic Read→Write — see `steps/step-4-tdd.md`).

`true` only when artifacts saved + assertions pass + no visible regressions. `false` → route to step-5.

**If skipped (exempt surface):** set `e2e_pass: true` with a note in `decisions.md`.

## Next
- `/feat` → step-9 (Team Code Review)
- `/qa` → step-10 (Human Review)
