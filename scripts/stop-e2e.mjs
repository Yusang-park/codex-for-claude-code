#!/usr/bin/env node
// stop-e2e.mjs
// Session-scoped E2E reminder.
// Only checks files that Claude actually modified this session (tracked by post-tool-verifier).
// Outputs a minimal prompt to avoid token waste.
// E2E execution itself is Step 8 of the workflow — this hook only reminds, not enforces.

import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { printTag } from './lib/yellow-tag.mjs';

printTag('Run E2E');

const cwd = process.cwd();
const SKIP = () => {
  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
};

// --- Read session-tracked files (written by post-tool-verifier.mjs) ---
const projectHash = createHash('md5').update(cwd).digest('hex').slice(0, 8);
const trackingFile = `/tmp/smelter-session-files-${projectHash}.json`;

if (!existsSync(trackingFile)) SKIP();

let sessionFiles;
try {
  sessionFiles = JSON.parse(readFileSync(trackingFile, 'utf-8'));
} catch {
  SKIP();
}

if (!Array.isArray(sessionFiles) || sessionFiles.length === 0) SKIP();

// --- Filter: only source files (not tests, docs, config) ---
const TEST_PATTERNS = [
  /\.test\./,  /\.spec\./,  /^test_/,  /_test\./,
  /\/tests?\//,  /\/spec\//,  /\/e2e\//,  /\/integration\//,
];
const DOC_CONFIG_PATTERNS = [
  /\.(md|json|yaml|yml|toml|lock|env)$/,
  /^\.github\//i,  /^\.vscode\//i,  /^docs?\//i,
];

function isSourceFile(f) {
  const base = f.split('/').pop();
  const isTest = TEST_PATTERNS.some(p => p.test(base) || p.test(f));
  const isDoc = DOC_CONFIG_PATTERNS.some(p => p.test(f));
  return !isTest && !isDoc;
}

const sourceFiles = sessionFiles.filter(isSourceFile);
if (sourceFiles.length === 0) SKIP();

// --- Once-per-session: clear tracking after reporting ---
try { unlinkSync(trackingFile); } catch { /* best-effort */ }

// --- Detect component types (minimal) ---
function detectTypes(files) {
  const types = new Set();
  for (const f of files) {
    if (/scripts\/|hooks\//.test(f)) types.add('hook');
    if (/\bbin\/|\bcli\b/i.test(f)) types.add('cli');
    if (/\b(routes?|handlers?|controllers?|api)\b/i.test(f)) types.add('api');
    if (/\.(tsx|jsx)$|\b(components?|pages?|ui)\b/i.test(f)) types.add('ui');
    if (/\b(lib|utils?|adapters?|services?)\b/i.test(f)) types.add('lib');
  }
  return [...types];
}

const types = detectTypes(sourceFiles);
const typeStr = types.length > 0 ? types.join(', ') : 'source';

// --- Check if workflow is active (tasks.md with pending items) ---
const tasksFile = join(cwd, '.smt', 'tasks.md');
let workflowActive = false;
try {
  if (existsSync(tasksFile)) {
    const content = readFileSync(tasksFile, 'utf-8');
    workflowActive = /^- \[ \]/m.test(content);
  }
} catch { /* not active */ }

// If no active workflow, skip entirely — E2E is Step 8 of the workflow
if (!workflowActive) SKIP();

// --- Minimal output ---
const prompt = `[E2E] ${sourceFiles.length} file(s) changed [${typeStr}]. Step 8 E2E required.`;

console.error('\x1b[33m[smelter] Stop · Step 8: E2E Validation\x1b[0m');
console.log(JSON.stringify({ decision: 'block', reason: prompt }));
process.exit(0);
