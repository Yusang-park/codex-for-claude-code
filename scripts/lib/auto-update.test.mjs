#!/usr/bin/env node
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_UPDATE_MANUAL_COMMAND,
  compareSemver,
  resolveAutoUpdate,
} from './auto-update.mjs';

function fakeStderr() {
  let output = '';
  return {
    stream: { write: (chunk) => { output += String(chunk); } },
    output: () => output,
  };
}

test('compareSemver orders patch releases numerically', () => {
  assert.equal(compareSemver('0.2.6', '0.2.5'), 1);
  assert.equal(compareSemver('0.2.5', '0.2.6'), -1);
  assert.equal(compareSemver('0.2.6', '0.2.6'), 0);
});

test('resolveAutoUpdate installs latest when registry version is newer', () => {
  const calls = [];
  const stderr = fakeStderr();
  const result = resolveAutoUpdate({
    currentVersion: '0.2.5',
    env: {},
    stderr: stderr.stream,
    execFileSync: (cmd, args) => {
      calls.push([cmd, args]);
      if (args[0] === 'view') return '0.2.6\n';
      if (args[0] === 'install') return '';
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    },
  });

  assert.equal(result.status, 'updated');
  assert.deepEqual(calls.map(([, args]) => args), [
    ['view', 'codex-for-claude-code', 'version', '--silent'],
    ['install', '-g', 'codex-for-claude-code@latest'],
  ]);
  assert.match(stderr.output(), /updating codex-for-claude-code from 0\.2\.5 to 0\.2\.6/);
});

test('resolveAutoUpdate does not install when current version is latest', () => {
  const calls = [];
  const result = resolveAutoUpdate({
    currentVersion: '0.2.6',
    env: {},
    stderr: fakeStderr().stream,
    execFileSync: (cmd, args) => {
      calls.push([cmd, args]);
      return '0.2.6\n';
    },
  });

  assert.equal(result.status, 'current');
  assert.equal(calls.length, 1);
});

test('resolveAutoUpdate tells users the manual command when install fails', () => {
  const stderr = fakeStderr();
  const result = resolveAutoUpdate({
    currentVersion: '0.2.5',
    env: {},
    stderr: stderr.stream,
    execFileSync: (_cmd, args) => {
      if (args[0] === 'view') return '0.2.6\n';
      throw new Error('permission denied');
    },
  });

  assert.equal(result.status, 'update_failed');
  assert.match(stderr.output(), /auto-update failed/);
  assert.match(stderr.output(), new RegExp(AUTO_UPDATE_MANUAL_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('resolveAutoUpdate skips after relaunch to avoid update loops', () => {
  const result = resolveAutoUpdate({
    currentVersion: '0.2.5',
    env: { CLAUDE_CODEX_AUTO_UPDATE_REENTRY: '1' },
    stderr: fakeStderr().stream,
    execFileSync: () => { throw new Error('should not run'); },
  });

  assert.equal(result.status, 'skipped');
});
