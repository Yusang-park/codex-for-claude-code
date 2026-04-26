import { execFileSync as defaultExecFileSync } from 'node:child_process';

export const PACKAGE_NAME = 'codex-for-claude-code';
export const AUTO_UPDATE_REENTRY_ENV = 'CLAUDE_CODEX_AUTO_UPDATE_REENTRY';
export const AUTO_UPDATE_MANUAL_COMMAND = `npm install -g ${PACKAGE_NAME}@latest`;

export function compareSemver(a, b) {
  const parse = (value) => String(value ?? '')
    .trim()
    .replace(/^v/, '')
    .split('-')[0]
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  const aa = parse(a);
  const bb = parse(b);

  for (let i = 0; i < Math.max(aa.length, bb.length); i += 1) {
    const av = aa[i] ?? 0;
    const bv = bb[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

export function resolveAutoUpdate({
  currentVersion,
  env = process.env,
  stderr = process.stderr,
  execFileSync = defaultExecFileSync,
} = {}) {
  if (env[AUTO_UPDATE_REENTRY_ENV] === '1' || env.SMELTER_WRAPPER_TEST === '1') {
    return { status: 'skipped' };
  }

  let latestVersion;
  try {
    latestVersion = String(execFileSync('npm', ['view', PACKAGE_NAME, 'version', '--silent'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    })).trim();
  } catch (error) {
    stderr.write(`[claude-wrapper] auto-update check failed; continuing with ${currentVersion ?? 'current version'}. To update manually, run: ${AUTO_UPDATE_MANUAL_COMMAND}\n`);
    return { status: 'check_failed', error };
  }

  if (!latestVersion || compareSemver(latestVersion, currentVersion) <= 0) {
    return { status: 'current', latestVersion };
  }

  stderr.write(`[claude-wrapper] updating ${PACKAGE_NAME} from ${currentVersion} to ${latestVersion}\n`);

  try {
    execFileSync('npm', ['install', '-g', `${PACKAGE_NAME}@latest`], {
      stdio: 'inherit',
      timeout: 120000,
    });
  } catch (error) {
    stderr.write(`[claude-wrapper] auto-update failed. Run: ${AUTO_UPDATE_MANUAL_COMMAND}\n`);
    return { status: 'update_failed', latestVersion, error };
  }

  return { status: 'updated', latestVersion };
}
