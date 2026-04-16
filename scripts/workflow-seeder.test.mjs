// Tests keyword-detector workflow seeding.
// Run: node scripts/workflow-seeder.test.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const KD = join(__dirname, 'keyword-detector.mjs');

function runKD(prompt, cwd, sessionId = 'test-sess') {
  return spawnSync(process.execPath, [KD], {
    input: JSON.stringify({ cwd, session_id: sessionId, prompt }),
    encoding: 'utf-8',
    cwd,
    env: { ...process.env, NO_COLOR: '1' },
  });
}

// Case 1: /feat seeds workflow.json + active-feature + plan.md
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-seed-'));
  runKD('/feat add dark mode toggle', dir);
  const featuresDir = join(dir, '.smt', 'features');
  assert.ok(existsSync(featuresDir), '.smt/features created');
  const slugs = readdirSync(featuresDir);
  assert.equal(slugs.length, 1, 'one feature seeded');
  const slug = slugs[0];
  assert.match(slug, /add-dark-mode-toggle/, `slug derived from prompt (got ${slug})`);

  const wfPath = join(featuresDir, slug, 'state', 'workflow.json');
  assert.ok(existsSync(wfPath));
  const state = JSON.parse(readFileSync(wfPath, 'utf-8'));
  assert.equal(state.command, 'feat');
  assert.equal(state.step, 'step-1');
  assert.equal(state.retry, 0);
  assert.deepEqual(state.signals, {});
  assert.equal(state.version, 0);

  const overviewPath = join(featuresDir, slug, 'task', 'plan.md');
  assert.ok(existsSync(overviewPath), 'plan.md created');

  const pointerPath = join(dir, '.smt', 'state', 'active-feature.json');
  assert.ok(existsSync(pointerPath), 'active-feature pointer written');
  const pointer = JSON.parse(readFileSync(pointerPath, 'utf-8'));
  assert.equal(pointer.slug, slug);

  rmSync(dir, { recursive: true, force: true });
  console.log('  seeder case 1 (/feat seeds state) OK');
}

// Case 2: /qa seeds at step-4
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-seed-'));
  runKD('/qa fix login typo', dir);
  const featuresDir = join(dir, '.smt', 'features');
  const [slug] = readdirSync(featuresDir);
  const state = JSON.parse(readFileSync(join(featuresDir, slug, 'state', 'workflow.json'), 'utf-8'));
  assert.equal(state.command, 'qa');
  assert.equal(state.step, 'step-4', '/qa starts at step-4 (skips 1-3)');
  rmSync(dir, { recursive: true, force: true });
  console.log('  seeder case 2 (/qa starts at step-4) OK');
}

// Case 3: /tasker seeds at step-1
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-seed-'));
  runKD('/tasker plan onboarding', dir);
  const featuresDir = join(dir, '.smt', 'features');
  const [slug] = readdirSync(featuresDir);
  const state = JSON.parse(readFileSync(join(featuresDir, slug, 'state', 'workflow.json'), 'utf-8'));
  assert.equal(state.command, 'tasker');
  assert.equal(state.step, 'step-1');
  rmSync(dir, { recursive: true, force: true });
  console.log('  seeder case 3 (/tasker starts at step-1) OK');
}

// Case 4: re-running /feat on existing feature doesn't clobber workflow.json state
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-seed-'));
  runKD('/feat add dark mode', dir);
  const featuresDir = join(dir, '.smt', 'features');
  const [slug] = readdirSync(featuresDir);
  const wfPath = join(featuresDir, slug, 'state', 'workflow.json');
  // Simulate progression: write advanced state
  const advanced = { command: 'feat', step: 'step-5', retry: 2, signals: { tests_green: false }, version: 7, updated_at: Date.now() };
  writeFileSync(wfPath, JSON.stringify(advanced));
  // Re-run same prompt
  runKD('/feat add dark mode', dir);
  const state = JSON.parse(readFileSync(wfPath, 'utf-8'));
  assert.equal(state.step, 'step-5', 'existing workflow.json not clobbered');
  assert.equal(state.version, 7);
  rmSync(dir, { recursive: true, force: true });
  console.log('  seeder case 4 (re-run preserves progress) OK');
}

// Case 5: /cancel does NOT seed workflow state
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-seed-'));
  runKD('/cancel', dir);
  const featuresDir = join(dir, '.smt', 'features');
  const slugs = existsSync(featuresDir) ? readdirSync(featuresDir) : [];
  assert.equal(slugs.length, 0, '/cancel creates no feature');
  rmSync(dir, { recursive: true, force: true });
  console.log('  seeder case 5 (/cancel no-seed) OK');
}

