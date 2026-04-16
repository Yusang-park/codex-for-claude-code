#!/usr/bin/env node

/**
 * PostToolUse Hook: Verification Reminder System (Node.js)
 * Monitors tool execution and provides contextual guidance
 * Cross-platform: Windows, macOS, Linux
 */

import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { printTag } from './lib/yellow-tag.mjs';

// Read stdin synchronously — hook scripts receive JSON via pipe, /dev/stdin returns immediately
function readStdinSync() {
  try { return readFileSync('/dev/stdin', 'utf-8'); } catch { return '{}'; }
}

// Append command to ~/.bash_history
function appendToBashHistory(command) {
  if (!command || typeof command !== 'string') return;

  // Clean command: trim, skip empty, skip if it's just whitespace
  const cleaned = command.trim();
  if (!cleaned) return;

  // Skip internal/meta commands that aren't useful in history
  if (cleaned.startsWith('#')) return;

  try {
    const historyPath = join(homedir(), '.bash_history');
    appendFileSync(historyPath, cleaned + '\n');
  } catch {
    // Silently fail - history is best-effort
  }
}

// Detect failures in Bash output — only match clear tool-level failure signals,
// not arbitrary occurrences of "error" / "failed" / "cannot" in stdout content.
function detectBashFailure(output) {
  const errorPatterns = [
    /^\s*(?:bash|zsh|sh):\s.+:\s+(?:permission denied|command not found|no such file)/im,
    /^(?:error|fatal):\s/im,
    /\bexit code:?\s*[1-9]\d*\b/i,
    /\bexit status\s+[1-9]\d*\b/i,
    /\baborted?\b.*\(core dumped\)/i,
    /^\s*npm ERR!\s/m,
    /^\s*ELIFECYCLE\s/m,
  ];

  return errorPatterns.some(pattern => pattern.test(output));
}

// Detect background operation — only match explicit background task indicators
function detectBackgroundOperation(output) {
  const bgPatterns = [
    /task_id/i,
    /run_in_background/i,
    /\bspawned\b/i,
  ];

  return bgPatterns.some(pattern => pattern.test(output));
}


// Detect write failure — check success indicators first to avoid false positives
// from file *contents* that contain words like "error" or "failed"
function detectWriteFailure(output) {
  // Known success messages from Claude Code Edit/Write tools
  if (/updated successfully|has been written|file written/i.test(output)) return false;

  // Specific error patterns that appear in tool failure messages (not file content)
  const errorPatterns = [
    /^Error:/m,
    /old_string.*not found/i,
    /did not match/i,
    /permission denied/i,
    /read-only file system/i,
    /no such file or directory/i,
  ];

  return errorPatterns.some(pattern => pattern.test(output));
}

// Get agent completion summary from tracking state
function getAgentCompletionSummary(directory) {
  const trackingFile = join(directory, '.smt', 'state', 'subagent-tracking.json');
  try {
    if (existsSync(trackingFile)) {
      const data = JSON.parse(readFileSync(trackingFile, 'utf-8'));
      const agents = data.agents || [];
      const running = agents.filter(a => a.status === 'running');
      const completed = data.total_completed || 0;
      const failed = data.total_failed || 0;

      if (running.length === 0 && completed === 0 && failed === 0) return '';

      const parts = [];
      if (running.length > 0) {
        parts.push(`Running: ${running.length} [${running.map(a => a.agent_type.replace('smelter:', '')).join(', ')}]`);
      }
      if (completed > 0) parts.push(`Completed: ${completed}`);
      if (failed > 0) parts.push(`Failed: ${failed}`);

      return parts.join(' | ');
    }
  } catch {}
  return '';
}

// Track files modified by Claude (Write/Edit) for session-scoped E2E checks
function trackModifiedFile(filePath, directory) {
  if (!filePath) return;
  try {
    const projectHash = createHash('md5').update(directory).digest('hex').slice(0, 8);
    const trackingFile = `/tmp/smelter-session-files-${projectHash}.json`;
    let files = [];
    if (existsSync(trackingFile)) {
      try { files = JSON.parse(readFileSync(trackingFile, 'utf-8')); } catch { files = []; }
    }
    // Store relative path if inside project dir
    const rel = filePath.startsWith(directory) ? filePath.slice(directory.length + 1) : filePath;
    if (!files.includes(rel)) {
      files.push(rel);
      writeFileSync(trackingFile, JSON.stringify(files));
    }
  } catch { /* best-effort */ }
}

