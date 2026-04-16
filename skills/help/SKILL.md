---
name: help
description: Guide on using smelter plugin
---

# How Smelter Works

Smelter is organized around planning state, start commands, and executor commands.

## Core Concepts

| Concept | Values | Purpose |
|--------|--------|---------|
| Planning state | `features/<slug>/task/plan.md`, `features/<slug>/task/*.md` | Source of truth |
| Start commands | `/feat`, `/qa`, `/tasker` | Start or shape work |

## Start Commands

| Command | Use |
|--------|-----|
| `/feat` | Standard implementation work |
| `/qa` | Small fixes and narrow changes |
| `/tasker` | Planning-state creation and repair |

Start command examples:
- `/feat "new onboarding flow"`
- `/qa "fix login error copy"`
- `/tasker "login page shows no password error"`

## Verification

Verification depends on the selected tasks, not on the preset name alone.

- Planning work does not require E2E by default
- UI or user-flow changes may require E2E
- Small fixes may only need targeted tests or typecheck

## Stopping Things

Use `/cancel` to stop active work.

For the canonical model, read `doc/index.md` and `doc/workflow-spec.md`.
