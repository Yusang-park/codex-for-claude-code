#!/usr/bin/env node
// session-start-smt.mjs
// Injects TDD + caveman context + .smt/ feature task state at session start.
//
// Behavior:
//   - Reads features/*/task/plan.md for feature plans
//   - Reads features/*/task/*.md (excluding plan.md) for pending tasks
//   - If pending tasks exist → instruct Claude to notify the user

import { readFileSync, existsSync, readdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { printTag } from './lib/yellow-tag.mjs';
import { parseYaml } from './lib/yaml-parser.mjs';

printTag('Session Start');

let stdinData = {};
try { stdinData = JSON.parse(readFileSync('/dev/stdin', 'utf8')); } catch {}

const TDD_CONTEXT = `[SMELTER — TDD + E2E MODE]
You MUST follow Test-Driven Development:
1. Write tests FIRST (RED) — before any implementation code
2. Run tests — they MUST fail initially
3. Write minimal code to pass tests (GREEN)
4. Refactor (IMPROVE)
5. After all code changes, E2E tests will run automatically

CRITICAL RULES:
- NEVER write implementation before tests
- ALWAYS create test file before source file
- If tests don't exist for a feature, write them first
- E2E tests are mandatory — they will run automatically after your changes`;

const CAVEMAN_CONTEXT = `[RESPONSE STYLE: CONCISE]
Remove filler words, pleasantries, and hedging from all responses.
Keep articles, grammar, and complete sentences intact.
Technical terms, code blocks, and error messages must be exact and unchanged.
If safety warnings, security issues, or irreversible actions are involved, use full clear prose regardless.`;

// Auto-update check: git fetch + compare local vs remote.
// Runs silently on session start; updates in background if behind.
function checkAutoUpdate() {
  const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const gitDir = join(harnessRoot, '.git');
  if (!existsSync(gitDir)) return null;
  try {
    // Check only — do NOT fetch here (blocks session start).
    // Compare local HEAD against cached remote ref from last fetch.
    const status = execFileSync('git', ['rev-list', '--count', 'HEAD..@{u}'], { cwd: harnessRoot, timeout: 2000, encoding: 'utf-8', stdio: 'pipe' }).trim();
    const behind = parseInt(status, 10);
    if (behind > 0) {
      printTag(`Update: ${behind} commit(s) behind`);
      return `[SMELTER UPDATE AVAILABLE] ${behind} commit(s) behind origin. Run \`git pull && npm run build\` in the smelter directory, or let the plugin marketplace update it with \`claude plugin update smelter@smelter-marketplace\`.`;
    }
  } catch { /* offline or not a git repo — skip silently */ }
  return null;
}

// Background fetch — spawn and forget. Doesn't block session start.
// Next session will see the updated remote ref.
import { spawn } from 'child_process';
function backgroundFetch() {
  const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (!existsSync(join(harnessRoot, '.git'))) return;
  try {
    const p = spawn('git', ['fetch', '--quiet'], { cwd: harnessRoot, detached: true, stdio: 'ignore' });
    p.unref();
  } catch { /* ignore */ }
}

// Project root = first ancestor with .git OR package.json (bounds both searches).
function findProjectRoot(startDir) {
  let dir = resolve(startDir || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, 'package.json'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Find .smt/ within or above current dir, but stop at the project root.
function findSmtDir(startDir) {
  const root = findProjectRoot(startDir);
  let dir = resolve(startDir || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  for (let i = 0; i < 8; i++) {
    const smtPath = join(dir, '.smt');
    if (existsSync(smtPath)) return smtPath;
    if (root && dir === root) break;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Returns { contextStr, pendingTasks }
function readSmtContext(smtDir) {
  const sections = [];
  const pendingTasks = [];

  const featuresDir = join(smtDir, 'features');
  if (existsSync(featuresDir)) {
    let slugs = [];
    try { slugs = readdirSync(featuresDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort(); } catch {}

    for (const slug of slugs) {
      const taskDirPath = join(featuresDir, slug, 'task');
      if (!existsSync(taskDirPath)) continue;

      const overviewPath = join(taskDirPath, 'plan.md');
      if (existsSync(overviewPath)) {
        try {
          const content = readFileSync(overviewPath, 'utf8').slice(0, 2000);
          sections.push(`## Feature: ${slug} (.smt/features/${slug}/task/plan.md)\n${content}`);
        } catch {}
      }

      let taskFiles = [];
      try { taskFiles = readdirSync(taskDirPath).filter(f => f.endsWith('.md') && f !== 'plan.md').sort(); } catch {}

      const taskLines = [];
      for (const f of taskFiles) {
        try {
          const content = readFileSync(join(taskDirPath, f), 'utf8').slice(0, 2000);
          const lines = content.split('\n');
          const filtered = lines.filter(l =>
            l.startsWith('# ') || l.startsWith('## ') ||
            l.includes('- [ ]') || l.includes('- [~]') || l.includes('- [!]')
          );
          for (const l of lines) {
            const m = l.match(/^[-*] \[[ ~!]\] (.+)$/);
            if (m) pendingTasks.push(m[1].trim());
          }
          if (filtered.length > 0) taskLines.push(`### ${f.replace(/\.md$/, '')}\n${filtered.join('\n')}`);
        } catch {}
      }
      if (taskLines.length > 0) {
        sections.push(`## Pending Tasks: ${slug}\n` + taskLines.join('\n\n'));
      }
    }
  }

  const contextStr = sections.length === 0 ? '' :
    `\n\n[SMELTER FILE-BASED MEMORY]\nAgents do not memorize — agents read files.\nStructure: .smt/features/<slug>/task/plan.md + .smt/features/<slug>/task/<task-name>.md\n\n` +
    sections.join('\n\n');

  return { contextStr, pendingTasks };
}

function buildPendingNotification(pendingTasks) {
  const list = pendingTasks.map(t => `  - ${t}`).join('\n');
  return `

[SMELTER — PENDING TASKS DETECTED]
There are ${pendingTasks.length} incomplete or unstarted task(s) in .smt/:

${list}

INSTRUCTIONS FOR THIS SESSION START:
1. Immediately tell the user (in Korean if they communicate in Korean):
   "미완료 혹은 시작하지 않은 태스크가 있습니다 (${pendingTasks.length}개)."
2. List the pending tasks so the user can see them.
3. Do NOT start working on any task automatically — wait for explicit user instruction.`;
}

const MAX_CONTEXT_CHARS = 32 * 1024; // Cap total context length to prevent runaway bloat

function emit(additionalContext, priorityTail = '') {
  // priorityTail (e.g., legacy migration notice) is preserved even when the body
  // overflows — it's injected AFTER any truncation marker so critical instructions
  // survive. Reserve 2KB for it.
  const tailBudget = Math.min(priorityTail.length, 2048);
  const bodyCap = MAX_CONTEXT_CHARS - tailBudget;
  let body = additionalContext || '';
  if (body.length > bodyCap) {
    body = body.slice(0, bodyCap) + `\n\n[...truncated ${body.length - bodyCap} chars — context size limit hit]`;
  }
  const tail = priorityTail.length > tailBudget ? priorityTail.slice(0, tailBudget) : priorityTail;
  const ctx = body + tail;
  process.stdout.write(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: ctx,
    },
  }));
}

function detectWorkflowIssues(smtDir) {
  const issues = [];
  const pointerPath = join(smtDir, 'state', 'active-feature.json');
  if (existsSync(pointerPath)) {
    try { JSON.parse(readFileSync(pointerPath, 'utf8')); }
    catch (e) { issues.push(`Corrupt JSON: ${pointerPath} (${e.message})`); }
  }
  const featuresDir = join(smtDir, 'features');
  if (!existsSync(featuresDir)) return issues;

  const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let slugs = [];
  try { slugs = readdirSync(featuresDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch {}
  for (const slug of slugs) {
    const statePath = join(featuresDir, slug, 'state', 'workflow.json');
    if (!existsSync(statePath)) continue;
    let state;
    try { state = JSON.parse(readFileSync(statePath, 'utf8')); }
    catch (e) { issues.push(`Corrupt JSON: ${statePath} (${e.message})`); continue; }
    if (!state?.command || !state?.step) continue;
    const wfPath = join(harnessRoot, 'workflows', `${state.command}.yaml`);
    if (!existsSync(wfPath)) continue;
    try {
      const wf = parseYaml(readFileSync(wfPath, 'utf8'));
      if (wf?.steps && !wf.steps[state.step]) {
        issues.push(`Stale step in ${slug}: step="${state.step}" not in workflows/${state.command}.yaml (valid: ${Object.keys(wf.steps).join(', ')})`);
      }
    } catch (err) {
      process.stderr.write(`[session-start-smt] YAML parse failed for ${wfPath}: ${err.message}\n`);
      issues.push(`Workflow YAML parse error at workflows/${state.command}.yaml: ${err.message}`);
    }
  }
  return issues;
}

// Read version from package.json
function getVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch { return '0.0.0'; }
}

try {
  const version = getVersion();
  printTag(`Smelter v${version}`);

  // Auto-update check (silent, non-blocking) + spawn background fetch for next session
  const updateNotice = checkAutoUpdate() || '';
  backgroundFetch();

  const smtDir = findSmtDir();
  if (!smtDir) {
    emit(CAVEMAN_CONTEXT + '\n\n' + TDD_CONTEXT + (updateNotice ? `\n\n${updateNotice}` : ''));
  } else {
    const { contextStr, pendingTasks } = readSmtContext(smtDir);
    let extra = contextStr;
    if (pendingTasks.length > 0) extra += buildPendingNotification(pendingTasks);
    const issues = detectWorkflowIssues(smtDir);
    if (issues.length > 0) {
      extra += `\n\n[WORKFLOW RECOVERY REQUIRED]\n` + issues.map(s => `  - ${s}`).join('\n')
        + `\n\nTell the user and await instructions before continuing.`;
    }
    if (updateNotice) extra += `\n\n${updateNotice}`;
    emit(CAVEMAN_CONTEXT + '\n\n' + TDD_CONTEXT + extra);
  }
} catch (err) {
  process.stderr.write(`[session-start-smt] error: ${err.message}\n`);
  process.stdout.write(JSON.stringify({ continue: true }));
}
