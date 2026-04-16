# Step 3-Interview: User Approval Gate

## Goal
Pause execution. Present the plan to the user. Wait for explicit approval before entering implementation.

## Actions
1. Summarize: feature title, task count, phase breakdown, complexity (S/M/L)
2. Present three options to the user:
   - **Approve** → proceed to Step 4 (TDD)
   - **Revise** → return to Step 1, 2, or 3 based on user feedback
   - **Hold** → save state, end session

## Gate
Explicit user approval. Do NOT auto-proceed.

## Allow revisit
User may request a jump back to:
- step-1 (Problem Recognition)
- step-2 (Pre Review)
- step-3 (Planning)

## On user approval
Advance workflow.json step → step-4. Log decision in `features/<slug>/decisions.md`.

## Next
→ step-4 (TDD)
