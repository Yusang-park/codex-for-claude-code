// Real-interface tests for scripts/session-end.mjs.
// Run: node scripts/session-end.test.mjs
//
// Strategy: call the hook with the real project root via `--project-root` style
// is not supported, so we exercise the checker by importing checkDocSync directly
// AND also smoke-test the CLI via stdin on the real project.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';
import { checkDocSync, stripNonExecutable } from './session-end.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeFixture(opts) {
  const {
    includeLegacyCommand = false,
    includeForbiddenMention = false,
    invalidStep = false,
    missingPreset = false,
    missingKdCommand = false,
  } = opts;
  const dir = mkdtempSync(join(tmpdir(), 'lh-se-'));
  mkdirSync(join(dir, 'commands'), { recursive: true });
  mkdirSync(join(dir, 'presets'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'doc'), { recursive: true });

  const expected = ['tasker', 'feat', 'qa'];
  for (const c of expected) {
    writeFileSync(join(dir, 'commands', `${c}.md`), `# /${c}\n`);
    if (!(missingPreset && c === 'qa')) {
      writeFileSync(join(dir, 'presets', `${c}.json`), JSON.stringify({ name: c }));
    }
  }
  if (includeLegacyCommand) {
    writeFileSync(join(dir, 'commands', 'blueprint.md'), '# /blueprint\n');
  }

  const md = [
    '# Smelter',
    '- /tasker plans',
    '- /feat full',
    '- /qa narrow',
    invalidStep ? 'See Step 99 for details.' : 'See Step 4 for details.',
    includeForbiddenMention ? 'Legacy: /simple docs' : '',
  ].join('\n');

  for (const rel of [
    'CLAUDE.md', 'AGENTS.md', 'README.md',
    'doc/index.md', 'doc/workflow.md', 'doc/spec.md',
    'doc/implementation.md', 'doc/Introduce.md', 'doc/reference.md',
  ]) {
    writeFileSync(join(dir, rel), md);
  }

  const kdLines = [
    "command: 'tasker'",
    missingKdCommand ? "" : "command: 'feat'",
    "command: 'qa'",
  ].join('\n');
  writeFileSync(join(dir, 'scripts', 'keyword-detector.mjs'), kdLines);

  return dir;
}

// Case 1: clean fixture → ok
{
  const dir = makeFixture({});
  const r = checkDocSync(dir);
  assert.equal(r.ok, true, `clean fixture should pass, got: ${JSON.stringify(r.issues)}`);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case clean OK');
}

// Case 2: forbidden reference → fail
{
  const dir = makeFixture({ includeForbiddenMention: true });
  const r = checkDocSync(dir);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some(i => /\/simple/.test(i.message)), 'must flag /simple');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case forbidden-ref OK');
}

// Case 3: invalid step → fail
{
  const dir = makeFixture({ invalidStep: true });
  const r = checkDocSync(dir);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some(i => /Step 99/.test(i.message)), 'must flag Step 99');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case invalid-step OK');
}

// Case 4: missing preset → fail
{
  const dir = makeFixture({ missingPreset: true });
  const r = checkDocSync(dir);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some(i => /presets\/qa\.json/.test(i.message)));
  rmSync(dir, { recursive: true, force: true });
  console.log('  case missing-preset OK');
}

// Case 5: legacy command file → fail
{
  const dir = makeFixture({ includeLegacyCommand: true });
  const r = checkDocSync(dir);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some(i => /commands\/blueprint\.md/.test(i.message)));
  rmSync(dir, { recursive: true, force: true });
  console.log('  case legacy-command-file OK');
}

// Case 6: keyword-detector missing a command → fail
{
  const dir = makeFixture({ missingKdCommand: true });
  const r = checkDocSync(dir);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some(i => /Magic keyword table missing command mapping: feat/.test(i.message)));
  rmSync(dir, { recursive: true, force: true });
  console.log('  case kd-missing-command OK');
}

