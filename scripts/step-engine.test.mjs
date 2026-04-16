// Tests for scripts/step-injector.mjs and scripts/step-tracker.mjs.
// Run: node scripts/step-engine.test.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { parseYaml } from './lib/yaml-parser.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INJECTOR = join(__dirname, 'step-injector.mjs');
const TRACKER = join(__dirname, 'step-tracker.mjs');

function runScript(scriptPath, payload, { cwd } = {}) {
  return spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    cwd,
    env: { ...process.env, NO_COLOR: '1' },
  });
}

function makeFeatureDir(baseDir, slug, workflowState = null) {
  const featureDir = join(baseDir, '.smt', 'features', slug);
  const taskDir = join(featureDir, 'task');
  const stateDir = join(featureDir, 'state');
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(taskDir, 'plan.md'), `# ${slug}\n`);
  if (workflowState) {
    writeFileSync(join(stateDir, 'workflow.json'), JSON.stringify(workflowState, null, 2));
  }
}

function setActivePointer(baseDir, slug) {
  const stateDir = join(baseDir, '.smt', 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'active-feature.json'), JSON.stringify({ slug, updated_at: Date.now() }));
}

function readState(baseDir, slug) {
  return JSON.parse(readFileSync(join(baseDir, '.smt/features', slug, 'state/workflow.json'), 'utf-8'));
}

// -----------------------------------------------------------------------------
// YAML parser tests
// -----------------------------------------------------------------------------

{
  const y = parseYaml(`name: feat
description: "Full 10-step: workflow"
steps:
  step-1:
    name: Problem Recognition
    next: step-2
  step-2:
    name: Learning
    on_fail:
      code_quality: step-5
      security: step-5
    options: [rework:step-3, complete, hold]
`);
  assert.equal(y.name, 'feat');
  assert.equal(y.description, 'Full 10-step: workflow', 'quoted string with colon preserved');
  assert.equal(y.steps['step-1'].next, 'step-2');
  assert.deepEqual(y.steps['step-2'].on_fail, { code_quality: 'step-5', security: 'step-5' });
  assert.deepEqual(y.steps['step-2'].options, ['rework:step-3', 'complete', 'hold']);
  console.log('  yaml parser (quoted, nested maps, flow list) OK');
}

{
  const y = parseYaml(`list:
  - alpha
  - beta
`);
  assert.deepEqual(y.list, ['alpha', 'beta'], 'block list form parsed');
  console.log('  yaml parser (block list) OK');
}

// -----------------------------------------------------------------------------
// step-injector tests
// -----------------------------------------------------------------------------

// Case 1: no active workflow → no-op
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-inj-'));
  const res = runScript(INJECTOR, { cwd: dir }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.hookSpecificOutput);
  rmSync(dir, { recursive: true, force: true });
  console.log('  injector case 1 (no workflow) OK');
}

// Case 1b: unrelated explicit slash command suppresses stale workflow injection
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-inj-'));
  makeFeatureDir(dir, 'demo', { command: 'qa', step: 'step-10', retry: 0, updated_at: Date.now() });
  setActivePointer(dir, 'demo');
  const res = runScript(INJECTOR, { cwd: dir, prompt: '/help' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.hookSpecificOutput, 'unrelated slash command must not get stale workflow overlay');
  rmSync(dir, { recursive: true, force: true });
  console.log('  injector case 1b (unrelated slash suppresses stale workflow) OK');
}

// Case 1c: ordinary unrelated prompt suppresses stale workflow injection
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-inj-'));
  makeFeatureDir(dir, 'demo', { command: 'qa', step: 'step-10', retry: 0, updated_at: Date.now() });
  setActivePointer(dir, 'demo');
  const res = runScript(INJECTOR, { cwd: dir, prompt: 'Templates랑 dashboard에서 로딩 flicker 고쳐줘' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.hookSpecificOutput, 'unrelated natural-language request must not get stale workflow overlay');
  rmSync(dir, { recursive: true, force: true });
  console.log('  injector case 1c (unrelated prompt suppresses stale workflow) OK');
}

// Case 2: step-1 prompt injected
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-inj-'));
  makeFeatureDir(dir, 'demo', { command: 'feat', step: 'step-1', retry: 0, updated_at: Date.now() });
  const res = runScript(INJECTOR, { cwd: dir }, { cwd: dir });
  const ctx = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Workflow: feat/);
  assert.match(ctx, /Current mode: FEAT MODE/);
  assert.match(ctx, /step-1/);
  assert.match(ctx, /Problem Recognition/);
  rmSync(dir, { recursive: true, force: true });
  console.log('  injector case 2 (step-1 prompt) OK');
}

