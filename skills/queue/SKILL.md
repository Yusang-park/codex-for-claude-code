---
name: queue
description: Queue a new intent to execute after current work finishes — soft redirect without interrupting
---

# Queue Skill

Queue a new intent without interrupting current work. When the current task finishes, Claude switches to the queued intent instead of continuing the old plan.

## Usage

```bash
/queue <what to do next>
```

## Examples

```bash
/queue fix the CSS overflow on mobile nav
/queue write unit tests for the auth module
/queue run the test suite and report failures
```

## How It Works

1. Writes `cancel-signal.json` with `type: "queue"` + your intent
2. Current work continues normally
3. Every tool call shows `[QUEUED REDIRECT]` reminder
4. When Claude finishes and tries to stop, the Stop hook injects your queued intent as the next task
5. Signal consumed after use (one-shot)

## Related

- `/cancel` — hard stop, kills everything immediately
- Escape/Ctrl+C — auto-detected, next prompt gets `[INTERRUPTED]` signal
