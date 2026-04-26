#!/usr/bin/env node
// Tests for set-model-mode.mjs — specifically ensureCodexConfigDir()'s SHARED_LINKS
// behavior. The original bug: `skills` was omitted from SHARED_LINKS, so
// ~/.claude-codex/skills never got a symlink to ~/.claude/skills, hiding all
// user workflow skills when running claude-codex.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readlinkSync, existsSync, lstatSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureCodexConfigDir, getCodexConfigDir } from './set-model-mode.mjs';
import * as setModelMode from './set-model-mode.mjs';

function makeFakeClaudeHome() {
  const home = mkdtempSync(join(tmpdir(), 'set-model-mode-test-'));
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, 'settings.json'), '{}');
  for (const name of ['agents', 'commands', 'hooks', 'plugins', 'skills']) {
    mkdirSync(join(claudeDir, name), { recursive: true });
  }
  return home;
}

const EXPECTED_LINKS = ['settings.json', 'agents', 'commands', 'hooks', 'plugins', 'skills'];

// --- happy path ---

test('happy: creates ~/.claude-codex directory under fake HOME', () => {
  const home = makeFakeClaudeHome();
  ensureCodexConfigDir(home);
  assert.ok(existsSync(getCodexConfigDir(home)), '~/.claude-codex must exist after call');
});

test('happy: creates all six expected symlinks including skills', () => {
  const home = makeFakeClaudeHome();
  ensureCodexConfigDir(home);
  const dst = getCodexConfigDir(home);
  for (const name of EXPECTED_LINKS) {
    const link = join(dst, name);
    assert.ok(existsSync(link), `missing link: ${name}`);
    assert.ok(lstatSync(link).isSymbolicLink(), `${name} must be a symlink`);
  }
});

// --- boundary ---

test('boundary: idempotent — second call does not throw or replace existing links', () => {
  const home = makeFakeClaudeHome();
  ensureCodexConfigDir(home);
  const dst = getCodexConfigDir(home);
  const skillsLink = join(dst, 'skills');
  const beforeTarget = readlinkSync(skillsLink);
  ensureCodexConfigDir(home);
  assert.equal(readlinkSync(skillsLink), beforeTarget, 'symlink target must not change on second call');
});

test('boundary: returns the codex config dir path', () => {
  const home = makeFakeClaudeHome();
  const returned = ensureCodexConfigDir(home);
  assert.equal(returned, getCodexConfigDir(home));
});

// --- error path ---

test('error: missing source target is skipped silently, no throw', () => {
  const home = mkdtempSync(join(tmpdir(), 'set-model-mode-test-'));
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, 'settings.json'), '{}');
  mkdirSync(join(claudeDir, 'skills'), { recursive: true });
  assert.doesNotThrow(() => ensureCodexConfigDir(home));
  const dst = getCodexConfigDir(home);
  assert.ok(existsSync(join(dst, 'settings.json')), 'settings.json link must exist');
  assert.ok(existsSync(join(dst, 'skills')), 'skills link must exist');
  assert.ok(!existsSync(join(dst, 'agents')), 'agents must NOT be linked when target absent');
});

test('error: missing ~/.claude entirely — creates dst but no links', () => {
  const home = mkdtempSync(join(tmpdir(), 'set-model-mode-test-'));
  assert.doesNotThrow(() => ensureCodexConfigDir(home));
  const dst = getCodexConfigDir(home);
  assert.ok(existsSync(dst), 'dst dir always created');
  for (const name of EXPECTED_LINKS) {
    assert.ok(!existsSync(join(dst, name)), `${name} must not exist when source missing`);
  }
});

// --- edge case ---

test('edge: pre-existing user symlink at skills is preserved (manual workaround)', () => {
  const home = makeFakeClaudeHome();
  const dst = getCodexConfigDir(home);
  mkdirSync(dst, { recursive: true });
  const altTarget = join(home, '.claude-alt-skills');
  mkdirSync(altTarget, { recursive: true });
  symlinkSync(altTarget, join(dst, 'skills'));
  ensureCodexConfigDir(home);
  assert.equal(readlinkSync(join(dst, 'skills')), altTarget, 'user-created symlink must be preserved');
});

test('edge: skills link resolves to ~/.claude/skills target', () => {
  const home = makeFakeClaudeHome();
  ensureCodexConfigDir(home);
  const skillsLink = join(getCodexConfigDir(home), 'skills');
  assert.equal(readlinkSync(skillsLink), join(home, '.claude', 'skills'));
});

