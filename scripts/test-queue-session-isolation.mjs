#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { propagateQueueCancel } from './cancel-propagator.mjs';

const STOP_HOOK_PATH = join(process.cwd(), 'scripts', 'auto-confirm.mjs');
const PRE_TOOL_HOOK_PATH = join(process.cwd(), 'scripts', 'pre-tool-enforcer.mjs');

function runStopHook({ cwd, sessionId = 'test-session', stopReason = 'end_turn' }) {
  const input = JSON.stringify({ cwd, session_id: sessionId, stop_reason: stopReason });
  const result = spawnSync(process.execPath, [STOP_HOOK_PATH], {
    input,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function runPreToolHook({ cwd, sessionId = 'test-session', toolName = 'Read' }) {
  const input = JSON.stringify({
    cwd,
    session_id: sessionId,
    tool_name: toolName,
    tool_input: { file_path: '/tmp/example.txt' },
  });
  const result = spawnSync(process.execPath, [PRE_TOOL_HOOK_PATH], {
    input,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('queue redirect applies within the same session', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'queue-session-'));

  try {
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'tmp', type: 'module' }));
    propagateQueueCancel(cwd, 'fix modal footer', 'test redirect', 'session-a');

    const preTool = runPreToolHook({ cwd, sessionId: 'session-a' });
    assert.equal(preTool.continue, true);
    assert.match(preTool.hookSpecificOutput.additionalContext, /QUEUED REDIRECT/);
    assert.match(preTool.hookSpecificOutput.additionalContext, /fix modal footer/);

    const stop = runStopHook({ cwd, sessionId: 'session-a' });
    assert.equal(stop.decision, 'block');
    assert.match(stop.reason, /QUEUED REDIRECT/);
    assert.match(stop.reason, /fix modal footer/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('queue redirect does not leak to a different session', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'queue-session-'));

  try {
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'tmp', type: 'module' }));
    propagateQueueCancel(cwd, 'fix modal footer', 'test redirect', 'session-a');

    const preTool = runPreToolHook({ cwd, sessionId: 'session-b' });
    assert.equal(preTool.continue, true);
    assert.ok(!preTool.hookSpecificOutput?.additionalContext?.includes('QUEUED REDIRECT'));

    const stop = runStopHook({ cwd, sessionId: 'session-b' });
    assert.deepEqual(stop, { continue: true });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
