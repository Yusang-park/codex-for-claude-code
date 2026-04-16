#!/usr/bin/env node
/**
 * Codex Proxy — Anthropic Messages API → ChatGPT Codex Responses API
 *
 * Translates requests/responses so `claude --codex` routes actual API calls
 * to ChatGPT Codex instead of Anthropic.
 *
 * Usage (standalone):
 *   node scripts/codex-proxy.mjs
 *
 * Requirements:
 *   Codex CLI OAuth login in ~/.codex/auth.json
 *
 * Env vars:
 *   CHATGPT_API_BASE  Optional. Default: https://chatgpt.com/backend-api/codex
 *   CODEX_PROXY_PORT  Optional. Default: 3099
 */
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STATE_DIR = join(process.cwd(), '.smt', 'state');
const CODEX_USAGE_PATH = join(STATE_DIR, 'codex-usage.json');
const CODEX_RATELIMIT_PATH = join(STATE_DIR, 'codex-ratelimit.json');
const CODEX_MODEL_CONTEXT_WINDOWS = {
  'gpt-5.4': 1_000_000,
};

function getContextWindowForModel(model) {
  return CODEX_MODEL_CONTEXT_WINDOWS[model] ?? null;
}

function buildUsagePayload(model, usage = {}) {
  const contextWindow = getContextWindowForModel(model);
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheCreationInputTokens = usage.cache_creation_input_tokens ?? 0;
  const cacheReadInputTokens = usage.cache_read_input_tokens ?? 0;
  const totalInputTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens;
  const payload = {
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_input_tokens: totalInputTokens,
    total_output_tokens: outputTokens,
    current_usage: {
      input_tokens: inputTokens,
      cache_creation_input_tokens: cacheCreationInputTokens,
      cache_read_input_tokens: cacheReadInputTokens,
    },
  };
  if (contextWindow) {
    payload.context_window = contextWindow;
    payload.context_window_size = contextWindow;
    payload.used_percentage = (totalInputTokens / contextWindow) * 100;
  }
  return payload;
}

function appendCodexUsage(outputTokens) {
  if (!outputTokens) return;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    let entries = [];
    if (existsSync(CODEX_USAGE_PATH)) {
      try { entries = JSON.parse(readFileSync(CODEX_USAGE_PATH, 'utf8')); } catch { entries = []; }
    }
    if (!Array.isArray(entries)) entries = [];
    const fiveHoursAgo = Date.now() - 5 * 60 * 60 * 1000;
    // Prune entries older than 5h, then append new one
    entries = entries.filter((e) => e.timestamp > fiveHoursAgo);
    entries.push({ timestamp: Date.now(), output_tokens: outputTokens });
    writeFileSync(CODEX_USAGE_PATH, JSON.stringify(entries));
  } catch { /* ignore write errors */ }
}

// Capture OpenAI rate-limit headers and persist for the HUD statusline.
// Headers: x-ratelimit-limit-tokens, x-ratelimit-remaining-tokens, x-ratelimit-reset-tokens
function persistCodexRateLimit(headers) {
  try {
    const limitTokens = parseInt(headers.get('x-ratelimit-limit-tokens') ?? '', 10);
    const remainingTokens = parseInt(headers.get('x-ratelimit-remaining-tokens') ?? '', 10);
    const resetTokens = headers.get('x-ratelimit-reset-tokens') ?? ''; // e.g. "6m0s", "1ms"
    if (!Number.isFinite(limitTokens)) return;
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(CODEX_RATELIMIT_PATH, JSON.stringify({
      limit_tokens: limitTokens,
      remaining_tokens: Number.isFinite(remainingTokens) ? remainingTokens : null,
      reset_tokens: resetTokens || null,
      updated_at: Date.now(),
    }) + '\n');
  } catch { /* ignore */ }
}

const PORT = parseInt(process.env.CODEX_PROXY_PORT ?? '3099', 10);
export const PROXY_VERSION = '6'; // bump when proxy behaviour changes — wrapper restarts stale instances
const CHATGPT_API_BASE = (process.env.CHATGPT_API_BASE ?? 'https://chatgpt.com/backend-api/codex').replace(/\/$/, '');
const CODEX_AUTH_PATH = join(homedir(), '.codex', 'auth.json');

