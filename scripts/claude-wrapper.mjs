#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setModelMode, CODEX_PROXY_PORT } from './set-model-mode.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROXY_SCRIPT = join(__dirname, 'codex-proxy.mjs');
const EXPECTED_PROXY_VERSION = '6'; // must match PROXY_VERSION in codex-proxy.mjs
const CODEX_AUTH_PATH = join(homedir(), '.codex', 'auth.json');

function semverCompare(a, b) {
  const pa = a.replace(/^v/, '').split('.').map((part) => parseInt(part, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((part) => parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

function resolveClaudeBinary() {
  const versionsDir = join(homedir(), '.local', 'share', 'claude', 'versions');
  const versions = readdirSync(versionsDir).sort(semverCompare).reverse();
  // Skip empty/broken binaries (failed downloads show as 0-byte files)
  for (const v of versions) {
    const p = join(versionsDir, v);
    try {
      const s = statSync(p);
      if (s.size > 0 && (s.mode & 0o111)) return p; // non-empty + executable
    } catch { continue; }
  }
  throw new Error(`No valid Claude versions found in ${versionsDir}`);
}

function parseArgs(argv) {
  let mode = 'claude';
  const passthrough = [];

  for (const arg of argv) {
    if (arg === '--codex') {
      mode = 'codex';
      continue;
    }
    if (arg === '--claude') {
      mode = 'claude';
      continue;
    }
    passthrough.push(arg);
  }

  return { mode, passthrough };
}

function hasCodexAuth() {
  try {
    if (!existsSync(CODEX_AUTH_PATH)) return false;
    const auth = JSON.parse(readFileSync(CODEX_AUTH_PATH, 'utf8'));
    return Boolean(auth.tokens?.access_token);
  } catch {
    return false;
  }
}

async function ensureProxyRunning() {
  try {
    const res = await fetch(`http://127.0.0.1:${CODEX_PROXY_PORT}/health`, { signal: AbortSignal.timeout(500) });
    if (res.ok) {
      const data = await res.json();
      if (data.version === EXPECTED_PROXY_VERSION) return; // already up, correct version
      // Stale proxy — kill it so we can start the new version
      process.stderr.write(`[claude-wrapper] proxy version mismatch (got ${data.version}, want ${EXPECTED_PROXY_VERSION}) — restarting\n`);
      try {
        const { execFileSync } = await import('node:child_process');
        execFileSync('pkill', ['-f', 'codex-proxy.mjs'], { stdio: 'ignore' });
      } catch { /* process may already be gone */ }
      await new Promise((r) => setTimeout(r, 200));
    }
  } catch { /* not running yet */ }

  const proxy = spawn(process.execPath, [PROXY_SCRIPT], {
    stdio: 'ignore',
    detached: true,
    env: { ...process.env },
  });
  proxy.unref();

  // Wait up to 2 s for proxy to accept connections
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const res = await fetch(`http://127.0.0.1:${CODEX_PROXY_PORT}/health`, { signal: AbortSignal.timeout(300) });
      if (res.ok) return;
    } catch { /* still starting */ }
  }
  process.stderr.write('[claude-wrapper] warning: codex-proxy did not start in time\n');
}

async function main() {
  const { mode, passthrough } = parseArgs(process.argv.slice(2));
  const binary = resolveClaudeBinary();
  const settings = setModelMode(mode, process.cwd());

  if (mode === 'codex' && process.env.SMELTER_WRAPPER_TEST !== '1') {
    if (!hasCodexAuth()) {
      process.stderr.write('[claude-wrapper] warning: no Codex auth found — login via `codex`\n');
    }
    await ensureProxyRunning();
  }

  if (process.env.SMELTER_WRAPPER_TEST === '1') {
    process.stdout.write(
      JSON.stringify({
        binary,
        mode,
        passthrough,
        settings,
      }),
    );
    return;
  }

  // In codex mode inject model-override env vars directly into the child process.
  // settings.json env vars only apply after Claude Code restarts; passing them
  // in the child's process.env ensures the model picker shows Codex models
  // immediately on first launch.
  const codexEnv = mode === 'codex' ? {
    // Route all API calls through the local proxy.
    // Proxy passes claude-* model IDs through to Anthropic unchanged,
    // and translates gpt-*/o* model IDs to OpenAI format.
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${CODEX_PROXY_PORT}`,
    // Skip bootstrap so it doesn't overwrite our additionalModelOptionsCache injection
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  } : {
    // Restore defaults — unset any codex overrides inherited from parent env
    ANTHROPIC_BASE_URL: '',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '',
  };

  // Remove empty-string keys (undefine them) so Claude doesn't see blank values
  const filteredEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...codexEnv }).filter(([, v]) => v !== ''),
  );

  const child = spawn(binary, passthrough, {
    stdio: 'inherit',
    env: filteredEnv,
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  child.on('error', (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
