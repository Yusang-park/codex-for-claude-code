#!/usr/bin/env node
// Tests for set-model-mode.mjs — specifically ensureCodexConfigDir()'s SHARED_LINKS
// behavior. The original bug: `skills` was omitted from SHARED_LINKS, so
// ~/.claude-codex/skills never got a symlink to ~/.claude/skills, hiding all
// user workflow skills when running claude-codex.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readlinkSync, existsSync, lstatSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureCodexConfigDir, getCodexConfigDir } from './set-model-mode.mjs';

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
