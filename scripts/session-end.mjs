#!/usr/bin/env node
/**
 * session-end.mjs — SessionEnd hook.
 *
 * Runs the legacy dist-based processor (if present) AND enforces the
 * smelter documentation sync contract:
 *
 *   1. Command set across tracked md files matches {tasker, feat, qa}
 *   2. Preset JSON filenames match the command names
 *   3. Step number references stay within 1..10
 *   4. Magic keyword table in keyword-detector.mjs stays in sync with command set
 *   5. Forbidden legacy references (/blueprint, /todo, /simple) → 0 hits
 *
 * On mismatch: stderr report + exit code 2 so the session surfaces a sync warning.
 * On pass: continue normally.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { printTag } from './lib/yellow-tag.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');
const sessionEndPath = join(PROJECT_ROOT, 'dist', 'hooks', 'session-end', 'index.js');

// --- Tracked-file list (explicit; add/remove here only) ---
export const TRACKED_MD_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  'README.md',
  'doc/index.md',
  'doc/workflow.md',
  'doc/spec.md',
  'doc/implementation.md',
  'doc/Introduce.md',
  'doc/reference.md',
];

export const TRACKED_COMMAND_FILES = [
  'commands/tasker.md',
  'commands/feat.md',
  'commands/qa.md',
];

export const TRACKED_CROSS_FILES = [
  'scripts/keyword-detector.mjs',
];

// Extra files scanned for forbidden legacy references (persistent-mode etc.)
// Glob-like prefix match: entries ending with `/**/*.md` are treated as dir walks.
export const TRACKED_LEGACY_SCAN = [
  'skills/**/*.md',
  'settings.json',
  'scripts/session-start-smt.mjs',
  'scripts/cancel-propagator.mjs',
  'scripts/test-queue-session-isolation.mjs',
  'scripts/test-max-attempts.ts',
  'scripts/auto-confirm.mjs',
  'scripts/auto-confirm-consumer.mjs',
  'rules/common/testing.md',
];

export const EXPECTED_COMMANDS = ['tasker', 'feat', 'qa'];
export const FORBIDDEN_COMMANDS = ['blueprint', 'todo', 'simple'];
export const FORBIDDEN_LEGACY_PATTERN = /persistent-mode(?:\.cjs|\.mjs|\.sh)?/i;
export const FORBIDDEN_TASKER_NATIVE_PLAN_PATTERN = /EnterPlanMode|ExitPlanMode|Native Plan File|\[Plan Mode: Enter\]|\[Plan Mode: Exit\]/i;
// Extra-preset guard: only these 4 preset JSONs are allowed.
export const ALLOWED_PRESETS = ['tasker', 'feat', 'qa'];
export const FORBIDDEN_EXTRA_PRESETS = ['full', 'narrow', 'planning', 'autopilot', 'e2e-force', 'tdd'];

function readFileSafe(path) {
  try { return existsSync(path) ? readFileSync(path, 'utf-8') : null; } catch { return null; }
}

function listDir(path) {
  try { return existsSync(path) ? readdirSync(path) : []; } catch { return []; }
}

function walkMdFiles(rootAbs, relPrefix) {
  const out = [];
  if (!existsSync(rootAbs)) return out;
  const stack = [rootAbs];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) { stack.push(abs); continue; }
      if (e.isFile() && e.name.endsWith('.md')) out.push(abs);
    }
  }
  return out;
}

/**
 * Is a line a pure comment we can safely ignore for forbidden-pattern scanning?
 * Anything starting with //, #, or * (after optional whitespace) is treated as
 * a comment. Executing code on any other line is flagged.
 */
function isCommentOnlyLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith('//')) return true;
  if (trimmed.startsWith('#')) return true;
  if (trimmed.startsWith('*')) return true;
  return false;
}

/**
 * Replace a span of `source` between [start,end) with whitespace that preserves
 * line numbers (newlines kept, everything else turned into spaces). This lets
 * the downstream per-line scanner keep accurate line-number reporting while
 * ignoring content inside stripped spans.
 */
function blankSpan(source, start, end) {
  const span = source.slice(start, end);
  const blanked = span.replace(/[^\n]/g, ' ');
  return source.slice(0, start) + blanked + source.slice(end);
}

/**
 * Strip regex-matched spans from `source`, preserving line numbers.
 * INVARIANT: `blankSpan` replaces matched text with whitespace of identical
 * byte length (newlines preserved, everything else → space). Because total
 * string length is unchanged, `regex.lastIndex = end` remains valid across
 * iterations of the same global regex.
 */
function stripSpans(source, regex) {
  let out = source;
  let m;
  regex.lastIndex = 0;
  while ((m = regex.exec(out)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    out = blankSpan(out, start, end);
    regex.lastIndex = end;
  }
  return out;
}

/**
 * Blank out CommonMark-style fenced code blocks in `content` with line-number
 * preserving whitespace. Scans line by line, tracking an `in-fence` flag
 * toggled by matching fence markers (``` or ~~~ at line start with optional
 * leading whitespace). The closing fence must use the same delimiter character
 * and be at least as long as the opener — this is what allows nested fences
 * (e.g. an outer ``` block that contains an inner ``` block literal) to be
 * treated as a single outer span rather than prematurely closing.
 */
