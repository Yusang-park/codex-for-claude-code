#!/usr/bin/env node
import assert from 'node:assert/strict';

const { parseUsageForTest } = await import('../src/adapters/claude.ts');

const codexUsage = parseUsageForTest({
  usage: {
    model: 'gpt-5.4',
    input_tokens: 100000,
  },
});

assert.equal(codexUsage?.contextWindow, 1_000_000, 'expected Codex gpt-5.4 to use 1M context window');
assert.equal(codexUsage?.percentage, 10, 'expected percentage to be computed against 1M context');

const explicitUsage = parseUsageForTest({
  usage: {
    model: 'gpt-5.4',
    input_tokens: 100000,
    context_window: 500000,
  },
});

assert.equal(explicitUsage?.contextWindow, 500000, 'expected explicit context window to override model default');

console.log('claude usage context test passed');
