// Real-interface tests for scripts/tool-retry.mjs.
// Run: node scripts/tool-retry.test.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, 'tool-retry.mjs');

function runHook(payload, cwd) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    cwd,
    env: { ...process.env, NO_COLOR: '1' },
  });
  return res;
}

// Fixture: rg timeout → block with Auto-Retry
{
  const dir = mkdtempSync(join(tmpdir(), 'lh-tr-'));
  const res = runHook({
    cwd: dir,
    session_id: 's1',
    tool_name: 'Grep',
    tool_input: { pattern: 'foo', path: '.' },
    tool_output: { stderr: 'Ripgrep search timed out after 10 seconds', exit_code: 124 },
  }, dir);
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block', 'rg-timeout should block');
  assert.match(out.reason, /\[Auto-Retry: Ripgrep timeout\]/);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case rg-timeout OK');
}

// Fixture: file-modified (long form with linter) → block with reread hint
{
  const dir = mkdtempSync(join(tmpdir(), 'lh-tr-'));
  const res = runHook({
    cwd: dir,
    session_id: 's1',
    tool_name: 'Edit',
    tool_input: { file_path: '/tmp/x.ts' },
    tool_output: { error: 'File has been modified since read, either by the user or by a linter.', exit_code: 1 },
  }, dir);
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block', 'file-modified (long form) should block');
  assert.match(out.reason, /\[Auto-Retry: File modified/);
  assert.match(out.reason, /Re-Read/);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case file-modified (long form) OK');
}

// Fixture: file-modified (short form) → still matches
{
  const dir = mkdtempSync(join(tmpdir(), 'lh-tr-'));
  const res = runHook({
    cwd: dir,
    session_id: 's1',
    tool_name: 'Edit',
    tool_input: { file_path: '/tmp/y.ts' },
    tool_output: { error: 'File has been modified since last read.', exit_code: 1 },
  }, dir);
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block', 'file-modified (short form) should block');
  assert.match(out.reason, /File modified/);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case file-modified (short form) OK');
}

// Fixture: rg flag-parse → wrap in bash -c
{
  const dir = mkdtempSync(join(tmpdir(), 'lh-tr-'));
  const res = runHook({
    cwd: dir,
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'rg -E foo .' },
    tool_output: { stderr: 'rg: error parsing flag -E', exit_code: 2 },
  }, dir);
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /bash -c/);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case rg-flag-parse OK');
}

// Fixture: grep exit 1 no match (empty output, empty stderr) → reclassify as success
{
  const dir = mkdtempSync(join(tmpdir(), 'lh-tr-'));
  const res = runHook({
    cwd: dir,
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'grep foo file' },
    tool_output: { stdout: '', stderr: '', exit_code: 1, error: 'grep exit code: 1' },
  }, dir);
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'grep no-match (clean) should NOT block');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case grep-no-match (benign) OK');
}

// NEGATIVE: grep exit 1 with permission-denied stderr → must NOT reclassify
{
  const dir = mkdtempSync(join(tmpdir(), 'lh-tr-'));
  const res = runHook({
    cwd: dir,
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'grep foo /root/private' },
    tool_output: {
      stdout: '',
      stderr: 'grep: /root/private: Permission denied',
      exit_code: 1,
      error: 'grep exit code: 1',
    },
  }, dir);
  const out = JSON.parse(res.stdout);
  // Real failure — either pass through (continue:true, no classifier match) or block,
  // but MUST NOT print reclassified-OK.
  assert.ok(
    !(out.continue === true && /reclassified OK/.test(res.stderr || '')),
    'permission-denied must not be reclassified as grep-no-match success',
  );
  rmSync(dir, { recursive: true, force: true });
  console.log('  case grep permission-denied (negative) OK');
}

// Fixture: unrelated error → no action
{
  const dir = mkdtempSync(join(tmpdir(), 'lh-tr-'));
  const res = runHook({
    cwd: dir,
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_output: { stdout: 'ok', exit_code: 0 },
  }, dir);
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case unrelated-noop OK');
}

