#!/usr/bin/env node
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const setupPath = join(__dirname, '..', 'dist', 'hooks', 'setup', 'index.js');

async function main() {
  // Read stdin synchronously
  let input = '{}';
  try { input = readFileSync('/dev/stdin', 'utf-8'); } catch {}

  try {
    const data = JSON.parse(input);
    if (!existsSync(setupPath)) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }
    const { processSetupInit } = await import(pathToFileURL(setupPath).href);
    const result = await processSetupInit(data);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error('[setup-init] Error:', error.message);
    process.exit(0); // Don't block on errors
  }
}

main();
