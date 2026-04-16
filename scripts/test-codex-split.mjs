import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const scriptPath = join(repoRoot, 'scripts', 'create-codex-split.mjs');

function run(outDir) {
  return execFileSync(process.execPath, [scriptPath, outDir], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

test('create-codex-split builds symlink package and initializes git', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'codex-split-'));
  const outDir = join(tempDir, 'codex-for-claude-code');

  try {
    run(outDir);

    const linkedDirs = [
      'dist',
      'skills',
      'agents',
      'workflows',
      'commands',
      'steps',
      'presets',
      'scripts',
      'hooks',
      'rules-lib',
    ];

    for (const rel of linkedDirs) {
      const full = join(outDir, rel);
      assert.equal(existsSync(full), true, `${rel} should exist`);
      assert.equal(lstatSync(full).isSymbolicLink(), false, `${rel} should be a real directory`);
    }

    const pkg = JSON.parse(readFileSync(join(outDir, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'codex-for-claude-code');
    assert.equal(pkg.bin.codex, 'dist/bin/cli.js');

    const plugin = JSON.parse(readFileSync(join(outDir, 'plugin.json'), 'utf8'));
    assert.equal(plugin.name, 'codex-for-claude-code');
    assert.equal(plugin.hooks, 'hooks/hooks.json');

    const readme = readFileSync(join(outDir, 'README.md'), 'utf8');
    assert.match(readme, /# Codex for Claude Code/);
    assert.match(readme, /Use Codex models inside Claude Code/);
    assert.match(readme, /## Why/);
    assert.match(readme, /## Install/);
    assert.match(readme, /## Quick start/);
    assert.match(readme, /## What you get/);

    const license = readFileSync(join(outDir, 'LICENSE'), 'utf8');
    assert.match(license, /MIT License/);

    assert.equal(existsSync(join(outDir, '.gitignore')), true, '.gitignore should exist');
    assert.equal(existsSync(join(outDir, '.git')), true, '.git should exist after git init');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
