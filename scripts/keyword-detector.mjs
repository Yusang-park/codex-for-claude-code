#!/usr/bin/env node

/**
 * Smelter command detector hook (Node.js)
 * Detects documented explicit slash commands AND natural-language magic keywords,
 * then activates harness state + injects a skill invocation payload.
 * Cross-platform: Windows, macOS, Linux.
 *
 * Priority: (1) explicit slash command → (2) magic keyword (natural language).
 *
 * Supported slash commands:
 *   /tasker /feat /qa /cancel /queue
 *
 * Supported magic keywords → command mapping:
 *   tasker / plan / 설계해줘 / 계획부터              → /tasker
 *   new feature / 새 기능 / design first            → /feat (Step 2 included)
 *   extend / add to / 덧붙여                         → /feat (Step 2 skipped)
 *   fix / bug / 버그                                 → /qa (E2E forced on)
 *   style / typo / 텍스트 / 색상 / i18n             → /qa (TDD exemption hint)
 *   cancel / stop                                    → /cancel
 *   queue                                            → /queue (explicit only)
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync, renameSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { clearCancel } from './lib/cancel-signal.mjs';
import { propagateHardCancel, propagateQueueCancel } from './cancel-propagator.mjs';
import { classifyPrompt } from './lib/subagent-classifier.mjs';
import { printTag } from './lib/yellow-tag.mjs';

// Read stdin synchronously
function readStdinSync() {
  try { return readFileSync('/dev/stdin', 'utf-8'); } catch { return '{}'; }
}

// Extract prompt from various JSON structures
function extractPrompt(input) {
  try {
    const data = JSON.parse(input);
    if (data.prompt) return data.prompt;
    if (data.message?.content) return data.message.content;
    if (Array.isArray(data.parts)) {
      return data.parts
        .filter(p => p.type === 'text')
        .map(p => p.text)
        .join(' ');
    }
    return '';
  } catch {
    const match = input.match(/"(?:prompt|content|text)"\s*:\s*"([^"]+)"/);
    return match ? match[1] : '';
  }
}

/**
 * Strip XML/URL/path/code so magic-keyword detection does not false-positive on
 * pasted code, system reminders, or agent tool outputs.
 * Previously used by regex magic-keyword detection; now replaced by Haiku sub-agent classifier.
 */

function extractExplicitHarnessCommand(prompt) {
  if (!prompt) return null;
  const trimmed = prompt.trim();
  const match = trimmed.match(/^\/(tasker|feat|qa|cancel|queue)\b(?:[:\s-]*(.*))?$/i);
  if (!match) return null;
  return {
    name: match[1].toLowerCase(),
    args: (match[2] || '').trim(),
    source: 'slash',
  };
}

// Command → preset/mode mapping (magic keywords handled by Haiku sub-agent classifier)
const COMMAND_CONFIG = {
  tasker: { preset: 'tasker', mode: 'normal' },
  feat:   { preset: 'feat',   mode: 'normal' },
  qa:     { preset: 'qa',     mode: 'normal' },
};

function writeStateFile(directory, filename, data) {
  const localDir = join(directory, '.smt', 'state');
  if (!existsSync(localDir)) {
    try { mkdirSync(localDir, { recursive: true }); } catch {}
  }
  try { writeFileSync(join(localDir, filename), JSON.stringify(data, null, 2), { mode: 0o600 }); } catch {}
}

// Map command → initial workflow step
const INITIAL_STEP = {
  tasker: 'step-1',
  feat: 'step-1',
  qa: 'step-4',
};

