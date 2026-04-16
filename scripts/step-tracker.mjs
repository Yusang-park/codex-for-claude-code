#!/usr/bin/env node
// step-tracker.mjs — PostToolUse hook.
//
// Evaluates the current step's gate and routes workflow.json accordingly.
//
// Gate semantics (FAIL-CLOSED):
//   - step has no `gate` field → advance to next on tool call (trusted step)
//   - step has `gate: <name>`:
//       - state.signals[<name>] === true  → advance
//       - state.signals[<name>] === false → apply on_fail / retry / max_retry
//       - signal absent                    → no-op (wait for agent to set signal)
//
// State writes are atomic (tmp+rename). Also updates
// `.smt/state/active-feature.json` to track current feature.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { printTag } from './lib/yellow-tag.mjs';
import { parseYaml } from './lib/yaml-parser.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HARNESS_ROOT = resolve(__dirname, '..');

function readStdinSync() {
  try { return readFileSync('/dev/stdin', 'utf-8'); } catch { return '{}'; }
}

function readJsonSafe(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    process.stderr.write(`[step-tracker] corrupt JSON at ${path}: ${err.message}\n`);
    return { __corrupt: true };
  }
}

function parseWorkflow(command) {
  const path = join(HARNESS_ROOT, 'workflows', `${command}.yaml`);
  if (!existsSync(path)) return null;
  try { return parseYaml(readFileSync(path, 'utf-8')); }
  catch (err) {
    process.stderr.write(`[step-tracker] YAML parse error: ${err.message}\n`);
    return null;
  }
}

function findActiveFeature(projectDir, sessionId = '') {
  const featuresDir = join(projectDir, '.smt', 'features');
  if (!existsSync(featuresDir)) return null;

  const stateDir = join(projectDir, '.smt', 'state');
  const pointerPath = sessionId
    ? join(stateDir, `active-feature-${sessionId}.json`)
    : join(stateDir, 'active-feature.json');
  const pointer = readJsonSafe(pointerPath);
  if (pointer?.slug) {
    const statePath = join(featuresDir, pointer.slug, 'state', 'workflow.json');
    const state = readJsonSafe(statePath);
    if (state) return { slug: pointer.slug, state, statePath };
  }
  // With a session id but no session-scoped pointer → no active workflow for this session.
  if (sessionId) return null;

  let latest = null;
  let slugs = [];
  try { slugs = readdirSync(featuresDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch {}
  for (const slug of slugs) {
    const statePath = join(featuresDir, slug, 'state', 'workflow.json');
    const state = readJsonSafe(statePath);
    if (!state) continue;
    const ts = state.updated_at || state.created_at || 0;
    if (!latest || ts > latest.ts) latest = { slug, state, statePath, ts };
  }
  return latest;
}

// Atomic write: write to tmp, then rename.
function writeJsonAtomic(path, obj) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, path);
}

// Compare-and-swap write: fails if on-disk state advanced beyond the snapshot
// we read at the start of this invocation. Caller MUST pass the version it read.
// Exported for unit tests.
export function writeStateCAS(statePath, expectedVersion, nextState) {
  const current = readJsonSafe(statePath);
  if (current?.__corrupt) return false;
  const onDiskVersion = current?.version ?? 0;
  if (onDiskVersion !== expectedVersion) return false;
  const payload = { ...nextState, version: onDiskVersion + 1, updated_at: Date.now() };
  // Strip sentinel fields if present
  delete payload.__corrupt;
  writeJsonAtomic(statePath, payload);
  return true;
}

function writeState(statePath, state) {
  // state should include the version as READ — passed in by main().
  const expected = state.version ?? 0;
  const ok = writeStateCAS(statePath, expected, state);
  if (!ok) {
    process.stderr.write(`[step-tracker] CAS conflict at ${statePath} — another writer advanced; skipping\n`);
  }
  return ok;
}

// Pointer updates are idempotent (same {slug} repeated is harmless). Last-writer-wins
// is acceptable because the pointer reflects the most-recently-touched feature, which is
// exactly what parallel tracker invocations would converge on anyway.
function updateActivePointer(projectDir, slug, sessionId = '') {
  const stateDir = join(projectDir, '.smt', 'state');
  const pointerPath = join(stateDir, 'active-feature.json');
  const current = readJsonSafe(pointerPath);
  // Skip write when pointer already names this slug to reduce contention
  if (current && !current.__corrupt && current.slug === slug) {
    if (sessionId) {
      const sessionPointerPath = join(stateDir, `active-feature-${sessionId}.json`);
      writeJsonAtomic(sessionPointerPath, { slug, session_id: sessionId, updated_at: Date.now() });
    }
    return;
  }
  writeJsonAtomic(pointerPath, { slug, session_id: sessionId || '', updated_at: Date.now() });
  if (sessionId) {
    const sessionPointerPath = join(stateDir, `active-feature-${sessionId}.json`);
    writeJsonAtomic(sessionPointerPath, { slug, session_id: sessionId, updated_at: Date.now() });
  }
}

/**
 * Evaluate a named gate. FAIL-CLOSED:
 *   - signal true  → 'pass'
 *   - signal false → 'fail'
 *   - signal absent → 'wait'
 */
