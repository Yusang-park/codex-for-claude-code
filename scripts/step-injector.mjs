#!/usr/bin/env node
// step-injector.mjs — UserPromptSubmit hook.
//
// Reads the active feature's workflow state and injects the current step
// prompt as additionalContext.
//
// Active feature resolution order:
//   1. `.smt/state/active-feature.json` → { slug }   (explicit pointer)
//   2. Fallback: most-recently-updated .smt/features/*/state/workflow.json

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { printTag } from './lib/yellow-tag.mjs';
import { parseYaml } from './lib/yaml-parser.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HARNESS_ROOT = resolve(__dirname, '..');
const MODE_LABELS = { tasker: 'TASKER MODE', feat: 'FEAT MODE', qa: 'QA MODE' };

function readStdinSync() {
  try { return readFileSync('/dev/stdin', 'utf-8'); } catch { return '{}'; }
}

function readJsonSafe(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    process.stderr.write(`[step-injector] corrupt JSON at ${path}: ${err.message}\n`);
    return { __corrupt: true, __path: path, __error: err.message };
  }
}

function findActiveFeature(projectDir, sessionId = '') {
  const featuresDir = join(projectDir, '.smt', 'features');
  if (!existsSync(featuresDir)) return null;

  // 1. Explicit pointer — session-scoped ONLY when we have a session id.
  // Live sessions must not inherit another session's global pointer; the global
  // file is kept for tests/tools that run without a session id.
  const stateDir = join(projectDir, '.smt', 'state');
  const pointerPath = sessionId
    ? join(stateDir, `active-feature-${sessionId}.json`)
    : join(stateDir, 'active-feature.json');
  const pointer = readJsonSafe(pointerPath);
  if (pointer?.__corrupt) {
    return { corrupt: true, path: pointer.__path || pointerPath, error: pointer.__error };
  }
  if (pointer?.slug) {
    const statePath = join(featuresDir, pointer.slug, 'state', 'workflow.json');
    const state = readJsonSafe(statePath);
    if (state?.__corrupt) return { corrupt: true, path: statePath, slug: pointer.slug };
    if (state) return { slug: pointer.slug, state, statePath };
  }
  // With a session id but no session-scoped pointer → this session has no active workflow.
  if (sessionId) return null;

  // 2. Fallback: most-recent by updated_at
  let latest = null;
  const corruptFeatures = [];
  let slugs = [];
  try { slugs = readdirSync(featuresDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch {}
  for (const slug of slugs) {
    const statePath = join(featuresDir, slug, 'state', 'workflow.json');
    const state = readJsonSafe(statePath);
    if (!state) continue;
    if (state.__corrupt) { corruptFeatures.push(statePath); continue; }
    const ts = state.updated_at || state.created_at || 0;
    if (!latest || ts > latest.ts) latest = { slug, state, statePath, ts };
  }
  if (latest && corruptFeatures.length > 0) latest.corruptSiblings = corruptFeatures;
  if (!latest && corruptFeatures.length > 0) return { corrupt: true, path: corruptFeatures.join(', ') };
  return latest;
}

function loadWorkflow(command) {
  const path = join(HARNESS_ROOT, 'workflows', `${command}.yaml`);
  if (!existsSync(path)) return null;
  try { return parseYaml(readFileSync(path, 'utf-8')); }
  catch (err) {
    process.stderr.write(`[step-injector] YAML parse error in ${path}: ${err.message}\n`);
    return null;
  }
}

function loadStepPrompt(promptPath) {
  const abs = join(HARNESS_ROOT, promptPath);
  if (!existsSync(abs)) return null;
  try { return readFileSync(abs, 'utf-8'); } catch { return null; }
}

function createOutput(additionalContext) {
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  };
}

function extractPrompt(input) {
  try {
    const data = JSON.parse(input);
    if (typeof data.prompt === 'string') return data.prompt;
    if (typeof data.message?.content === 'string') return data.message.content;
    if (Array.isArray(data.parts)) {
      return data.parts.filter(p => p.type === 'text').map(p => p.text).join(' ');
    }
    return '';
  } catch {
    return '';
  }
}

function shouldInjectWorkflow(prompt = '') {
  const trimmed = String(prompt || '').trim();
  if (!trimmed) return true;
  if (/^\/(tasker|feat|qa)\b/i.test(trimmed)) return false;
  if (/^\/(cancel|queue|help|model|usage|hud|instinct|evolve|doctor|skill)\b/i.test(trimmed)) return false;
  return false;
}

function createSilentOutput() {
  return { continue: true };
}

function main() {
  printTag('Step Injector');
  try {
    const input = readStdinSync();
    let data = {};
    try { data = JSON.parse(input); } catch {}

    const projectDir = data.cwd || data.directory || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const sessionId = data.session_id || data.sessionId || '';
    const prompt = extractPrompt(input);
    if (!shouldInjectWorkflow(prompt)) {
      console.log(JSON.stringify(createSilentOutput()));
      return;
    }

    const active = findActiveFeature(projectDir, sessionId);
    if (!active) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }
    if (active.corrupt) {
      const recovery = `[Workflow Recovery Required]\n\n`
        + `Corrupt JSON at ${active.path}\n`
        + `Fix or delete the file to recover the workflow.`;
      console.log(JSON.stringify(createOutput(recovery)));
      return;
    }

    const { slug, state } = active;
    const command = state.command;
    const stepId = state.step;
    const retry = state.retry || 0;

    const workflow = loadWorkflow(command);
    if (!workflow || !workflow.steps) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }
    if (!workflow.steps[stepId]) {
      // Stale step-id — workflow yaml was edited and current step no longer exists.
      // Surface the issue to the agent via additionalContext so it can recover.
      const validSteps = Object.keys(workflow.steps).join(', ');
      const recovery = `[Workflow: ${command} | Feature: ${slug}]\n\n`
        + `WARNING: state.step = "${stepId}" does not exist in workflows/${command}.yaml.\n`
        + `Valid steps: ${validSteps}\n`
        + `Recover by editing .smt/features/${slug}/state/workflow.json to a valid step, or delete it to restart.`;
      process.stderr.write(`[step-injector] stale step-id ${stepId} for ${command}\n`);
      console.log(JSON.stringify(createOutput(recovery)));
      return;
    }

    const step = workflow.steps[stepId];
    const isGate = step.type === 'gate';
    // Sort siblings deterministically before truncating so the "first 5" shown are stable across runs/filesystems.
    const siblings = (active.corruptSiblings || []).map(String).sort();
    const shown = siblings.slice(0, 5);
    const more = siblings.length > 5 ? `\n  ...and ${siblings.length - 5} more` : '';
    const corruptWarning = siblings.length > 0
      ? `\n\n[WARNING] Corrupt sibling state detected at:\n  ${shown.join('\n  ')}${more}\nInspect and fix or delete these before switching features.`
      : '';

    let ctx;
    const modeLabel = MODE_LABELS[command] || `${String(command || '').toUpperCase()} MODE`;
    if (isGate) {
      ctx = `[Workflow: ${command} | ${stepId}: ${step.name} | Feature: ${slug}]\n`
          + `Current mode: ${modeLabel}\n\n`
          + `GATE — PAUSE. Present current state to the user and wait for explicit approval.\n`
          + (step.options ? `Options: ${Array.isArray(step.options) ? step.options.join(', ') : step.options}\n` : '')
          + (step.allow_revisit ? `User may request revisit: ${Array.isArray(step.allow_revisit) ? step.allow_revisit.join(', ') : step.allow_revisit}\n` : '');
    } else {
      const body = step.prompt ? loadStepPrompt(step.prompt) : null;
      ctx = `[Workflow: ${command} | ${stepId}: ${step.name} | Feature: ${slug}${retry > 0 ? ` | Retry ${retry}` : ''}]\n`
          + `Current mode: ${modeLabel}\n\n`
          + (body || `(step prompt file not found: ${step.prompt})`);
    }
    ctx += corruptWarning;

    printTag(`Step: ${stepId} (${command})`);
    console.log(JSON.stringify(createOutput(ctx)));
  } catch (err) {
    process.stderr.write(`[step-injector] error: ${err.message}\n`);
    console.log(JSON.stringify({ continue: true }));
  }
}

main();