// Case 3: gate step → PAUSE with explicit mode copy
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-inj-'));
  makeFeatureDir(dir, 'demo', { command: 'feat', step: 'step-3-interview', retry: 0, updated_at: Date.now() });
  const res = runScript(INJECTOR, { cwd: dir }, { cwd: dir });
  const ctx = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Workflow: feat/);
  assert.match(ctx, /Current mode: FEAT MODE/);
  assert.match(ctx, /GATE — PAUSE/);
  rmSync(dir, { recursive: true, force: true });
  console.log('  injector case 3 (gate pause) OK');
}

// Case 4: retry shown
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-inj-'));
  makeFeatureDir(dir, 'demo', { command: 'feat', step: 'step-5', retry: 2, updated_at: Date.now() });
  const res = runScript(INJECTOR, { cwd: dir }, { cwd: dir });
  const ctx = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Retry 2/);
  rmSync(dir, { recursive: true, force: true });
  console.log('  injector case 4 (retry tag) OK');
}

// Case 5: explicit active-feature pointer wins over mtime
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-inj-'));
  const newer = Date.now();
  const older = newer - 60_000;
  makeFeatureDir(dir, 'older', { command: 'feat', step: 'step-1', retry: 0, updated_at: older });
  makeFeatureDir(dir, 'newer', { command: 'qa', step: 'step-4', retry: 0, updated_at: newer });
  setActivePointer(dir, 'older'); // user explicitly selects older
  const res = runScript(INJECTOR, { cwd: dir }, { cwd: dir });
  const ctx = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Workflow: feat/, 'explicit pointer overrides mtime fallback');
  assert.match(ctx, /older/);
  rmSync(dir, { recursive: true, force: true });
  console.log('  injector case 5 (explicit active pointer) OK');
}

// -----------------------------------------------------------------------------
// step-tracker tests
// -----------------------------------------------------------------------------

// Case 6: no workflow
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-trk-'));
  const res = runScript(TRACKER, { cwd: dir }, { cwd: dir });
  assert.equal(JSON.parse(res.stdout).continue, true);
  rmSync(dir, { recursive: true, force: true });
  console.log('  tracker case 6 (no workflow) OK');
}

// Case 7: gate step — no auto-advance
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-trk-'));
  makeFeatureDir(dir, 'demo', { command: 'feat', step: 'step-3-interview', retry: 0, updated_at: Date.now() });
  const res = runScript(TRACKER, { cwd: dir }, { cwd: dir });
  assert.ok(!JSON.parse(res.stdout).hookSpecificOutput);
  assert.equal(readState(dir, 'demo').step, 'step-3-interview');
  rmSync(dir, { recursive: true, force: true });
  console.log('  tracker case 7 (gate no auto-advance) OK');
}

// Case 8: gate pass → advance
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-trk-'));
  makeFeatureDir(dir, 'demo', { command: 'feat', step: 'step-4', retry: 0, signals: { tests_exist_and_red: true }, updated_at: Date.now() });
  const res = runScript(TRACKER, { cwd: dir }, { cwd: dir });
  assert.match(JSON.parse(res.stdout).hookSpecificOutput.additionalContext, /step-4 complete → step-5/);
  const state = readState(dir, 'demo');
  assert.equal(state.step, 'step-5');
  assert.deepEqual(state.signals, {}, 'signals reset on advance');
  rmSync(dir, { recursive: true, force: true });
  console.log('  tracker case 8 (gate pass → advance) OK');
}

// Case 9: FAIL-CLOSED — absent signal does NOT advance
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-trk-'));
  makeFeatureDir(dir, 'demo', { command: 'feat', step: 'step-4', retry: 0, updated_at: Date.now() });
  const res = runScript(TRACKER, { cwd: dir }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.hookSpecificOutput, 'no signal → no advance context');
  assert.equal(readState(dir, 'demo').step, 'step-4', 'fail-closed: stays on step-4');
  rmSync(dir, { recursive: true, force: true });
  console.log('  tracker case 9 (fail-closed: absent signal waits) OK');
}

// Case 10: on_fail string route
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-trk-'));
  makeFeatureDir(dir, 'demo', { command: 'feat', step: 'step-7', retry: 0, signals: { tests_pass_and_build_clean: false }, updated_at: Date.now() });
  const res = runScript(TRACKER, { cwd: dir }, { cwd: dir });
  assert.match(JSON.parse(res.stdout).hookSpecificOutput.additionalContext, /step-7 failed → step-5/);
  assert.equal(readState(dir, 'demo').step, 'step-5');
  rmSync(dir, { recursive: true, force: true });
  console.log('  tracker case 10 (on_fail string route) OK');
}

