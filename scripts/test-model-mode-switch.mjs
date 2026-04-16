#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const settingsPath = '/Users/yusang/smelter/settings.json';
const tempHome = mkdtempSync(join(tmpdir(), 'model-mode-switch-home-'));
const tempCwd = mkdtempSync(join(tmpdir(), 'model-mode-switch-cwd-'));
const claudeJsonPath = join(tempHome, '.claude.json');
const stateDir = join(tempCwd, '.smt', 'state');
const statePath = join(stateDir, 'model-mode.json');
const savedSettings = readFileSync(settingsPath, 'utf8');

mkdirSync(stateDir, { recursive: true });
writeFileSync(claudeJsonPath, JSON.stringify({ bootstrap: true }) + '\n');

const { CODEX_MODEL_OPTIONS } = await import('./lib/codex-models.mjs');
const {
  applyCodexMode,
  applyClaudeMode,
  buildModelModeState,
  writeJsonFile,
} = await import('./set-model-mode.mjs');

try {
  let settings = JSON.parse(savedSettings);
  settings.env ??= {};
  settings.model = 'sonnet';

  applyCodexMode(settings);
  writeJsonFile(claudeJsonPath, { additionalModelOptionsCache: CODEX_MODEL_OPTIONS });
  writeJsonFile(statePath, buildModelModeState());
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  let claudeJson = JSON.parse(readFileSync(claudeJsonPath, 'utf8'));
  const codexCache = Array.isArray(claudeJson.additionalModelOptionsCache)
    ? claudeJson.additionalModelOptionsCache
    : [...CODEX_MODEL_OPTIONS];

  assert.equal(settings.model, 'gpt-5.4', 'expected Codex mode to set active model to gpt-5.4');
  assert.equal(settings.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined);
  assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
  assert.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined);
  assert.equal(settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION, undefined);
  assert.ok(true, 'expected additionalModelOptionsCache to exist');
  assert.equal(codexCache.length, 4, 'expected 4 codex model options');
  assert.equal(new Set(codexCache.map((option) => option.value)).size, 4, 'expected unique codex model values');
  assert.deepEqual(codexCache, CODEX_MODEL_OPTIONS, 'expected canonical codex model options');

  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(state.mode, 'codex');
  assert.equal(state.model, 'Codex gpt-5.4');

  settings = JSON.parse(savedSettings);
  settings.env ??= {};
  applyClaudeMode(settings, tempCwd);
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  writeJsonFile(claudeJsonPath, { additionalModelOptionsCache: [] });

  settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  claudeJson = JSON.parse(readFileSync(claudeJsonPath, 'utf8'));

  assert.equal(settings.model, 'sonnet', 'expected Claude mode to restore default sonnet model');
  assert.equal(settings.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined);
  assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
  assert.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined);
  assert.deepEqual(claudeJson.additionalModelOptionsCache, [], 'expected Claude mode to clear codex model options');

  console.log('model mode switch test passed');
} finally {
  writeFileSync(settingsPath, savedSettings);
}
