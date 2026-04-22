#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CODEX_MODEL_OPTIONS, DEFAULT_CODEX_MODEL, getCodexModelLabel } from './lib/codex-models.mjs';

const settingsPath = process.env.CLAUDE_CODEX_SETTINGS_PATH
  ?? join(homedir(), '.claude', 'settings.json');
const defaultStateDir = join(process.cwd(), '.smt', 'state');
const statePath = join(defaultStateDir, 'model-mode.json');
const claudeJsonPath = join(homedir(), '.claude.json');

// Codex mode uses a scoped config file inside ~/.claude/ so it cannot bleed
// into plain `claude` windows that read ~/.claude.json. Claude Code (v2.1+)
// resolves its state file as `<CLAUDE_CONFIG_DIR>/.claude.json`. Earlier
// versions used a sha256-hashed filename; that path is no longer read.
export function getCodexConfigDir(home = homedir()) {
  return join(home, '.claude');
}

export function getCodexClaudeJsonPath(configDir = getCodexConfigDir()) {
  return join(configDir, '.claude.json');
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
  delete settings.modelOverrides;
  delete settings.availableModels;
  stripModelEnv(settings);
  delete settings.env.ANTHROPIC_BASE_URL;
  // Write codex options to the scoped config file, NOT the global ~/.claude.json.
  // The wrapper injects CLAUDE_CONFIG_DIR into the codex child so Claude Code
  // reads this scoped file instead. Plain `claude` windows (no CLAUDE_CONFIG_DIR)
  // read ~/.claude.json and stay untouched → concurrent-safe isolation.
  setModelCache(CODEX_MODEL_OPTIONS, getCodexClaudeJsonPath());
  ensureStateDir(defaultStateDir);
  writeJsonFile(statePath, buildModelModeState(activeModel));
  return activeModel;
}

export function applyClaudeMode(settings, cwd = process.cwd()) {
  delete settings.modelOverrides;
  delete settings.env.ANTHROPIC_BASE_URL;
  delete settings.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  stripModelEnv(settings);
  removeIfExists(statePath);
  // One-time migration: zero the global cache in case a prior (pre-isolation)
  // codex run left options there. New codex runs no longer write to it.
  // Do NOT touch the codex-scoped file — a concurrent codex window may be
  // running and re-reading it. Claude mode reads the global file only.
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
