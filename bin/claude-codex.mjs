#!/usr/bin/env node
// Codex-only entry point. Strip mode toggles so the CLI is single-purpose.
process.argv = [
  process.argv[0],
  process.argv[1],
  ...process.argv.slice(2).filter((a) => a !== '--claude' && a !== '--codex'),
];
await import('../scripts/claude-wrapper.mjs');