// Resolve auth from Codex CLI OAuth (ChatGPT subscription billing).
// Returns { mode: 'oauth', token, accountId? } | null
export function getCodexAuth() {
  try {
    if (existsSync(CODEX_AUTH_PATH)) {
      const auth = JSON.parse(readFileSync(CODEX_AUTH_PATH, 'utf8'));
      if (auth.tokens?.access_token) {
        return {
          mode: 'oauth',
          token: auth.tokens.access_token,
          accountId: auth.tokens.account_id ?? null,
        };
      }
    }
  } catch { /* fall through */ }
  return null;
}

// ── Responses API (ChatGPT backend) ──────────────────────────────────────────
// When using Codex CLI OAuth, requests go to chatgpt.com/backend-api/codex/responses
// using the Responses API format.

export function buildResponsesAPIRequest(body) {
  const input = [];

  // System → developer instructions (Responses API uses "instructions" or a developer message)
  let instructions;
  if (body.system) {
    instructions = typeof body.system === 'string'
      ? body.system
      : body.system.filter((b) => b.type === 'text').map((b) => b.text).join('');
  }

  // Convert Anthropic messages to Responses API input items
  for (const msg of body.messages ?? []) {
    if (typeof msg.content === 'string') {
      input.push({ role: msg.role, content: msg.content });
      continue;
    }
    for (const block of msg.content ?? []) {
      if (block.type === 'text') {
        input.push({ role: msg.role, content: block.text });
      } else if (block.type === 'tool_use') {
        input.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        });
      } else if (block.type === 'tool_result') {
        const content = typeof block.content === 'string'
          ? block.content
          : (Array.isArray(block.content)
            ? block.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
            : '');
        input.push({
          type: 'function_call_output',
          call_id: block.tool_use_id,
          output: content,
        });
      }
    }
  }

  const req = {
    model: body.model,
    input,
    store: false, // required by ChatGPT backend
    stream: true, // ChatGPT backend requires stream=true; non-stream clients are handled by collecting SSE events
  };

  req.instructions = instructions || 'You are a helpful assistant.';

  // Tools → Responses API format
  if (body.tools?.length) {
    req.tools = body.tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description ?? '',
      parameters: t.input_schema ?? { type: 'object', properties: {} },
    }));
  }

  // ChatGPT backend rejects token limit params — do NOT include max_output_tokens etc.
  return req;
}

export function translateResponsesAPIResponse(resp, originalModel) {
  const content = [];
  let outputTokens = 0;
  let inputTokens = 0;
  const contextWindow = getContextWindowForModel(originalModel);

  if (resp.usage) {
    inputTokens = resp.usage.input_tokens ?? 0;
    outputTokens = resp.usage.output_tokens ?? 0;
  }

  // Extract output items
  for (const item of resp.output ?? []) {
    if (item.type === 'message') {
      for (const c of item.content ?? []) {
        if (c.type === 'output_text') {
          content.push({ type: 'text', text: c.text });
        }
      }
    } else if (item.type === 'function_call') {
      let input = {};
      try { input = JSON.parse(item.arguments ?? '{}'); } catch { /* keep empty */ }
      content.push({
        type: 'tool_use',
        id: item.call_id ?? `toolu_${Date.now()}`,
        name: item.name,
        input,
      });
    }
  }

  const hasToolUse = content.some((c) => c.type === 'tool_use');

  return {
    id: `msg_${resp.id ?? Date.now()}`,
    type: 'message',
    role: 'assistant',
    content: content.length > 0 ? content : [{ type: 'text', text: '' }],
    model: originalModel,
    stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: buildUsagePayload(originalModel, {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    }),
  };
}

