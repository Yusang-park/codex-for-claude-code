#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { CODEX_MODEL_OPTIONS, DEFAULT_CODEX_MODEL, getCodexModelLabel } from './lib/codex-models.mjs';

const settingsPath = process.env.CLAUDE_CODEX_SETTINGS_PATH
  ?? join(homedir(), '.claude', 'settings.json');
const claudeJsonPath = join(homedir(), '.claude.json');

// Codex mode uses an isolated CLAUDE_CONFIG_DIR (~/.claude-codex) so codex
// model options stay separate from plain `claude` sessions that read
// ~/.claude/.claude.json. Claude Code v2.1+ resolves its state file as
// `${CLAUDE_CONFIG_DIR}/.claude.json` (non-hashed); writing to a hashed
// sidecar leaves additionalModelOptionsCache invisible to the model picker.
// Shared Claude assets (settings, agents, commands, hooks, plugins, skills)
// are symlinked into the codex dir so users keep a single source of truth.
const SHARED_LINKS = ['settings.json', 'agents', 'commands', 'hooks', 'plugins', 'skills', 'CLAUDE.md', 'plugin.json'];

// Inlined from scripts/auto-confirm.mjs:65-67 to keep codex-for-claude-code
// standalone (no cross-package import). Contract: matches regex there exactly
// — any change to either copy requires coordinated update of both.
export function sanitizeSessionId(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return '';
  return /^[A-Za-z0-9_-]+$/.test(sessionId) ? sessionId : '';
}

export function getCodexConfigDir(home = homedir()) {
  return join(home, '.claude-codex');
}

export function getCodexClaudeJsonPath(home = homedir()) {
  return join(getCodexConfigDir(home), '.claude.json');
}

// Slots that fall back to the codex/Smelter repo when ~/.claude/<name> is
// absent. Smelter's dev-install removes ~/.claude/skills + ~/.claude/agents
// (replaced with symlinks), and a pure npm install of codex-for-claude-code
// has no such dirs at all — without a repo fallback, codex windows would
// have empty skills/agents pickers.
const REPO_FALLBACK_WHITELIST = new Set(['skills', 'agents']);

