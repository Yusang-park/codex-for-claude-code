// Yellow tag printer for smelter hooks.
// Emits short ANSI-yellow bracketed labels to stderr so users see hook activity.
// Respects NO_COLOR and non-TTY environments (plain text fallback).

const YELLOW_OPEN = '\x1b[33m';
const RESET = '\x1b[0m';

function shouldUseColor() {
  if (process.env.NO_COLOR) return false;
  // stderr TTY check; default to true when isTTY is undefined (piped but CI color-safe).
  if (process.stderr && process.stderr.isTTY === false) return false;
  return true;
}

export function formatTag(label) {
  const text = `[${label}]`;
  return shouldUseColor() ? `${YELLOW_OPEN}${text}${RESET}` : text;
}

export function printTag(label) {
  try {
    process.stderr.write(formatTag(label) + '\n');
  } catch {
    // stderr write failures are never fatal for a hook.
  }
}

export default printTag;
