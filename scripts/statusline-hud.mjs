#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CODEX_MODEL_OPTIONS } from './lib/codex-models.mjs';

const SETTINGS_PATH = '/Users/yusang/smelter/settings.json';
const MODEL_CACHE_DIR = join(homedir(), '.claude', 'hud', 'last-model');
const TASK_SUMMARY_DIR = join(homedir(), '.claude', 'hud', 'task-summary');
const TASK_SUMMARY_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
const TASK_SUMMARY_TRUNCATE = 40;

// Per-cwd cache key. Multiple Claude Code windows run in different workspaces with different
// models (Opus 1M in one, Codex gpt-5.4 in another); a shared cache would cross-contaminate
// the model label shown at each window's first-launch render.
function cacheKeyForCwd(cwd) {
  return Buffer.from(cwd || 'default').toString('base64url');
}

const CLAUDE_ALIAS_LABELS = {
  sonnet: 'Sonnet 4.6',
  opus: 'Opus 4.6',
  haiku: 'Haiku 4.5',
};

function resolveModelLabel(settingsModel, additionalCache) {
  if (!settingsModel) return null;
  // Codex/gpt model — look up in cache for display label
  const cached = Array.isArray(additionalCache) && additionalCache.find((m) => m.value === settingsModel);
  if (cached) return cached.label;
  // Raw gpt/o model ID not in cache
  if (/^(gpt-|o\d)/i.test(settingsModel)) return settingsModel;
  // Claude alias — show model name so user knows which Claude model is active
  if (CLAUDE_ALIAS_LABELS[settingsModel]) return CLAUDE_ALIAS_LABELS[settingsModel];
  // Full claude-* model ID
  if (/^claude-/i.test(settingsModel)) return settingsModel;
  return null;
}

function readStdinSync() {
  try { return readFileSync('/dev/stdin', 'utf-8'); } catch { return '{}'; }
}