// Case 6: empty-prompt /feat gets collision-resistant slug
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-seed-'));
  runKD('/feat', dir);
  const featuresDir = join(dir, '.smt', 'features');
  const [slug] = readdirSync(featuresDir);
  assert.match(slug, /^feature-[a-z0-9]+-[a-f0-9]{6}$/, 'empty prompt → collision-resistant slug');
  rmSync(dir, { recursive: true, force: true });
  console.log('  seeder case 6 (empty prompt slug collision-safe) OK');
}

// Case 7: punctuation-only prompt gets fallback slug
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-seed-'));
  runKD('/feat !!!???', dir);
  const featuresDir = join(dir, '.smt', 'features');
  const [slug] = readdirSync(featuresDir);
  assert.match(slug, /^feature-[a-z0-9]+-[a-f0-9]{6}$/);
  rmSync(dir, { recursive: true, force: true });
  console.log('  seeder case 7 (punctuation-only slug fallback) OK');
}

// Case 8: Korean prompt produces korean-character slug
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-seed-'));
  runKD('/feat 다크모드 토글', dir);
  const featuresDir = join(dir, '.smt', 'features');
  const [slug] = readdirSync(featuresDir);
  assert.match(slug, /다크모드/, 'Korean preserved');
  rmSync(dir, { recursive: true, force: true });
  console.log('  seeder case 8 (Korean prompt) OK');
}

// Case 9: /cancel clears active-feature pointer
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-seed-'));
  runKD('/feat add dark mode', dir);
  const pointerPath = join(dir, '.smt', 'state', 'active-feature.json');
  assert.ok(existsSync(pointerPath), 'pointer exists after /feat');
  runKD('/cancel', dir);
  assert.ok(!existsSync(pointerPath), 'pointer cleared after /cancel');
  rmSync(dir, { recursive: true, force: true });
  console.log('  seeder case 9 (/cancel clears active pointer) OK');
}

// Case 10: cross-slug switch preserves previous-feature record
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-seed-'));
  runKD('/feat add dark mode', dir);
  runKD('/feat add light mode', dir);
  const prevPath = join(dir, '.smt', 'state', 'previous-feature.json');
  assert.ok(existsSync(prevPath), 'previous-feature record written on switch');
  const prev = JSON.parse(readFileSync(prevPath, 'utf-8'));
  assert.match(prev.slug, /add-dark-mode/);
  assert.match(prev.new_slug, /add-light-mode/);
  // Current pointer points to the new feature
  const pointer = JSON.parse(readFileSync(join(dir, '.smt', 'state', 'active-feature.json'), 'utf-8'));
  assert.match(pointer.slug, /add-light-mode/);
  rmSync(dir, { recursive: true, force: true });
  console.log('  seeder case 10 (cross-slug switch logged) OK');
}

// Case 11: explicit /qa overrides stale feat pointer immediately
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-seed-'));
  runKD('/feat add dark mode', dir);
  const featSlug = readdirSync(join(dir, '.smt', 'features'))[0];
  const featStatePath = join(dir, '.smt', 'features', featSlug, 'state', 'workflow.json');
  writeFileSync(featStatePath, JSON.stringify({ command: 'feat', step: 'step-3-interview', retry: 0, signals: {}, version: 0, updated_at: Date.now() }, null, 2));

  runKD('/qa fix login typo', dir);

  const featureSlugs = readdirSync(join(dir, '.smt', 'features')).sort();
  assert.equal(featureSlugs.length, 2, 'new qa feature seeded');
  const qaSlug = featureSlugs.find((slug) => slug !== featSlug);
  const pointer = JSON.parse(readFileSync(join(dir, '.smt', 'state', 'active-feature.json'), 'utf-8'));
  assert.equal(pointer.slug, qaSlug, 'active pointer switches to new qa feature');

  const qaState = JSON.parse(readFileSync(join(dir, '.smt', 'features', qaSlug, 'state', 'workflow.json'), 'utf-8'));
  assert.equal(qaState.command, 'qa');
  assert.equal(qaState.step, 'step-4');

  rmSync(dir, { recursive: true, force: true });
  console.log('  seeder case 11 (/qa overrides stale feat pointer) OK');
}

console.log('workflow-seeder: OK');
