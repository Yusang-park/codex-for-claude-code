#!/usr/bin/env node
/**
 * auto-confirm.mjs — Stop hook (command-agnostic).
 *
 * Behavior: when the main agent ends a turn while the project still has pending
 * work, drop the main agent's last assistant message + pending-task list into
 * `.smt/state/auto-confirm-queue.json` and block the stop with a
 * static "continue working" reason. The queue file is consumed on the next
 * UserPromptSubmit by `auto-confirm-consumer.mjs`, which injects the forwarded
 * payload as additionalContext. We do NOT spawn `claude` from the Stop hook —
 * Stop hooks run under a 15s cap and a full sub-agent roundtrip never fits.
 *
 * Gates:
 *   - `~/.smt/config.json` → `{ "autoConfirm": true }`. Defaults to ON.
 *   - Never blocks context-limit or user-abort stops.
 *
 * Works across /tasker, /feat, /qa.
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { printTag } from './lib/yellow-tag.mjs';
import { readCancel, clearCancel } from './lib/cancel-signal.mjs';

const __filename = fileURLToPath(import.meta.url);

function readStdinSync() {
  try { return readFileSync('/dev/stdin', 'utf-8'); } catch { return '{}'; }
}

function readJsonFile(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch { return null; }
}

export function isAutoConfirmEnabled() {
  const cfgPath = join(homedir(), '.smt', 'config.json');
  const cfg = readJsonFile(cfgPath);
  if (!cfg) return true; // default on
  return cfg.autoConfirm !== false;
}

export function isContextLimitStop(data) {
  const reason = (data.stop_reason || data.stopReason || '').toLowerCase();
  const patterns = [
    'context_limit', 'context_window', 'context_exceeded', 'context_full',
    'max_context', 'token_limit', 'max_tokens',
    'conversation_too_long', 'input_too_long',
  ];
  if (patterns.some(p => reason.includes(p))) return true;
  const endTurn = (data.end_turn_reason || data.endTurnReason || '').toLowerCase();
  return endTurn && patterns.some(p => endTurn.includes(p));
}

export function isUserAbort(data) {
  if (data.user_requested || data.userRequested) return true;
  const reason = (data.stop_reason || data.stopReason || '').toLowerCase();
  const exact = ['aborted', 'abort', 'cancel', 'interrupt'];
  const substr = ['user_cancel', 'user_interrupt', 'user_aborted', 'ctrl_c', 'manual_stop'];
  return exact.some(p => reason === p) || substr.some(p => reason.includes(p));
}

/**
 * Heuristic: does this message look like a confirmation / approval question
 * that would benefit from auto-continuation? We look at the last ~300 chars
 * since that's where agents typically place "shall I proceed?" type questions.
 */
export function looksLikeConfirmationQuestion(message) {
  if (!message || typeof message !== 'string') return false;
  const tail = message.slice(-400).toLowerCase();
  const patterns = [
    /shall i (?:proceed|continue|go ahead|do|start|create|update)/,
    /should i (?:proceed|continue|go ahead|do|start|create|update)/,
    /do you want me to /,
    /would you like me to /,
    /let me know (?:if|when|whether)/,
    /ready to (?:proceed|continue|push|commit|deploy)\?/,
    /진행할까요?\?|계속할까요?\?|할까요?\?|맞나요?\?/,
    /proceed\?\s*$|continue\?\s*$|ok\?\s*$/,
  ];
  return patterns.some(p => p.test(tail));
}

export function looksLikeSelfCommitment(message) {
  if (!message || typeof message !== 'string') return false;
  const tail = message.slice(-500).toLowerCase();
  const patterns = [
    /next i (?:will|ll) /,
    /i (?:will|ll) (?:update|fix|change|edit|implement|run|finish|continue|handle|refactor)/,
    /i(?:'|’)m going to /,
    /다음(?:으로)? .*?(?:하겠습니다|할게요|진행하겠습니다|수정하겠습니다|고치겠습니다)/,
    /(?:이제|바로|계속) .*?(?:하겠습니다|진행하겠습니다|수정하겠습니다|고치겠습니다)/,
  ];
  return patterns.some(p => p.test(tail));
}

export function shouldAutoContinue(lastMessage, pendingTasks) {
  return pendingTasks.length > 0 || looksLikeConfirmationQuestion(lastMessage) || looksLikeSelfCommitment(lastMessage);
}

export function buildAutoConfirmReason(lastMessage, pendingTasks) {
  const taskHint = pendingTasks.length > 0
    ? `${pendingTasks.length} pending task(s) in .smt/. `
    : '';
  if (looksLikeConfirmationQuestion(lastMessage)) {
    return `[AUTO-CONFIRM] ${taskHint}You ended the turn with a confirmation question. Answer it yourself and continue — do not ask the user.`;
  }
  if (looksLikeSelfCommitment(lastMessage)) {
    return `[AUTO-CONFIRM] ${taskHint}You ended the turn by committing to a concrete next step. Continue that work now — do not stop at a plan or summary.`;
  }
  return `[AUTO-CONFIRM] ${taskHint}Read your prior last message in the forwarded context and continue the work.`;
}

/**
 * Extract last assistant message text from the Stop hook payload.
 * Transcripts may appear under `transcript` or `messages`.
 */
export function extractLastAssistantMessage(data) {
  const transcript = data.transcript || data.messages;
  if (!Array.isArray(transcript)) return '';
  for (let i = transcript.length - 1; i >= 0; i--) {
    const msg = transcript[i];
    if (msg.role !== 'assistant') continue;
    if (typeof msg.content === 'string') return msg.content.trim();
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter(b => b && b.type === 'text')
        .map(b => b.text || '')
        .join('\n')
        .trim();
    }
  }
  return '';
}