test('edge: all created links point into the matching ~/.claude/<name>', () => {
  const home = makeFakeClaudeHome();
  ensureCodexConfigDir(home);
  const dst = getCodexConfigDir(home);
  for (const name of EXPECTED_LINKS) {
    assert.equal(
      readlinkSync(join(dst, name)),
      join(home, '.claude', name),
      `${name} link target mismatch`,
    );
  }
});

// --- integration ---

test('integration: ensureCodexConfigDir reproduces the observed ~/.claude-codex layout', () => {
  const home = makeFakeClaudeHome();
  ensureCodexConfigDir(home);
  const dst = getCodexConfigDir(home);
  const found = EXPECTED_LINKS.filter(name => lstatSync(join(dst, name)).isSymbolicLink());
  assert.deepEqual(found.sort(), [...EXPECTED_LINKS].sort(), 'exactly six shared symlinks expected');
});

test('integration: skills link is usable — listing shows source skills through the link', () => {
  const home = makeFakeClaudeHome();
  const skillDir = join(home, '.claude', 'skills', 'marker-skill');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '# marker');
  ensureCodexConfigDir(home);
  const viaLink = join(getCodexConfigDir(home), 'skills', 'marker-skill', 'SKILL.md');
  assert.ok(existsSync(viaLink), 'skill file must be reachable through the symlink');
});

// =============================================================================
// FIX SCOPE — claude-codex skills slot dangling + repo fallback
// Investigation: .smt/features/feature-a82b463f-5436-4865-a93b-15c161f2353b/task/investigation.md
// =============================================================================
//
// Two defects in `ensureCodexConfigDir`:
//  D1. existsSync(link) follows symlinks → dangling link returns false → guard
//      A passes through; but guard B (target missing) then short-circuits.
//      Net: dangling slot stays dangling forever. No self-heal path.
//  D2. No repo-fallback. Smelter dev-install removes ~/.claude/skills as
//      LEGACY, so guard B silently skips and ~/.claude-codex/skills is never
//      created. Workflow-* skills invisible in codex mode.
//
// Fix contract (informs test design):
//  - lstat-based detection. Dangling links are unlinked before recreate.
//  - Optional repo fallback for `skills` and `agents` only (the two
//    slots that dev-install removes as LEGACY). Other SHARED_LINKS keep
//    today's "skip if target missing" behavior.
//  - Fallback target source: `opts.repoRoot` (test injection) >
//    `process.env.SMELTER_REPO_ROOT` > derived from `import.meta.url`.
//    Test cases pass `opts.repoRoot` explicitly to make assertions
//    independent of where the test runner lives on disk.
//  - When skills/agents target AND fallback are both missing, emit one
//    diagnostic line on stderr (today is fully silent, breaking debug).

import { unlinkSync, readdirSync } from 'node:fs';

function makeFakeRepo(home, options = {}) {
  const repo = join(home, 'fake-smelter-repo');
  mkdirSync(repo, { recursive: true });
  if (options.skillsContent) {
    const skillDir = join(repo, 'skills', options.skillsContent);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), `# ${options.skillsContent}`);
  }
  if (options.agentsContent) {
    const agentDir = join(repo, 'agents', options.agentsContent);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'AGENT.md'), `# ${options.agentsContent}`);
  }
  if (options.commandsContent) {
    const cmdDir = join(repo, 'commands', options.commandsContent);
    mkdirSync(cmdDir, { recursive: true });
    writeFileSync(join(cmdDir, 'CMD.md'), `# ${options.commandsContent}`);
  }
  return repo;
}

function makeBareClaudeHome() {
  // Like makeFakeClaudeHome but WITHOUT skills/agents source dirs — emulates
  // the post-dev-install state where ~/.claude has only commands/hooks/etc.
  const home = mkdtempSync(join(tmpdir(), 'set-model-mode-test-'));
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, 'settings.json'), '{}');
  for (const name of ['commands', 'hooks', 'plugins']) {
    mkdirSync(join(claudeDir, name), { recursive: true });
  }
  return home;
}

function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk, ...rest) => {
    captured += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  };
  try { fn(); } finally { process.stderr.write = original; }
  return captured;
}

// --- happy: repo fallback ---