// ---------------------------------------------------------------------------
// New guards: FORBIDDEN_LEGACY_PATTERN + FORBIDDEN_EXTRA_PRESETS
// ---------------------------------------------------------------------------

// Case 7: persistent-mode on a non-comment line in a scanned file → fail
{
  const dir = makeFixture({});
  // Seed a tracked legacy-scan file with a raw reference (executable line)
  writeFileSync(join(dir, 'settings.json'), 'node scripts/persistent-mode.cjs\n');
  const r = checkDocSync(dir);
  assert.equal(r.ok, false, 'raw persistent-mode reference must flag');
  assert.ok(
    r.issues.some(i => /persistent-mode/.test(i.message)),
    'issues must mention persistent-mode',
  );
  rmSync(dir, { recursive: true, force: true });
  console.log('  case legacy-pattern positive OK');
}

// Case 8: persistent-mode under // line comment → allowed
{
  const dir = makeFixture({});
  writeFileSync(join(dir, 'scripts', 'auto-confirm.mjs'), '// legacy persistent-mode.cjs note\n');
  // Also clear any other seeded legacy file to keep noise low
  writeFileSync(join(dir, 'settings.json'), '{}\n');
  const r = checkDocSync(dir);
  const legacyIssues = r.issues.filter(i => /persistent-mode/.test(i.message));
  assert.equal(legacyIssues.length, 0, '// commented mention must not flag');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case legacy-pattern // comment negative OK');
}

// Case 9: persistent-mode inside /* ... */ block comment → allowed
{
  const dir = makeFixture({});
  writeFileSync(
    join(dir, 'scripts', 'auto-confirm.mjs'),
    'const x = 1;\n/* legacy\n   persistent-mode.cjs mention in block comment\n*/\nconst y = 2;\n',
  );
  writeFileSync(join(dir, 'settings.json'), '{}\n');
  const r = checkDocSync(dir);
  const legacyIssues = r.issues.filter(i => /persistent-mode/.test(i.message));
  assert.equal(legacyIssues.length, 0, 'block-comment mention must not flag');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case legacy-pattern /* block */ comment negative OK');
}

// Case 10: persistent-mode inside fenced markdown code block → allowed
{
  const dir = makeFixture({});
  // Scanned md files: rules/common/testing.md is in TRACKED_LEGACY_SCAN
  mkdirSync(join(dir, 'rules', 'common'), { recursive: true });
  writeFileSync(
    join(dir, 'rules', 'common', 'testing.md'),
    '# Testing\n\n```bash\nnode scripts/persistent-mode.cjs\n```\n\nBody.\n',
  );
  writeFileSync(join(dir, 'settings.json'), '{}\n');
  const r = checkDocSync(dir);
  const legacyIssues = r.issues.filter(i => /persistent-mode/.test(i.message));
  assert.equal(legacyIssues.length, 0, 'fenced code must not flag');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case fenced-markdown negative OK');
}

// Case 11: YAML front matter with persistent-mode mention → allowed
{
  const dir = makeFixture({});
  mkdirSync(join(dir, 'rules', 'common'), { recursive: true });
  writeFileSync(
    join(dir, 'rules', 'common', 'testing.md'),
    '---\ntitle: "persistent-mode notes"\n---\n\nBody.\n',
  );
  writeFileSync(join(dir, 'settings.json'), '{}\n');
  const r = checkDocSync(dir);
  const legacyIssues = r.issues.filter(i => /persistent-mode/.test(i.message));
  assert.equal(legacyIssues.length, 0, 'YAML front matter must not flag');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case yaml-frontmatter negative OK');
}

// Case 12: forbidden extra preset (full.json) → fail
{
  const dir = makeFixture({});
  writeFileSync(join(dir, 'presets', 'full.json'), JSON.stringify({ name: 'full' }));
  const r = checkDocSync(dir);
  assert.equal(r.ok, false, 'full.json must flag');
  assert.ok(
    r.issues.some(i => /presets\/full\.json/.test(i.message)),
    'issue must name presets/full.json',
  );
  rmSync(dir, { recursive: true, force: true });
  console.log('  case extra-preset positive OK');
}

