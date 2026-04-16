# Codex for Claude Code

Use Codex models inside Claude Code with a user-focused workflow layer.

## Why

Claude Code is excellent for day-to-day work, but long sessions can hit usage limits or need a different execution style. Codex for Claude Code gives you a focused split repo you can package, version, and publish separately while still reusing the proven Smelter runtime underneath.

## What you get

- A standalone repo shell for Codex-oriented distribution
- User-facing package and plugin metadata
- Claude Code compatible hooks and workflow assets
- A separate Git repository you can commit and publish independently

## Install

```bash
git clone https://github.com/yusang-park/codex-for-claude-code.git
cd codex-for-claude-code
```

## Quick start

```bash
codex run --preset feat "add dark mode"
codex run --preset qa "fix login error text"
codex run --preset tasker "plan onboarding flow"
```

## How it works

This repo is a thin standalone package around the workflow runtime, prompts, hooks, and assets needed to run Codex-style workflows in Claude Code. The split keeps distribution metadata and documentation user-focused while the linked runtime directories stay in sync with the source project.

## Requirements

- Node.js 20+
- Claude Code
- Git

## License

MIT
