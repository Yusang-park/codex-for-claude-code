#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CODEX_MODEL_OPTIONS, DEFAULT_CODEX_MODEL, getCodexModelLabel } from './lib/codex-models.mjs';

const settingsPath = process.env.CLAUDE_CODEX_SETTINGS_PATH
  ?? join(homedir(), '.claude', 'settings.json');
const defaultStateDir = join(process.cwd(), '.smt', 'state');
const statePath = join(defaultStateDir, 'model-mode.json');
const claudeJsonPath = join(homedir(), '.claude.json');

// Codex mode shares the regular Claude config dir (~/.claude) so session
// history and `--resume` stay interoperable with plain `claude`.
// Model-picker state is isolated by writing Codex options to a cwd-scoped
// `.claude-<sha8(NFC(cwd))>.json` file inside that shared dir.
const SHARED_LINKS = ['settings.json', 'agents', 'commands', 'hooks', 'plugins'];

function buildScopedConfigHash(cwd = process.cwd()) {
  return createHash('sha256').update(String(cwd).normalize('NFC')).digest('hex').slice(0, 8);
}

export function getCodexConfigDir(home = homedir()) {
  return join(home, '.claude');
}

export function getCodexClaudeJsonPath(cwd = process.cwd(), home = homedir()) {
  return join(getCodexConfigDir(home), `.claude-${buildScopedConfigHash(cwd)}.json`);
}

export function ensureCodexConfigDir(home = homedir()) {
  const src = join(home, '.claude');
  const dst = getCodexConfigDir(home);
  mkdirSync(dst, { recursive: true });
  for (const name of SHARED_LINKS) {
    const link = join(dst, name);
    const target = join(src, name);
    if (existsSync(link)) continue;
    if (!existsSync(target)) continue;
    try { symlinkSync(target, link); } catch { /* race / permission — skip */ }
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
    // Ensure parent dir exists (codex-scoped path lives inside ~/.claude/
    // which may not exist yet on a fresh install or in tests).
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

export function getModelModeStatePath(cwd = process.cwd()) {
  return join(cwd, '.smt', 'state', 'model-mode.json');
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
  // Don't create the file if it doesn't exist — clearing a non-existent cache
  // is a no-op, not an invitation to materialize an empty config.
  if (!existsSync(filePath)) return;
  patchClaudeJson([], filePath);
}

export function ensureStateDir(dirPath = defaultStateDir) {
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

export function applyCodexMode(settings) {
  const current = settings.model ?? '';
  const activeModel = resolveCodexDefaultModel(current);
  // settings.json is shared with plain `claude` sessions; never persist a
  // Codex model ID here or plain claude will boot with gpt-* and 401.
  // Codex model-picker state lives in ~/.claude/.claude-<hash>.json while
  // sessions keep using the shared ~/.claude config dir.
  delete settings.model;
  delete settings.modelOverrides;
  delete settings.availableModels;
  stripModelEnv(settings);
  delete settings.env.ANTHROPIC_BASE_URL;
  ensureCodexConfigDir();
  // Write codex options to the cwd-scoped file, NOT the global ~/.claude.json.
  // The wrapper points Claude Code at ~/.claude so sessions stay shared; the
  // binary resolves the scoped .claude-<hash>.json file for model cache.
  setModelCache(CODEX_MODEL_OPTIONS, getCodexClaudeJsonPath(process.cwd()));
  ensureStateDir(defaultStateDir);
  writeJsonFile(statePath, buildModelModeState(activeModel));
  return activeModel;
}

export function applyClaudeMode(settings, cwd = process.cwd()) {
  // Mirror codex-mode: never persist a model here. Plain `claude` picks its
  // own default; leaving a stale value lets modes cross-contaminate.
  delete settings.model;
  delete settings.modelOverrides;
  delete settings.env.ANTHROPIC_BASE_URL;
  delete settings.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  stripModelEnv(settings);
  removeIfExists(statePath);
  // One-time migration: zero the global cache in case a prior (pre-isolation)
  // codex run left options there. New codex runs no longer write to it.
  // Do NOT touch the codex-scoped file — a concurrent codex window may be
  // running and re-reading it. Plain Claude uses the shared session dir and
  // the non-scoped cache path only.
  clearModelCache();
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

export function setModelMode(mode, cwd) {
  if (!['codex', 'claude'].includes(mode)) {
    throw new Error('Usage: set-model-mode.mjs <codex|claude>');
  }

  const settings = readSettings();
  settings.env ??= {};

  if (mode === 'codex') {
    applyCodexMode(settings);
  } else {
    applyClaudeMode(settings, cwd ?? process.cwd());
  }

  writeSettings(settings);
  return settings;
}

export const CODEX_PROXY_PORT = parseInt(process.env.CODEX_PROXY_PORT ?? '3099', 10);

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  try {
    const mode = process.argv[2];
    setModelMode(mode);
    console.log(`model mode set to ${mode}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