function readJsonFile(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function isActiveState(path) {
  const state = readJsonFile(path);
  return Boolean(state?.active);
}

// Sum assistant output_tokens from the last 5h across all Claude Code JSONL transcripts.
// Returns { outputTokens, oldestTimestampMs } — oldestTimestampMs is the earliest matching
// assistant turn within the 5h window (used to derive a Codex "rolling 5h reset" point).
// `modelFilter` controls which turns count:
//   'claude' — only claude-* models (excludes gpt/codex turns made in Codex-mode windows)
//   'codex'  — only gpt-*/o\d models
//   'any'    — all models
function compute5hUsage(modelFilter = 'any') {
  const fiveHoursAgo = Date.now() - 5 * 60 * 60 * 1000;
  const projectsDir = join(homedir(), '.claude', 'projects');
  const matches = (model) => {
    if (!model) return modelFilter === 'any';
    if (modelFilter === 'any') return true;
    if (modelFilter === 'codex') return /^(gpt-|o\d)/i.test(model);
    if (modelFilter === 'claude') return /^claude-/i.test(model);
    return false;
  };
  let outputTokens = 0;
  let oldestTimestampMs = null;
  try {
    for (const proj of readdirSync(projectsDir)) {
      const projPath = join(projectsDir, proj);
      try {
        for (const file of readdirSync(projPath)) {
          if (!file.endsWith('.jsonl')) continue;
          const filePath = join(projPath, file);
          try {
            if (statSync(filePath).mtimeMs < fiveHoursAgo) continue;
          } catch { continue; }
          try {
            for (const line of readFileSync(filePath, 'utf8').split('\n')) {
              if (!line.trim()) continue;
              try {
                const d = JSON.parse(line);
                if (d.type !== 'assistant') continue;
                const ts = new Date(d.timestamp).getTime();
                if (ts < fiveHoursAgo) continue;
                if (!matches(d.message?.model)) continue;
                const u = d.message?.usage;
                if (u) outputTokens += (u.output_tokens ?? 0);
                if (oldestTimestampMs === null || ts < oldestTimestampMs) oldestTimestampMs = ts;
              } catch { /* skip malformed line */ }
            }
          } catch { /* skip unreadable file */ }
        }
      } catch { /* skip unreadable project dir */ }
    }
  } catch { /* projects dir not found */ }
  return { outputTokens, oldestTimestampMs };
}

// Format a millisecond duration as compact "XhYm" or "Xm" — used for "reset in …" badge.
function formatDuration(ms) {
  if (ms <= 0) return 'now';
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

// Parse OpenAI x-ratelimit-reset-tokens duration strings like "6m0s", "500ms", "1m30s" → ms.
function parseOpenAIDuration(str) {
  if (!str) return null;
  let ms = 0;
  const hMatch = str.match(/(\d+)h/);
  const mMatch = str.match(/(\d+)m(?!s)/);
  const sMatch = str.match(/(\d+)s/);
  const msMatch = str.match(/(\d+)ms/);
  if (hMatch) ms += parseInt(hMatch[1], 10) * 3_600_000;
  if (mMatch) ms += parseInt(mMatch[1], 10) * 60_000;
  if (sMatch) ms += parseInt(sMatch[1], 10) * 1_000;
  if (msMatch) ms += parseInt(msMatch[1], 10);
  return ms > 0 ? ms : null;
}


function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function readTaskSummary(cwd, sessionId) {
  try {
    const cwdKey = cacheKeyForCwd(cwd);
    const summaryPath = join(TASK_SUMMARY_DIR, `${cwdKey}.json`);
    if (!existsSync(summaryPath)) return null;
    const data = JSON.parse(readFileSync(summaryPath, 'utf8'));
    if (!data.timestamp) return null;
    const age = Date.now() - new Date(data.timestamp).getTime();
    if (age > TASK_SUMMARY_MAX_AGE_MS) return null;
    // Only show summary from the current session
    if (sessionId && data.session_id && data.session_id !== sessionId) return null;
    if (data.summary) return data.summary;
    if (data.raw_prompt) {
      const trimmed = data.raw_prompt.trim();
      if (trimmed.length <= TASK_SUMMARY_TRUNCATE) return trimmed;
      return trimmed.slice(0, TASK_SUMMARY_TRUNCATE) + '...';
    }
    return null;
  } catch {
    return null;
  }
}

function readWorkflowStatus(cwd, sessionId = '') {
  try {
    // Live sessions must only read the session-scoped pointer so a stale global
    // pointer from another session cannot leak into this HUD render.
    const pointerPath = sessionId
      ? join(cwd, '.smt', 'state', `active-feature-${sessionId}.json`)
      : join(cwd, '.smt', 'state', 'active-feature.json');
    const pointer = readJsonFile(pointerPath);
    if (!pointer?.slug) return null;
    const workflow = readJsonFile(join(cwd, '.smt', 'features', pointer.slug, 'state', 'workflow.json'));
    if (!workflow?.command || !workflow?.step) return null;
    const modeLabel = `${String(workflow.command).toUpperCase()} MODE`;
    const stepLabel = String(workflow.step);
    return `${modeLabel} · ${pointer.slug} · ${stepLabel}`;
  } catch {
    return null;
  }
}

function isWorkflowVisiblePrompt(prompt = '') {
  const trimmed = String(prompt || '').trim();
  if (!trimmed) return false;
  if (/^\/(tasker|feat|qa)\b/i.test(trimmed)) return true;
  const lower = trimmed.toLowerCase();
  return ['continue', 'proceed', 'next step', 'keep going', '계속', '진행', '다음', '이어', '승인'].some((signal) => lower.includes(signal));
}

function shouldSuppressWorkflowOverlay(input, cwd) {
  try {
    const parsed = JSON.parse(input);
    const prompt = parsed.prompt || parsed.message?.content || '';
    const sid = parsed.session_id || parsed.sessionId || '';
    if (!readWorkflowStatus(cwd, sid)) return false;
    return !isWorkflowVisiblePrompt(prompt);
  } catch {
    return false;
  }
}

function resolveCwd(input) {
  try {
    const parsed = JSON.parse(input);
    return parsed.cwd || parsed.workspace?.current_dir || process.cwd();
  } catch {
    return process.cwd();
  }
}

async function main() {
  const input = readStdinSync();
  const cwd = resolveCwd(input);

  // Parse all useful fields from stdin
  let fiveHourPct = null;
  let fiveHourResetsAtMs = null;
  let ctxUsedPct = null;
  let totalInputTokens = null;
  let sessionOutputTokens = null;
  let stdinModelId = null;
  let stdinModelLabel = null;
  let stdinSessionId = null;
  try {
    const parsed = JSON.parse(input);
    fiveHourPct = parsed.rate_limits?.five_hour?.used_percentage ?? null;
    // rate_limits.five_hour.resets_at is a unix epoch in seconds
    const resetsAt = parsed.rate_limits?.five_hour?.resets_at;
    fiveHourResetsAtMs = typeof resetsAt === 'number' ? resetsAt * 1000 : null;
    ctxUsedPct = parsed.context_window?.used_percentage ?? null;
    totalInputTokens = parsed.context_window?.total_input_tokens ?? null;
    sessionOutputTokens = parsed.context_window?.total_output_tokens ?? null;
    stdinModelId = parsed.model?.id ?? null;
    stdinModelLabel = parsed.model?.display_name ?? null;
    stdinSessionId = parsed.session_id ?? null;
  } catch { /* ignore */ }

  const home = homedir();
  const modelModeState = readJsonFile(join(cwd, '.smt', 'state', 'model-mode.json'))
    ?? readJsonFile(join(home, '.omc', 'state', 'model-mode.json'));
  const inCodexMode = modelModeState?.mode === 'codex'
    || process.env.SMELTER_MODEL_MODE === 'codex';

  // Resolve current model label from settings.json (always, both modes)
  const settings = readJsonFile(SETTINGS_PATH);
  const claudeJson = readJsonFile(join(home, '.claude.json'));
  // Self-heal: if in codex mode but cache was cleared by bootstrap, restore it
  if (inCodexMode && Array.isArray(claudeJson?.additionalModelOptionsCache) && claudeJson.additionalModelOptionsCache.length === 0) {
    try {
      claudeJson.additionalModelOptionsCache = CODEX_MODEL_OPTIONS;
      writeFileSync(join(home, '.claude.json'), JSON.stringify(claudeJson) + '\n');
    } catch { /* ignore */ }
  }

  // Detect whether *this statusline invocation* is for a Codex window.
  // Two windows (Claude + Codex) can share the SAME cwd, so caches must be keyed by
  // cwd + model-family. Determine family from stdin first, then cached, then global state.
  const stdinIsCodex = stdinModelId ? /^(gpt-|o\d)/i.test(stdinModelId) : null;
  const cwdKey = cacheKeyForCwd(cwd);

  // Read BOTH family caches for this cwd — pick the right one after we know the family.
  const cachedClaude = readJsonFile(join(MODEL_CACHE_DIR, `${cwdKey}-claude.json`));
  const cachedCodex = readJsonFile(join(MODEL_CACHE_DIR, `${cwdKey}-codex.json`));
  // Also read the legacy single-file cache (from before family split) for migration
  const cachedLegacy = readJsonFile(join(MODEL_CACHE_DIR, `${cwdKey}.json`));

  // Resolve family: stdin model is authoritative. When stdin is empty (first frame before any
  // turn), default to Claude unless only a Codex cache exists for this cwd. Two windows in the
  // same cwd always send model.id after the first turn, so this ambiguity is brief.
  let windowIsCodex;
  if (stdinIsCodex !== null) {
    windowIsCodex = stdinIsCodex;
  } else if (cachedClaude) {
    windowIsCodex = false; // prefer Claude when both caches exist
  } else if (cachedCodex) {
    windowIsCodex = true;  // only Codex cache → must be a Codex window
  } else if (cachedLegacy?.id) {
    windowIsCodex = /^(gpt-|o\d)/i.test(cachedLegacy.id);
  } else {
    windowIsCodex = inCodexMode;
  }

  const cachedModel = windowIsCodex ? (cachedCodex ?? cachedLegacy) : (cachedClaude ?? cachedLegacy);
  const modelCachePath = join(MODEL_CACHE_DIR, `${cwdKey}-${windowIsCodex ? 'codex' : 'claude'}.json`);

  // Resolve model label
  let modelLabel;
  const cache = claudeJson?.additionalModelOptionsCache;
  const codexModeLabel = inCodexMode ? (modelModeState?.model ?? 'Codex') : null;
  if (windowIsCodex && codexModeLabel) {
    modelLabel = codexModeLabel;
  } else if (stdinModelId && /^(gpt-|o\d)/i.test(stdinModelId)) {
    modelLabel = resolveModelLabel(stdinModelId, cache) ?? stdinModelLabel ?? stdinModelId;
  } else if (stdinModelLabel) {
    modelLabel = stdinModelLabel;
  } else if (cachedModel?.label) {
    modelLabel = cachedModel.label;
  } else {
    const currentModel = settings?.model;
    modelLabel = resolveModelLabel(currentModel, cache)
      ?? codexModeLabel;
  }

  // 5h usage scan — filter to the window's model family for token counts.
  const usageFilter = windowIsCodex ? 'codex' : 'claude';
  const { outputTokens: liveUsedTokens, oldestTimestampMs } = compute5hUsage(usageFilter);
  // For reset calculation, also get the oldest turn across ALL models. Anthropic's 5h window
  // is account-wide, so the Codex window's 5h window started when the account's first usage
  // happened (often a Claude turn), not when the first Codex turn happened.
  const { oldestTimestampMs: oldestAnyTimestampMs } = compute5hUsage('any');

  // 5h percentage: use authoritative fiveHourPct from stdin, cache it for frames where stdin
  // lacks rate_limits. Never derive a denominator from output_tokens / pct — output_tokens is
  // only a fraction of what Anthropic counts (input+output+cache), making the derivation wrong.
  const shouldWriteCache =
    (stdinModelLabel && stdinModelLabel !== cachedModel?.label) ||
    (fiveHourPct !== null && fiveHourPct !== cachedModel?.five_hour_pct) ||
    (fiveHourResetsAtMs !== null && fiveHourResetsAtMs !== cachedModel?.five_hour_resets_at_ms);
  if (shouldWriteCache && !process.env.HUD_DRY_RUN) {
    try {
      mkdirSync(MODEL_CACHE_DIR, { recursive: true });
      const payload = {
        label: stdinModelLabel ?? cachedModel?.label ?? null,
        id: stdinModelId ?? cachedModel?.id ?? null,
        five_hour_pct: fiveHourPct ?? cachedModel?.five_hour_pct ?? null,
        five_hour_resets_at_ms: fiveHourResetsAtMs ?? cachedModel?.five_hour_resets_at_ms ?? null,
        updated_at: new Date().toISOString(),
      };
      writeFileSync(modelCachePath, JSON.stringify(payload) + '\n');
    } catch { /* ignore cache write failures */ }
  }

  const usedTokens = liveUsedTokens;
  const effectivePct = fiveHourPct ?? cachedModel?.five_hour_pct ?? null;

  // Reset countdown
  const nowMs = Date.now();
  let resetLabel = '';
  const resetAtMs = fiveHourResetsAtMs ?? cachedModel?.five_hour_resets_at_ms ?? null;
  if (resetAtMs && resetAtMs > nowMs) {
    resetLabel = `reset ${formatDuration(resetAtMs - nowMs)}`;
  }

  let usagePart = '';
  if (effectivePct !== null) {
    const resetSuffix = resetLabel ? ` (${resetLabel})` : '';
    if (usedTokens > 0) {
      usagePart = `${formatTokens(usedTokens)} ${Math.round(effectivePct)}%${resetSuffix}`;
    } else {
      usagePart = `${Math.round(effectivePct)}%${resetSuffix}`;
    }
  } else if (usedTokens > 0) {
    // No authoritative percentage available — show 5h output tokens with label
    const resetSuffix = resetLabel ? ` (${resetLabel})` : '';
    usagePart = `5h ${formatTokens(usedTokens)}${resetSuffix}`;
  }

  // Primary display: "[모델명]  612k / [전체] 95% (5h)"
  let primary = '';
  if (modelLabel && usagePart) {
    primary = `${modelLabel}  ${usagePart}`;
  } else if (modelLabel) {
    primary = modelLabel;
  } else if (usagePart) {
    primary = usagePart;
  }

  // Session + context badges from stdin. Subagents also trigger the statusline with their own
  // (near-zero) context windows, causing ctx% to flicker. Discriminate by context_window_size:
  // main sessions use large windows (1M for Opus, 200k+ for Sonnet), subagents use ≤200k.
  const infoBadges = [];
  let ctxWindowSize = null;
  try { ctxWindowSize = JSON.parse(input).context_window?.context_window_size ?? null; } catch {}
  const effectiveCtxWindowSize =
    windowIsCodex && ctxWindowSize === 200_000
      ? 1_000_000
      : ctxWindowSize;
  const effectiveCtxUsedPct =
    ctxUsedPct
    ?? (
      effectiveCtxWindowSize && totalInputTokens
        ? (totalInputTokens / effectiveCtxWindowSize) * 100
        : null
    );
  const isMainSession = effectiveCtxWindowSize === null || effectiveCtxWindowSize > 200_000;
  if (isMainSession && sessionOutputTokens !== null && sessionOutputTokens > 0) {
    infoBadges.push(`${formatTokens(sessionOutputTokens)} out`);
  }
  if (isMainSession && effectiveCtxUsedPct !== null && effectiveCtxUsedPct > 0) {
    infoBadges.push(`ctx ${Math.round(effectiveCtxUsedPct)}%`);
  }

  // Additional mode badges
  const ultraworkActive =
    isActiveState(join(cwd, '.omc', 'state', 'ultrawork-state.json')) ||
    isActiveState(join(home, '.omc', 'state', 'ultrawork-state.json'));
  const ecomodeActive =
    isActiveState(join(cwd, '.omc', 'state', 'ecomode-state.json')) ||
    isActiveState(join(home, '.omc', 'state', 'ecomode-state.json'));

  const extraBadges = [];
  if (ultraworkActive) extraBadges.push('ULTRAWORK');
  if (ecomodeActive) extraBadges.push('ECO');

  // Line 1: model + usage + badges (existing)
  const parts = [
    ...(primary ? [primary] : []),
    ...infoBadges,
    ...extraBadges,
  ];
  const line1 = parts.join(' | ');

  // Line 2: workflow status + task summary in blue
  const taskSummary = readTaskSummary(cwd, stdinSessionId);
  const workflowStatus = readWorkflowStatus(cwd, stdinSessionId);
  const BLUE = '\x1b[34m';
  const RESET = '\x1b[0m';
  const line2Parts = [workflowStatus, taskSummary].filter(Boolean);
  const line2 = line2Parts.length > 0 ? `${BLUE}${line2Parts.join(' | ')}${RESET}` : '';

  const output = line2 ? `${line1}\n${line2}` : line1;
  process.stdout.write(output);
}

main().catch(() => {
  process.stdout.write('');
});
