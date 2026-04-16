---
name: cancel
description: Cancel active work — hard stop or queue redirect
---

# Cancel Skill

Stop active execution or queue a redirect for after current work finishes.

## Two Cancel Types

### 1. Hard Cancel (`/cancel`)

Immediately stops everything:

- Kills tracked background processes and subagents
- Clears legacy / auto-confirm state files
- Writes a cancel signal that **blocks all tool execution**
- Stop hook allows clean exit (no continuation payload dropped)
- Signal auto-cleared on next user prompt

```bash
/cancel
```

**What happens:**
1. `cancel-propagator` kills active PIDs, clears legacy state
2. `cancel-signal.json` written with `type: "hard"`
3. `pre-tool-enforcer` reads signal → blocks every tool call with `decision: "block"`
4. `auto-confirm` reads signal → allows stop (no continuation)
5. Next `UserPromptSubmit` → signal auto-cleared, fresh start

### 2. Queue Cancel (`/queue <intent>`)

Lets current work finish, then redirects to new intent:

- Does NOT kill processes or interrupt current work
- Writes a queue signal with the new intent
- `pre-tool-enforcer` injects "[QUEUED REDIRECT]" reminder on each tool call
- When Claude stops, `auto-confirm` injects the queued intent as continuation
- Signal consumed after use

```bash
/queue fix the login bug
/queue run the test suite and report failures
```

**What happens:**
1. `cancel-signal.json` written with `type: "queue"` + `queued_intent`
2. Current work continues normally
3. Each tool call shows "[QUEUED REDIRECT] After current step, switch to: ..."
4. When Claude finishes current work and tries to stop:
   - `auto-confirm` reads queue signal
   - Injects queued intent as continuation prompt
   - Signal consumed (one-shot)

## Signal File

Location: `{project}/.smt/state/cancel-signal.json`

```json
{
  "type": "hard",
  "timestamp": 1713000000000,
  "reason": "user /cancel command",
  "source": "propagator"
}
```

```json
{
  "type": "queue",
  "timestamp": 1713000000000,
  "reason": "user /queue command",
  "source": "propagator",
  "queued_intent": "fix the login bug"
}
```

Auto-expires after 5 minutes to prevent stale signals from blocking future sessions.

## Auto-Detection Keywords

The keyword-detector recognizes:
- `/cancel` — hard cancel
- `/queue <intent>` — queue redirect

## Hook Integration

| Hook | Hard Cancel | Queue Cancel |
|------|------------|--------------|
| `UserPromptSubmit` (keyword-detector) | Write signal + kill processes | Write signal with intent |
| `PreToolUse` (pre-tool-enforcer) | Block all tools | Inject redirect reminder |
| `Stop` (auto-confirm) | Allow stop | Inject queued intent as continuation |
| `UserPromptSubmit` (next prompt) | Clear signal | Clear signal |

## Examples

```
# Working on feature X, want to stop everything
/cancel
→ "All work stopped. Awaiting new instructions."

# Working on feature X, but want to fix a bug after current step
/queue fix the CSS overflow on mobile nav
→ Current work continues
→ When done: "Now executing queued intent: fix the CSS overflow on mobile nav"

# Working on feature X, realized you need tests first
/queue write unit tests for the auth module before continuing
→ Current work finishes current tool call
→ Redirects to writing tests
```
