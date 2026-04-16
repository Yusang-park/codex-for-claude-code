// Hook audit utility for smelter.
// Scans hook scripts for console.log(JSON.stringify({ ... additionalContext lines
// and verifies each has a preceding printTag() call within 5 lines.
// Yellow tag: [Hook Audit]

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { printTag } from './yellow-tag.mjs';

/**
 * Scan all *.mjs files in scriptsDir for additionalContext output lines
 * that lack a preceding printTag() call within 5 lines.
 *
 * @param {string} scriptsDir - Absolute or relative path to the scripts directory.
 * @returns {Promise<{ ok: boolean, violations: Array<{ file: string, line: number }> }>}
 */
export async function auditHooks(scriptsDir) {
  printTag('Hook Audit');

  const violations = [];
  const files = readdirSync(scriptsDir)
    .filter(f => f.endsWith('.mjs'))
    .sort();

  for (const file of files) {
    const filePath = join(scriptsDir, file);
    let content;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match lines that output JSON with additionalContext
      if (
        line.includes('console.log(JSON.stringify(') &&
        line.includes('additionalContext')
      ) {
        // Check preceding 5 lines for a printTag call
        const start = Math.max(0, i - 5);
        let hasPrintTag = false;
        for (let j = start; j < i; j++) {
          if (lines[j].includes('printTag(')) {
            hasPrintTag = true;
            break;
          }
        }
        if (!hasPrintTag) {
          violations.push({ file, line: i + 1 });
        }
      }
    }
  }

  return { ok: violations.length === 0, violations };
}
