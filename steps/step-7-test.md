# Step 7: Utility Test (Scoped)

## Goal
Scoped unit/integration tests on changed files. No regressions.

## Actions
1. Identify changed files: `git diff --name-only`
2. Run tests intersecting those files:
   - `npm test -- --testPathPattern="<area>"` / `pytest tests/test_<module>.py` / `go test ./<pkg>/...`
3. `tsc --noEmit` (0 errors)
4. `eslint .` / `ruff check` if configured
5. Build if build-affecting

## Scope
**Do NOT run the full suite.** Scoped to changed files only.

## Gate signal (REQUIRED — you must write this)
Set `signals.tests_pass_and_build_clean = true` (atomic Read→Write — see `steps/step-4-tdd.md`).

`true` only when scoped tests pass + tsc clean + build succeeds. `false` → route to step-5.

## Next
→ step-8 (E2E Validation)
