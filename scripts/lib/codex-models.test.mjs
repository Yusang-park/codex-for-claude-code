#!/usr/bin/env node
// Tests for codex-models.mjs — verifies gpt-5.5 model registration and that
// the new default (gpt-5.5) is at index 0 (no silent regression to gpt-5.4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_MODEL_OPTIONS, DEFAULT_CODEX_MODEL, getCodexModelLabel } from './codex-models.mjs';

// --- happy path ---

test('happy: gpt-5.5 entry is registered in CODEX_MODEL_OPTIONS', () => {
  const entry = CODEX_MODEL_OPTIONS.find((o) => o.value === 'gpt-5.5');
  assert.ok(entry, 'gpt-5.5 entry must exist in CODEX_MODEL_OPTIONS');
});

test('happy: gpt-5.5 entry has the canonical label "Codex gpt-5.5"', () => {
  const entry = CODEX_MODEL_OPTIONS.find((o) => o.value === 'gpt-5.5');
  assert.ok(entry, 'gpt-5.5 entry required for this assertion');
  assert.equal(entry.label, 'Codex gpt-5.5');
});

// --- boundary ---

test('boundary: CODEX_MODEL_OPTIONS contains exactly 5 entries after gpt-5.5 added', () => {
  assert.equal(CODEX_MODEL_OPTIONS.length, 5, `expected 5 codex models after adding gpt-5.5, got ${CODEX_MODEL_OPTIONS.length}`);
});

test('boundary: gpt-5.5 sits at index 0 (DEFAULT slot); gpt-5.4 immediately follows', () => {
  const idx55 = CODEX_MODEL_OPTIONS.findIndex((o) => o.value === 'gpt-5.5');
  const idx54 = CODEX_MODEL_OPTIONS.findIndex((o) => o.value === 'gpt-5.4');
  assert.equal(idx55, 0, 'gpt-5.5 must be the first entry (new DEFAULT)');
  assert.equal(idx54, 1, 'gpt-5.4 must sit immediately after gpt-5.5');
});

test('boundary: CODEX_MODEL_OPTIONS values are in canonical order [5.5, 5.4, 5.3-spark, 5.4-mini, 5.3-mini]', () => {
  const values = CODEX_MODEL_OPTIONS.map((o) => o.value);
  assert.deepEqual(values, [
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.3-codex-spark',
    'gpt-5.4-mini',
    'gpt-5.3-mini',
  ]);
});

// --- error path ---

test('error: getCodexModelLabel returns the value verbatim for an unknown model id', () => {
  assert.equal(getCodexModelLabel('definitely-not-a-real-model-xyz'), 'definitely-not-a-real-model-xyz');
});

test('error: CODEX_MODEL_OPTIONS contains no duplicate value keys', () => {
  const values = CODEX_MODEL_OPTIONS.map((o) => o.value);
  const unique = new Set(values);
  assert.equal(unique.size, values.length, `duplicate value keys detected: ${values.join(', ')}`);
});

// --- edge case ---

test('edge: DEFAULT_CODEX_MODEL is pinned to gpt-5.5 (new flagship default)', () => {
  assert.equal(DEFAULT_CODEX_MODEL, 'gpt-5.5');
});

test('edge: getCodexModelLabel(DEFAULT_CODEX_MODEL) resolves to "Codex gpt-5.5"', () => {
  assert.equal(getCodexModelLabel(DEFAULT_CODEX_MODEL), 'Codex gpt-5.5');
});

test('edge: gpt-5.5 entry has a non-empty description string', () => {
  const entry = CODEX_MODEL_OPTIONS.find((o) => o.value === 'gpt-5.5');
  assert.ok(entry, 'gpt-5.5 entry required for this assertion');
  assert.equal(typeof entry.description, 'string');
  assert.ok(entry.description.length > 0, 'description must be non-empty');
});

// --- integration ---

test('integration: getCodexModelLabel resolves gpt-5.5 to its registered label end-to-end', () => {
  const entry = CODEX_MODEL_OPTIONS.find((o) => o.value === 'gpt-5.5');
  assert.ok(entry, 'gpt-5.5 entry required for this assertion');
  assert.equal(getCodexModelLabel('gpt-5.5'), entry.label);
  assert.notEqual(getCodexModelLabel('gpt-5.5'), 'gpt-5.5', 'label must differ from raw value (registered, not fallback)');
});