// Generate contextual message
function generateMessage(toolName, toolOutput, sessionId, toolCount, directory) {
  let message = '';

  switch (toolName) {
    case 'Bash':
      if (detectBashFailure(toolOutput)) {
        message = 'Command failed. Please investigate the error and fix before continuing.';
      } else if (detectBackgroundOperation(toolOutput)) {
        message = 'Background operation detected. Remember to verify results before proceeding.';
      }
      break;

    case 'Task':
    case 'TaskCreate':
    case 'TaskUpdate': {
      const agentSummary = getAgentCompletionSummary(directory);
      if (detectWriteFailure(toolOutput)) {
        message = 'Task delegation failed. Verify agent name and parameters.';
      } else if (detectBackgroundOperation(toolOutput)) {
        message = 'Background task launched. Use TaskOutput to check results when needed.';
      }
      if (agentSummary) {
        message = message ? `${message} | ${agentSummary}` : agentSummary;
      }
      break;
    }

    case 'Edit':
      if (detectWriteFailure(toolOutput)) {
        message = 'Edit operation failed. Verify file exists and content matches exactly.';
      } else {
        message = 'Code modified. Verify changes work as expected before marking complete.';
      }
      break;

    case 'Write':
      if (detectWriteFailure(toolOutput)) {
        message = 'Write operation failed. Check file permissions and directory existence.';
      } else {
        message = 'File written. Test the changes to ensure they work correctly.';
      }
      break;

    case 'TodoWrite':
      if (/created|added/i.test(toolOutput)) {
        message = 'Todo list updated. Proceed with next task on the list.';
      } else if (/completed|done/i.test(toolOutput)) {
        message = 'Task marked complete. Continue with remaining todos.';
      } else if (/in_progress/i.test(toolOutput)) {
        message = 'Task marked in progress. Focus on completing this task.';
      }
      break;

    case 'Read':
      break;

    case 'Grep':
      if (/^0$|no matches/i.test(toolOutput)) {
        message = 'No matches found. Verify pattern syntax or try broader search.';
      }
      break;

    case 'Glob':
      if (!toolOutput.trim() || /no files/i.test(toolOutput)) {
        message = 'No files matched pattern. Verify glob syntax and directory.';
      }
      break;
  }

  return message;
}

function main() {
  printTag('Post Tool Verifier');
  try {
    const input = readStdinSync();
    const data = JSON.parse(input);

    const toolName = data.tool_name || data.toolName || '';
    const rawResponse = data.tool_response || data.toolOutput || '';
    const toolOutput = typeof rawResponse === 'string' ? rawResponse : JSON.stringify(rawResponse);
    const directory = data.cwd || data.directory || process.cwd();

    // Append Bash commands to ~/.bash_history for terminal recall
    if (toolName === 'Bash' || toolName === 'bash') {
      const toolInput = data.tool_input || data.toolInput || {};
      const command = typeof toolInput === 'string' ? toolInput : (toolInput.command || '');
      appendToBashHistory(command);
    }

    // Track files modified by Claude for session-scoped E2E checks
    if (toolName === 'Write' || toolName === 'Edit') {
      const toolInput = data.tool_input || data.toolInput || {};
      const filePath = typeof toolInput === 'string' ? toolInput : (toolInput.file_path || toolInput.filePath || '');
      trackModifiedFile(filePath, directory);
    }

    // Generate contextual message
    const message = generateMessage(toolName, toolOutput, '', 0, directory);

    // Build response - use hookSpecificOutput.additionalContext for PostToolUse
    const response = { continue: true };
    if (message) {
      console.error(`\x1b[33m[smelter] PostToolUse · ${toolName}\x1b[0m`);
      response.hookSpecificOutput = {
        hookEventName: 'PostToolUse',
        additionalContext: message
      };
    } else {
      response.suppressOutput = true;
    }

    console.log(JSON.stringify(response, null, 2));
  } catch (error) {
    // On error, always continue
    console.log(JSON.stringify({ continue: true }));
  }
}

main();
