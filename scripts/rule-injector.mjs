#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { printTag } from './lib/yellow-tag.mjs';

function readStdinSync() {
  try { return readFileSync('/dev/stdin', 'utf-8'); } catch { return '{}'; }
}

const EXT_TO_LANG = {
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'typescript', '.jsx': 'typescript', '.mjs': 'typescript', '.cjs': 'typescript',
  '.py': 'python',
  '.go': 'golang',
  '.swift': 'swift',
  '.php': 'php',
  '.rs': 'rust',
  '.cpp': 'cpp', '.cc': 'cpp', '.h': 'cpp', '.hpp': 'cpp',
  '.cs': 'csharp',
  '.java': 'java',
  '.kt': 'kotlin', '.kts': 'kotlin',
  '.pl': 'perl', '.pm': 'perl',
};

const RULE_FILES = ['coding-style.md', 'patterns.md', 'testing.md', 'security.md', 'hooks.md'];
const MAX_FILE_SIZE = 8 * 1024;
const INJECT_STATE_FILE = 'rule-inject-state.json';

function detectLanguage(filePath) {
  if (!filePath) return null;
  const ext = extname(filePath).toLowerCase();
  return EXT_TO_LANG[ext] || null;
}

function loadRules(projectRoot, lang) {
  const results = [];
  const dirs = lang ? ['common', lang] : ['common'];

  for (const dir of dirs) {
    for (const file of RULE_FILES) {
      const p = join(projectRoot, 'rules-lib', dir, file);
      if (!existsSync(p)) continue;
      try {
        const content = readFileSync(p, 'utf-8');
        if (content.length <= MAX_FILE_SIZE) {
          results.push({ path: `rules-lib/${dir}/${file}`, content });
        }
      } catch {}
    }
  }
  return results;
}

function readInjectState(projectRoot) {
  const p = join(projectRoot, '.smt', 'state', INJECT_STATE_FILE);
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return {}; }
}

function writeInjectState(projectRoot, state) {
  const dir = join(projectRoot, '.smt', 'state');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, INJECT_STATE_FILE), JSON.stringify(state));
}

export function injectRulesForFile(projectRoot, filePath, sessionId) {
  const lang = detectLanguage(filePath);
  const cacheKey = `${sessionId || 'default'}:${lang || 'common'}`;

  const state = readInjectState(projectRoot);
  if (state[cacheKey]) {
    return null;
  }

  const rules = loadRules(projectRoot, lang);
  if (rules.length === 0) return null;

  state[cacheKey] = Date.now();
  try { writeInjectState(projectRoot, state); } catch {}

  const langLabel = lang || 'common';
  const ruleText = rules.map(r => `\n--- ${r.path} ---\n${r.content}`).join('\n');

  return {
    tag: `Inject: rules-lib/${langLabel}`,
    context: ruleText,
  };
}

async function main() {
  printTag('Rule Injector');
  try {
    const input = readStdinSync();
    let data = {};
    try { data = JSON.parse(input); } catch {}

    const directory = data.cwd || data.directory || process.cwd();
    const sessionId = data.session_id || data.sessionId || '';
    const toolInput = data.tool_input || {};
    const filePath = toolInput.file_path || toolInput.path || '';

    if (!filePath) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    const result = injectRulesForFile(directory, filePath, sessionId);
    if (!result) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    printTag(result.tag);
    console.log(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: result.context,
      },
    }));
  } catch {
    console.log(JSON.stringify({ continue: true }));
  }
}

main();