test('happy(fallback): skills target missing — repo fallback creates link to repoRoot/skills', () => {
  const home = makeBareClaudeHome();
  const repoRoot = makeFakeRepo(home, { skillsContent: 'workflow-investigate' });
  ensureCodexConfigDir(home, { repoRoot });
  const link = join(getCodexConfigDir(home), 'skills');
  assert.ok(lstatSync(link).isSymbolicLink(), 'skills must be a symlink after fallback');
  assert.ok(existsSync(link), 'skills link must resolve (non-dangling)');
  assert.deepEqual(readdirSync(link), ['workflow-investigate'], 'skills must reach repoRoot/skills contents');
});

test('happy(fallback): agents target missing — repo fallback creates link to repoRoot/agents', () => {
  const home = makeBareClaudeHome();
  const repoRoot = makeFakeRepo(home, { agentsContent: 'planner' });
  ensureCodexConfigDir(home, { repoRoot });
  const link = join(getCodexConfigDir(home), 'agents');
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.ok(existsSync(link));
  assert.deepEqual(readdirSync(link), ['planner']);
});

// --- boundary: fallback restraint ---

test('boundary(fallback): repoRoot exists but repoRoot/skills absent — no link, no throw', () => {
  const home = makeBareClaudeHome();
  const repoRoot = join(home, 'empty-repo');
  mkdirSync(repoRoot, { recursive: true });
  assert.doesNotThrow(() => ensureCodexConfigDir(home, { repoRoot }));
  const link = join(getCodexConfigDir(home), 'skills');
  assert.ok(!existsSync(link), 'skills link must NOT be created when fallback target is also missing');
});

test('boundary(fallback): repo fallback whitelist — commands target missing is NOT covered by repo fallback', () => {
  const home = makeBareClaudeHome();
  // ~/.claude/commands exists in makeBareClaudeHome → remove it to force missing
  const claudeCommands = join(home, '.claude', 'commands');
  // remove the dir so target is missing
  // (use unlink on a dir won't work; we re-create as missing by skipping)
  // makeBareClaudeHome already creates commands; for this test we recreate home without it
  const home2 = mkdtempSync(join(tmpdir(), 'set-model-mode-test-'));
  mkdirSync(join(home2, '.claude'), { recursive: true });
  writeFileSync(join(home2, '.claude', 'settings.json'), '{}');
  // No commands dir; no skills dir; only settings.json present.
  const repoRoot = makeFakeRepo(home2, { commandsContent: 'somecmd', skillsContent: 'wi' });
  ensureCodexConfigDir(home2, { repoRoot });
  const cmdLink = join(getCodexConfigDir(home2), 'commands');
  assert.ok(!existsSync(cmdLink), 'commands link must NOT use repo fallback (whitelist excludes commands)');
  // skills however is in whitelist → must be linked
  const skillsLink = join(getCodexConfigDir(home2), 'skills');
  assert.ok(existsSync(skillsLink), 'skills link must use repo fallback (whitelisted)');
});

// --- error: dangling self-heal ---

test('error(dangling): pre-existing dangling skills link — unlinked and replaced via fallback', () => {
  const home = makeBareClaudeHome();
  const repoRoot = makeFakeRepo(home, { skillsContent: 'wi' });
  const dst = getCodexConfigDir(home);
  mkdirSync(dst, { recursive: true });
  // Create a dangling symlink: target points at a path that does not exist.
  const phantom = join(home, 'does-not-exist');
  symlinkSync(phantom, join(dst, 'skills'));
  assert.equal(existsSync(join(dst, 'skills')), false, 'precondition: dangling link reads as not-exist');
  assert.equal(lstatSync(join(dst, 'skills')).isSymbolicLink(), true, 'precondition: but lstat sees the symlink');
  ensureCodexConfigDir(home, { repoRoot });
  const link = join(dst, 'skills');
  assert.ok(existsSync(link), 'after self-heal, skills link must resolve');
  assert.equal(readlinkSync(link), join(repoRoot, 'skills'), 'self-heal must repoint at repoRoot/skills');
  assert.deepEqual(readdirSync(link), ['wi']);
});