// Slug from prompt: first meaningful words, sanitized.
// Empty/punctuation-only prompts get a collision-resistant timestamp+random fallback.
function deriveSlug(prompt) {
  const base = (prompt || '').toString().trim().slice(0, 80).toLowerCase();
  const slug = base
    .replace(/[^a-z0-9가-힣\s-]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
  if (slug) return slug;
  const suffix = randomBytes(3).toString('hex');
  return `feature-${Date.now().toString(36)}-${suffix}`;
}

// Atomic single-file write (tmp + rename) to avoid torn state on crash.
function writeAtomic(path, content) {
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

function seedWorkflowState(directory, commandName, prompt, sessionId, args = '') {
  const initialStep = INITIAL_STEP[commandName];
  if (!initialStep) return; // cancel/queue — no workflow state

  // Prefer slash-args for slug derivation (ignore the leading "/feat " literal).
  // For natural-language magic-keyword invocations, args is empty so we fall back
  // to the prompt with any leading slash-command token stripped.
  const cleanedPrompt = String(prompt || '').replace(/^\/\w+\b[:\s-]*/, '');
  const slugSource = args && args.trim() ? args : cleanedPrompt;
  const slug = deriveSlug(slugSource);
  const featuresDir = join(directory, '.smt', 'features');
  const featureDir = join(featuresDir, slug);
  const taskDir = join(featureDir, 'task');
  const stateDir = join(featureDir, 'state');
  const smtStateDir = join(directory, '.smt', 'state');
  const pointerPath = join(smtStateDir, 'active-feature.json');

  // Cross-slug switch detection: warn if an active feature exists with a different slug
  // and its workflow is in-flight. User explicitly invoked a new command, so honor it,
  // but preserve the prior pointer content as last-active for troubleshooting.
  try {
    if (existsSync(pointerPath)) {
      const prev = JSON.parse(readFileSync(pointerPath, 'utf-8'));
      if (prev?.slug && prev.slug !== slug) {
        try {
          if (!existsSync(smtStateDir)) mkdirSync(smtStateDir, { recursive: true });
          writeAtomic(join(smtStateDir, 'previous-feature.json'), JSON.stringify({
            slug: prev.slug, switched_at: Date.now(), new_slug: slug,
          }, null, 2));
        } catch {}
      }
    }
  } catch {}

  try {
    if (!existsSync(taskDir)) mkdirSync(taskDir, { recursive: true });
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
    if (!existsSync(smtStateDir)) mkdirSync(smtStateDir, { recursive: true });

    // plan.md (only create if missing — don't clobber prior plans)
    const planPath = join(taskDir, 'plan.md');
    if (!existsSync(planPath)) {
      const now = new Date().toISOString();
      // Sanitize prompt body: strip control chars and system-reminder-like leakage
      const cleanPrompt = String(prompt || '')
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
        .slice(0, 2000);
      const planContent = `---\nstatus: open\ncreated: ${now}\n---\n\n# ${slug}\n\n${cleanPrompt}\n\n## Plan\n\n## Wiki Links\n\n## Risks\n`;
      writeAtomic(planPath, planContent);
    }

    // workflow.json — seed only if absent so re-running /feat doesn't reset progress
    const workflowPath = join(stateDir, 'workflow.json');
    if (!existsSync(workflowPath)) {
      const state = {
        command: commandName,
        step: initialStep,
        retry: 0,
        signals: {},
        version: 0,
        created_at: Date.now(),
        updated_at: Date.now(),
        prompt: String(prompt || '').slice(0, 500),
        session_id: sessionId || '',
      };
      writeAtomic(workflowPath, JSON.stringify(state, null, 2));
    }

    // active-feature pointer (atomic)
    writeAtomic(pointerPath, JSON.stringify({ slug, session_id: sessionId || '', updated_at: Date.now() }, null, 2));
    if (sessionId) {
      writeAtomic(join(smtStateDir, `active-feature-${sessionId}.json`), JSON.stringify({ slug, session_id: sessionId, updated_at: Date.now() }, null, 2));
    }
  } catch {}
}

// Clear active-feature pointer — called on /cancel and /queue so the next
// UserPromptSubmit does not silently resume a cancelled/redirected feature.
function clearActiveFeature(directory) {
  try {
    const p = join(directory, '.smt', 'state', 'active-feature.json');
    if (existsSync(p)) unlinkSync(p);
  } catch {}
}

function activateHarnessState(directory, commandName, prompt, sessionId, args = '') {
  const config = COMMAND_CONFIG[commandName];
  if (!config) return;
  seedWorkflowState(directory, commandName, prompt, sessionId, args);
}

function createSkillInvocation(skillName, originalPrompt, args = '', hint = null) {
  const argsSection = args ? `\nArguments: ${args}` : '';
  const hintSection = hint ? `\nBranch hint: ${hint}` : '';
  return `[MAGIC KEYWORD: ${skillName.toUpperCase()}]

You MUST invoke the skill using the Skill tool:

Skill: ${skillName}${argsSection}${hintSection}

User request:
${originalPrompt}

IMPORTANT: Invoke the skill IMMEDIATELY. Do not proceed without loading the skill instructions.`;
}

function createHookOutput(additionalContext) {
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  };
}

async function main() {
  printTag('Keyword Detector');
  try {
    const input = readStdinSync();
    if (!input.trim()) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    let data = {};
    try { data = JSON.parse(input); } catch {}
    const directory = data.cwd || data.directory || process.cwd();
    const sessionId = data.session_id || data.sessionId || '';

    const prompt = extractPrompt(input);
    if (!prompt) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    // (1) Explicit slash command takes priority
    let detected = extractExplicitHarnessCommand(prompt);

    // (2) Haiku sub-agent classifier for non-slash prompts
    if (!detected) {
      const classification = classifyPrompt(prompt, { cwd: directory, sessionId });
      if (classification.intent === 'command' && classification.command) {
        const validCommands = ['tasker', 'feat', 'qa', 'cancel', 'queue'];
        const cmd = classification.command.toLowerCase().replace(/^\//, '');
        if (validCommands.includes(cmd)) {
          printTag(`Magic Keyword: Haiku classified command`);
          detected = {
            name: cmd,
            args: '',
            hint: classification.branch || null,
            matched: `Haiku:${cmd}`,
            source: 'magic',
          };
        }
      }
      if (!detected && classification.intent === 'question') {
        printTag(`Magic Keyword: Haiku classified question`);
      }
    }

    // Clear stale cancel signals on any non-cancel/queue prompt
    if (!detected || (detected.name !== 'cancel' && detected.name !== 'queue')) {
      clearCancel(directory);
    }

    // Auto-detect interrupt
    const interruptMarkerPath = join(directory, '.smt', 'state', 'last-interrupt.json');
    let wasInterrupted = false;
    if (existsSync(interruptMarkerPath)) {
      try {
        const marker = JSON.parse(readFileSync(interruptMarkerPath, 'utf-8'));
        if (Date.now() - marker.timestamp < 60_000) wasInterrupted = true;
      } catch {}
      try { unlinkSync(interruptMarkerPath); } catch {}
    }

    if (!detected) {
      if (wasInterrupted) {
        printTag('Detect: Interrupt');
        console.log(JSON.stringify(createHookOutput(
          `[INTERRUPTED] The previous response was interrupted by the user. IMPORTANT: Follow the NEW instruction below. Do NOT continue or resume previous work unless explicitly asked.`
        )));
      } else {
        console.log(JSON.stringify({ continue: true }));
      }
      return;
    }

    // Trace
    let tracer = null;
    try { tracer = await import('../dist/hooks/subagent-tracker/flow-tracer.js'); } catch {}
    if (tracer) {
      try { tracer.recordKeywordDetected(directory, sessionId, detected.name); } catch {}
    }

    // /cancel
    if (detected.name === 'cancel') {
      printTag('Command: /cancel');
      const result = propagateHardCancel(directory, 'user /cancel command');
      clearActiveFeature(directory);
      const killedMsg = result.killed.length > 0 ? `\nKilled: ${result.killed.join(', ')}` : '';
      const clearedMsg = result.cleared.length > 0 ? `\nCleared: ${result.cleared.join(', ')}` : '';
      console.log(JSON.stringify(createHookOutput(
        `[CANCEL] Hard cancel executed. All work stopped.${killedMsg}${clearedMsg}\n\nInform the user that cancellation is complete. Do NOT continue any previous work. Await new instructions.`
      )));
      return;
    }

    // /queue (slash-only; magic keyword not supported for queue)
    if (detected.name === 'queue') {
      printTag('Command: /queue');
      const intent = detected.args;
      if (!intent) {
        console.log(JSON.stringify(createHookOutput(
          `[QUEUE ERROR] No intent provided. Usage: /queue <what to do next>\nExample: /queue fix the login bug`
        )));
        return;
      }
      propagateQueueCancel(directory, intent, 'user /queue command', sessionId);
      console.log(JSON.stringify(createHookOutput(
        `[QUEUED] Intent queued for after current work completes: "${intent}"\n\nContinue current work. When the current task finishes, switch to the queued intent instead of continuing the old plan.`
      )));
      return;
    }

    // Harness commands — activate state
    activateHarnessState(directory, detected.name, prompt, sessionId, detected.args || '');
    if (tracer) {
      try { tracer.recordModeChange(directory, sessionId, 'none', detected.name); } catch {}
    }

    // MODE banner (once per session per command)
    const MODE_LABELS = { tasker: 'TASKER MODE', feat: 'FEAT MODE', qa: 'QA MODE' };
    const modeLabel = MODE_LABELS[detected.name];
    if (modeLabel) {
      const bannerFile = join(directory, '.smt', 'state', `mode-emitted-${sessionId || 'default'}.json`);
      let alreadyEmitted = false;
      try { alreadyEmitted = JSON.parse(readFileSync(bannerFile, 'utf-8')).mode === detected.name; } catch {}
      if (!alreadyEmitted) {
        printTag(modeLabel);
        try {
          const stateDir = join(directory, '.smt', 'state');
          if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
          writeFileSync(bannerFile, JSON.stringify({ mode: detected.name, ts: Date.now() }));
        } catch {}
      }
    }

    if (detected.source === 'magic') {
      const hintTag = detected.hint ? ` (${detected.hint})` : '';
      printTag(`Magic Keyword: ${detected.matched} → /${detected.name}${hintTag}`);
    } else {
      printTag(`Command: /${detected.name}`);
    }

    console.log(JSON.stringify(createHookOutput(
      createSkillInvocation(detected.name, prompt, detected.args, detected.hint)
    )));
  } catch (error) {
    console.log(JSON.stringify({ continue: true }));
  }
}

main();
