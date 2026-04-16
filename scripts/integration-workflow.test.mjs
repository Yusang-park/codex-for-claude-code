// End-to-end integration: simulate /tasker → /feat workflow cycle.
// Verifies step-injector + step-tracker work together across a feature lifecycle.
// Run: node scripts/integration-workflow.test.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const KEYWORD_DETECTOR = join(__dirname, 'keyword-detector.mjs');
const INJECTOR = join(__dirname, 'step-injector.mjs');
const TRACKER = join(__dirname, 'step-tracker.mjs');

function runScript(scriptPath, payload, cwd) {
  return spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    cwd,
    env: { ...process.env, NO_COLOR: '1' },
  });
}

function runKeywordDetector(dir, prompt, sessionId = 'test-session') {
  return runScript(KEYWORD_DETECTOR, { cwd: dir, session_id: sessionId, prompt }, dir);
}

function seedWorkflow(dir, slug, command, step) {
  const featureDir = join(dir, '.smt', 'features', slug);
  const taskDir = join(featureDir, 'task');
  const stateDir = join(featureDir, 'state');
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(taskDir, 'plan.md'), `# ${slug}\n\n## Plan\n`);
  writeFileSync(join(taskDir, 'task-1.md'), `- [ ] do the thing\n`);
  writeFileSync(join(stateDir, 'workflow.json'), JSON.stringify({
    command, step, retry: 0, signals: {}, updated_at: Date.now(),
  }, null, 2));
  return join(stateDir, 'workflow.json');
}

function readState(statePath) {
  return JSON.parse(readFileSync(statePath, 'utf-8'));
}

function writeSignal(statePath, signal, value) {
  const state = readState(statePath);
  state.signals = { ...(state.signals || {}), [signal]: value };
  state.updated_at = Date.now();
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

// -----------------------------------------------------------------------------
// Cycle 1: /tasker full lifecycle — step-1 → step-2 → step-3 → gate
// Steps without `gate:` advance on any tool call (trusted transitions).
// -----------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-int-'));
  const statePath = seedWorkflow(dir, 'auth-flow', 'tasker', 'step-1');

  let inj = JSON.parse(runScript(INJECTOR, { cwd: dir }, dir).stdout);
  assert.match(inj.hookSpecificOutput.additionalContext, /Current mode: TASKER MODE/);
  assert.match(inj.hookSpecificOutput.additionalContext, /step-1.*Problem Recognition/s);

  let trk = JSON.parse(runScript(TRACKER, { cwd: dir }, dir).stdout);
  assert.match(trk.hookSpecificOutput.additionalContext, /step-1 complete → step-2/);
  assert.equal(readState(statePath).step, 'step-2');

  inj = JSON.parse(runScript(INJECTOR, { cwd: dir }, dir).stdout);
  assert.match(inj.hookSpecificOutput.additionalContext, /step-2.*Pre Review/s);

  trk = JSON.parse(runScript(TRACKER, { cwd: dir }, dir).stdout);
  assert.equal(readState(statePath).step, 'step-3');

  inj = JSON.parse(runScript(INJECTOR, { cwd: dir }, dir).stdout);
  assert.match(inj.hookSpecificOutput.additionalContext, /step-3.*Planning/s);

  trk = JSON.parse(runScript(TRACKER, { cwd: dir }, dir).stdout);
  assert.equal(readState(statePath).step, 'step-3-interview');

  inj = JSON.parse(runScript(INJECTOR, { cwd: dir }, dir).stdout);
  assert.match(inj.hookSpecificOutput.additionalContext, /GATE — PAUSE/);

  trk = JSON.parse(runScript(TRACKER, { cwd: dir }, dir).stdout);
  assert.ok(!trk.hookSpecificOutput, 'gate must not auto-advance');
  assert.equal(readState(statePath).step, 'step-3-interview');

  rmSync(dir, { recursive: true, force: true });
  console.log('  cycle 1 (/tasker lifecycle) OK');
}

// -----------------------------------------------------------------------------
// Cycle 2: Gate failure → step-back routing
// -----------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-int-'));
  const statePath = seedWorkflow(dir, 'dark-mode', 'feat', 'step-7');

  writeSignal(statePath, 'tests_pass_and_build_clean', false);

  const trk = JSON.parse(runScript(TRACKER, { cwd: dir }, dir).stdout);
  assert.match(trk.hookSpecificOutput.additionalContext, /step-7 failed → step-5/);
  assert.equal(readState(statePath).step, 'step-5');
  assert.deepEqual(readState(statePath).signals, {}, 'signals cleared on route');

  rmSync(dir, { recursive: true, force: true });
  console.log('  cycle 2 (gate fail routing) OK');
}

// -----------------------------------------------------------------------------
// Cycle 3: /qa full happy path — skips step-1/2/3/9; ends at step-10
// -----------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-int-'));
  const statePath = seedWorkflow(dir, 'typo-fix', 'qa', 'step-4');

  writeSignal(statePath, 'tests_exist_and_red', true);
  runScript(TRACKER, { cwd: dir }, dir);
  assert.equal(readState(statePath).step, 'step-5');

  writeSignal(statePath, 'tests_green', true);
  runScript(TRACKER, { cwd: dir }, dir);
  assert.equal(readState(statePath).step, 'step-6');

  writeSignal(statePath, 'review_clean', true);
  runScript(TRACKER, { cwd: dir }, dir);
  assert.equal(readState(statePath).step, 'step-7');

  writeSignal(statePath, 'tests_pass_and_build_clean', true);
  runScript(TRACKER, { cwd: dir }, dir);
  assert.equal(readState(statePath).step, 'step-8');

  writeSignal(statePath, 'e2e_pass', true);
  runScript(TRACKER, { cwd: dir }, dir);
  assert.equal(readState(statePath).step, 'step-10', '/qa skips step-9');

  const inj = JSON.parse(runScript(INJECTOR, { cwd: dir }, dir).stdout);
  assert.match(inj.hookSpecificOutput.additionalContext, /Workflow: qa/);
  assert.match(inj.hookSpecificOutput.additionalContext, /Current mode: QA MODE/);
  assert.match(inj.hookSpecificOutput.additionalContext, /GATE — PAUSE/);

  rmSync(dir, { recursive: true, force: true });
  console.log('  cycle 3 (/qa lifecycle) OK');
}

