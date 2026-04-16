#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const commandPath = join(homedir(), '.claude', 'commands', 'model-codex.md');

test('model-codex command exists when installed', () => {
  if (!existsSync(commandPath)) {
    return;
  }

  const command = readFileSync(commandPath, 'utf8');

  assert.match(command, /^# /m, 'expected command markdown heading');
  assert.match(command, /Codex gpt-5\.[34]/, 'expected custom Codex model to be listed');
  assert.match(command, /\/model\b/, 'expected command to instruct using /model');
});

console.log('model-codex command test passed');
