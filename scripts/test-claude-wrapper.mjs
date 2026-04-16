#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const wrapper = '/Users/yusang/smelter/scripts/claude-wrapper.mjs';
const SETTINGS_PATH = '/Users/yusang/smelter/settings.json';
const tempHome = mkdtempSync(join(tmpdir(), 'claude-wrapper-home-'));
const versionsDir = join(tempHome, '.local', 'share', 'claude', 'versions');
mkdirSync(versionsDir, { recursive: true });
const fakeClaudeBinary = join(versionsDir, '1.0.0');
writeFileSync(fakeClaudeBinary, '#!/bin/sh\nexit 0\n');
chmodSync(fakeClaudeBinary, 0o755);

// Save state before tests so we can restore after
const savedSettings = readFileSync(SETTINGS_PATH, 'utf8');

function run(args) {
  return JSON.parse(
    execFileSync('node', [wrapper, ...args], {
      env: {
        ...process.env,
        HOME: tempHome,
        SMELTER_WRAPPER_TEST: '1',
      },
      encoding: 'utf8',
    }),
  );
}

// Reset to a clean claude-alias state before each codex test so model defaulting is deterministic
function resetModelToSonnet() {
  const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
  settings.model = 'sonnet';
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}

resetModelToSonnet();
const codex = run(['--codex', '--version']);
assert.equal(codex.mode, 'codex');
assert.deepEqual(codex.passthrough, ['--version']);
// ANTHROPIC_BASE_URL must NOT be in settings.json — it's only injected into child process env
assert.equal(codex.settings.env.ANTHROPIC_BASE_URL, undefined);
// CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set only in wrapper's child process env, not in settings.json
// (setting it in settings.json blocks rate_limits/context_window from HUD stdin)
// Coming from 'sonnet' alias → should default to gpt-5.4
assert.equal(codex.settings.model, 'gpt-5.4');
// Slots 1-4 must NOT be redirected to gpt models
assert.equal(codex.settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined);
assert.equal(codex.settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);

// Re-entering codex mode always resets to the default Codex model.
const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
settings.model = 'gpt-5.4-mini';
writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
const codexPreserve = run(['--codex', '--version']);
assert.equal(codexPreserve.settings.model, 'gpt-5.4', 'codex mode should reset to the default model');

// Full claude model IDs are also replaced with the default Codex model.
const settings2 = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
settings2.model = 'claude-opus-4-6';
writeFileSync(SETTINGS_PATH, JSON.stringify(settings2, null, 2) + '\n');
const codexPreserveClaude = run(['--codex', '--version']);
assert.equal(codexPreserveClaude.settings.model, 'gpt-5.4', 'full claude model ID should be replaced by the default codex model');

resetModelToSonnet();
const plain = run(['--version']);
assert.equal(plain.mode, 'claude');
assert.deepEqual(plain.passthrough, ['--version']);
assert.equal(plain.settings.env.ANTHROPIC_BASE_URL, undefined);
assert.equal(plain.settings.model, 'sonnet');

const forcedClaude = run(['--codex', '--claude', '--version']);
assert.equal(forcedClaude.mode, 'claude');
assert.deepEqual(forcedClaude.passthrough, ['--version']);
assert.equal(forcedClaude.settings.env.ANTHROPIC_BASE_URL, undefined);

// Restore original state so tests don't leave system in wrong mode
writeFileSync(SETTINGS_PATH, savedSettings);

console.log('claude wrapper test passed');