// Case 11: on_fail map route by failure_category
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-trk-'));
  makeFeatureDir(dir, 'demo', { command: 'feat', step: 'step-6', retry: 0, signals: { review_clean: false, failure_category: 'plan_mismatch' }, updated_at: Date.now() });
  const res = runScript(TRACKER, { cwd: dir }, { cwd: dir });
  assert.match(JSON.parse(res.stdout).hookSpecificOutput.additionalContext, /plan_mismatch.*step-3/);
  assert.equal(readState(dir, 'demo').step, 'step-3');
  rmSync(dir, { recursive: true, force: true });
  console.log('  tracker case 11 (on_fail map route) OK');
}

// Case 12: on_fail map "continue" category (low) → advance to next
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-trk-'));
  makeFeatureDir(dir, 'demo', { command: 'feat', step: 'step-9', retry: 0, signals: { team_review_clean: false, failure_category: 'low' }, updated_at: Date.now() });
  const res = runScript(TRACKER, { cwd: dir }, { cwd: dir });
  assert.match(JSON.parse(res.stdout).hookSpecificOutput.additionalContext, /low.*continue/);
  assert.equal(readState(dir, 'demo').step, 'step-10', 'low → continue → next step');
  rmSync(dir, { recursive: true, force: true });
  console.log('  tracker case 12 (on_fail low → continue) OK');
}

// Case 13: retry increment
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-trk-'));
  makeFeatureDir(dir, 'demo', { command: 'feat', step: 'step-5', retry: 0, signals: { tests_green: false }, updated_at: Date.now() });
  const res = runScript(TRACKER, { cwd: dir }, { cwd: dir });
  assert.match(JSON.parse(res.stdout).hookSpecificOutput.additionalContext, /retry 1\/3/);
  assert.equal(readState(dir, 'demo').retry, 1);
  rmSync(dir, { recursive: true, force: true });
  console.log('  tracker case 13 (retry increment) OK');
}

// Case 14: max_retry exceeded → on_max_retry
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-trk-'));
  makeFeatureDir(dir, 'demo', { command: 'feat', step: 'step-5', retry: 2, signals: { tests_green: false }, updated_at: Date.now() });
  const res = runScript(TRACKER, { cwd: dir }, { cwd: dir });
  assert.match(JSON.parse(res.stdout).hookSpecificOutput.additionalContext, /exceeded retry budget/);
  assert.equal(readState(dir, 'demo').step, 'step-2');
  rmSync(dir, { recursive: true, force: true });
  console.log('  tracker case 14 (max_retry → on_max_retry) OK');
}

// Case 15: tracker updates active-feature pointer
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-trk-'));
  makeFeatureDir(dir, 'auth', { command: 'feat', step: 'step-4', retry: 0, signals: { tests_exist_and_red: true }, updated_at: Date.now() });
  runScript(TRACKER, { cwd: dir }, { cwd: dir });
  const pointer = JSON.parse(readFileSync(join(dir, '.smt/state/active-feature.json'), 'utf-8'));
  assert.equal(pointer.slug, 'auth');
  rmSync(dir, { recursive: true, force: true });
  console.log('  tracker case 15 (active-feature pointer written) OK');
}

// Case 16: atomic write — no tmp files left behind
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-trk-'));
  makeFeatureDir(dir, 'demo', { command: 'feat', step: 'step-4', retry: 0, signals: { tests_exist_and_red: true }, updated_at: Date.now() });
  runScript(TRACKER, { cwd: dir }, { cwd: dir });
  const files = readdirSync(join(dir, '.smt/features/demo/state'));
  const tmpFiles = files.filter(f => f.includes('.tmp.'));
  assert.equal(tmpFiles.length, 0, 'no tmp files after atomic write');
  rmSync(dir, { recursive: true, force: true });
  console.log('  tracker case 16 (atomic write, no tmp left) OK');
}

// Case 17: stale step-id → recovery hint injected
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-inj-'));
  makeFeatureDir(dir, 'demo', { command: 'feat', step: 'step-does-not-exist', retry: 0, updated_at: Date.now() });
  const res = runScript(INJECTOR, { cwd: dir }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.ok(out.hookSpecificOutput, 'stale step-id must inject recovery hint');
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /WARNING.*does not exist/);
  assert.match(ctx, /Valid steps:/);
  rmSync(dir, { recursive: true, force: true });
  console.log('  injector case 17 (stale step-id recovery) OK');
}

