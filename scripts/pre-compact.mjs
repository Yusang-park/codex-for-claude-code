#!/usr/bin/env node
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { printTag } from './lib/yellow-tag.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const preCompactPath = join(__dirname, '..', 'dist', 'hooks', 'pre-compact', 'index.js');

function readJsonFile(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function isCodexMode(data) {
  if (process.env.SMELTER_MODEL_MODE === 'codex') return true;
  const cwd = data?.cwd || process.cwd();
  const state = readJsonFile(join(cwd, '.smt', 'state', 'model-mode.json'));
  return state?.mode === 'codex';
}

function shouldBlockCompact(data) {
  const disabled = process.env.DISABLE_COMPACT === '1' || process.env.DISABLE_COMPACT === 'true';
  return disabled && !isCodexMode(data);
}

async function main() {
  printTag('Pre Compact');
  // Read stdin synchronously
  let input = '{}';
  try { input = readFileSync('/dev/stdin', 'utf-8'); } catch {}

  try {
    const data = JSON.parse(input);
    if (shouldBlockCompact(data)) {
      console.log(JSON.stringify({ decision: 'block' }));
      return;
    }
    if (!existsSync(preCompactPath)) {
      process.stderr.write('[pre-compact] WARN: dist/hooks/pre-compact/index.js missing — run `npm run build` to enable state preservation.\n');
      console.log(JSON.stringify({ continue: true }));
      return;
    }
    const { processPreCompact } = await import(pathToFileURL(preCompactPath).href);
    const result = await processPreCompact(data);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error('[pre-compact] Error:', error.message);
    process.exit(0); // Don't block on errors
  }
}

main();