// Case 13: exactly the 3 allowed presets → pass
{
  const dir = makeFixture({});
  // makeFixture already writes exactly tasker/feat/qa — keep as-is.
  const r = checkDocSync(dir);
  // Filter only preset-related issues
  const presetIssues = r.issues.filter(i => i.file === 'presets/');
  assert.equal(presetIssues.length, 0, `no preset issues expected, got ${JSON.stringify(presetIssues)}`);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case extra-preset negative (allowed 4) OK');
}

// Case 14: stripNonExecutable unit — fenced markdown span replaced with spaces of same line count
{
  const md = 'line1\n```bash\nbad persistent-mode.cjs\n```\nline5\n';
  const stripped = stripNonExecutable(md, 'x.md');
  const lines = stripped.split('\n');
  // Original has 5 lines + trailing empty → 6 entries; stripped must keep the same
  assert.equal(lines.length, md.split('\n').length, 'line count preserved');
  assert.ok(!/persistent-mode/.test(stripped), 'persistent-mode must be scrubbed out of fenced code');
  console.log('  case stripNonExecutable (md) OK');
}

// Case 15: stripNonExecutable unit — /* */ block comment scrubbed in .mjs
{
  const src = 'const a = 1;\n/* persistent-mode.cjs\n   and more */\nconst b = 2;\n';
  const stripped = stripNonExecutable(src, 'foo.mjs');
  assert.ok(!/persistent-mode/.test(stripped), 'block comment content must be scrubbed');
  assert.equal(
    stripped.split('\n').length,
    src.split('\n').length,
    'line count preserved through scrubbing',
  );
  console.log('  case stripNonExecutable (mjs) OK');
}

// Case 16: tasker-native-plan references in tracked docs → fail
{
  const dir = makeFixture({});
  writeFileSync(
    join(dir, 'commands', 'tasker.md'),
    '# /tasker\nCall `EnterPlanMode` and record Native Plan File: foo\n',
  );
  const r = checkDocSync(dir);
  assert.equal(r.ok, false, 'tracked tasker native-plan references must flag');
  assert.ok(
    r.issues.some(i => /EnterPlanMode/.test(i.message) || /Native Plan File/.test(i.message)),
    'issue must mention forbidden native-plan reference',
  );
  rmSync(dir, { recursive: true, force: true });
  console.log('  case tasker-native-plan positive OK');
}

// Case 17: YAML front matter ending at EOF (no trailing newline) → exempted
{
  const dir = makeFixture({});
  mkdirSync(join(dir, 'rules', 'common'), { recursive: true });
  // Note: no trailing newline after closing `---`.
  writeFileSync(
    join(dir, 'rules', 'common', 'testing.md'),
    '---\ntitle: "persistent-mode notes"\n---',
  );
  writeFileSync(join(dir, 'settings.json'), '{}\n');
  const r = checkDocSync(dir);
  const legacyIssues = r.issues.filter(i => /persistent-mode/.test(i.message));
  assert.equal(legacyIssues.length, 0, 'YAML front matter at EOF (no trailing newline) must not flag');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case yaml-frontmatter EOF (no newline) OK');
}

// Case 17: nested fenced block — outer ``` contains inner ``` literals
// The scanner must treat the outer fence as a single span and not close early
// on the inner ``` line. The inner persistent-mode mention is inside the outer
// fence → must be exempted.
{
  const dir = makeFixture({});
  mkdirSync(join(dir, 'rules', 'common'), { recursive: true });
  const nested = [
    '# Nested',
    '',
    '````markdown',           // outer opener: 4 backticks
    'Outer body.',
    '```bash',                 // inner fence (3 backticks) — ignored as inner content
    'node scripts/persistent-mode.cjs',
    '```',                     // inner closer (3 backticks) — not enough to close outer
    'Still inside outer.',
    '````',                    // outer closer: 4 backticks
    '',
    'After block.',
  ].join('\n');
  writeFileSync(join(dir, 'rules', 'common', 'testing.md'), nested);
  writeFileSync(join(dir, 'settings.json'), '{}\n');
  const r = checkDocSync(dir);
  const legacyIssues = r.issues.filter(i => /persistent-mode/.test(i.message));
  assert.equal(
    legacyIssues.length, 0,
    `nested fenced block must not flag (got: ${JSON.stringify(legacyIssues)})`,
  );
  rmSync(dir, { recursive: true, force: true });
  console.log('  case nested fenced-block negative OK');
}

