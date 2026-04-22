#!/usr/bin/env node
// Smoke test — verify wrapper resolves args + proxy module loads cleanly.
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'bin', 'claude-codex.mjs');
const wrapper = join(here, 'claude-wrapper.mjs');
const tempHome = mkdtempSync(join(tmpdir(), 'codex-for-claude-code-home-'));
const versionsDir = join(tempHome, '.local', 'share', 'claude', 'versions');
mkdirSync(versionsDir, { recursive: true });
const fakeClaudeBinary = join(versionsDir, '1.0.0');
writeFileSync(fakeClaudeBinary, '#!/bin/sh\nexit 0\n');
chmodSync(fakeClaudeBinary, 0o755);

const r = spawnSync(process.execPath, [bin, '--version'], {
  env: { ...process.env, HOME: tempHome, SMELTER_WRAPPER_TEST: '1', CODEX_PROXY_TEST: '1' },
  encoding: 'utf8',
});

if (r.status !== 0) {
  process.stderr.write(`wrapper test failed (exit ${r.status})\n${r.stderr}\n`);
  process.exit(1);
}

let parsed;
try { parsed = JSON.parse(r.stdout); } catch {
  process.stderr.write(`wrapper test: stdout not JSON: ${r.stdout}\n`);
  process.exit(1);
}

if (parsed.mode !== 'codex' || !parsed.passthrough.includes('--version') || !parsed.binary) {
  process.stderr.write(`wrapper test: unexpected payload ${JSON.stringify(parsed)}\n`);
  process.exit(1);
}

const inheritedCodexEnv = JSON.parse(
  execFileSync(process.execPath, [wrapper, '--claude', '--version'], {
    env: {
      ...process.env,
      HOME: tempHome,
      SMELTER_WRAPPER_TEST: '1',
      CODEX_MODE: '1',
      SMELTER_MODEL_MODE: 'codex',
      SMELTER_ACTIVE_MODEL: 'gpt-5.4',
      CLAUDE_CONFIG_DIR: join(here, '..', '.tmp-claude-codex'),
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:3099',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    encoding: 'utf8',
  }),
);

if (inheritedCodexEnv.mode !== 'claude') {
  process.stderr.write(`wrapper test: expected explicit claude mode, got ${JSON.stringify(inheritedCodexEnv)}\n`);
  process.exit(1);
}

if (inheritedCodexEnv.childEnvPreview?.SMELTER_MODEL_MODE !== 'claude') {
  process.stderr.write(`wrapper test: expected SMELTER_MODEL_MODE=claude, got ${JSON.stringify(inheritedCodexEnv.childEnvPreview)}\n`);
  process.exit(1);
}

for (const key of [
  'CODEX_MODE',
  'SMELTER_ACTIVE_MODEL',
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
]) {
  if (inheritedCodexEnv.childEnvPreview?.[key] !== undefined) {
    process.stderr.write(`wrapper test: expected ${key} to be cleared, got ${JSON.stringify(inheritedCodexEnv.childEnvPreview)}\n`);
    process.exit(1);
  }
}

// Load proxy module without starting it.
process.env.CODEX_PROXY_TEST = '1';
const proxy = await import('./codex-proxy.mjs');
if (typeof proxy.createServer !== 'function') {
  process.stderr.write('proxy module missing createServer export\n');
  process.exit(1);
}

console.log('OK');
