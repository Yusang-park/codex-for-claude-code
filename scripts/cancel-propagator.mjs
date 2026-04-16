#!/usr/bin/env node

/**
 * Cancel Propagator — kills active processes, clears state, writes cancel signal.
 *
 * Two modes:
 *   hard  — kill everything, block tools, allow stop
 *   queue — write queued intent, let current work finish, then redirect
 *
 * Usage (from keyword-detector or standalone):
 *   import { propagateHardCancel, propagateQueueCancel } from './cancel-propagator.mjs';
 *   propagateHardCancel(directory);
 *   propagateQueueCancel(directory, "fix the login bug");
 *
 * Standalone:
 *   echo '{"cwd":"/path","type":"hard"}' | node scripts/cancel-propagator.mjs
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';
import { writeCancel, clearCancel } from './lib/cancel-signal.mjs';

/**
 * Kill tracked subagent processes and background tasks.
 */
function killTrackedProcesses(directory) {
  const killed = [];

  // 1. Kill tracked subagents from subagent-tracking.json
  const trackingFile = join(directory, '.smt', 'state', 'subagent-tracking.json');
  if (existsSync(trackingFile)) {
    try {
      const data = JSON.parse(readFileSync(trackingFile, 'utf-8'));
      const agents = data.agents || [];
      for (const agent of agents) {
        if (agent.status === 'running' && agent.pid) {
          try {
            process.kill(agent.pid, 'SIGTERM');
            killed.push(`subagent:${agent.agent_type || 'unknown'}(pid:${agent.pid})`);
          } catch { /* already dead */ }
        }
      }
    } catch { /* skip */ }
  }

  // 2. Kill background bash tasks tracked by Claude Code
  //    These are in /tmp or session-specific locations
  try {
    const result = execSync(
      'pgrep -f "smelter.*background" 2>/dev/null || true',
      { encoding: 'utf-8', timeout: 3000 }
    ).trim();
    if (result) {
      for (const pid of result.split('\n').filter(Boolean)) {
        try {
          process.kill(parseInt(pid, 10), 'SIGTERM');
          killed.push(`background:${pid}`);
        } catch { /* already dead */ }
      }
    }
  } catch { /* skip */ }

  return killed;
}

/**
 * Clear legacy auto-confirm / persistent state files (best-effort cleanup).
 */
function clearLegacyState(directory) {
  const cleared = [];
  const omcStateDir = join(directory, '.omc', 'state');
  const legacyFiles = ['persistent-state.json'];
  for (const file of legacyFiles) {
    const path = join(omcStateDir, file);
    if (existsSync(path)) {
      try { unlinkSync(path); cleared.push(`.omc/state/${file}`); } catch { /* skip */ }
    }
  }
  return cleared;
}

/**
 * Hard cancel: kill processes, clear state, write signal to block further execution.
 */
export function propagateHardCancel(directory, reason = 'user request') {
  const killed = killTrackedProcesses(directory);
  const cleared = clearLegacyState(directory);
  writeCancel(directory, 'hard', { reason, source: 'propagator' });

  return {
    type: 'hard',
    killed,
    cleared,
    timestamp: Date.now(),
  };
}

/**
 * Queue cancel: write queued intent, let current work finish, then redirect.
 * Does NOT kill processes.
 */
export function propagateQueueCancel(directory, queuedIntent, reason = 'user redirect', sessionId = '') {
  writeCancel(directory, 'queue', { reason, queuedIntent, source: 'propagator', sessionId });

  return {
    type: 'queue',
    queued_intent: queuedIntent,
    session_id: sessionId,
    timestamp: Date.now(),
  };
}

/**
 * Standalone entry: read stdin JSON and propagate cancel.
 */
async function main() {
  let input = '{}';
  try { input = readFileSync('/dev/stdin', 'utf-8'); } catch {}

  let data = {};
  try { data = JSON.parse(input); } catch {}

  const directory = data.cwd || data.directory || process.cwd();
  const type = data.type || 'hard';
  const reason = data.reason || 'user request';
  const queuedIntent = data.queued_intent || data.queuedIntent || '';
  const sessionId = data.session_id || data.sessionId || '';

  let result;
  if (type === 'queue' && queuedIntent) {
    result = propagateQueueCancel(directory, queuedIntent, reason, sessionId);
  } else {
    result = propagateHardCancel(directory, reason);
  }

  console.log(JSON.stringify(result, null, 2));
}

// Run standalone if invoked directly
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^\//, ''));
if (isMain || process.argv[1]?.endsWith('cancel-propagator.mjs')) {
  main().catch((err) => {
    console.error(`[cancel-propagator] Error: ${err.message}`);
    process.exit(1);
  });
}