function formatSSE(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ── HTTP Server ───────────────────────────────────────────────────────────────

export function createServer() {
  return http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mode: 'codex-proxy', port: PORT, version: PROXY_VERSION }));
    return;
  }

  if (!req.url?.includes('/messages')) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  let rawBody = '';
  try {
    for await (const chunk of req) rawBody += chunk;
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid JSON' } }));
    return;
  }

  // Claude model IDs pass through to Anthropic directly (no translation needed).
  // OpenAI/Codex model IDs are translated from Anthropic format → OpenAI format.
  const isClaudeModel = /^claude-|^(opus|sonnet|haiku)(-|$)/i.test(body.model ?? '');

  if (isClaudeModel) {
    // ── Claude passthrough: forward verbatim to api.anthropic.com ────────────
    const anthropicUrl = `https://api.anthropic.com/v1/messages`;
    const forwardHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.toLowerCase() === 'host') continue;
      forwardHeaders[k] = v;
    }
    let upstreamRes;
    try {
      upstreamRes = await fetch(anthropicUrl, {
        method: 'POST',
        headers: forwardHeaders,
        body: rawBody,
      });
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Proxy upstream error: ${err.message}` } }));
      return;
    }
    const contentType = upstreamRes.headers.get('content-type') ?? 'application/json';
    res.writeHead(upstreamRes.status, { 'Content-Type': contentType });
    if (upstreamRes.body) {
      for await (const chunk of upstreamRes.body) res.write(chunk);
    }
    res.end();
    return;
  }

  // ── Codex path ────────────────────────────────────────────────────────────
  const auth = getCodexAuth();
  if (!auth) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: { type: 'authentication_error', message: 'No Codex auth: login via `codex` CLI' },
    }));
    return;
  }

  const originalModel = body.model;
  const responsesReq = buildResponsesAPIRequest(body);
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${auth.token}`,
  };
  if (auth.accountId) headers['ChatGPT-Account-ID'] = auth.accountId;

  let upstreamRes;
  try {
    upstreamRes = await fetch(`${CHATGPT_API_BASE}/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify(responsesReq),
    });
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `ChatGPT backend error: ${err.message}` } }));
    return;
  }

  if (!upstreamRes.ok) {
    const errText = await upstreamRes.text();
    process.stderr.write(`[codex-proxy] ChatGPT backend ${upstreamRes.status}: ${errText.slice(0, 200)}\n`);
    res.writeHead(upstreamRes.status, { 'Content-Type': 'application/json' });
    res.end(errText);
    return;
  }

  const isStream = body.stream === true;
  let lineBuffer = '';
  let finalResponse = null;
  let streamOutputTokens = 0;

  if (isStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const state = {
      started: false,
      msgId: `msg_${Date.now()}`,
      nextBlockIdx: 0,
      // output_index (from Responses API) → { idx: claude block index, type: 'text'|'tool_use', open: bool }
      blocks: new Map(),
      hasToolUse: false,
    };

    const ensureMessageStart = () => {
      if (state.started) return;
      state.started = true;
      res.write(formatSSE('message_start', {
        type: 'message_start',
        message: {
          id: state.msgId,
          type: 'message',
          role: 'assistant',
          content: [],
          model: originalModel,
          stop_reason: null,
          stop_sequence: null,
          usage: buildUsagePayload(originalModel),
        },
      }));
      res.write(formatSSE('ping', { type: 'ping' }));
    };

    const openTextBlock = (outputIndex) => {
      ensureMessageStart();
      const idx = state.nextBlockIdx++;
      state.blocks.set(outputIndex, { idx, type: 'text', open: true });
      res.write(formatSSE('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } }));
      return idx;
    };

    const openToolBlock = (outputIndex, item) => {
      ensureMessageStart();
      const idx = state.nextBlockIdx++;
      state.blocks.set(outputIndex, { idx, type: 'tool_use', open: true });
      state.hasToolUse = true;
      res.write(formatSSE('content_block_start', {
        type: 'content_block_start',
        index: idx,
        content_block: {
          type: 'tool_use',
          id: item.call_id ?? item.id ?? `toolu_${Date.now()}_${idx}`,
          name: item.name ?? '',
          input: {},
        },
      }));
      return idx;
    };

    const closeBlock = (outputIndex) => {
      const b = state.blocks.get(outputIndex);
      if (!b || !b.open) return;
      b.open = false;
      res.write(formatSSE('content_block_stop', { type: 'content_block_stop', index: b.idx }));
    };

    try {
      for await (const rawChunk of upstreamRes.body) {
        lineBuffer += new TextDecoder().decode(rawChunk);
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (!payload || payload === '[DONE]') continue;

          let evt;
          try { evt = JSON.parse(payload); } catch { continue; }

          if (evt.type === 'response.completed' || evt.type === 'response.done') {
            finalResponse = evt.response ?? evt;
            streamOutputTokens = finalResponse.usage?.output_tokens ?? 0;
            continue;
          }

          if (evt.type === 'response.output_item.added' && evt.item) {
            const oi = evt.output_index ?? evt.item.index ?? state.blocks.size;
            if (evt.item.type === 'function_call') {
              openToolBlock(oi, evt.item);
            }
            // message (text) blocks open lazily on first text delta
            continue;
          }

          if (evt.type === 'response.output_item.done') {
            const oi = evt.output_index ?? evt.item?.index;
            if (oi !== undefined) closeBlock(oi);
            continue;
          }

          if (evt.type === 'response.output_text.delta' && evt.delta) {
            const oi = evt.output_index ?? 0;
            let b = state.blocks.get(oi);
            if (!b) {
              openTextBlock(oi);
              b = state.blocks.get(oi);
            }
            res.write(formatSSE('content_block_delta', { type: 'content_block_delta', index: b.idx, delta: { type: 'text_delta', text: evt.delta } }));
            continue;
          }

          if (evt.type === 'response.function_call_arguments.delta' && evt.delta) {
            const oi = evt.output_index;
            const b = state.blocks.get(oi);
            if (!b) continue;
            res.write(formatSSE('content_block_delta', { type: 'content_block_delta', index: b.idx, delta: { type: 'input_json_delta', partial_json: evt.delta } }));
            continue;
          }

          if (evt.type === 'response.function_call_arguments.done') {
            const oi = evt.output_index;
            closeBlock(oi);
            continue;
          }
        }
      }
    } catch { /* best-effort */ }

    // Close any blocks that remained open
    for (const [oi] of state.blocks) closeBlock(oi);

    if (state.started) {
      res.write(formatSSE('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: state.hasToolUse ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: buildUsagePayload(originalModel, {
          output_tokens: streamOutputTokens,
        }),
      }));
      res.write(formatSSE('message_stop', { type: 'message_stop' }));
    } else {
      // No content arrived — emit a minimal end_turn so the client doesn't hang
      res.write(formatSSE('message_start', {
        type: 'message_start',
        message: {
          id: state.msgId,
          type: 'message',
          role: 'assistant',
          content: [],
          model: originalModel,
          stop_reason: null,
          stop_sequence: null,
          usage: buildUsagePayload(originalModel),
        },
      }));
      res.write(formatSSE('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
      res.write(formatSSE('content_block_stop', { type: 'content_block_stop', index: 0 }));
      res.write(formatSSE('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: {
          output_tokens: 0,
          ...(getContextWindowForModel(originalModel) ? {
            context_window: getContextWindowForModel(originalModel),
            context_window_size: getContextWindowForModel(originalModel),
          } : {}),
        },
      }));
      res.write(formatSSE('message_stop', { type: 'message_stop' }));
    }
    appendCodexUsage(streamOutputTokens);
    res.end();
  } else {
    // Non-stream path: collect text deltas + function calls from SSE, then build Anthropic response
    let collectedText = '';
    const collectedToolCalls = [];
    let usageInput = 0;
    let usageOutput = 0;

    try {
      for await (const rawChunk of upstreamRes.body) {
        lineBuffer += new TextDecoder().decode(rawChunk);
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (!payload || payload === '[DONE]') continue;
          let evt;
          try { evt = JSON.parse(payload); } catch { continue; }

          if (evt.type === 'response.output_text.delta' && evt.delta) {
            collectedText += evt.delta;
          } else if (evt.type === 'response.function_call_arguments.done') {
            let input = {};
            try { input = JSON.parse(evt.arguments ?? '{}'); } catch { /* keep empty */ }
            collectedToolCalls.push({
              type: 'tool_use',
              id: evt.call_id ?? `toolu_${Date.now()}`,
              name: evt.name,
              input,
            });
          } else if (evt.type === 'response.completed' || evt.type === 'response.done') {
            const r = evt.response ?? evt;
            usageInput = r.usage?.input_tokens ?? 0;
            usageOutput = r.usage?.output_tokens ?? 0;
          }
        }
      }
    } catch { /* best-effort */ }

    const content = [];
    if (collectedText) content.push({ type: 'text', text: collectedText });
    for (const tc of collectedToolCalls) content.push(tc);
    const hasToolUse = collectedToolCalls.length > 0;

    if (content.length > 0 || usageOutput > 0) {
      const anthropicResp = {
        id: `msg_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content: content.length > 0 ? content : [{ type: 'text', text: '' }],
        model: originalModel,
        stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: buildUsagePayload(originalModel, {
          input_tokens: usageInput,
          output_tokens: usageOutput,
        }),
      };
      appendCodexUsage(usageOutput);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(anthropicResp));
    } else {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'No response received from ChatGPT backend' } }));
    }
  }
  });
}

export function startServer() {
  const server = createServer();

  server.listen(PORT, '127.0.0.1', () => {
    process.stderr.write(`[codex-proxy] listening on http://127.0.0.1:${PORT}\n`);
    process.stderr.write(`[codex-proxy] chatgpt=${CHATGPT_API_BASE}\n`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      // Already running — exit silently so wrapper doesn't fail
      process.exit(0);
    }
    process.stderr.write(`[codex-proxy] error: ${err.message}\n`);
    process.exit(1);
  });

  return server;
}

if (process.env.CODEX_PROXY_TEST !== '1') {
  startServer();
}
