#!/usr/bin/env node
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { printTag } from './lib/yellow-tag.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const trackerPath = join(__dirname, '..', 'dist', 'hooks', 'subagent-tracker', 'index.js');

async function main() {
  printTag('Subagent Tracker');
  const action = process.argv[2]; // 'start' or 'stop'

  // Read stdin synchronously
  let input = '{}';
  try { input = readFileSync('/dev/stdin', 'utf-8'); } catch {}

  try {
    const data = JSON.parse(input);
    if (!existsSync(trackerPath)) {
      process.stderr.write('[subagent-tracker] WARN: dist/hooks/subagent-tracker/index.js missing — run `npm run build` to enable tracking.\n');
      console.log(JSON.stringify({ continue: true }));
      return;
    }
    const { processSubagentStart, processSubagentStop } = await import(pathToFileURL(trackerPath).href);

    let result;
    if (action === 'start') {
      result = await processSubagentStart(data);
    } else if (action === 'stop') {
      result = await processSubagentStop(data);
    } else {
      console.error(`[subagent-tracker] Unknown action: ${action}`);
      process.exit(0);
    }

    console.log(JSON.stringify(result));
  } catch (error) {
    console.error('[subagent-tracker] Error:', error.message);
    process.exit(0); // Don't block on errors
  }
}

main();