// -----------------------------------------------------------------------------
// Cycle 4: Feature isolation — explicit pointer binds to one feature
// -----------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-int-'));
  const olderPath = seedWorkflow(dir, 'feature-a', 'feat', 'step-1');
  {
    const s = readState(olderPath);
    s.updated_at = Date.now() - 60_000;
    writeFileSync(olderPath, JSON.stringify(s, null, 2));
  }
  const newerPath = seedWorkflow(dir, 'feature-b', 'qa', 'step-4');

  const inj = JSON.parse(runScript(INJECTOR, { cwd: dir }, dir).stdout);
  assert.match(inj.hookSpecificOutput.additionalContext, /feature-b/);

  // After tracker runs, feature-b is advanced AND pointer is written
  writeSignal(newerPath, 'tests_exist_and_red', true);
  runScript(TRACKER, { cwd: dir }, dir);
  assert.equal(readState(newerPath).step, 'step-5', 'feature-b advanced');
  assert.equal(readState(olderPath).step, 'step-1', 'feature-a untouched');
  const pointer = JSON.parse(readFileSync(join(dir, '.smt/state/active-feature.json'), 'utf-8'));
  assert.equal(pointer.slug, 'feature-b');

  rmSync(dir, { recursive: true, force: true });
  console.log('  cycle 4 (feature isolation) OK');
}

// -----------------------------------------------------------------------------
// Cycle 5: direct command transition replaces stale feat gate with qa output
// -----------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-int-'));

  runKeywordDetector(dir, '/feat add dark mode');
  const featSlug = JSON.parse(readFileSync(join(dir, '.smt', 'state', 'active-feature.json'), 'utf-8')).slug;
  const featStatePath = join(dir, '.smt', 'features', featSlug, 'state', 'workflow.json');
  writeFileSync(featStatePath, JSON.stringify({
    command: 'feat',
    step: 'step-3-interview',
    retry: 0,
    signals: {},
    updated_at: Date.now(),
  }, null, 2));

  let inj = JSON.parse(runScript(INJECTOR, { cwd: dir }, dir).stdout);
  assert.match(inj.hookSpecificOutput.additionalContext, /Workflow: feat/);
  assert.match(inj.hookSpecificOutput.additionalContext, /Current mode: FEAT MODE/);
  assert.match(inj.hookSpecificOutput.additionalContext, /step-3-interview/);

  runKeywordDetector(dir, '/qa fix login typo');

  inj = JSON.parse(runScript(INJECTOR, { cwd: dir }, dir).stdout);
  assert.match(inj.hookSpecificOutput.additionalContext, /Workflow: qa/);
  assert.match(inj.hookSpecificOutput.additionalContext, /step-4/);

  rmSync(dir, { recursive: true, force: true });
  console.log('  cycle 5 (direct feat → qa replacement) OK');
}

// -----------------------------------------------------------------------------
// Cycle 6: Fail-closed TDD — step-4 does NOT advance without tests_exist_and_red signal
// -----------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-int-'));
  const statePath = seedWorkflow(dir, 'tdd-guard', 'feat', 'step-4');

  // No signal set → tracker must NOT advance
  const trk = JSON.parse(runScript(TRACKER, { cwd: dir }, dir).stdout);
  assert.ok(!trk.hookSpecificOutput, 'no signal → no advance');
  assert.equal(readState(statePath).step, 'step-4', 'fail-closed: remains on TDD step');

  // Even after 5 more tool calls, still won't advance
  for (let i = 0; i < 5; i++) runScript(TRACKER, { cwd: dir }, dir);
  assert.equal(readState(statePath).step, 'step-4', 'still on step-4 after 5 more ticks');

  rmSync(dir, { recursive: true, force: true });
  console.log('  cycle 6 (fail-closed TDD guard) OK');
}

// -----------------------------------------------------------------------------
// Cycle 7: scoped workflow guidance is present in step and command docs
// -----------------------------------------------------------------------------
{
  const step5 = readFileSync(join(__dirname, '..', 'steps', 'step-5-implementation.md'), 'utf-8');
  const qa = readFileSync(join(__dirname, '..', 'commands', 'qa.md'), 'utf-8');
  const feat = readFileSync(join(__dirname, '..', 'commands', 'feat.md'), 'utf-8');

  assert.match(step5, /selected task|changed surface|scoped/i);
  assert.match(step5, /autonomously|without asking the user|do not ask the user/i);
  assert.match(qa, /repo-wide.*forbidden|forbidden.*repo-wide/i);
  assert.match(feat, /repo-wide.*forbidden|forbidden.*repo-wide/i);

  console.log('  cycle 7 (scoped guidance docs present) OK');
}

console.log('integration-workflow: OK');