// Case 18: presets/Full.JSON (case variant) → must trigger extra-preset guard
{
  const dir = makeFixture({});
  writeFileSync(join(dir, 'presets', 'Full.JSON'), JSON.stringify({ name: 'full' }));
  const r = checkDocSync(dir);
  assert.equal(r.ok, false, 'Full.JSON case variant must flag');
  assert.ok(
    r.issues.some(i => /presets\/full\.json/.test(i.message)),
    `must normalize case and flag presets/full.json (got: ${JSON.stringify(r.issues)})`,
  );
  rmSync(dir, { recursive: true, force: true });
  console.log('  case extra-preset case-insensitive OK');
}

// Case 19: unclosed fence containing persistent-mode at tail → must flag
// (fenced-region scrubbing is only safe when the fence actually closed).
{
  const dir = makeFixture({});
  mkdirSync(join(dir, 'rules', 'common'), { recursive: true });
  // No closing ``` — scrubbing must NOT silently exempt this region.
  writeFileSync(
    join(dir, 'rules', 'common', 'testing.md'),
    '# Title\n\n```bash\nnode scripts/persistent-mode.cjs\n',
  );
  writeFileSync(join(dir, 'settings.json'), '{}\n');
  const r = checkDocSync(dir);
  const legacyIssues = r.issues.filter(i => /persistent-mode/.test(i.message));
  assert.ok(legacyIssues.length > 0, 'unclosed fence must NOT exempt persistent-mode');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case unclosed-fence-flags OK');
}

// Case 20: properly closed fence still exempts persistent-mode (regression guard)
{
  const dir = makeFixture({});
  mkdirSync(join(dir, 'rules', 'common'), { recursive: true });
  writeFileSync(
    join(dir, 'rules', 'common', 'testing.md'),
    '# Title\n\n```bash\nnode scripts/persistent-mode.cjs\n```\n\nTail.\n',
  );
  writeFileSync(join(dir, 'settings.json'), '{}\n');
  const r = checkDocSync(dir);
  const legacyIssues = r.issues.filter(i => /persistent-mode/.test(i.message));
  assert.equal(legacyIssues.length, 0, 'closed fence must still exempt');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case closed-fence-still-exempts OK');
}

// Case 21: Step 99 in scripts/keyword-detector.mjs (cross-file) → flagged
{
  const { extractStepRefs } = await import('./session-end.mjs');
  const src = [
    "command: 'tasker'",
    "command: 'feat'",
    "command: 'qa'",
    "// See Step 99 for details",
  ].join('\n');
  const steps = extractStepRefs(src, 'scripts/keyword-detector.mjs');
  assert.ok(steps.includes(99), 'Step 99 in cross-file must be extracted');

  // End-to-end: a Step 99 in keyword-detector.mjs must surface as an issue.
  const dir = makeFixture({});
  const existing = [
    "command: 'tasker'",
    "command: 'feat'",
    "command: 'qa'",
    "// See Step 99 for details",
  ].join('\n');
  writeFileSync(join(dir, 'scripts', 'keyword-detector.mjs'), existing);
  const r = checkDocSync(dir);
  assert.ok(
    r.issues.some(i => /Step 99/.test(i.message) && /keyword-detector/.test(i.file)),
    `Step 99 in keyword-detector.mjs must be flagged (got: ${JSON.stringify(r.issues)})`,
  );
  rmSync(dir, { recursive: true, force: true });
  console.log('  case cross-file-step-ref OK');
}

console.log('session-end: OK');