// Case 18: corrupt workflow.json → injector injects recovery hint, not silent no-op
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-inj-'));
  const featureDir = join(dir, '.smt', 'features', 'demo');
  const stateDir = join(featureDir, 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'workflow.json'), '{ this is not valid json');
  // Explicit pointer so injector picks this feature
  const ptrDir = join(dir, '.smt', 'state');
  mkdirSync(ptrDir, { recursive: true });
  writeFileSync(join(ptrDir, 'active-feature.json'), JSON.stringify({ slug: 'demo' }));
  const res = runScript(INJECTOR, { cwd: dir }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.ok(out.hookSpecificOutput);
  assert.match(out.hookSpecificOutput.additionalContext, /Corrupt JSON/);
  rmSync(dir, { recursive: true, force: true });
  console.log('  injector case 18 (corrupt state recovery) OK');
}

// Case 19: tracker re-prompts when failure_category missing on on_fail map
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-trk-'));
  makeFeatureDir(dir, 'demo', { command: 'feat', step: 'step-6', retry: 0, signals: { review_clean: false }, updated_at: Date.now() });
  const res = runScript(TRACKER, { cwd: dir }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.ok(out.hookSpecificOutput, 'must re-prompt instead of silent wait');
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /CATEGORY REQUIRED/);
  assert.match(ctx, /code_quality.*bug.*security/);
  // State unchanged
  assert.equal(readState(dir, 'demo').step, 'step-6');
  rmSync(dir, { recursive: true, force: true });
  console.log('  tracker case 19 (category re-prompt) OK');
}

// Case 20: CAS — version bumps on each write
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-trk-'));
  makeFeatureDir(dir, 'demo', { command: 'feat', step: 'step-4', retry: 0, signals: { tests_exist_and_red: true }, version: 0, updated_at: Date.now() });
  runScript(TRACKER, { cwd: dir }, { cwd: dir });
  const s = readState(dir, 'demo');
  assert.equal(s.step, 'step-5');
  assert.equal(s.version, 1, 'version bumped after advance');
  rmSync(dir, { recursive: true, force: true });
  console.log('  tracker case 20 (CAS version bump) OK');
}

// Case 21: YAML parser handles escape sequences in double-quoted strings
{
  const y = parseYaml(`description: "line 1\\nline 2\\ttab"
raw: 'can''t'
`);
  assert.equal(y.description, 'line 1\nline 2\ttab', 'double-quoted unescapes \\n and \\t');
  assert.equal(y.raw, "can't", 'single-quoted YAML-style unescape');
  console.log('  yaml parser (escape sequences) OK');
}

// Case 22: version-absent workflow.json → first tracker write produces version=1
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-trk-'));
  // Seed WITHOUT version field — simulates agent/tasker-created state
  const featureDir = join(dir, '.smt', 'features', 'fresh');
  const taskDir = join(featureDir, 'task');
  const stateDir = join(featureDir, 'state');
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(taskDir, 'plan.md'), '# fresh\n');
  writeFileSync(join(stateDir, 'workflow.json'), JSON.stringify({
    command: 'feat', step: 'step-4', retry: 0, signals: { tests_exist_and_red: true }, updated_at: Date.now(),
  }));
  runScript(TRACKER, { cwd: dir }, { cwd: dir });
  const s = readState(dir, 'fresh');
  assert.equal(s.step, 'step-5');
  assert.equal(s.version, 1, 'missing-version path writes version=1');
  rmSync(dir, { recursive: true, force: true });
  console.log('  tracker case 22 (version-absent first write) OK');
}

// Case 22b: real CAS conflict — pre-advance on-disk version between agent state read and tracker write
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-trk-'));
  makeFeatureDir(dir, 'demo', { command: 'feat', step: 'step-4', retry: 0, signals: { tests_exist_and_red: true }, version: 5, updated_at: Date.now() });
  // Simulate: state was read at version=5 but another writer has since advanced to 99 on disk.
  // To force CAS conflict from tracker's main flow, we need tracker to think it's at v=5 but
  // writeStateCAS finds v=99 on disk. This happens when state.version in memory is v=5 but disk is v=99.
  // Achieve this by making state file contain v=99 but our tracker reads it fresh — so actually it'll
  // read v=99 and CAS passes. True conflict requires race. Instead: test writeStateCAS directly.
  const statePath = join(dir, '.smt/features/demo/state/workflow.json');
  const diskState = JSON.parse(readFileSync(statePath, 'utf-8'));
  writeFileSync(statePath, JSON.stringify({ ...diskState, version: 99 }));
  // Call tracker with expectedVersion=5 via a snapshot from earlier — tracker's main reads fresh so CAS passes.
  // This test verifies CAS path doesn't crash; a pure-unit test of writeStateCAS would need direct import.
  const res = runScript(TRACKER, { cwd: dir }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  // After run: state advanced from v=99 to v=100 (CAS re-reads on-disk, so no conflict)
  assert.ok(out.continue === true);
  const s2 = JSON.parse(readFileSync(statePath, 'utf-8'));
  assert.equal(s2.version, 100, 'CAS reads live on-disk version and bumps from there');
  rmSync(dir, { recursive: true, force: true });
  console.log('  tracker case 22b (CAS reads live version) OK');
}

