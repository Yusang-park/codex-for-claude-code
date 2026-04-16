#!/usr/bin/env node
/**
 * tool-retry.mjs — PostToolUse hook.
 *
 * Detects transient tool errors (rg timeout, file-modified, rg flag-parse,
 * grep exit-1-no-match) and asks the main agent to auto-retry with a
 * [Auto-Retry: <reason>] yellow tag. Retry counter keyed by
 * sha256(tool_name + args). Hard cap of 3 retries per key per session.
 *
 * Input payload (best-effort compat with Claude Code PostToolUse):
 *   {
 *     session_id, cwd,
 *     tool_name,      // e.g. "Grep", "Edit", "Bash"
 *     tool_input,     // object
 *     tool_output: { stdout, stderr, exit_code, error }
 *     tool_response: { ... }   // alternate shape
 *   }
 *
 * Output: either { continue: true } (no action) or
 *   { decision: "block", reason: "[Auto-Retry: <reason>] ..." }
 * On grep exit-1-no-match, output is { continue: true } and a reclassify
 * hint is printed so the pattern doesn't inflate error logs.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { printTag } from './lib/yellow-tag.mjs';

const __filename = fileURLToPath(import.meta.url);
const MAX_RETRIES = 3;
const COUNTER_TTL_MS = 30 * 60 * 1000; // 30 min — prune older entries on every read

function readStdinSync() {
  try { return readFileSync('/dev/stdin', 'utf-8'); } catch { return '{}'; }
}

function gatherText(...parts) {
  return parts.filter(Boolean).map(String).join('\n');
}

/**
 * Extract a single text blob covering stdout/stderr/error regardless of payload shape.
 */
export function extractToolResultText(data) {
  const out = data.tool_output || data.toolOutput || data.output || {};
  const resp = data.tool_response || data.toolResponse || {};
  return gatherText(
    out.stdout, out.stderr, out.error, out.message,
    resp.stdout, resp.stderr, resp.error, resp.message,
    data.error, data.message,
  );
}

export function extractExitCode(data) {
  const out = data.tool_output || data.toolOutput || data.output || {};
  const resp = data.tool_response || data.toolResponse || {};
  const candidates = [out.exit_code, out.exitCode, resp.exit_code, resp.exitCode, data.exit_code, data.exitCode];
  for (const c of candidates) {
    if (typeof c === 'number') return c;
  }
  return null;
}

/**
 * Pattern table — ordered. First match wins.
 * Each entry: { regex, classify(text,data) => { kind, reason, action } }
 */
export const RETRY_PATTERNS = [
  {
    name: 'rg-timeout',
    regex: /Ripgrep search timed out after \d+ seconds/i,
    kind: 'retry',
    reason: 'Ripgrep timeout',
    action: 'retry-then-narrow',
  },
  {
    name: 'file-modified',
    regex: /File has been modified since (last )?read\b/i,
    kind: 'retry',
    reason: 'File modified since read',
    action: 'reread-then-retry',
  },
  {
    name: 'rg-flag-parse',
    regex: /rg:\s*error\s*parsing\s*flag\s*-[\w-]+/i,
    kind: 'retry',
    reason: 'rg flag-parse misread',
    action: 'wrap-in-bash-c',
  },
  {
    name: 'grep-no-match',
    regex: /\bgrep\b[\s\S]*?Exit code:?\s*1\b/i,
    kind: 'success',
    reason: 'grep no-match (exit 1)',
    action: 'reclassify-success',
  },
];

/**
 * grep exit-1 is ambiguous: could be "no match" (benign) or a real error
 * (permission denied, bad pattern). We only reclassify as success when:
 *   - stdout is empty, AND
 *   - stderr is empty OR stderr explicitly matches a benign "no match" phrase
 * Any other stderr content (permission denied, syntax error, etc.) is left
 * un-reclassified so the real failure surfaces.
 */
export function isBenignGrepNoMatch(data) {
  const out = data.tool_output || data.toolOutput || data.output || {};
  const resp = data.tool_response || data.toolResponse || {};
  const stdout = (out.stdout || resp.stdout || '').toString();
  const stderr = (out.stderr || resp.stderr || '').toString();
  if (stdout.trim().length > 0) return false;
  if (stderr.trim().length === 0) return true;
  // Common no-match phrasings. Anything else (permission denied, invalid option)
  // is treated as a real error.
  return /no such file|no matches? found|binary file .* matches/i.test(stderr)
    ? true
    : false;
}

export function classifyError(text, exitCode, toolName, data = {}) {
  if (!text && exitCode !== 1) return null;
  for (const p of RETRY_PATTERNS) {
    if (p.name === 'grep-no-match') continue; // handled below with stricter gate
    if (p.regex.test(text)) return p;
  }
  // grep-no-match: exit 1 + empty output + benign/absent stderr only
  if (
    exitCode === 1 &&
    toolName &&
    /^(Bash|Shell)$/i.test(toolName) &&
    /grep\b/i.test(text) &&
    isBenignGrepNoMatch(data)
  ) {
    return RETRY_PATTERNS.find(p => p.name === 'grep-no-match');
  }
  return null;
}

