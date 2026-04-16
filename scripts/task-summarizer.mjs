#!/usr/bin/env node

/**
 * Task Summarizer — UserPromptSubmit hook
 *
 * Captures the user's request and caches it per-cwd for the HUD statusline
 * taskSummary widget to display.
 *
 * Cache: ~/.claude/hud/task-summary/{cwdKey}.json
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CACHE_DIR = join(homedir(), '.claude', 'hud', 'task-summary');
const MIN_PROMPT_LENGTH = 5;
const SLASH_CMD_RE = /^\/(tasker|feat|qa|cancel|queue|help|model|usage|hud|instinct|evolve|doctor|skill)\b/i;

function cacheKeyForCwd(cwd) {
  return Buffer.from(cwd || 'default').toString('base64url');
}

function cachePath(cwd) {
  return join(CACHE_DIR, `${cacheKeyForCwd(cwd)}.json`);
}

function readStdinSync() {
  try { return readFileSync('/dev/stdin', 'utf-8'); } catch { return '{}'; }
}

function extractPrompt(input) {
  try {
    const data = JSON.parse(input);
    if (data.prompt) return data.prompt;
    if (data.message?.content) return data.message.content;
    if (Array.isArray(data.parts)) {
      return data.parts.filter(p => p.type === 'text').map(p => p.text).join(' ');
    }
    return '';
  } catch {
    return '';
  }
}

function isSubstantive(prompt) {
  const trimmed = prompt.trim();
  if (trimmed.length < MIN_PROMPT_LENGTH) return false;
  if (SLASH_CMD_RE.test(trimmed)) return false;
  if (trimmed.startsWith('<task-notification>')) return false;
  if (trimmed.startsWith('<system-reminder>')) return false;
  return true;
}

function writeCache(cwd, rawPrompt, sessionId) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const data = {
    raw_prompt: rawPrompt,
    timestamp: new Date().toISOString(),
    cwd,
    session_id: sessionId || null,
  };
  writeFileSync(cachePath(cwd), JSON.stringify(data, null, 2));
}

// --- Hook mode ---

try {
  const input = readStdinSync();
  if (input.trim()) {
    let data = {};
    try { data = JSON.parse(input); } catch {}
    const cwd = data.cwd || data.directory || process.cwd();
    const prompt = extractPrompt(input);
    if (isSubstantive(prompt)) {
      const sessionId = data.session_id || data.sessionId || null;
      writeCache(cwd, prompt.trim(), sessionId);
    }
  }
} catch { /* ignore */ }

console.log(JSON.stringify({ continue: true }));