// Case 23: corrupt sibling feature — injector surfaces warning alongside active context
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-inj-'));
  makeFeatureDir(dir, 'good', { command: 'feat', step: 'step-1', retry: 0, updated_at: Date.now() });
  // Corrupt sibling
  const badDir = join(dir, '.smt/features/bad/state');
  mkdirSync(badDir, { recursive: true });
  writeFileSync(join(badDir, 'workflow.json'), '{ broken');
  const res = runScript(INJECTOR, { cwd: dir }, { cwd: dir });
  const ctx = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /good/, 'active feature still surfaced');
  assert.match(ctx, /Corrupt sibling state/, 'sibling corruption warned');
  rmSync(dir, { recursive: true, force: true });
  console.log('  injector case 23 (corrupt sibling surfaced) OK');
}

// Case 24: 7 corrupt siblings → truncated to 5 + "and 2 more"
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-inj-'));
  makeFeatureDir(dir, 'good', { command: 'feat', step: 'step-1', retry: 0, updated_at: Date.now() });
  for (let i = 0; i < 7; i++) {
    const badDir = join(dir, `.smt/features/bad${i}/state`);
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'workflow.json'), '{ broken');
  }
  const res = runScript(INJECTOR, { cwd: dir }, { cwd: dir });
  const ctx = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /and 2 more/, 'truncation suffix rendered');
  rmSync(dir, { recursive: true, force: true });
  console.log('  injector case 24 (corrupt siblings truncated at 5) OK');
}

// Case 25: writeStateCAS conflict — stale expectedVersion returns false
{
  const { writeStateCAS } = await import('./step-tracker.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'smt-cas-'));
  const statePath = join(dir, 'workflow.json');
  writeFileSync(statePath, JSON.stringify({ command: 'feat', step: 'step-5', version: 10 }));
  // Stale expectedVersion=5, on-disk=10 → must refuse
  const ok = writeStateCAS(statePath, 5, { command: 'feat', step: 'step-6' });
  assert.equal(ok, false, 'stale expectedVersion must fail CAS');
  const s = JSON.parse(readFileSync(statePath, 'utf-8'));
  assert.equal(s.step, 'step-5', 'disk state unchanged on CAS fail');
  assert.equal(s.version, 10);
  // Matching expectedVersion=10 → succeeds, bumps to 11
  const before = Date.now();
  const ok2 = writeStateCAS(statePath, 10, { command: 'feat', step: 'step-6' });
  assert.equal(ok2, true);
  const s2 = JSON.parse(readFileSync(statePath, 'utf-8'));
  assert.equal(s2.step, 'step-6');
  assert.equal(s2.version, 11);
  assert.ok(s2.updated_at >= before, 'updated_at bumped on successful write');
  rmSync(dir, { recursive: true, force: true });
  console.log('  tracker case 25 (real CAS conflict rejected) OK');
}

// Case 26: step-5 prompt requires scoped validation and autonomous routing
{
  const step5 = readFileSync(join(__dirname, '..', 'steps', 'step-5-implementation.md'), 'utf-8');
  assert.match(step5, /selected task|changed surface|scoped/i, 'step-5 must require scoped validation');
  assert.doesNotMatch(step5, /fresh test run \+ `?tsc --noEmit`? clean/i, 'step-5 must not require unconditional repo-wide tsc');
  assert.match(step5, /do not ask the user|without asking the user|autonomously/i, 'step-5 must require autonomous gate decisions');
  console.log('  tracker case 26 (step-5 prompt enforces scoped autonomous validation) OK');
}

// Case 27: /qa command forbids repo-wide widening for validation
{
  const qa = readFileSync(join(__dirname, '..', 'commands', 'qa.md'), 'utf-8');
  assert.match(qa, /scoped validation|changed surface|selected task/i, '/qa must define scoped validation');
  assert.match(qa, /repo-wide|full suite/i, '/qa must explicitly forbid repo-wide widening');
  console.log('  tracker case 27 (/qa docs enforce scoped validation) OK');
}

console.log('step-engine: OK');

// helper
import { readdirSync } from 'node:fs';
