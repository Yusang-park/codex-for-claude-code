/**
 * Cancel Signal — shared read/write/clear utilities
 *
 * Signal file: {project}/.smt/state/cancel-signal.json
 *
 * Two types:
 *   "hard"  — immediately block all tool execution, kill processes
 *   "queue" — let current work finish, then redirect to queued intent
 *
 * Queue signals are session-scoped; hard cancel remains project-scoped.
 * Auto-expires after 5 minutes to prevent stale signals from blocking future sessions.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';

const SIGNAL_FILENAME = 'cancel-signal.json';
const EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

function getSignalPath(directory) {
  return join(directory, '.smt', 'state', SIGNAL_FILENAME);
}

function ensureStateDir(directory) {
  const dir = join(directory, '.smt', 'state');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Write a cancel signal.
 * @param {string} directory — project root
 * @param {"hard"|"queue"} type
 * @param {object} options
 * @param {string} [options.reason]
 * @param {string} [options.source] — "keyword" | "skill" | "propagator"
 * @param {string} [options.queuedIntent] — only for type "queue"
 * @param {string} [options.sessionId] — required for type "queue" session scoping
 */
export function writeCancel(directory, type, options = {}) {
  ensureStateDir(directory);
  const signal = {
    type,
    timestamp: Date.now(),
    reason: options.reason || 'user request',
    source: options.source || 'keyword',
  };
  if (type === 'queue') {
    if (options.queuedIntent) {
      signal.queued_intent = options.queuedIntent;
    }
    if (options.sessionId) {
      signal.session_id = options.sessionId;
    }
  }
  writeFileSync(getSignalPath(directory), JSON.stringify(signal, null, 2));
  return signal;
}

/**
 * Read the cancel signal. Returns null if absent, expired, or session-mismatched.
 */
export function readCancel(directory, sessionId = '') {
  const path = getSignalPath(directory);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    if (Date.now() - data.timestamp > EXPIRY_MS) {
      clearCancel(directory);
      return null;
    }
    if (data.type === 'queue') {
      if (!data.session_id || !sessionId || data.session_id !== sessionId) {
        return null;
      }
    }
    return data;
  } catch {
    return null;
  }
}

/**
 * Delete the cancel signal file.
 */
export function clearCancel(directory) {
  const path = getSignalPath(directory);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch { /* best-effort */ }
}

/**
 * Check if hard cancel is active.
 */
export function isHardCancel(directory) {
  const signal = readCancel(directory);
  return signal?.type === 'hard';
}

/**
 * Check if queue cancel is active.
 */
export function isQueueCancel(directory, sessionId = '') {
  const signal = readCancel(directory, sessionId);
  return signal?.type === 'queue';
}
