# codex-for-claude-code

<img width="903" height="724" alt="image" src="https://github.com/user-attachments/assets/4c873064-7f3d-4d55-9308-1a264c7aba75" />

> Run **[Claude Code](https://claude.ai/code)** against **ChatGPT Codex** using your existing Codex CLI subscription.

> [!IMPORTANT]
> If you hit a **401** error, just launch the Codex CLI once (`codex`) to refresh the OAuth token, then rerun `claude-codex`.

---

## Install

Requires Node.js ≥ 20, [Claude Code](https://claude.ai/code), and a logged-in [Codex CLI](https://github.com/openai/codex) (`codex login`).

```bash
npm install -g codex-for-claude-code
```

## How to run

```bash
claude-codex                      # launch Claude Code in Codex mode
claude-codex --resume my-session  # any extra args forward to `claude`
```

---

## How it works

```
Claude Code TUI  ──►  codex-proxy :3099  ──►  chatgpt.com/backend-api/codex
                                (translates Anthropic ↔ Responses API,
                                 auth: Codex OAuth from ~/.codex/auth.json)
```

On each launch `claude-codex`:

1. Reads `~/.codex/auth.json` for your Codex OAuth token.
2. Starts the local proxy on `127.0.0.1:3099` (if not already running).
3. Uses the normal Claude config dir `~/.claude`, so session history and `--resume` are shared with plain `claude`.
4. Injects Codex model options into a cwd-scoped file `~/.claude/.claude-<sha8(NFC(cwd))>.json`, keeping the model picker isolated without splitting session history.
5. Spawns `claude` with `ANTHROPIC_BASE_URL=http://127.0.0.1:3099` and `CLAUDE_CONFIG_DIR=~/.claude`.

Claude model IDs (`claude-*`, `opus`, `sonnet`, `haiku`) pass through unchanged to `api.anthropic.com`. Only Codex IDs hit ChatGPT.

---

## Troubleshooting

**401 Unauthorized from ChatGPT backend**
OAuth token expired. Run `codex` once to refresh, then rerun `claude-codex`.

**`No Codex auth: login via \`codex\` CLI`**
Run `codex login`. Verify `~/.codex/auth.json` contains `tokens.access_token`.

**`Could not find Claude Code binary`**
Install Claude Code, or set `CLAUDE_CODEX_CLAUDE_BIN=/path/to/claude`.

**Model picker shows only Claude models**
Quit the TUI and relaunch `claude-codex`.

**`claude-codex --resume` cannot see my plain Claude sessions**
Update to a build that uses the shared `~/.claude` config dir. Current releases share sessions and isolate only the model cache.

**Port 3099 in use**
`pkill -f codex-proxy.mjs` or set `CODEX_PROXY_PORT=3199`.

**Requests hang / 502**
`curl http://127.0.0.1:3099/health`. Next `claude-codex` run auto-restarts on version mismatch.

---

MIT © Yusang Park
