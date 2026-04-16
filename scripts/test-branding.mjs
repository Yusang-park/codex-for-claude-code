import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const forbiddenPatterns = [
  'linear-harness',
  'Linear Harness',
  'LINEAR_HARNESS',
  'LINEAR-HARNESS',
  'linearHarness',
  'LinearHarness',
];

const ignoredPaths = [
  '.git/',
  '.claude/worktrees/',
  'dist/',
  'node_modules/',
  'scripts/test-branding.mjs',
];

test('repository branding uses Smelter variants only', () => {
  let output = '';
  try {
    output = execFileSync(
      'rg',
      [
        '-n',
        '--fixed-strings',
        '--hidden',
        '--glob',
        '!.git',
        ...forbiddenPatterns.flatMap((pattern) => ['-e', pattern]),
        '.',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    );
  } catch (error) {
    if (error.status !== 1) {
      throw error;
    }

    output = error.stdout ?? '';
  }

  const lines = output
    .trim()
    .split('\n')
    .filter(Boolean)
    .filter((line) => !ignoredPaths.some((path) => line.includes(path)));

  assert.equal(
    lines.length,
    0,
    `found forbidden branding references:\n${lines.join('\n')}`,
  );
});
