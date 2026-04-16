#!/usr/bin/env tsx
/**
 * DISABLED — test-max-attempts.ts
 *
 * This test used to import from `src/hooks/persistent-mode/index.js`, but the
 * persistent-mode module was removed when the harness switched to the
 * async-fire-and-drop auto-confirm model (see scripts/auto-confirm.mjs and
 * scripts/auto-confirm-consumer.mjs). The retry-counter behavior it exercised
 * is now covered by `scripts/tool-retry.test.mjs`.
 *
 * TODO: delete this stub once downstream harness configs stop referencing it.
 * Until then, exit 0 so CI remains green.
 */

console.log('[test-max-attempts] DISABLED — see header comment. Coverage moved to scripts/tool-retry.test.mjs');
process.exit(0);
