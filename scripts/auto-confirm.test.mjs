// Real-interface tests for scripts/auto-confirm.mjs (Stop hook) and
// scripts/auto-confirm-consumer.mjs (UserPromptSubmit hook).
//
// Exercises the queue-file drop + consume contract. No PATH neutering tricks.
// Run: node scripts/auto-confirm.test.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, 'auto-confirm.mjs');
const CONSUMER = join(__dirname, 'auto-confirm-consumer.mjs');

function runScript(scriptPath, payload, { cwd, env } = {}) {
  const res = spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    cwd,
    env: { ...process.env, NO_COLOR: '1', SMELTER_TEST: '1', ...(env || {}) },
  });
  if (res.status !== 0) {
    throw new Error(`script failed: ${scriptPath}\nstatus=${res.status}\nstdout=${res.stdout}\nstderr=${res.stderr}`);
  }
  return res;
}

function runModelClassifier(prompt, { cwd, sessionId = 'test-session', env } = {}) {
  return spawnSync(process.execPath, ['-e', `
    import { classifyPrompt } from ${JSON.stringify(HOOK.replace('auto-confirm.mjs', 'lib/subagent-classifier.mjs'))};
    const result = classifyPrompt(${JSON.stringify('__PROMPT__')}.replace('__PROMPT__', process.env.TEST_PROMPT), { cwd: process.env.TEST_CWD, sessionId: process.env.TEST_SESSION_ID });
    process.stdout.write(JSON.stringify(result));
  `], {
    encoding: 'utf-8',
    cwd,
    env: {
      ...process.env,
      NO_COLOR: '1',
      SMELTER_TEST: '1',
      TEST_PROMPT: prompt,
      TEST_CWD: cwd || process.cwd(),
      TEST_SESSION_ID: sessionId,
      ...(env || {}),
    },
  });
}

function parseJson(stdout) {
  return JSON.parse(stdout.trim());
}

function makeProject({ hasPending }) {
  const dir = mkdtempSync(join(tmpdir(), 'lh-ac-'));
  const taskDir = join(dir, '.smt', 'features', 'test-feature', 'task');
  mkdirSync(taskDir, { recursive: true });
  if (hasPending) {
    writeFileSync(join(taskDir, 'plan.md'), '# Test Feature\n');
    writeFileSync(join(taskDir, 'task-1.md'), '- [ ] Task 1: do the thing\n');
    writeFileSync(join(taskDir, 'task-2.md'), '- [x] Task 2: done already\n');
  } else {
    writeFileSync(join(taskDir, 'plan.md'), '# Test Feature\n');
    writeFileSync(join(taskDir, 'task-1.md'), '- [x] Task 1: done\n');
  }
  return dir;
}

// Case 1: context-limit stop → always continue
{
  const dir = makeProject({ hasPending: true });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'max_tokens' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'context-limit stop must pass through');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 1 (context-limit) OK');
}

// Case 2a: user abort via user_cancel → continue + interrupt marker
{
  const dir = makeProject({ hasPending: true });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'user_cancel' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'user_cancel must pass through');
  assert.ok(
    existsSync(join(dir, '.smt', 'state', 'last-interrupt.json')),
    'interrupt marker must be written',
  );
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 2a (user_cancel) OK');
}

// Case 2b: user abort via user_aborted (NEW) → continue, no block
{
  const dir = makeProject({ hasPending: true });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'user_aborted' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'user_aborted must pass through');
  assert.ok(!out.decision, 'must NOT block on user_aborted');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 2b (user_aborted) OK');
}

// Case 3a: no pending + non-question message → continue (no infinite loop)
{
  const dir = makeProject({ hasPending: false });
  const transcript = [{ role: 'assistant', content: 'Done. All changes pushed.' }];
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript, session_id: 'sess-none' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'no pending + no question → pass through');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 3a (no-pending, no-question) OK');
}

