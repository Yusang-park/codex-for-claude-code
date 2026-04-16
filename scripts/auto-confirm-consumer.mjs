#!/usr/bin/env node
/**
 * auto-confirm-consumer.mjs — UserPromptSubmit hook.
 *
 * Consumes the queue file dropped by `auto-confirm.mjs` on the prior Stop event.
 * If `.smt/state/auto-confirm-queue.json` exists, this hook reads
 * and deletes it, then injects its content as `additionalContext` so the main
 * agent can act on the forwarded summary on this turn.
 *
 * The Stop hook cannot spawn a sub-agent within its 15s cap, so we split the
 * roundtrip: Stop drops → next UserPromptSubmit consumes.
 *
 * Output (queue present): { continue: true, hookSpecificOutput: { additionalContext } }
 * Output (queue absent):  { continue: true }
 */

import { existsSync, readFileSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { printTag } from './lib/yellow-tag.mjs';

const __filename = fileURLToPath(import.meta.url);

function readStdinSync() {
  try { return readFileSync('/dev/stdin', 'utf-8'); } catch { return '{}'; }
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

function isWorkflowContinuationPrompt(prompt = '') {
  const trimmed = String(prompt || '').trim();
  if (!trimmed) return false;
  if (/^\/(tasker|feat|qa)\b/i.test(trimmed)) return true;
  const lower = trimmed.toLowerCase();
  const continuationSignals = [
    'continue', 'proceed', 'go ahead', 'next step', 'keep going', 'mark done', 'done', 'finish', 'close',
    '계속', '진행', '다음', '이어', '승인', 'approve', 'rework:', 'complete', 'hold', '끝내', '완료'
  ];
  return continuationSignals.some(signal => lower.includes(signal));
}

const STALE_MS = 30 * 60 * 1000; // 30 min
// Legacy sid-less queue files: give the owning session a grace window before
// any consumer is allowed to adopt the file. Prevents a racing consumer from
// stealing a payload the owning session is about to claim on its next prompt.
const LEGACY_ADOPT_MIN_AGE_MS = 5 * 1000;

function listQueueCandidates(stateDir) {
  const out = [];
  let entries = [];
  try { entries = readdirSync(stateDir); } catch { return out; }
  for (const name of entries) {
    if (name === 'auto-confirm-queue.json') {
      out.push(join(stateDir, name)); // legacy single-file layout
      continue;
    }
    if (/^queue-.+\.json$/.test(name) && !name.includes('.tmp.')) {
      out.push(join(stateDir, name));
    }
  }
  return out;
}

function peekPayload(path) {
  let payload = null;
  try {
    payload = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    // Unreadable/garbage file — safe to unlink immediately; it cannot match any session.
    try { unlinkSync(path); } catch {}
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (payload.timestamp && Date.now() - payload.timestamp > STALE_MS) {
    try { unlinkSync(path); } catch {}
    return null;
  }
  return payload;
}

function unlinkSafe(path) {
  try { unlinkSync(path); } catch {}
}

function extractSessionFromFilename(path) {
  // OS-agnostic: strip directory first, then match.
  const m = basename(path).match(/^queue-(.+)\.json$/);
  return m ? m[1] : null;
}

export function consumeQueueFile(projectDir, sessionId = '') {
  const stateDir = join(projectDir, '.smt', 'state');
  if (!existsSync(stateDir)) return null;
  const candidates = listQueueCandidates(stateDir);
  if (candidates.length === 0) return null;

  const sid = String(sessionId || '').replace(/[^a-zA-Z0-9_.-]/g, '_');

  // Strict session scoping: consume files that belong to this session (filename
  // match) in strict priority. Only fall through to legacy single-file when no
  // session-scoped candidate exists — this prevents a stale legacy payload from
  // hijacking a mismatched sid file.
  const ordered = [...candidates].sort((a, b) => {
    const sa = extractSessionFromFilename(a) !== null ? 0 : 1;
    const sb = extractSessionFromFilename(b) !== null ? 0 : 1;
    return sa - sb; // sid-scoped first, legacy last
  });
  let sawSidScopedMismatch = false;
  for (const p of ordered) {
    const fileSid = extractSessionFromFilename(p);
    if (fileSid !== null) {
      // Session-scoped file — consume only if it matches current session.
      if (!sid || fileSid !== sid) { sawSidScopedMismatch = true; continue; }
      const payload = peekPayload(p);
      if (!payload) continue;
      // Check session_id BEFORE unlink so a mismatched payload isn't destroyed.
      if (payload.session_id && sessionId && payload.session_id !== sessionId) {
        continue;
      }
      unlinkSafe(p);
      return payload;
    }
    // Legacy single-file: if we already saw a mismatched sid-scoped file, skip
    // legacy fallthrough — the user has an active sid session and legacy data
    // would be stale.
    if (sawSidScopedMismatch) continue;
    // Legacy single-file (auto-confirm-queue.json): peek FIRST, then only
    // unlink if the payload's session_id matches (or has none). This prevents
    // racing sessions from destroying each other's legacy payloads.
    const payload = peekPayload(p);
    if (!payload) continue;
    if (payload.session_id && sessionId && payload.session_id !== sessionId) {
      // Not ours — leave the file for the owning session to consume.
      continue;
    }
    // sid-less legacy file: require a minimum age before adopting so the
    // owning session has a chance to claim it. Too-young → skip + leave intact.
    if (!payload.session_id) {
      let ageMs = Infinity;
      try {
        const st = statSync(p);
        ageMs = Date.now() - st.mtimeMs;
      } catch {}
      if (ageMs < LEGACY_ADOPT_MIN_AGE_MS) continue;
    }
    unlinkSafe(p);
    return payload;
  }
  return null;
}

export function formatContext(payload) {
  const tasks = Array.isArray(payload.pending_tasks) ? payload.pending_tasks : [];
  const taskLines = tasks.length > 0
    ? tasks.map(t => `  - [${t.status || 'pending'}] ${t.title || ''}`).join('\n')
    : '  (none tracked)';
  const lastMsg = (payload.last_message || '').trim();
  return `[AUTO-CONFIRM FORWARD]\n\nOn the previous turn you ended while pending tasks remained in .smt/. Continue that work now — do not ask for confirmation.\n\n## Your prior last message (verbatim, truncated)\n${lastMsg || '(empty)'}\n\n## Pending tasks\n${taskLines}\n\nAct on the next concrete step. Name files/commands directly.`;
}

async function main() {
  printTag('Auto-Confirm Consumer');
  try {
    const input = readStdinSync();
    let data = {};
    try { data = JSON.parse(input); } catch {}

    const directory = data.cwd || data.directory || process.cwd();
    const sessionId = data.session_id || data.sessionId || '';
    const prompt = extractPrompt(input);
    if (!isWorkflowContinuationPrompt(prompt)) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }
    const payload = consumeQueueFile(directory, sessionId);
    if (!payload) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    printTag('Auto-Confirm: consumed');
    console.log(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: formatContext(payload),
      },
    }));
  } catch {
    console.log(JSON.stringify({ continue: true }));
  }
}

if (process.argv[1] && process.argv[1] === __filename) {
  main();
}