// Fixture: retry counter enforcement — 3 consecutive identical failures (same session)
{
  const dir = mkdtempSync(join(tmpdir(), 'lh-tr-'));
  const payload = {
    cwd: dir,
    session_id: 'sess-A',
    tool_name: 'Grep',
    tool_input: { pattern: 'loop', path: '.' },
    tool_output: { stderr: 'Ripgrep search timed out after 10 seconds', exit_code: 124 },
  };
  const first  = JSON.parse(runHook(payload, dir).stdout);
  const second = JSON.parse(runHook(payload, dir).stdout);
  const third  = JSON.parse(runHook(payload, dir).stdout);
  const fourth = JSON.parse(runHook(payload, dir).stdout);
  assert.equal(first.decision, 'block');
  assert.equal(second.decision, 'block');
  assert.equal(third.decision, 'block');
  assert.equal(fourth.continue, true, '4th identical retry must give up');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case retry-cap OK');
}

// NEW: counter-reset-on-success — after success, a subsequent failure starts fresh
{
  const dir = mkdtempSync(join(tmpdir(), 'lh-tr-'));
  const base = {
    cwd: dir,
    session_id: 'sess-B',
    tool_name: 'Grep',
    tool_input: { pattern: 'loop', path: '.' },
  };
  const fail = { ...base, tool_output: { stderr: 'Ripgrep search timed out after 10 seconds', exit_code: 124 } };
  const ok   = { ...base, tool_output: { stdout: 'ok', exit_code: 0 } };
  const a = JSON.parse(runHook(fail, dir).stdout);
  const b = JSON.parse(runHook(fail, dir).stdout);
  assert.equal(a.decision, 'block');
  assert.equal(b.decision, 'block');
  JSON.parse(runHook(ok, dir).stdout); // success — must reset counter
  const c = JSON.parse(runHook(fail, dir).stdout);
  assert.equal(c.decision, 'block', 'after success, new failure must block again');
  assert.match(c.reason, /Attempt 1\/3/, 'counter must restart at 1 after reset');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case counter-reset-on-success OK');
}

// NEW: counter does NOT leak across sessions (same tool+args, different session_id)
{
  const dir = mkdtempSync(join(tmpdir(), 'lh-tr-'));
  const failA = {
    cwd: dir,
    session_id: 'sess-X',
    tool_name: 'Grep',
    tool_input: { pattern: 'leak', path: '.' },
    tool_output: { stderr: 'Ripgrep search timed out after 10 seconds', exit_code: 124 },
  };
  const failB = { ...failA, session_id: 'sess-Y' };
  // Burn through 3 attempts for session X
  runHook(failA, dir);
  runHook(failA, dir);
  runHook(failA, dir);
  const x4 = JSON.parse(runHook(failA, dir).stdout);
  assert.equal(x4.continue, true, 'session X must exhaust at 4th');
  // Session Y should still start fresh
  const y1 = JSON.parse(runHook(failB, dir).stdout);
  assert.equal(y1.decision, 'block', 'session Y must not inherit session X counter');
  assert.match(y1.reason, /Attempt 1\/3/, 'session Y must start at attempt 1');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case no-cross-session-leak OK');
}

// NEW: counter expiry — stale entries pruned on read
{
  const dir = mkdtempSync(join(tmpdir(), 'lh-tr-'));
  const stateDir = join(dir, '.smt', 'state');
  mkdirSync(stateDir, { recursive: true });
  // Seed a stale entry (older than 30 min TTL)
  const staleEntry = {
    'deadbeefdeadbeef': { count: 99, updated_at: Date.now() - (31 * 60 * 1000) },
  };
  writeFileSync(join(stateDir, 'tool-retry.json'), JSON.stringify(staleEntry));
  // Trigger a read via a noop payload
  runHook({
    cwd: dir,
    session_id: 'sess-Z',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_output: { stdout: 'ok', exit_code: 0 },
  }, dir);
  const after = JSON.parse(readFileSync(join(stateDir, 'tool-retry.json'), 'utf-8'));
  assert.ok(!('deadbeefdeadbeef' in after), 'stale entry must be pruned on read');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case counter-expiry OK');
}