// Read pending task titles from .smt/features/<slug>/task/<name>.md (excluding plan.md).
export function readPendingTasks(projectDir) {
  const tasks = [];
  const featuresDir = join(projectDir, '.smt', 'features');
  if (!existsSync(featuresDir)) return tasks;
  let slugs = [];
  try { slugs = readdirSync(featuresDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch {}
  for (const slug of slugs) {
    const taskDirPath = join(featuresDir, slug, 'task');
    if (!existsSync(taskDirPath)) continue;
    let files = [];
    try { files = readdirSync(taskDirPath).filter(f => f.endsWith('.md') && f !== 'plan.md').sort(); } catch {}
    for (const f of files) {
      try {
        const content = readFileSync(join(taskDirPath, f), 'utf-8');
        for (const line of content.split('\n')) {
          const m = line.match(/^[-*]\s*\[\s\]\s*(.+)$/);
          if (m) tasks.push({ status: 'pending', title: m[1].trim() });
        }
      } catch {}
    }
  }
  return tasks;
}

/**
 * Drop the forwarded payload into `.smt/state/queue-<session_id>.json`
 * using an atomic tmp+rename. Consumed by `auto-confirm-consumer.mjs` on the
 * next UserPromptSubmit. Session-scoped filename prevents two concurrent
 * producers from clobbering each other.
 *
 * Returns true on successful write, false otherwise.
 */
export function queueForwardPayload(projectDir, lastMessage, pendingTasks, sessionId = '') {
  try {
    const stateDir = join(projectDir, '.smt', 'state');
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
    const safeSid = String(sessionId || 'nosession').replace(/[^a-zA-Z0-9_.-]/g, '_');
    const queuePath = join(stateDir, `queue-${safeSid}.json`);
    // Unique tmp per write so two producers in the same session cannot collide.
    const tmpPath = `${queuePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
    const payload = {
      timestamp: Date.now(),
      session_id: sessionId || '',
      last_message: (lastMessage || '').slice(0, 3000),
      pending_tasks: pendingTasks.slice(0, 20).map(t => ({ status: t.status, title: t.title })),
    };
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    renameSync(tmpPath, queuePath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  printTag('Auto-Confirm');
  try {
    const input = readStdinSync();
    let data = {};
    try { data = JSON.parse(input); } catch {}

    const directory = data.cwd || data.directory || process.cwd();
    const sessionId = data.session_id || data.sessionId || '';

    // Never block context-limit stops
    if (isContextLimitStop(data)) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }
    // Respect explicit user abort
    if (isUserAbort(data)) {
      try {
        const stateDir = join(directory, '.smt', 'state');
        if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
        writeFileSync(
          join(stateDir, 'last-interrupt.json'),
          JSON.stringify({ timestamp: Date.now(), reason: data.stop_reason || 'user_abort' }),
        );
      } catch {}
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    // Global autoConfirm gate — checked BEFORE cancel-signal handling so a
    // disabled autoConfirm truly no-ops the hook.
    if (!isAutoConfirmEnabled()) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    // Cancel signal — respect hard/queue
    const cancelSignal = readCancel(directory, sessionId);
    if (cancelSignal) {
      if (cancelSignal.type === 'hard') {
        clearCancel(directory);
        console.log(JSON.stringify({ continue: true }));
        return;
      }
      if (cancelSignal.type === 'queue' && cancelSignal.queued_intent) {
        clearCancel(directory);
        printTag('Auto-Confirm: Queued Redirect');
        console.log(JSON.stringify({
          decision: 'block',
          reason: `[QUEUED REDIRECT] Previous work complete. Now execute the queued intent: ${cancelSignal.queued_intent}`,
        }));
        return;
      }
    }

    // Auto-confirm blocks the stop ONLY when there's actionable work left:
    //   (a) pending tasks exist in .smt/, OR
    //   (b) the last assistant message looks like a confirmation/approval question
    // Otherwise we pass through — no infinite loop on generic "done" replies.
    const pending = readPendingTasks(directory);
    const lastMessage = extractLastAssistantMessage(data);
    const hasWork = shouldAutoContinue(lastMessage, pending);

    if (!hasWork) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    queueForwardPayload(directory, lastMessage, pending, sessionId);

    const reason = buildAutoConfirmReason(lastMessage, pending);

    printTag('Auto-Confirm: queued');
    console.log(JSON.stringify({ decision: 'block', reason }));
  } catch (err) {
    // Never deadlock on errors
    try { printTag('Auto-Confirm: Error (continue)'); } catch {}
    console.log(JSON.stringify({ continue: true }));
  }
}

// Only run main when invoked as a script (not when imported for tests).
if (process.argv[1] && process.argv[1] === __filename) {
  main();
}
