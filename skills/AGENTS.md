<!-- Parent: ../AGENTS.md -->
<!-- Updated: 2026-04-14 -->

# skills

Skill definitions for workflow automation and specialized behaviors.

## Purpose

Skills are reusable workflow templates invoked via the Skill tool or keyword detection. Each skill provides structured prompts for specific workflows and integrates with hooks and commands.

## Key Files

### Execution Skills

| File | Skill | Purpose |
|-----------|-------|---------|
| `ralph/SKILL.md` | ralph | Read pending tasks → assign per-task agent team → execute linearly until all complete |
| `deep-executor/SKILL.md` | deep-executor | Complex goal-oriented autonomous execution |

### Planning Skills

| File | Skill | Purpose |
|-----------|-------|---------|
| `plan/SKILL.md` | plan | Strategic planning with interview workflow |
| `ralplan/SKILL.md` | ralplan | Iterative planning (Planner+Architect+Critic consensus) |
| `review/SKILL.md` | review | Review plan with Critic |
| `analyze/SKILL.md` | analyze | Deep analysis and investigation |
| `ralph-init/SKILL.md` | ralph-init | Initialize PRD for structured ralph execution |

### Code Quality Skills

| File | Skill | Purpose |
|-----------|-------|---------|
| `code-review/SKILL.md` | code-review | Comprehensive code review |
| `security-review/SKILL.md` | security-review | Security vulnerability detection |
| `tdd/SKILL.md` | tdd | Test-driven development workflow |
| `tdd-linear/SKILL.md` | tdd-linear | Smelter TDD — RED-GREEN-REFACTOR, 10+ tests |
| `build-fix/SKILL.md` | build-fix | Fix build and TypeScript errors |

### Exploration Skills

| File | Skill | Purpose |
|-----------|-------|---------|
| `deepsearch/SKILL.md` | deepsearch | Thorough codebase search |
| `deepinit/SKILL.md` | deepinit | Generate hierarchical AGENTS.md documentation |
| `research/SKILL.md` | research | Parallel scientist orchestration |

### Utility Skills

| File | Skill | Purpose |
|-----------|-------|---------|
| `orchestrate/SKILL.md` | orchestrate | Multi-agent orchestration (always active) |
| `learner/SKILL.md` | learner | Extract reusable skill from current session |
| `note/SKILL.md` | note | Save notes for compaction resilience |
| `cancel/SKILL.md` | cancel | Cancel active Ralph continuation run |
| `caveman/SKILL.md` | caveman | Token-efficient response mode (~40-50% savings) |
| `hud/SKILL.md` | hud | Configure HUD display |
| `usage-all/SKILL.md` | usage-all | Token usage report (Claude + Codex 5h stats) |
| `doctor/SKILL.md` | doctor | Diagnose installation issues |
| `mcp-setup/SKILL.md` | mcp-setup | Configure MCP servers |
| `help/SKILL.md` | help | Usage guide |
| `skill/SKILL.md` | skill | Manage local skills |
| `trace/SKILL.md` | trace | Show agent flow trace timeline |
| `continuous-learning-v2/SKILL.md` | continuous-learning-v2 | Instinct-based learning system |

### Domain Skills

| File | Skill | Purpose |
|-----------|-------|---------|
| `frontend-ui-ux/SKILL.md` | frontend-ui-ux | Designer-developer for UI/UX work |
| `git-master/SKILL.md` | git-master | Git expertise, atomic commits, history management |
| `project-session-manager/SKILL.md` | psm | Isolated dev environments (worktree + tmux) |
| `writer-memory/SKILL.md` | writer-memory | Agentic memory for writers |
| `release/SKILL.md` | release | Automated release workflow |
| `local-skills-setup/SKILL.md` | local-skills-setup | Manage local skills |

## For AI Agents

### Skill Template Format

```markdown
---
name: skill-name
description: Brief description
triggers:
  - "keyword1"
  - "keyword2"
agent: executor  # Optional: which agent to use
model: sonnet    # Optional: model override
---

# Skill Name

## Purpose
What this skill accomplishes.

## Workflow
1. Step one
2. Step two
3. Step three
```

### Creating a New Skill

1. Create `new-skill/SKILL.md` with YAML frontmatter
2. Define purpose, workflow, and usage
3. Add to this index (skills/AGENTS.md)
4. Optionally create `commands/new-skill.md` mirror
5. Register any keyword triggers in `scripts/keyword-detector.mjs`

## Skill Categories & Triggers

| Category | Skills | Trigger Keywords |
|----------|--------|------------------|
| Execution | ralph, deep-executor | "ralph", "don't stop until" |
| Planning | plan, ralplan, review, analyze, ralph-init | "plan this", "ralplan" |
| Quality | code-review, security-review, tdd, tdd-linear, build-fix | "review", "tdd" |
| Exploration | deepsearch, deepinit, research | "deepsearch", "research" |
| Utility | cancel, note, caveman, hud, doctor, mcp-setup, help, skill, trace | "cancelomc", "stopomc" |
| Domain | frontend-ui-ux, git-master, psm, writer-memory, release | UI/git context |

## Auto-Activation

| Skill | Auto-Trigger Condition |
|-------|----------------------|
| ralph | "ralph", "don't stop", "must complete", "until done" |
| cancel | "cancelomc", "stopomc" |
| tdd | "tdd", "test first", "red green" |
| research | "research", "analyze data", "statistics" |

<!-- MANUAL: Update this file when adding or removing skills -->