function evaluateGate(gateName, state) {
  const signals = state.signals || {};
  if (!(gateName in signals)) return 'wait';
  return signals[gateName] === true ? 'pass' : 'fail';
}

function createOutput(additionalContext) {
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext,
    },
  };
}

function main() {
  printTag('Step Tracker');
  try {
    const input = readStdinSync();
    let data = {};
    try { data = JSON.parse(input); } catch {}

    const projectDir = data.cwd || data.directory || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const sessionId = data.session_id || data.sessionId || '';

    const active = findActiveFeature(projectDir, sessionId);
    if (!active) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    const { slug, state, statePath } = active;
    const workflow = parseWorkflow(state.command);
    if (!workflow || !workflow.steps || !workflow.steps[state.step]) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    const step = workflow.steps[state.step];

    // Gate steps are passive — don't touch state, don't update pointer
    if (step.type === 'gate') {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    // Keep the active-feature pointer current (only for active non-gate steps)
    updateActivePointer(projectDir, slug, sessionId);

    // Evaluate gate condition (fail-closed)
    const gateName = step.gate;
    if (gateName) {
      const result = evaluateGate(gateName, state);
      if (result === 'wait') {
        // No signal yet — do not advance
        console.log(JSON.stringify({ continue: true }));
        return;
      }
      if (result === 'fail') {
        const retry = (state.retry || 0) + 1;
        const maxRetry = step.max_retry;
        const emitConflict = () => console.log(JSON.stringify(createOutput(`[CAS conflict at ${state.step} — another writer advanced; re-read workflow.json]`)));
        if (maxRetry && retry >= maxRetry && step.on_max_retry) {
          const ok = writeState(statePath, { ...state, step: step.on_max_retry, retry: 0, signals: {} });
          if (!ok) { emitConflict(); return; }
          printTag(`Step: ${state.step} → ${step.on_max_retry} (max_retry)`);
          console.log(JSON.stringify(createOutput(`[Step ${state.step} exceeded retry budget → ${step.on_max_retry}]`)));
          return;
        }
        if (typeof step.on_fail === 'string') {
          const ok = writeState(statePath, { ...state, step: step.on_fail, retry: 0, signals: {} });
          if (!ok) { emitConflict(); return; }
          printTag(`Step: ${state.step} → ${step.on_fail} (failed)`);
          console.log(JSON.stringify(createOutput(`[Step ${state.step} failed → ${step.on_fail}]`)));
          return;
        }
        if (step.on_fail && typeof step.on_fail === 'object') {
          const category = state.signals?.failure_category;
          if (category && step.on_fail[category]) {
            const target = step.on_fail[category];
            if (target === 'continue') {
              const ok = writeState(statePath, { ...state, step: step.next, retry: 0, signals: {} });
              if (!ok) { emitConflict(); return; }
              printTag(`Step: ${state.step} → ${step.next} (${category}: continue)`);
              console.log(JSON.stringify(createOutput(`[Step ${state.step} failed (${category}) → continue → ${step.next}]`)));
              return;
            }
            const ok = writeState(statePath, { ...state, step: target, retry: 0, signals: {} });
            if (!ok) { emitConflict(); return; }
            printTag(`Step: ${state.step} → ${target} (${category})`);
            console.log(JSON.stringify(createOutput(`[Step ${state.step} failed (${category}) → ${target}]`)));
            return;
          }
          const categories = Object.keys(step.on_fail).join(', ');
          const prompt = `[Step ${state.step} gate failed — CATEGORY REQUIRED]\n`
            + `You set signals.${gateName} = false but did not set signals.failure_category.\n`
            + `Valid categories: ${categories}\n`
            + `Update .smt/features/${slug}/state/workflow.json with:\n`
            + `  { "signals": { "${gateName}": false, "failure_category": "<category>" } }\n`
            + `Write BOTH keys atomically in the same update.`;
          console.log(JSON.stringify(createOutput(prompt)));
          return;
        }
        const ok = writeState(statePath, { ...state, retry });
        if (!ok) { emitConflict(); return; }
        console.log(JSON.stringify(createOutput(`[Step ${state.step} retry ${retry}/${maxRetry || 3}]`)));
        return;
      }
      // result === 'pass' → fall through to advance
    }

    // Advance to next step
    if (step.next) {
      const ok = writeState(statePath, { ...state, step: step.next, retry: 0, signals: {} });
      if (!ok) {
        console.log(JSON.stringify(createOutput(`[CAS conflict at ${state.step} — another writer advanced; re-read workflow.json]`)));
        return;
      }
      printTag(`Step: ${state.step} → ${step.next}`);
      console.log(JSON.stringify(createOutput(`[Step ${state.step} complete → ${step.next}]`)));
      return;
    }

    console.log(JSON.stringify({ continue: true }));
  } catch (err) {
    process.stderr.write(`[step-tracker] error: ${err.message}\n`);
    console.log(JSON.stringify({ continue: true }));
  }
}

// Only auto-run as a script entry point, not when imported for tests.
// Using URL equality is symlink/bundler-safe.
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
