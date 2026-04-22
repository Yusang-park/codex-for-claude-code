# codex-for-claude-code

> Run **[Claude Code](https://claude.ai/code)** against **ChatGPT Codex** using your existing Codex CLI subscription.

A local proxy translates Anthropic Messages API ↔ ChatGPT Responses API so the Claude Code TUI you already know talks to `gpt-5.4`, `gpt-5.3`, and other Codex models — **without an Anthropic API key, using your ChatGPT Plus/Pro billing**.

```
┌──────────────────────┐     ┌──────────────────┐     ┌────────────────────┐
│  Claude Code TUI     │ ──► │ codex-proxy :3099│ ──► │ chatgpt.com/codex  │
│  (unchanged UX)      │ ◄── │ Anthropic ⇄ OAI  │ ◄── │ OAuth from codex   │
└──────────────────────┘     └──────────────────┘     └────────────────────┘
```

---

## Why

- You have a ChatGPT Plus/Pro subscription already.
- You love Claude Code's TUI.
- You don't want to pay for an Anthropic API key just to keep using Claude Code.

Use your Codex CLI OAuth token → route Claude Code through ChatGPT's backend.

---

## Requirements

| Tool | How to get it |
|------|---------------|
| Node.js ≥ 20 | `brew install node` |
| Claude Code | <https://claude.ai/code> (binary on PATH or under `~/.local/share/claude/versions/`) |
| Codex CLI logged in | `npm i -g @openai/codex && codex login` (must produce `~/.codex/auth.json` with `tokens.access_token`) |

---

## Install

```bash
npm install -g codex-for-claude-code
```

Or from source:

```bash
git clone https://github.com/Yusang-park/codex-for-claude-code.git
cd codex-for-claude-code && npm link
```

---

## Usage

```bash
claude-codex                      # launch Claude Code in Codex mode
claude-codex --resume my-session  # any extra args forward to `claude`
```

That's it. The wrapper auto-starts the proxy, injects the proper env vars, and spawns Claude Code. The TUI looks identical — just pick a Codex model from the model picker. For plain Anthropic-backed Claude Code, run `claude` directly — this wrapper doesn't touch that path.

---

## How it works

On each launch `claude-codex` does 5 things:

1. Reads `~/.codex/auth.json` for your Codex OAuth token.
2. Ensures the proxy is running on `127.0.0.1:3099` (spawns detached if not).
3. Injects Codex model options into a **scoped** config (`~/.claude/.claude-<hash>.json`) so the Claude Code model picker shows `gpt-5.4`, `gpt-5.3`, … without polluting your plain `claude` sessions.
4. Cleans conflicting `ANTHROPIC_*` env keys from `~/.claude/settings.json`.
5. Spawns `claude` with:
   - `ANTHROPIC_BASE_URL=http://127.0.0.1:3099` (route API through proxy)
   - `CLAUDE_CONFIG_DIR=~/.claude` (isolate state from plain `claude`)

### Request path

```
Claude Code
   │  POST /v1/messages {model: "gpt-5.4", ...}     (Anthropic format)
   ▼
codex-proxy
   │  translate → POST /responses (Responses API, OpenAI format)
   │  Authorization: Bearer <codex OAuth access_token>
   │  ChatGPT-Account-ID: <from auth.json>
   ▼
chatgpt.com/backend-api/codex/responses
   │  SSE stream of output_text.delta / function_call / ...
   ▼
codex-proxy
   │  translate back → Anthropic SSE (message_start / content_block_delta / ...)
   ▼
Claude Code TUI
```

Claude model IDs (`claude-*`, `opus`, `sonnet`, `haiku`) **pass through unchanged** to `api.anthropic.com` — you can mix and match from the picker at runtime.

---

## Environment variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `CODEX_PROXY_PORT` | Proxy listen port | `3099` |
| `CHATGPT_API_BASE` | Codex backend URL | `https://chatgpt.com/backend-api/codex` |
| `CLAUDE_CODEX_CLAUDE_BIN` | Override Claude Code binary path | auto-detect |
| `CLAUDE_CODEX_SETTINGS_PATH` | Override settings.json path | `~/.claude/settings.json` |

---

## Troubleshooting

**`No Codex auth: login via \`codex\` CLI`**
Run `codex login`. Verify `~/.codex/auth.json` contains `tokens.access_token`.

**`Could not find Claude Code binary`**
Install Claude Code from <https://claude.ai/code>, or set `CLAUDE_CODEX_CLAUDE_BIN=/path/to/claude`.

**Model picker shows only Claude models**
Quit the TUI and relaunch `claude-codex`. The scoped config is written on launch.

**Port 3099 in use**
Kill the stale proxy (`pkill -f codex-proxy.mjs`) and relaunch, or set `CODEX_PROXY_PORT=3199`.

**Requests hang / 502**
Check proxy health: `curl http://127.0.0.1:3099/health`. If `version` mismatches, the next `claude-codex` run auto-restarts it.

---

## Compared to LiteLLM / other proxies

|  | codex-for-claude-code | LiteLLM | generic Anthropic↔OpenAI proxy |
|--|--|--|--|
| Billing | **ChatGPT subscription** (Codex OAuth) | per-token API key | per-token API key |
| Scope | Claude Code ↔ Codex, one job | 100+ providers, gateway/router | generic translator |
| Setup | `npm link` + `codex login` | config YAML, keys, server | server + keys |
| Model picker injection | yes (scoped, isolated) | no | no |

Use LiteLLM if you have API keys and need a routing layer. Use this if you already pay for ChatGPT and just want Claude Code to hit Codex.

---

## ⚠️ Caveats

- **Unofficial endpoint.** `chatgpt.com/backend-api/codex` is the endpoint Codex CLI itself uses. It is not a public API. OpenAI can change or block it at any time — use at your own risk.
- **ToS.** Using ChatGPT subscriptions to power a non-official client may fall outside OpenAI's terms. Check current ToS before relying on it.
- **No Anthropic billing.** Requests to Codex models do **not** touch Anthropic. Claude model IDs still do (normal billing).

---

## Uninstall

```bash
npm uninstall -g codex-for-claude-code
pkill -f codex-proxy.mjs
```

Your `~/.claude/settings.json` is left intact (only `ANTHROPIC_*` env noise and `modelOverrides` are stripped on each run). The scoped cache file `~/.claude/.claude-<hash>.json` can be deleted safely.

---

## Development

```bash
git clone https://github.com/Yusang-park/codex-for-claude-code.git
cd codex-for-claude-code
npm test            # smoke test: wrapper arg parsing + proxy module load
node bin/claude-codex.mjs --version   # end-to-end sanity
```

Zero runtime dependencies — pure Node built-ins.

---

## License

MIT © Yusang Park
