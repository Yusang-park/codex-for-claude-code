#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT_PATH = join(process.cwd(), 'scripts', 'keyword-detector.mjs');

function runDetector({ cwd, prompt, sessionId = 'test-session' }) {
  const input = JSON.stringify({
    cwd,
    session_id: sessionId,
    prompt,
  });

  const result = spawnSync(process.execPath, [SCRIPT_PATH], {
    input,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('natural language planning phrase does not trigger /plan', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-'));

  try {
    const result = runDetector({ cwd, prompt: 'plan this feature for me' });

    assert.deepEqual(result, { continue: true });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('explicit /feat command triggers skill only — no state file written', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-'));

  try {
    const result = runDetector({ cwd, prompt: '/feat fix login validation' });

    assert.equal(result.continue, true);
    assert.match(result.hookSpecificOutput.additionalContext, /Skill: feat/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('explicit /qa command triggers skill only — no state file written', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-'));

  try {
    const result = runDetector({ cwd, prompt: '/qa fix login error copy' });

    assert.equal(result.continue, true);
    assert.match(result.hookSpecificOutput.additionalContext, /Skill: qa/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
