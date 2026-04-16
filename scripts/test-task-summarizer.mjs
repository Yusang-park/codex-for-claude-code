#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, readFileSync, existsSync,
  writeFileSync, mkdirSync, rmSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const HOOK_PATH = join(process.cwd(), 'scripts', 'task-summarizer.mjs');
const HUD_PATH = join(process.cwd(), 'scripts', 'statusline-hud.mjs');
const CACHE_DIR = join(homedir(), '.claude', 'hud', 'task-summary');

function cacheKeyForCwd(cwd) {
  return Buffer.from(cwd || 'default').toString('base64url');
}

function cachePath(cwd) {
  return join(CACHE_DIR, `${cacheKeyForCwd(cwd)}.json`);
}

function runHook({ cwd, prompt, sessionId = 'test-session' }) {
  const input = JSON.stringify({ cwd, session_id: sessionId, prompt });
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ANTHROPIC_API_KEY: '', PATH: process.env.PATH },
  });
  assert.equal(result.status, 0, `hook crashed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function runHud(cwd) {
  const result = spawnSync(process.execPath, [HUD_PATH], {
    input: JSON.stringify({ cwd }),
    encoding: 'utf8',
  });
  return result.stdout;
}

// --- Hook tests ---

test('hook outputs continue:true and caches raw prompt', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'task-summarizer-'));
  const cf = cachePath(cwd);

  try {
    const result = runHook({ cwd, prompt: 'add dark mode toggle to settings' });
    assert.equal(result.continue, true);
    assert.equal(existsSync(cf), true, 'cache file should be created');

    const cached = JSON.parse(readFileSync(cf, 'utf8'));
    assert.equal(cached.raw_prompt, 'add dark mode toggle to settings');
    assert.ok(cached.timestamp, 'timestamp should be set');
    assert.equal(cached.cwd, cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    if (existsSync(cf)) rmSync(cf);
  }
});

test('slash commands are skipped — no cache written', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'task-summarizer-'));
  const cf = cachePath(cwd);

  try {
    for (const cmd of ['/tasker new feature', '/feat fix it', '/qa typo']) {
      const result = runHook({ cwd, prompt: cmd });
      assert.equal(result.continue, true, `should continue for: ${cmd}`);
      assert.equal(existsSync(cf), false, `no cache for slash command: ${cmd}`);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    if (existsSync(cf)) rmSync(cf);
  }
});

test('empty or very short prompts are skipped', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'task-summarizer-'));
  const cf = cachePath(cwd);

  try {
    for (const prompt of ['', '  ', 'ok', 'y', 'yes']) {
      const result = runHook({ cwd, prompt });
      assert.equal(result.continue, true);
      assert.equal(existsSync(cf), false, `no cache for trivial prompt: "${prompt}"`);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    if (existsSync(cf)) rmSync(cf);
  }
});

test('new substantive prompt overwrites previous cache', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'task-summarizer-'));
  const cf = cachePath(cwd);

  try {
    runHook({ cwd, prompt: 'implement user authentication flow' });
    const first = JSON.parse(readFileSync(cf, 'utf8'));
    assert.equal(first.raw_prompt, 'implement user authentication flow');

    runHook({ cwd, prompt: 'refactor the payment module to use stripe' });
    const second = JSON.parse(readFileSync(cf, 'utf8'));
    assert.equal(second.raw_prompt, 'refactor the payment module to use stripe');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    if (existsSync(cf)) rmSync(cf);
  }
});

// --- Statusline integration tests ---

test('statusline shows AI summary on second line in blue', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'task-summarizer-'));
  const cf = cachePath(cwd);

  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cf, JSON.stringify({
      raw_prompt: 'add dark mode toggle',
      summary: '다크모드 토글 추가',
      timestamp: new Date().toISOString(),
      cwd,
    }));

    const output = runHud(cwd);
    const lines = output.split('\n');
    assert.ok(lines.length >= 2, 'should have two lines');
    assert.match(lines[1], /다크모드 토글 추가/, 'second line should contain AI summary');
    assert.match(lines[1], /\x1b\[34m/, 'second line should have blue ANSI code');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    if (existsSync(cf)) rmSync(cf);
  }
});

test('statusline shows truncated raw prompt on second line as fallback', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'task-summarizer-'));
  const cf = cachePath(cwd);

  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cf, JSON.stringify({
      raw_prompt: 'add dark mode toggle to the settings page with multiple theme options and preview',
      summary: null,
      timestamp: new Date().toISOString(),
      cwd,
    }));

    const output = runHud(cwd);
    const lines = output.split('\n');
    assert.ok(lines.length >= 2, 'should have two lines');
    assert.match(lines[1], /add dark mode toggle/, 'second line should show start of raw prompt');
    assert.ok(!lines[1].includes('preview'), 'should be truncated');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    if (existsSync(cf)) rmSync(cf);
  }
});

test('statusline has no second line when cache is stale (>30min)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'task-summarizer-'));
  const cf = cachePath(cwd);

  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const staleTime = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    writeFileSync(cf, JSON.stringify({
      raw_prompt: 'old task',
      summary: '오래된 작업',
      timestamp: staleTime,
      cwd,
    }));

    const output = runHud(cwd);
    assert.ok(!output.includes('오래된 작업'), 'stale summary should not appear');
    assert.ok(!output.includes('\n'), 'should be single line when no summary');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    if (existsSync(cf)) rmSync(cf);
  }
});