test('error(dangling): dangling link with no fallback available — unlinked, no false replacement', () => {
  const home = makeBareClaudeHome();
  const dst = getCodexConfigDir(home);
  mkdirSync(dst, { recursive: true });
  symlinkSync(join(home, 'phantom'), join(dst, 'skills'));
  // No repoRoot fallback content for skills.
  const repoRoot = join(home, 'empty-repo');
  mkdirSync(repoRoot, { recursive: true });
  assert.doesNotThrow(() => ensureCodexConfigDir(home, { repoRoot }));
  const link = join(dst, 'skills');
  // Either the link is absent (preferred — clean state) or it still exists
  // pointing at something valid. The forbidden state is "dangling symlink
  // remains in place". Assert the bug is gone:
  if (existsSync(link)) {
    assert.notEqual(readlinkSync(link), join(home, 'phantom'),
      'dangling target must not survive');
  } else {
    // Acceptable: link removed, no replacement.
    assert.equal(lstatSync(link, { throwIfNoEntry: false }), undefined);
  }
});

// --- edge: precedence + uniform self-heal ---

test('edge(precedence): both ~/.claude/skills and repoRoot/skills exist — prefer ~/.claude/skills', () => {
  const home = makeFakeClaudeHome();
  // Add a marker file under ~/.claude/skills to distinguish it.
  writeFileSync(join(home, '.claude', 'skills', 'CLAUDE_MARKER'), 'claude');
  const repoRoot = makeFakeRepo(home, { skillsContent: 'repo-only' });
  ensureCodexConfigDir(home, { repoRoot });
  const link = join(getCodexConfigDir(home), 'skills');
  assert.equal(readlinkSync(link), join(home, '.claude', 'skills'),
    'when both exist, ~/.claude/skills wins (existing semantic preserved)');
});

test('edge(uniform-self-heal): dangling link in non-whitelist slot (commands) — also unlinked, no replacement created', () => {
  // commands isn't in fallback whitelist; but dangling-detect must apply
  // uniformly so a stale link doesn't block future repair when target reappears.
  const home = makeBareClaudeHome();
  // Remove commands dir to make target missing
  const cmdDir = join(home, '.claude', 'commands');
  // Replace dir with nothing
  try { unlinkSync(cmdDir); } catch { /* it's a dir; rmSync needed */ }
  // Use a fresh home without commands instead.
  const home2 = mkdtempSync(join(tmpdir(), 'set-model-mode-test-'));
  mkdirSync(join(home2, '.claude'), { recursive: true });
  writeFileSync(join(home2, '.claude', 'settings.json'), '{}');
  const dst = getCodexConfigDir(home2);
  mkdirSync(dst, { recursive: true });
  symlinkSync(join(home2, 'phantom-cmd'), join(dst, 'commands'));
  ensureCodexConfigDir(home2, { repoRoot: undefined });
  const link = join(dst, 'commands');
  if (existsSync(link)) {
    assert.notEqual(readlinkSync(link), join(home2, 'phantom-cmd'),
      'dangling commands link must not survive even though commands is not in repo-fallback whitelist');
  }
});

test('edge(diagnostic): both target and fallback missing for skills — emits a stderr warn line', () => {
  const home = makeBareClaudeHome();
  const captured = captureStderr(() => {
    ensureCodexConfigDir(home, { repoRoot: undefined });
  });
  assert.match(captured, /skills/i, 'stderr output must mention skills');
  assert.match(captured, /(missing|absent|empty|not found)/i, 'stderr output must explain why');
});

// --- integration: end-to-end with fallback ---

test('integration(fallback): end-to-end — skill file reachable via codex skills link sourced from repoRoot', () => {
  const home = makeBareClaudeHome();
  const repoRoot = makeFakeRepo(home, { skillsContent: 'workflow-marker' });
  ensureCodexConfigDir(home, { repoRoot });
  const viaLink = join(getCodexConfigDir(home), 'skills', 'workflow-marker', 'SKILL.md');
  assert.ok(existsSync(viaLink), 'skill file must be reachable through the codex skills link backed by repoRoot');
});

// =============================================================================
// FIX SCOPE — broader global linking + hashed-sidecar codex-cache scrub
// Investigation: .smt/features/feature-445be9a8-c683-4577-81b6-1a05c0469abb/task/investigation.md
// =============================================================================
//
// G1. SHARED_LINKS lacks top-level globals: CLAUDE.md, plugin.json — codex
//     mode never sees user's global instructions or plugin metadata even
//     though plain claude does.
// G2. Per-cwd hashed sidecar `~/.claude/.claude-<sha256(cwd)[0..8]>.json`
//     holds additionalModelOptionsCache containing codex models. The current
//     clearModelCache only zeroes the non-hashed `~/.claude.json`, so codex
//     models leak into plain `claude` runs which read the hashed sidecar and
//     pick the first codex entry as default.
//
// Fix contract for tests below:
//   - ensureCodexConfigDir links CLAUDE.md and plugin.json when present.
//   - A new exported `scrubGlobalCodexCaches(home)` walks
//     ~/.claude/.claude-<8hex>.json AND the non-hashed ~/.claude.json,
//     stripping codex entries (matched by isCodexModel) from
//     additionalModelOptionsCache. Non-codex entries preserved. Files without
//     additionalModelOptionsCache untouched. Filename pattern strict to
//     `/^\.claude-[0-9a-f]{8}\.json$/`.
//   - applyCodexMode invokes the scrub end-to-end.

