// Test hook-audit utility via real filesystem (E2E style).
// Runs: node scripts/lib/hook-audit.test.mjs
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { auditHooks } from './hook-audit.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'hook-audit-test-'));

// Case 1: Script with printTag before additionalContext — should pass
writeFileSync(
  join(tmp, 'good-hook.mjs'),
  `import { printTag } from './lib/yellow-tag.mjs';
printTag('Good Hook');
console.log(JSON.stringify({ continue: true, hookSpecificOutput: { additionalContext: 'hello' } }));
`
);

// Case 2: Script with additionalContext but NO printTag — should fail
writeFileSync(
  join(tmp, 'bad-hook.mjs'),
  `// no printTag here
const x = 1;
const y = 2;
const z = 3;
const w = 4;
const v = 5;
const u = 6;
console.log(JSON.stringify({ continue: true, hookSpecificOutput: { additionalContext: 'oops' } }));
`
);

// Case 3: Script with printTag too far away (>5 lines) — should fail
writeFileSync(
  join(tmp, 'far-hook.mjs'),
  `import { printTag } from './lib/yellow-tag.mjs';
printTag('Far Hook');
const a = 1;
const b = 2;
const c = 3;
const d = 4;
const e = 5;
const f = 6;
console.log(JSON.stringify({ continue: true, hookSpecificOutput: { additionalContext: 'far' } }));
`
);

// Case 4: Script with console.log(JSON.stringify but no additionalContext — should be ignored
writeFileSync(
  join(tmp, 'no-ctx-hook.mjs'),
  `console.log(JSON.stringify({ continue: true }));
`
);

const result = await auditHooks(tmp);

// Should NOT be ok — bad-hook.mjs and far-hook.mjs have violations
assert.equal(result.ok, false, 'audit should report violations');
assert.equal(result.violations.length, 2, 'should find exactly 2 violations');

const violationFiles = result.violations.map(v => v.file).sort();
assert.deepEqual(violationFiles, ['bad-hook.mjs', 'far-hook.mjs']);

// bad-hook.mjs violation should be on line 8
const badViolation = result.violations.find(v => v.file === 'bad-hook.mjs');
assert.equal(badViolation.line, 8);

// far-hook.mjs violation should be on line 9
const farViolation = result.violations.find(v => v.file === 'far-hook.mjs');
assert.equal(farViolation.line, 9);

// Now test a clean directory — only good files
const cleanTmp = mkdtempSync(join(tmpdir(), 'hook-audit-clean-'));
writeFileSync(
  join(cleanTmp, 'clean-hook.mjs'),
  `import { printTag } from './lib/yellow-tag.mjs';
printTag('Clean');
console.log(JSON.stringify({ hookSpecificOutput: { additionalContext: 'ok' } }));
`
);

const cleanResult = await auditHooks(cleanTmp);
assert.equal(cleanResult.ok, true, 'clean directory should pass audit');
assert.equal(cleanResult.violations.length, 0);

// Cleanup
rmSync(tmp, { recursive: true, force: true });
rmSync(cleanTmp, { recursive: true, force: true });

console.log('hook-audit: OK');