function deriveRepoRoot() {
  if (process.env.SMELTER_REPO_ROOT) return process.env.SMELTER_REPO_ROOT;
  // This file is at <repo>/codex-for-claude-code/scripts/. Walk up two
  // levels to land at the parent repo (Smelter root in dev install, or the
  // codex-for-claude-code package itself in npm install — neither has
  // skills/agents in the latter case, so the fallback is a silent miss).
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function ensureCodexConfigDir(home = homedir(), opts = {}) {
  const src = join(home, '.claude');
  const dst = getCodexConfigDir(home);
  mkdirSync(dst, { recursive: true });
  // Only enable repo fallback when the caller (production wrapper or
  // applyCodexMode) explicitly passes opts.repoRoot. Bare-call back-compat:
  // ensureCodexConfigDir(home) keeps the original "skip if target missing"
  // behavior — no auto-derived fallback that would surprise tests/callers.
  const repoRoot = Object.prototype.hasOwnProperty.call(opts, 'repoRoot')
    ? opts.repoRoot
    : null;

  for (const name of SHARED_LINKS) {
    const link = join(dst, name);
    const target = join(src, name);

    // Self-heal: detect existing entry. If it's a dangling symlink (lstat
    // sees it but existsSync resolves false), unlink so the slot can be
    // replaced. Live symlinks and real dirs/files are preserved (user
    // overrides + idempotency).
    let existingLstat = null;
    try { existingLstat = lstatSync(link); } catch { /* absent */ }
    if (existingLstat) {
      if (existingLstat.isSymbolicLink() && !existsSync(link)) {
        try { unlinkSync(link); } catch { continue; }
      } else {
        continue;
      }
    }

    let resolvedTarget = null;
    if (existsSync(target)) {
      resolvedTarget = target;
    } else if (REPO_FALLBACK_WHITELIST.has(name)) {
      const fallback = repoRoot ? join(repoRoot, name) : null;
      if (fallback && existsSync(fallback)) {
        resolvedTarget = fallback;
      } else {
        const reason = fallback
          ? `target missing at ${target} and fallback missing at ${fallback}`
          : `target missing at ${target} and no repoRoot fallback configured`;
        process.stderr.write(`[set-model-mode] warning: ${name} ${reason}\n`);
      }
    }

    if (resolvedTarget) {
      try { symlinkSync(resolvedTarget, link); } catch { /* race / permission — skip */ }
    }
  }
  return dst;
}

function patchClaudeJson(additionalModelOptionsCache, filePath = claudeJsonPath) {
  let data = {};
  try {
    if (existsSync(filePath)) {
      data = JSON.parse(readFileSync(filePath, 'utf8'));
    }
  } catch {
    data = {};
  }

  try {
    const dir = filePath.slice(0, filePath.lastIndexOf('/'));
    if (dir) mkdirSync(dir, { recursive: true });
    data.additionalModelOptionsCache = additionalModelOptionsCache;
    writeFileSync(filePath, JSON.stringify(data) + '\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[set-model-mode] warning: could not patch ${filePath}: ${message}\n`);
  }
}

export { patchClaudeJson };

export function getClaudeJsonPath(homeDir = homedir()) {
  return join(homeDir, '.claude.json');
}

// Session-scoped model-mode state path. `sessionId` is required and must pass
// `sanitizeSessionId`; otherwise throws (writers must never silently fall back
// to the unscoped path — that was the bug we fixed).
export function getModelModeStatePath(cwd, sessionId) {
  const sid = sanitizeSessionId(sessionId);
  if (!sid) {
    throw new Error(`[set-model-mode] getModelModeStatePath: sid required and must match /^[A-Za-z0-9_-]+$/, got: ${JSON.stringify(sessionId)}`);
  }
  return join(cwd, '.smt', 'state', `model-mode-${sid}.json`);
}

export function getDefaultStateDir(cwd = process.cwd()) {
  return join(cwd, '.smt', 'state');
}

export function isCodexModel(model = '') {
  return ['gpt-', 'o3', 'o4', 'codex'].some((prefix) => model.startsWith(prefix));
}

export function isFullClaudeModelId(model = '') {
  return /^claude-/i.test(model);
}

export function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

export function writeJsonFile(filePath, data) {
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

export function resolveCodexDefaultModel(currentModel = '') {
  return isCodexModel(currentModel) ? currentModel : DEFAULT_CODEX_MODEL;
}

export function buildModelModeState(model = DEFAULT_CODEX_MODEL) {
  return {
    mode: 'codex',
    model: getCodexModelLabel(model),
    updated_at: new Date().toISOString(),
  };
}

export function setModelCache(additionalModelOptionsCache, filePath = claudeJsonPath) {
  patchClaudeJson(additionalModelOptionsCache, filePath);
}

export function clearModelCache(filePath = claudeJsonPath) {
  if (!existsSync(filePath)) return;
  patchClaudeJson([], filePath);
}

const HASHED_SIDECAR_RE = /^\.claude-[0-9a-f]{8}\.json$/;

// Strip codex-only entries from additionalModelOptionsCache in any
// `${HOME}/.claude/.claude-<sha256(cwd)[0..8]>.json` per-cwd sidecar AND in
// `${HOME}/.claude.json`. Claude Code v2.1+ persists the picker cache in
// these locations independent of CLAUDE_CONFIG_DIR, so codex-mode entries
// leak into plain `claude` runs unless we scrub explicitly. Files lacking
// `additionalModelOptionsCache`, malformed JSON, or non-codex entries are
// preserved.
export function scrubGlobalCodexCaches(home = homedir()) {
  const claudeDir = join(home, '.claude');
  const claudeJsonTop = join(home, '.claude.json');

  const filesToCheck = [];
  if (existsSync(claudeDir)) {
    let entries;
    try { entries = readdirSync(claudeDir); } catch { entries = []; }
    for (const name of entries) {
      if (!HASHED_SIDECAR_RE.test(name)) continue;
      filesToCheck.push(join(claudeDir, name));
    }
  }
  if (existsSync(claudeJsonTop)) filesToCheck.push(claudeJsonTop);

  for (const filePath of filesToCheck) {
    let raw;
    try { raw = readFileSync(filePath, 'utf8'); } catch { continue; }
    let data;
    try { data = JSON.parse(raw); } catch { continue; }
    if (!data || typeof data !== 'object') continue;
    const cache = data.additionalModelOptionsCache;
    if (!Array.isArray(cache)) continue;

    const filtered = cache.filter((entry) => {
      const value = entry && typeof entry === 'object' ? String(entry.value ?? '') : '';
      return !isCodexModel(value);
    });
    if (filtered.length === cache.length) continue;

    data.additionalModelOptionsCache = filtered;
    try {
      writeFileSync(filePath, JSON.stringify(data) + '\n');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[set-model-mode] warning: could not scrub ${filePath}: ${message}\n`);
    }
  }
}

export function ensureStateDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
}

export function removeIfExists(filePath) {
  if (existsSync(filePath)) rmSync(filePath, { force: true });
}

export function stripModelEnv(settings) {
  for (const k of Object.keys(settings.env)) {
    if (/^ANTHROPIC_(DEFAULT_(OPUS|SONNET|HAIKU)_MODEL|CUSTOM_MODEL_OPTION)/.test(k)) {
      delete settings.env[k];
    }
  }
}

// Prune `model-mode-*.json` files under stateDir whose mtime exceeds maxAgeMs.
// Always preserves the file for `currentSid` (if any). Swallows ENOENT on
// concurrent-prune races. Intended to be called from the wrapper BEFORE it
// writes its own scoped file.
export function sweepStaleModelModeStates(stateDir, currentSid, maxAgeMs) {
  if (!existsSync(stateDir)) return;
  const currentName = currentSid ? `model-mode-${currentSid}.json` : null;
  const cutoff = Date.now() - maxAgeMs;
  let entries;
  try { entries = readdirSync(stateDir); } catch { return; }
  for (const name of entries) {
    if (!/^model-mode-.*\.json$/.test(name)) continue;
    if (name === currentName) continue;
    const p = join(stateDir, name);
    try {
      const s = statSync(p);
      if (s.mtimeMs < cutoff) {
        try { unlinkSync(p); } catch { /* ENOENT or concurrent-prune — ignore */ }
      }
    } catch { /* stat failed — skip */ }
  }
}

// One-time legacy-file disposition. Pre-scoping versions wrote
// `.smt/state/model-mode.json` (unscoped). No updated reader opens this path;
// delete it on wrapper start to close the partial-rollback resurrection window.
export function unlinkLegacyModelModeState(stateDir) {
  const legacy = join(stateDir, 'model-mode.json');
  try { unlinkSync(legacy); } catch { /* ENOENT — already gone */ }
}

export function applyCodexMode(settings, sessionId) {
  const current = settings.model ?? '';
  const activeModel = resolveCodexDefaultModel(current);
  delete settings.model;
  delete settings.modelOverrides;
  delete settings.availableModels;
  stripModelEnv(settings);
  delete settings.env.ANTHROPIC_BASE_URL;
  // Pass derived repoRoot so applyCodexMode resolves skills/agents fallback
  // when ~/.claude/skills (etc.) is missing in the user's install.
  ensureCodexConfigDir(homedir(), { repoRoot: deriveRepoRoot() });
  // Strip codex entries from the per-cwd hashed sidecars in ~/.claude/.
  // Claude Code writes those sidecars independently of CLAUDE_CONFIG_DIR,
  // so without this scrub plain `claude` reads codex models as defaults.
  scrubGlobalCodexCaches();
  setModelCache(CODEX_MODEL_OPTIONS, getCodexClaudeJsonPath());
  const stateDir = getDefaultStateDir();
  ensureStateDir(stateDir);
  const statePath = getModelModeStatePath(process.cwd(), sessionId);
  writeJsonFile(statePath, buildModelModeState(activeModel));
  return activeModel;
}

export function applyClaudeMode(settings, cwd = process.cwd(), sessionId) {
  delete settings.model;
  delete settings.modelOverrides;
  delete settings.env.ANTHROPIC_BASE_URL;
  delete settings.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  stripModelEnv(settings);
  // Only remove the scoped file when a valid sid is available. Without one
  // there is nothing specific to this session to clear, and we do not touch
  // other sessions' files.
  const sid = sanitizeSessionId(sessionId);
  if (sid) {
    removeIfExists(getModelModeStatePath(cwd, sid));
  }
  clearModelCache();
  scrubGlobalCodexCaches();
  removeIfExists(join(cwd, '.smt', 'state', 'codex-state.json'));
}

export function readSettings() {
  if (!existsSync(settingsPath)) return {};
  try { return readJsonFile(settingsPath); } catch { return {}; }
}

export function writeSettings(settings) {
  mkdirSync(join(settingsPath, '..'), { recursive: true });
  writeJsonFile(settingsPath, settings);
}

export function setModelMode(mode, cwd, sessionId) {
  if (!['codex', 'claude'].includes(mode)) {
    throw new Error('Usage: set-model-mode.mjs <codex|claude>');
  }

  const settings = readSettings();
  settings.env ??= {};

  if (mode === 'codex') {
    applyCodexMode(settings, sessionId);
  } else {
    applyClaudeMode(settings, cwd ?? process.cwd(), sessionId);
  }

  writeSettings(settings);
  return settings;
}

export const CODEX_PROXY_PORT = parseInt(process.env.CODEX_PROXY_PORT ?? '3099', 10);

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  try {
    const mode = process.argv[2];
    // CLI entry mirrors claude-wrapper.mjs sid lifecycle: honor an inbound
    // SMELTER_SESSION_ID (sanitized) or coin a fresh UUID. Without this
    // fallback, direct `node set-model-mode.mjs codex` invocations throw in
    // getModelModeStatePath's positive guard.
    const sid = sanitizeSessionId(process.env.SMELTER_SESSION_ID) || randomUUID();
    setModelMode(mode, process.cwd(), sid);
    console.log(`model mode set to ${mode}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