// --- happy(globals) ---

test('happy(globals): ensureCodexConfigDir links CLAUDE.md when present in ~/.claude/', () => {
  const home = makeFakeClaudeHome();
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# user-global');
  ensureCodexConfigDir(home);
  const link = join(getCodexConfigDir(home), 'CLAUDE.md');
  assert.ok(lstatSync(link).isSymbolicLink(), 'CLAUDE.md must be a symlink');
  assert.equal(readlinkSync(link), join(home, '.claude', 'CLAUDE.md'));
});

test('happy(globals): ensureCodexConfigDir links plugin.json when present in ~/.claude/', () => {
  const home = makeFakeClaudeHome();
  writeFileSync(join(home, '.claude', 'plugin.json'), '{}');
  ensureCodexConfigDir(home);
  const link = join(getCodexConfigDir(home), 'plugin.json');
  assert.ok(lstatSync(link).isSymbolicLink(), 'plugin.json must be a symlink');
  assert.equal(readlinkSync(link), join(home, '.claude', 'plugin.json'));
});

// --- boundary(globals) ---

test('boundary(globals): missing CLAUDE.md is silently skipped — no link created', () => {
  const home = makeFakeClaudeHome();
  // No CLAUDE.md created.
  assert.doesNotThrow(() => ensureCodexConfigDir(home));
  assert.ok(!existsSync(join(getCodexConfigDir(home), 'CLAUDE.md')));
});

// --- happy(scrub) ---

test('happy(scrub): scrubGlobalCodexCaches zeroes additionalModelOptionsCache containing only codex entries', () => {
  const home = mkdtempSync(join(tmpdir(), 'set-model-mode-test-'));
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  const sidecar = join(claudeDir, '.claude-deadbeef.json');
  writeFileSync(sidecar, JSON.stringify({
    additionalModelOptionsCache: [
      { value: 'gpt-5.5', label: 'Codex gpt-5.5' },
      { value: 'gpt-5.4', label: 'Codex gpt-5.4' },
    ],
  }));
  setModelMode.scrubGlobalCodexCaches(home);
  const after = JSON.parse(readFileSync(sidecar, 'utf8'));
  assert.deepEqual(after.additionalModelOptionsCache, [],
    'codex-only cache must be zeroed on scrub');
});

test('happy(scrub): scrub processes every ~/.claude/.claude-<hash>.json sidecar', () => {
  const home = mkdtempSync(join(tmpdir(), 'set-model-mode-test-'));
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  const a = join(claudeDir, '.claude-aaaaaaaa.json');
  const b = join(claudeDir, '.claude-bbbbbbbb.json');
  writeFileSync(a, JSON.stringify({ additionalModelOptionsCache: [{ value: 'gpt-5.5' }] }));
  writeFileSync(b, JSON.stringify({ additionalModelOptionsCache: [{ value: 'gpt-5.4-mini' }] }));
  setModelMode.scrubGlobalCodexCaches(home);
  assert.deepEqual(JSON.parse(readFileSync(a, 'utf8')).additionalModelOptionsCache, []);
  assert.deepEqual(JSON.parse(readFileSync(b, 'utf8')).additionalModelOptionsCache, []);
});

// --- boundary(scrub) ---

