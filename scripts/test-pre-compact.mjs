#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runPreCompact(cwd, env = {}, input = { session_id: 'test-session' }) {
  const output = execFileSync(
    'node',
    ['/Users/yusang/smelter/scripts/pre-compact.mjs'],
    {
      cwd,
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: { ...process.env, ...env },
    },
  );

  const lines = output.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

function makeProjectDir() {
  return mkdtempSync(join(tmpdir(), 'pre-compact-project-'));
}

function setMode(projectDir, mode) {
  const stateDir = join(projectDir, '.smt', 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, 'model-mode.json'),
    JSON.stringify({ mode, updated_at: new Date().toISOString() }) + '\n',
  );
}

const claudeProject = makeProjectDir();
assert.deepEqual(runPreCompact(claudeProject, { DISABLE_COMPACT: '1' }), { decision: 'block' });

const codexProject = makeProjectDir();
setMode(codexProject, 'codex');
assert.notDeepEqual(runPreCompact(codexProject, { DISABLE_COMPACT: '1' }), { decision: 'block' });

const envCodexProject = makeProjectDir();
assert.notDeepEqual(
  runPreCompact(envCodexProject, { DISABLE_COMPACT: '1', SMELTER_MODEL_MODE: 'codex' }),
  { decision: 'block' },
);

console.log('pre-compact test passed');
