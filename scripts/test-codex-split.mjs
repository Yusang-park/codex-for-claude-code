#!/usr/bin/env node
// Smoke test — verify wrapper resolves args + proxy module loads cleanly.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'bin', 'claude-codex.mjs');

const r = spawnSync(process.execPath, [bin, '--version'], {
  env: { ...process.env, SMELTER_WRAPPER_TEST: '1', CODEX_PROXY_TEST: '1' },
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

// Load proxy module without starting it.
process.env.CODEX_PROXY_TEST = '1';
const proxy = await import('./codex-proxy.mjs');
if (typeof proxy.createServer !== 'function') {
  process.stderr.write('proxy module missing createServer export\n');
  process.exit(1);
}

console.log('OK');