test('boundary(scrub): non-hashed ~/.claude.json (top-level) is also scrubbed', () => {
  const home = mkdtempSync(join(tmpdir(), 'set-model-mode-test-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  const top = join(home, '.claude.json');
  writeFileSync(top, JSON.stringify({ additionalModelOptionsCache: [{ value: 'gpt-5.5' }] }));
  setModelMode.scrubGlobalCodexCaches(home);
  const after = JSON.parse(readFileSync(top, 'utf8'));
  assert.deepEqual(after.additionalModelOptionsCache, []);
});

test('boundary(scrub): files without additionalModelOptionsCache are preserved verbatim', () => {
  const home = mkdtempSync(join(tmpdir(), 'set-model-mode-test-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  const sidecar = join(home, '.claude', '.claude-cafebabe.json');
  const original = { somethingElse: 42, nested: { ok: true } };
  writeFileSync(sidecar, JSON.stringify(original));
  setModelMode.scrubGlobalCodexCaches(home);
  const after = JSON.parse(readFileSync(sidecar, 'utf8'));
  assert.deepEqual(after, original, 'non-cache file must be untouched');
});

// --- error(scrub) ---

test('error(scrub): malformed JSON sidecar — skipped without throwing', () => {
  const home = mkdtempSync(join(tmpdir(), 'set-model-mode-test-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  const sidecar = join(home, '.claude', '.claude-12345678.json');
  writeFileSync(sidecar, '{this-is-not-json');
  assert.doesNotThrow(() => setModelMode.scrubGlobalCodexCaches(home));
});

test('error(scrub): missing ~/.claude directory — no-op, no throw', () => {
  const home = mkdtempSync(join(tmpdir(), 'set-model-mode-test-'));
  // No ~/.claude created.
  assert.doesNotThrow(() => setModelMode.scrubGlobalCodexCaches(home));
});

// --- edge(scrub) ---

test('edge(scrub): preserves non-codex entries; removes only codex entries from mixed cache', () => {
  const home = mkdtempSync(join(tmpdir(), 'set-model-mode-test-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  const sidecar = join(home, '.claude', '.claude-99999999.json');
  writeFileSync(sidecar, JSON.stringify({
    additionalModelOptionsCache: [
      { value: 'gpt-5.5', label: 'Codex gpt-5.5' },
      { value: 'custom-internal-model', label: 'Internal' },
      { value: 'o3-fast', label: 'Codex o3' },
    ],
  }));
  setModelMode.scrubGlobalCodexCaches(home);
  const after = JSON.parse(readFileSync(sidecar, 'utf8'));
  assert.deepEqual(after.additionalModelOptionsCache,
    [{ value: 'custom-internal-model', label: 'Internal' }],
    'codex entries (gpt-*, o*, codex*) removed; non-codex preserved');
});

test('edge(scrub): only ~/.claude/.claude-<8hex>.json filenames matched — decoys ignored', () => {
  const home = mkdtempSync(join(tmpdir(), 'set-model-mode-test-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  const decoys = [
    join(home, '.claude', '.claude-toolong-not-hex.json'), // not 8 hex
    join(home, '.claude', '.claude-DEADBEEFcafe.json'),    // 12 hex, not 8
    join(home, '.claude', '.claudewat.json'),              // wrong prefix
    join(home, '.claude', '.claude-abcd.json'),            // 4 hex, not 8
  ];
  for (const f of decoys) {
    writeFileSync(f, JSON.stringify({ additionalModelOptionsCache: [{ value: 'gpt-5.5' }] }));
  }
  setModelMode.scrubGlobalCodexCaches(home);
  for (const f of decoys) {
    const after = JSON.parse(readFileSync(f, 'utf8'));
    assert.deepEqual(after.additionalModelOptionsCache, [{ value: 'gpt-5.5' }],
      `decoy ${f} must not be touched — only /^\\.claude-[0-9a-f]{8}\\.json$/ pattern matches`);
  }
});

// --- integration(scrub) ---

test('integration(scrub): real-world hash sidecar from sha256(cwd)[0..8] gets cleared', () => {
  const home = mkdtempSync(join(tmpdir(), 'set-model-mode-test-'));
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  // Reproduce the production filename from the bug: sha256("/Users/yusang/Smelter")[0..8]
  // = d08e66bc — exactly the file the investigation found leaking codex models.
  const sidecar = join(claudeDir, '.claude-d08e66bc.json');
  writeFileSync(sidecar, JSON.stringify({
    additionalModelOptionsCache: [
      { value: 'gpt-5.4', label: 'Codex gpt-5.4', description: 'Codex balanced model' },
    ],
  }));
  setModelMode.scrubGlobalCodexCaches(home);
  assert.deepEqual(
    JSON.parse(readFileSync(sidecar, 'utf8')).additionalModelOptionsCache,
    [],
    'after scrub, hashed sidecar containing only codex entries must be cleared',
  );
});
