#!/usr/bin/env node
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { printTag } from './lib/yellow-tag.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const handlerPath = join(__dirname, '..', 'dist', 'hooks', 'permission-handler', 'index.js');

async function main() {
  printTag('Permission');
  printTag('Permission');
  // Read stdin synchronously
  let input = '{}';
  try { input = readFileSync('/dev/stdin', 'utf-8'); } catch {}

  try {
    const data = JSON.parse(input);
    if (!existsSync(handlerPath)) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }
    const { processPermissionRequest } = await import(pathToFileURL(handlerPath).href);
    const result = await processPermissionRequest(data);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error('[permission-handler] Error:', error.message);
    process.exit(0); // Don't block on errors
  }
}

main();