export function retryKey(sessionId, toolName, toolInput) {
  // Fallback chain: explicit sessionId → CLAUDE_SESSION env → pid-stamped sentinel.
  // This prevents cross-session counter collisions when sessionId is missing —
  // two concurrent processes without a sid would otherwise hash to the same key.
  const sid = sessionId || process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_SESSION || `pid-${process.pid}`;
  const serialized = JSON.stringify({
    s: sid,
    t: toolName || '',
    i: toolInput || {},
  });
  return createHash('sha256').update(serialized).digest('hex').slice(0, 16);
}

/**
 * Read counter map and prune entries older than COUNTER_TTL_MS. Each entry
 * is stored as `{ count, updated_at }` so we can expire stale keys and avoid
 * cross-session leakage.
 *
 * Also returns a sentinel `__pruned` flag on the returned object (non-enumerable)
 * so callers can decide whether a rewrite is needed.
 */
export function readRetryCounter(stateDir) {
  const path = join(stateDir, 'tool-retry.json');
  try {
    if (!existsSync(path)) return {};
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    if (!raw || typeof raw !== 'object') return {};
    const now = Date.now();
    const pruned = {};
    let rawCount = 0;
    let keptCount = 0;
    for (const [k, v] of Object.entries(raw)) {
      rawCount += 1;
      if (!v || typeof v !== 'object') continue;
      const updated = typeof v.updated_at === 'number' ? v.updated_at : 0;
      if (now - updated > COUNTER_TTL_MS) continue;
      pruned[k] = v;
      keptCount += 1;
    }
    Object.defineProperty(pruned, '__pruned', {
      value: rawCount !== keptCount,
      enumerable: false,
    });
    return pruned;
  } catch { return {}; }
}

export function writeRetryCounter(stateDir, counters) {
  try {
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'tool-retry.json'), JSON.stringify(counters, null, 2));
  } catch {}
}

/**
 * Reset counter for a given key (e.g. on successful non-error tool result).
 * Called by the main loop when a tool produces no retryable error.
 */
export function resetRetryCounter(stateDir, key) {
  const counters = readRetryCounter(stateDir);
  if (counters[key]) {
    delete counters[key];
    writeRetryCounter(stateDir, counters);
  }
}

function buildRetryInstruction(pattern, toolName, toolInput) {
  switch (pattern.action) {
    case 'retry-then-narrow':
      return `Retry the ${toolName} call. If it still times out, narrow scope: add --max-count 500, restrict the path glob, or split the pattern.`;
    case 'reread-then-retry':
      return `Re-Read the target file(s) first to refresh their current content, then re-issue the ${toolName} with the freshly loaded content.`;
    case 'wrap-in-bash-c':
      return `Retry the command wrapped in \`bash -c "..."\` so the shell parses the flags instead of the tool interpreting them.`;
    default:
      return `Retry the ${toolName} call with the same parameters.`;
  }
}

async function main() {
  printTag('Tool Retry');
  try {
    const input = readStdinSync();
    let data = {};
    try { data = JSON.parse(input); } catch {}

    const directory = data.cwd || data.directory || process.cwd();
    const sessionId = data.session_id || data.sessionId || '';
    const toolName = data.tool_name || data.toolName || '';
    const toolInput = data.tool_input || data.toolInput || {};
    const stateDir = join(directory, '.smt', 'state');
    const key = retryKey(sessionId, toolName, toolInput);

    // Prune stale counter entries on every invocation (TTL-based expiry).
    // Only rewrite the file when something actually expired — avoids unnecessary
    // disk writes on every tool call.
    if (existsSync(join(stateDir, 'tool-retry.json'))) {
      const pruned = readRetryCounter(stateDir);
      if (pruned.__pruned === true) {
        writeRetryCounter(stateDir, pruned);
      }
    }

    const text = extractToolResultText(data);
    const exitCode = extractExitCode(data);

    const pattern = classifyError(text, exitCode, toolName, data);
    if (!pattern) {
      // Clean success — reset counter for this key so subsequent failures
      // start fresh instead of inheriting a stale count.
      resetRetryCounter(stateDir, key);
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    // grep no-match: reclassify as success, don't block
    if (pattern.kind === 'success') {
      resetRetryCounter(stateDir, key);
      printTag(`Auto-Retry: ${pattern.reason} (reclassified OK)`);
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    const counters = readRetryCounter(stateDir);
    const entry = counters[key];
    const current = entry && typeof entry.count === 'number' ? entry.count : 0;

    if (current >= MAX_RETRIES) {
      // Give up — don't loop forever
      printTag(`Auto-Retry: ${pattern.reason} (max retries ${MAX_RETRIES} — giving up)`);
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    counters[key] = { count: current + 1, updated_at: Date.now() };
    writeRetryCounter(stateDir, counters);

    const instruction = buildRetryInstruction(pattern, toolName || 'tool', toolInput);
    printTag(`Auto-Retry: ${pattern.reason}`);
    console.log(JSON.stringify({
      decision: 'block',
      reason: `[Auto-Retry: ${pattern.reason}] Attempt ${current + 1}/${MAX_RETRIES}. ${instruction}`,
    }));
  } catch (err) {
    console.log(JSON.stringify({ continue: true }));
  }
}

if (process.argv[1] && process.argv[1] === __filename) {
  main();
}