// NEW: on-disk state key is truly compound (session + tool + args)
// and a same-input, different-session does not resolve to the same raw key.
{
  const { retryKey } = await import('./tool-retry.mjs');
  const k1 = retryKey('sess-A', 'Grep', { pattern: 'foo', path: '.' });
  const k2 = retryKey('sess-B', 'Grep', { pattern: 'foo', path: '.' });
  const k3 = retryKey('sess-A', 'Grep', { pattern: 'foo', path: '.' });
  assert.notEqual(k1, k2, 'different sessions must produce different raw keys');
  assert.equal(k1, k3, 'same (session, tool, args) must be stable');
  console.log('  case retryKey-compound OK');
}

// NEW: session-A exhausts its cap on disk; session-B with identical tool+args
// has a different raw key and therefore is not blocked by A's exhaustion.
{
  const dir = mkdtempSync(join(tmpdir(), 'lh-tr-'));
  const stateDir = join(dir, '.smt', 'state');
  mkdirSync(stateDir, { recursive: true });

  const failA = {
    cwd: dir, session_id: 'sess-A',
    tool_name: 'Grep', tool_input: { pattern: 'iso', path: '.' },
    tool_output: { stderr: 'Ripgrep search timed out after 10 seconds', exit_code: 124 },
  };
  runHook(failA, dir);
  runHook(failA, dir);
  runHook(failA, dir);
  const a4 = JSON.parse(runHook(failA, dir).stdout);
  assert.equal(a4.continue, true, 'session-A must exhaust');

  const onDisk = JSON.parse(readFileSync(join(stateDir, 'tool-retry.json'), 'utf-8'));
  const aKeys = Object.keys(onDisk);
  assert.ok(aKeys.length >= 1, 'session-A must have produced an on-disk key');

  const { retryKey } = await import('./tool-retry.mjs');
  const bKey = retryKey('sess-B', 'Grep', { pattern: 'iso', path: '.' });
  assert.ok(!aKeys.includes(bKey), 'session-B raw key must not collide with session-A keys on disk');

  const failB = { ...failA, session_id: 'sess-B' };
  const b1 = JSON.parse(runHook(failB, dir).stdout);
  assert.equal(b1.decision, 'block', 'session-B must start fresh');
  assert.match(b1.reason, /Attempt 1\/3/);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case on-disk-key-compound-isolation OK');
}

// NEW: undefined/null sessionId under distinct PIDs must produce distinct keys.
// Simulates two concurrent processes where the harness forgot to pass sid.
{
  const { retryKey } = await import('./tool-retry.mjs');
  // In-process sanity: explicit sid vs undefined sid must not collide.
  const kExplicit = retryKey('real-sid', 'Grep', { pattern: 'x' });
  const kUndef    = retryKey(undefined,   'Grep', { pattern: 'x' });
  const kNull     = retryKey(null,        'Grep', { pattern: 'x' });
  assert.notEqual(kExplicit, kUndef, 'explicit sid must differ from undefined-sid fallback');
  assert.notEqual(kExplicit, kNull,  'explicit sid must differ from null-sid fallback');

  // Cross-process: run retryKey in two child processes with different PIDs.
  // With sid missing + no CLAUDE_SESSION env, the fallback uses `pid-${pid}`,
  // so keys from distinct PIDs must differ.
  const { execFileSync } = await import('node:child_process');
  const script = `
    import('${join(__dirname, 'tool-retry.mjs').replace(/\\\\/g, '/')}').then(m => {
      // Clear env so pid-sentinel kicks in.
      process.env.CLAUDE_SESSION = '';
      const k = m.retryKey(undefined, 'Grep', { pattern: 'concurrent' });
      process.stdout.write(k + '|' + process.pid);
    });
  `;
  const envClean = { ...process.env };
  delete envClean.CLAUDE_SESSION;
  delete envClean.CLAUDE_SESSION_ID;
  const outA = execFileSync(process.execPath, ['--input-type=module', '-e', script],
    { encoding: 'utf-8', env: envClean });
  const outB = execFileSync(process.execPath, ['--input-type=module', '-e', script],
    { encoding: 'utf-8', env: envClean });
  const [keyA, pidA] = outA.split('|');
  const [keyB, pidB] = outB.split('|');
  assert.notEqual(pidA, pidB, 'precondition: child PIDs differ');
  assert.notEqual(keyA, keyB, 'sid-less keys from distinct PIDs must differ');
  console.log('  case sid-less-distinct-pid OK');
}

console.log('tool-retry: OK');