// Case 3b: no pending + confirmation question → block + queue
{
  const dir = makeProject({ hasPending: false });
  const transcript = [{ role: 'assistant', content: 'Tests written. Shall I proceed with implementation?' }];
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript, session_id: 'sess-q' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block', 'confirmation question triggers forward');
  const queuePath = join(dir, '.smt', 'state', 'queue-sess-q.json');
  assert.ok(existsSync(queuePath), 'queue file dropped for question');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 3b (no-pending, confirmation-question) OK');
}

// Case 4: pending + end_turn → block + queue file dropped (NO claude spawn)
{
  const dir = makeProject({ hasPending: true });
  const transcript = [
    { role: 'user', content: 'fix it' },
    { role: 'assistant', content: 'Shall I proceed with updating auth.ts?' },
  ];
  const start = Date.now();
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript, session_id: 'sess-case4' }, { cwd: dir });
  const elapsed = Date.now() - start;
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block', 'pending task → must block');
  assert.match(out.reason, /\[AUTO-CONFIRM\]/, 'reason must carry AUTO-CONFIRM tag');
  assert.ok(elapsed < 2000, `Stop hook must complete fast (got ${elapsed}ms) — no sub-agent spawn`);

  const queuePath = join(dir, '.smt', 'state', 'queue-sess-case4.json');
  assert.ok(existsSync(queuePath), 'session-scoped queue file must be dropped');
  const queued = JSON.parse(readFileSync(queuePath, 'utf-8'));
  assert.ok(queued.last_message.includes('Shall I proceed'), 'queue must include verbatim last message');
  assert.equal(queued.session_id, 'sess-case4', 'queue must carry session_id');
  assert.ok(Array.isArray(queued.pending_tasks) && queued.pending_tasks.length > 0, 'queue must include pending tasks');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 4 (pending-block + queue drop) OK');
}

// Case 5: autoConfirm disabled via config → continue, no queue drop
{
  const dir = makeProject({ hasPending: true });
  const homeDir = mkdtempSync(join(tmpdir(), 'lh-ac-home-'));
  mkdirSync(join(homeDir, '.smt'), { recursive: true });
  writeFileSync(
    join(homeDir, '.smt', 'config.json'),
    JSON.stringify({ autoConfirm: false }),
  );
  const res = runScript(
    HOOK,
    { cwd: dir, stop_reason: 'end_turn', transcript: [], session_id: 'sess-disabled' },
    { cwd: dir, env: { HOME: homeDir, NO_COLOR: '1' } },
  );
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'autoConfirm=false must allow stop');
  const stateDir = join(dir, '.smt', 'state');
  if (existsSync(stateDir)) {
    const files = readdirSync(stateDir).filter(f => f.startsWith('queue-'));
    assert.equal(files.length, 0, 'disabled autoConfirm must not drop queue file');
  }
  rmSync(dir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
  console.log('  case 5 (disabled-config) OK');
}