function stripFencedBlocks(content, filePath = '') {
  const lines = content.split('\n');
  let inFence = false;
  let fenceChar = '';   // '`' or '~'
  let fenceLen = 0;
  let fenceOpenLine = -1;
  const out = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^(\s*)(`{3,}|~{3,})/);
    if (!inFence) {
      if (m) {
        inFence = true;
        fenceChar = m[2][0];
        fenceLen = m[2].length;
        fenceOpenLine = i;
        // Blank the opener line itself.
        out[i] = line.replace(/[^\n]/g, ' ');
      } else {
        out[i] = line;
      }
    } else {
      // Inside a fence — blank everything.
      out[i] = line.replace(/[^\n]/g, ' ');
      if (m && m[2][0] === fenceChar && m[2].length >= fenceLen) {
        // Closing fence: same char, at least as long as opener.
        inFence = false;
        fenceChar = '';
        fenceLen = 0;
        fenceOpenLine = -1;
      }
    }
  }
  // Unclosed fence at EOF: an unterminated fence must NOT silently exempt the
  // trailing region — restore original content from opener onward and warn.
  if (inFence && fenceOpenLine >= 0) {
    for (let i = fenceOpenLine; i < lines.length; i++) {
      out[i] = lines[i];
    }
    const fileLabel = filePath || '<unknown>';
    process.stderr.write(
      `[Doc Sync Check] WARN: unclosed fence at line ${fenceOpenLine + 1} in ${fileLabel}\n`,
    );
  }
  return out.join('\n');
}

/**
 * Return `content` with sections that cannot contain executable references
 * blanked out (replaced with whitespace of the same length, preserving line
 * numbers). Supported strip types:
 *   - markdown:  fenced code blocks (``` ... ```) and YAML front matter at file head
 *   - source:    /* ... *​/ block comments spanning any number of lines
 *   - json:      none (raw content)
 */
export function stripNonExecutable(content, filePath = '') {
  if (!content) return content;
  const p = filePath.toLowerCase();
  if (p.endsWith('.md') || p.endsWith('.markdown')) {
    let out = content;
    // YAML front matter only if it's the first thing in the file. CRLF-tolerant,
    // allows closing `---` to end at EOF (no trailing newline required).
    out = out.replace(/^---\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, (m) => m.replace(/[^\n]/g, ' '));
    // Fenced code blocks via line-by-line scanner (handles nesting / same-delim
    // inner markers by requiring the closing fence to match the opener's char
    // and length). Unclosed fences at EOF are restored + warned, not exempted.
    out = stripFencedBlocks(out, filePath);
    return out;
  }
  if (/\.(m?js|cjs|[cm]?ts|tsx|jsx)$/.test(p)) {
    // Block comments — may span many lines.
    return stripSpans(content, /\/\*[\s\S]*?\*\//g);
  }
  // .json and other formats: return as-is.
  return content;
}

function expandLegacyScanFiles(projectRoot) {
  const abs = [];
  for (const spec of TRACKED_LEGACY_SCAN) {
    if (spec.endsWith('/**/*.md')) {
      const prefix = spec.slice(0, -'/**/*.md'.length);
      const root = join(projectRoot, prefix);
      for (const f of walkMdFiles(root, prefix)) abs.push(f);
    } else {
      abs.push(join(projectRoot, spec));
    }
  }
  return abs;
}

/**
 * Extract unique /xxx command references from text. Limits to a small alpha set
 * to avoid matching URLs or paths.
 */
export function extractCommandRefs(text) {
  if (!text) return [];
  const refs = new Set();
  const re = /\/([a-z]{3,16})\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) refs.add(m[1].toLowerCase());
  return [...refs];
}

/**
 * Extract Step N references (N must be 1..11 to be valid).
 * Only counts Step refs that appear in a workflow context — either the file
 * path contains `doc/`, or the line itself mentions `workflow`. This avoids
 * false positives from README recipes, changelog notes, etc.
 */
export function extractStepRefs(text, filePath = '') {
  if (!text) return [];
  const refs = new Set();
  const isDocFile = /(^|\/)doc\//.test(filePath);
  // Cross-files (e.g. scripts/keyword-detector.mjs) are authoritative for the
  // step numbering contract too — a `Step 99` there must be flagged.
  const normalized = filePath.replace(/^\.\//, '');
  const isCrossFile = TRACKED_CROSS_FILES.some(
    (f) => normalized === f || normalized.endsWith('/' + f),
  );
  const lines = text.split('\n');
  for (const line of lines) {
    const re = /\bstep\s+(\d{1,2})\b/gi;
    let m;
    while ((m = re.exec(line)) !== null) {
      const n = Number(m[1]);
      if (isDocFile || isCrossFile || /workflow/i.test(line)) refs.add(n);
    }
  }
  return [...refs];
}

/**
 * The core sync checker. Returns { ok, issues: [{severity, file, message}] }.
 */
export function checkDocSync(projectRoot) {
  const issues = [];
  const mdFiles = [...TRACKED_MD_FILES, ...TRACKED_COMMAND_FILES, ...TRACKED_CROSS_FILES];

  // --- 1. Forbidden-reference check (covers md + cross files) ---
  for (const rel of mdFiles) {
    const abs = join(projectRoot, rel);
    const content = readFileSafe(abs);
    if (content === null) continue;
    for (const forbidden of FORBIDDEN_COMMANDS) {
      const re = new RegExp(`\\/${forbidden}\\b`, 'i');
      if (re.test(content)) {
        issues.push({
          severity: 'error',
          file: rel,
          message: `Forbidden legacy command reference: /${forbidden}`,
        });
      }
    }
  }

  // --- 2. Step-number validity (1..10 inclusive) ---
  for (const rel of mdFiles) {
    const abs = join(projectRoot, rel);
    const content = readFileSafe(abs);
    if (content === null) continue;
    const steps = extractStepRefs(content, rel);
    for (const n of steps) {
      if (!(n >= 1 && n <= 10)) {
        issues.push({
          severity: 'error',
          file: rel,
          message: `Invalid step reference: Step ${n} (must be 1..10)`,
        });
      }
    }
  }

  // --- 2b. Forbidden legacy pattern (persistent-mode) across wider scope ---
  const legacyAbs = expandLegacyScanFiles(projectRoot);
  for (const abs of legacyAbs) {
    const content = readFileSafe(abs);
    if (content === null) continue;
    const rel = abs.startsWith(projectRoot) ? abs.slice(projectRoot.length + 1) : abs;
    // Blank out fenced markdown code, YAML front matter, and /* ... */ block
    // comments so they never trip the line-level scan. Line numbers preserved.
    const scrubbed = stripNonExecutable(content, rel);
    const lines = scrubbed.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!FORBIDDEN_LEGACY_PATTERN.test(line)) continue;
      if (isCommentOnlyLine(line)) continue;
      issues.push({
        severity: 'error',
        file: rel,
        message: `Forbidden legacy reference on line ${i + 1}: persistent-mode`,
      });
    }
  }

  // --- 2c. Forbidden tasker native-plan references in tracked docs/commands ---
  for (const rel of mdFiles) {
    const abs = join(projectRoot, rel);
    const content = readFileSafe(abs);
    if (content === null) continue;
    const scrubbed = stripNonExecutable(content, rel);
    const lines = scrubbed.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(FORBIDDEN_TASKER_NATIVE_PLAN_PATTERN);
      if (!match) continue;
      if (isCommentOnlyLine(line)) continue;
      issues.push({
        severity: 'error',
        file: rel,
        message: `Forbidden tasker native-plan reference on line ${i + 1}: ${match[0]}`,
      });
    }
  }

  // --- 2d. Forbidden extra presets — enforce exactly {tasker,feat,qa} ---
  // Case-insensitive: normalize filename to lowercase and strip any .json/.JSON
  // suffix before comparing. This catches case-variant filenames like
  // `Full.JSON` on case-insensitive filesystems (macOS default, Windows).
  const presetsDirForExtra = join(projectRoot, 'presets');
  const presetFilesAll = listDir(presetsDirForExtra)
    .filter(f => /\.json$/i.test(f))
    .map(f => f.toLowerCase().replace(/\.json$/i, ''));
  for (const extra of presetFilesAll) {
    if (!ALLOWED_PRESETS.includes(extra)) {
      issues.push({
        severity: 'error',
        file: 'presets/',
        message: `Forbidden extra preset: presets/${extra}.json (only ${ALLOWED_PRESETS.join(', ')} allowed)`,
      });
    }
  }
  for (const forbidden of FORBIDDEN_EXTRA_PRESETS) {
    if (presetFilesAll.includes(forbidden)) {
      // Already flagged above, but emit a clearer specific message too.
      issues.push({
        severity: 'error',
        file: 'presets/',
        message: `Legacy preset still present: presets/${forbidden}.json`,
      });
    }
  }

  // --- 3. Preset name consistency ---
  const presetsDir = join(projectRoot, 'presets');
  const presetFiles = listDir(presetsDir)
    .filter(f => /\.json$/i.test(f))
    .map(f => f.toLowerCase().replace(/\.json$/i, ''));
  for (const cmd of EXPECTED_COMMANDS) {
    if (!presetFiles.includes(cmd)) {
      issues.push({
        severity: 'error',
        file: 'presets/',
        message: `Missing preset: presets/${cmd}.json (expected for /${cmd})`,
      });
    }
  }
  for (const name of ['narrow', 'planning']) {
    if (presetFiles.includes(name)) {
      issues.push({
        severity: 'error',
        file: 'presets/',
        message: `Legacy preset still present: presets/${name}.json (should be removed)`,
      });
    }
  }

  // --- 4. Command directory must have exactly the expected files ---
  const commandsDir = join(projectRoot, 'commands');
  const cmdFiles = listDir(commandsDir)
    .filter(f => f.endsWith('.md'))
    .map(f => f.replace(/\.md$/, ''));
  for (const cmd of EXPECTED_COMMANDS) {
    if (!cmdFiles.includes(cmd)) {
      issues.push({
        severity: 'error',
        file: 'commands/',
        message: `Missing command file: commands/${cmd}.md`,
      });
    }
  }
  for (const legacy of FORBIDDEN_COMMANDS) {
    if (cmdFiles.includes(legacy)) {
      issues.push({
        severity: 'error',
        file: 'commands/',
        message: `Legacy command file still present: commands/${legacy}.md`,
      });
    }
  }

  // --- 5. keyword-detector magic keyword table must list all expected commands ---
  const kd = readFileSafe(join(projectRoot, 'scripts', 'keyword-detector.mjs'));
  if (kd !== null) {
    for (const cmd of EXPECTED_COMMANDS) {
      // Match either `command: 'tasker'` or `tasker:` (object key in COMMAND_CONFIG)
      const pattern = new RegExp(`(?:command:\\s*['"]${cmd}['"])|(?:^\\s*${cmd}:\\s*\\{)`, 'm');
      if (!pattern.test(kd)) {
        issues.push({
          severity: 'error',
          file: 'scripts/keyword-detector.mjs',
          message: `Magic keyword table missing command mapping: ${cmd}`,
        });
      }
    }
    for (const forbidden of FORBIDDEN_COMMANDS) {
      const pattern = new RegExp(`command:\\s*['"]${forbidden}['"]`);
      if (pattern.test(kd)) {
        issues.push({
          severity: 'error',
          file: 'scripts/keyword-detector.mjs',
          message: `Legacy mapping still present: ${forbidden}`,
        });
      }
    }
  }

  // --- 6. Warn if user-global .smt/ has runtime state beyond config.json ---
  try {
    const globalDir = join(homedir(), '.smt');
    if (existsSync(globalDir)) {
      const entries = readdirSync(globalDir).filter(f => f !== 'config.json' && !f.startsWith('.'));
      for (const entry of entries) {
        issues.push({
          severity: 'warn',
          file: `~/.smt/${entry}`,
          message: `User-global state file detected outside config.json — should be project-scoped in {project}/.smt/state/`,
        });
      }
    }
  } catch {}

  return { ok: issues.filter(i => i.severity === 'error').length === 0, issues };
}

function formatReport(result) {
  const errors = result.issues.filter(i => i.severity === 'error');
  const warns = result.issues.filter(i => i.severity === 'warn');
  const lines = [];

  if (errors.length > 0) {
    lines.push('[Doc Sync Check] smelter documentation out of sync:');
    for (const i of errors) {
      lines.push(`  - (error) ${i.file}: ${i.message}`);
    }
    lines.push('');
    lines.push('Fix these references, then finish the session.');
  }

  if (warns.length > 0) {
    lines.push('[Doc Sync Check] Warnings:');
    for (const i of warns) {
      lines.push(`  - (warn) ${i.file}: ${i.message}`);
    }
  }

  return lines.join('\n');
}

async function runLegacyDistHook(data) {
  if (!existsSync(sessionEndPath)) return null;
  try {
    const { processSessionEnd } = await import(pathToFileURL(sessionEndPath).href);
    return await processSessionEnd(data);
  } catch {
    return null;
  }
}

async function main() {
  printTag('Session End');
  let input = '{}';
  try { input = readFileSync('/dev/stdin', 'utf-8'); } catch {}
  let data = {};
  try { data = JSON.parse(input); } catch {}

  const directory = data.cwd || data.directory || process.cwd();

  printTag('Doc Sync Check');

  // Run sync check on the smelter project root by default,
  // but fall back to the session's cwd if it looks like a smelter project.
  const projectRoot = existsSync(join(directory, 'commands', 'feat.md'))
    ? directory
    : PROJECT_ROOT;

  const syncResult = checkDocSync(projectRoot);

  // Also run legacy dist hook if present (non-blocking)
  try { await runLegacyDistHook(data); } catch {}

  if (!syncResult.ok) {
    process.stderr.write(formatReport(syncResult) + '\n');
    console.log(JSON.stringify({
      continue: true,
      reason: `[Doc Sync Check] ${syncResult.issues.length} issue(s) found. See stderr.`,
    }));
    process.exit(2);
  }

  console.log(JSON.stringify({ continue: true }));
}

if (process.argv[1] && process.argv[1] === __filename) {
  main().catch(err => {
    process.stderr.write(`[session-end] Error: ${err.message}\n`);
    // Errors should not block session end
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  });
}
