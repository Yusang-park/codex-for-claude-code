// Test yellow-tag utility via child processes (real interface).
// Runs this file: `node scripts/lib/yellow-tag.test.mjs`
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOD = join(__dirname, 'yellow-tag.mjs');

function runWithEnv(env) {
  const code = `import('${MOD}').then(m => m.printTag('Test Tag'));`;
  return spawnSync(process.execPath, ['-e', code], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

// Case 1: NO_COLOR disables ANSI
const plain = runWithEnv({ NO_COLOR: '1' });
assert.equal(plain.stderr.trim(), '[Test Tag]', 'NO_COLOR should produce plain output');

// Case 2: Without NO_COLOR, piped stderr (non-TTY) also produces plain output (safer default)
const piped = runWithEnv({ NO_COLOR: '' });
assert.ok(
  piped.stderr.includes('[Test Tag]'),
  'Piped stderr must still contain the bracketed label',
);

console.log('yellow-tag: OK');