// Case 6: consumer reads and deletes queue file, injects additionalContext
{
  const dir = makeProject({ hasPending: true });
  // Seed queue via Stop hook
  runScript(HOOK, {
    cwd: dir,
    session_id: 'sess-6',
    stop_reason: 'end_turn',
    transcript: [{ role: 'assistant', content: 'Shall I continue the migration?' }],
  }, { cwd: dir });
  const queuePath = join(dir, '.smt', 'state', 'queue-sess-6.json');
  assert.ok(existsSync(queuePath), 'precondition: session-scoped queue file exists');

  // Consume with matching session id
  const res = runScript(CONSUMER, { cwd: dir, session_id: 'sess-6', prompt: 'next step' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(out.hookSpecificOutput, 'consumer must emit hookSpecificOutput');
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /AUTO-CONFIRM FORWARD/);
  assert.match(ctx, /Shall I continue the migration/);
  assert.match(ctx, /Pending tasks/);
  assert.ok(!existsSync(queuePath), 'consumer must delete queue file after reading');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 6 (consumer drop+consume) OK');
}

// Case 7: consumer with no queue file → plain continue
{
  const dir = makeProject({ hasPending: false });
  const res = runScript(CONSUMER, { cwd: dir, prompt: 'hi' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.hookSpecificOutput, 'no queue → no additionalContext');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 7 (consumer no-queue) OK');
}

// Case 8: two producers (different sessions) → both payloads survive
{
  const dir = makeProject({ hasPending: true });
  runScript(HOOK, {
    cwd: dir, session_id: 'sess-A',
    stop_reason: 'end_turn',
    transcript: [{ role: 'assistant', content: 'Producer A message' }],
  }, { cwd: dir });
  runScript(HOOK, {
    cwd: dir, session_id: 'sess-B',
    stop_reason: 'end_turn',
    transcript: [{ role: 'assistant', content: 'Producer B message' }],
  }, { cwd: dir });

  const qA = join(dir, '.smt', 'state', 'queue-sess-A.json');
  const qB = join(dir, '.smt', 'state', 'queue-sess-B.json');
  assert.ok(existsSync(qA), 'producer A queue must survive');
  assert.ok(existsSync(qB), 'producer B queue must survive');
  const a = JSON.parse(readFileSync(qA, 'utf-8'));
  const b = JSON.parse(readFileSync(qB, 'utf-8'));
  assert.ok(a.last_message.includes('Producer A'));
  assert.ok(b.last_message.includes('Producer B'));
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 8 (race: two producers both survive) OK');
}

// Case 9: session-A producer, session-B consumer → B must NOT consume A's payload
{
  const dir = makeProject({ hasPending: true });
  runScript(HOOK, {
    cwd: dir, session_id: 'sess-prod',
    stop_reason: 'end_turn',
    transcript: [{ role: 'assistant', content: 'Message for producer session' }],
  }, { cwd: dir });
  const qProd = join(dir, '.smt', 'state', 'queue-sess-prod.json');
  assert.ok(existsSync(qProd), 'precondition: producer queue dropped');

  // Different session consumes — should NOT inject (file for a different session)
  const res = runScript(CONSUMER, { cwd: dir, session_id: 'sess-other', prompt: 'hi' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.hookSpecificOutput, 'cross-session consumer must NOT inject peer session payload');
  // Producer file preserved for its own session
  assert.ok(existsSync(qProd), 'peer queue must be preserved for its own session');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 9 (session scoping on consume) OK');
}

// Case 10: legacy sid-less queue file younger than 5s → consumer must SKIP + leave intact
{
  const dir = makeProject({ hasPending: true });
  const stateDir = join(dir, '.smt', 'state');
  mkdirSync(stateDir, { recursive: true });
  const legacyPath = join(stateDir, 'auto-confirm-queue.json');
  // sid-less payload, just written → mtime is "now"
  writeFileSync(legacyPath, JSON.stringify({
    timestamp: Date.now(),
    last_message: 'legacy young message',
    pending_tasks: [{ status: 'pending', title: 'x' }],
  }));
  const res = runScript(CONSUMER, { cwd: dir, session_id: 'sess-consumer', prompt: 'hi' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.hookSpecificOutput, 'young sid-less file must not be consumed');
  assert.ok(existsSync(legacyPath), 'young sid-less file must be preserved on disk');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 10 (legacy young-file skip) OK');
}

// Case 11: legacy sid-less queue file older than 5s → consumer adopts + deletes
{
  const dir = makeProject({ hasPending: true });
  const stateDir = join(dir, '.smt', 'state');
  mkdirSync(stateDir, { recursive: true });
  const legacyPath = join(stateDir, 'auto-confirm-queue.json');
  writeFileSync(legacyPath, JSON.stringify({
    timestamp: Date.now(),
    last_message: 'legacy old message',
    pending_tasks: [{ status: 'pending', title: 'x' }],
  }));
  // Backdate mtime to 10s ago via utimes
  const { utimesSync } = await import('node:fs');
  const past = (Date.now() - 10_000) / 1000;
  utimesSync(legacyPath, past, past);

  const res = runScript(CONSUMER, { cwd: dir, session_id: 'sess-consumer', prompt: 'continue' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(out.hookSpecificOutput, 'old sid-less file must be adopted');
  assert.match(out.hookSpecificOutput.additionalContext, /legacy old message/);
  assert.ok(!existsSync(legacyPath), 'adopted legacy file must be deleted');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 11 (legacy old-file adopted) OK');
}

// Case 12: unrelated prompt must not consume queue payload
{
  const dir = makeProject({ hasPending: true });
  runScript(HOOK, {
    cwd: dir,
    session_id: 'sess-unrelated',
    stop_reason: 'end_turn',
    transcript: [{ role: 'assistant', content: 'Continue the current QA workflow.' }],
  }, { cwd: dir });
  const queuePath = join(dir, '.smt', 'state', 'queue-sess-unrelated.json');
  assert.ok(existsSync(queuePath), 'precondition: queue file exists');

  const res = runScript(CONSUMER, { cwd: dir, session_id: 'sess-unrelated', prompt: 'Templates랑 dashboard에서 로딩 flicker 고쳐줘' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.hookSpecificOutput, 'unrelated prompt must not inject queued workflow payload');
  assert.ok(existsSync(queuePath), 'queue file must remain for a real continuation');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12 (unrelated prompt skips queue consume) OK');
}

// Case 13: no pending tasks + self-commitment should still queue for model follow-up
{
  const dir = makeProject({ hasPending: false });
  const transcript = [{ role: 'assistant', content: 'Next I will update auto-confirm to use conversation history and then run the hook tests.' }];
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript, session_id: 'sess-self-commit' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block', 'self-commitment should trigger auto-confirm even without .smt pending tasks');
  const queuePath = join(dir, '.smt', 'state', 'queue-sess-self-commit.json');
  assert.ok(existsSync(queuePath), 'queue file should be written for self-commitment');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 13 (self-commitment queues without pending tasks) OK');
}

// Case 14: mark done prompt should count as a continuation-style consumer prompt
{
  const dir = makeProject({ hasPending: true });
  runScript(HOOK, {
    cwd: dir,
    session_id: 'sess-mark-done',
    stop_reason: 'end_turn',
    transcript: [{ role: 'assistant', content: 'Next I will finish the remaining docs cleanup.' }],
  }, { cwd: dir });
  const queuePath = join(dir, '.smt', 'state', 'queue-sess-mark-done.json');
  assert.ok(existsSync(queuePath), 'precondition: queue file exists');

  const res = runScript(CONSUMER, { cwd: dir, session_id: 'sess-mark-done', prompt: 'mark done!' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(out.hookSpecificOutput, 'mark done should be treated as a continuation prompt');
  assert.ok(!existsSync(queuePath), 'queue file should be consumed by mark done prompt');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 14 (mark done consumes queue) OK');
}

// Case 15: summary-only turn should not queue
{
  const dir = makeProject({ hasPending: false });
  const transcript = [{ role: 'assistant', content: 'Summary: I inspected the hooks, identified the likely cause, and no further concrete action remains.' }];
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript, session_id: 'sess-summary-only' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'summary-only turns should pass through');
  const queuePath = join(dir, '.smt', 'state', 'queue-sess-summary-only.json');
  assert.ok(!existsSync(queuePath), 'summary-only turn must not write queue');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 15 (summary-only turn passes through) OK');
}

// Case 16: explicit ask-user question should not queue without pending tasks
{
  const dir = makeProject({ hasPending: false });
  const transcript = [{ role: 'assistant', content: 'Which approach do you prefer for the auto-confirm classifier?' }];
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript, session_id: 'sess-ask-user' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'true user-input questions should pass through');
  const queuePath = join(dir, '.smt', 'state', 'queue-sess-ask-user.json');
  assert.ok(!existsSync(queuePath), 'ask-user turn must not write queue');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 16 (ask-user turn passes through) OK');
}

console.log('auto-confirm: OK');
