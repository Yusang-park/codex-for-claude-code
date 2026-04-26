#!/usr/bin/env node
// Tests for codex-proxy.mjs CODEX_MODEL_CONTEXT_WINDOWS — verifies gpt-5.5
// is registered with a positive integer context-window so the HUD usage %
// payload (used_percentage / context_window_size) renders for the new model.
//
// CODEX_MODEL_CONTEXT_WINDOWS is a module-internal const, not exported.
// We deliberately avoid widening the proxy public surface for testing.
// Instead, read the source file and assert the literal entry is present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const proxySrc = readFileSync(join(here, 'codex-proxy.mjs'), 'utf8');

function parseContextWindowEntry(modelId) {
  const block = proxySrc.match(/CODEX_MODEL_CONTEXT_WINDOWS\s*=\s*\{([\s\S]*?)\}/);
  if (!block) return null;
  const escaped = modelId.replace(/[.]/g, '\\.');
  const re = new RegExp(`['"]${escaped}['"]\\s*:\\s*([\\d_]+)`);
  const m = block[1].match(re);
  if (!m) return null;
  return Number(m[1].replace(/_/g, ''));
}

// --- happy path ---

test('happy: CODEX_MODEL_CONTEXT_WINDOWS includes a gpt-5.5 entry', () => {
  const value = parseContextWindowEntry('gpt-5.5');
  assert.ok(value !== null, 'gpt-5.5 key must be present in CODEX_MODEL_CONTEXT_WINDOWS');
});

// --- boundary ---

test('boundary: gpt-5.5 context-window value is a positive integer', () => {
  const value = parseContextWindowEntry('gpt-5.5');
  assert.ok(Number.isFinite(value) && value > 0, `gpt-5.5 context window must be positive integer, got ${value}`);
});

// --- error path / no regression ---

test('error: gpt-5.4 entry remains registered (no regression in existing model)', () => {
  const value = parseContextWindowEntry('gpt-5.4');
  assert.ok(value !== null, 'gpt-5.4 must remain registered after gpt-5.5 is added');
  assert.ok(Number.isFinite(value) && value > 0, 'gpt-5.4 context window must remain a positive integer');
});

// --- edge case ---

test('edge: gpt-5.5 context window is at flagship scale (>= 100k tokens)', () => {
  const value = parseContextWindowEntry('gpt-5.5');
  assert.ok(value >= 100_000, `expected gpt-5.5 context window >= 100k tokens, got ${value}`);
});
