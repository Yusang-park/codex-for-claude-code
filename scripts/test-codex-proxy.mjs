#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempHome = mkdtempSync(join(tmpdir(), 'codex-proxy-home-'));
mkdirSync(join(tempHome, '.codex'), { recursive: true });
writeFileSync(
  join(tempHome, '.codex', 'auth.json'),
  JSON.stringify({
    tokens: {
      access_token: 'oauth-token',
      account_id: 'acct-123',
    },
  }),
);

process.env.HOME = tempHome;
process.env.CODEX_PROXY_TEST = '1';

const {
  PROXY_VERSION,
  getCodexAuth,
  buildResponsesAPIRequest,
  translateResponsesAPIResponse,
} = await import('./codex-proxy.mjs');

assert.equal(PROXY_VERSION, '6');
assert.deepEqual(getCodexAuth(), {
  mode: 'oauth',
  token: 'oauth-token',
  accountId: 'acct-123',
});
assert.deepEqual(getCodexAuth(), {
  mode: 'oauth',
  token: 'oauth-token',
  accountId: 'acct-123',
});

const request = buildResponsesAPIRequest({
  model: 'gpt-5.4',
  system: 'system rule',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'say hi' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup_artist', input: { name: 'Adele' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] },
  ],
  max_tokens: 999,
  max_output_tokens: 555,
  stream: false,
  tools: [
    {
      name: 'lookup_artist',
      description: 'Lookup artist',
      input_schema: { type: 'object', properties: { name: { type: 'string' } } },
    },
  ],
});

assert.equal(request.model, 'gpt-5.4');
assert.equal(request.instructions, 'system rule');
assert.equal(request.store, false);
assert.equal(request.stream, true);
assert.equal(request.max_tokens, undefined);
assert.equal(request.max_output_tokens, undefined);
assert.deepEqual(request.input, [
  { role: 'user', content: 'say hi' },
  {
    type: 'function_call',
    call_id: 'toolu_1',
    name: 'lookup_artist',
    arguments: JSON.stringify({ name: 'Adele' }),
  },
  {
    type: 'function_call_output',
    call_id: 'toolu_1',
    output: 'done',
  },
]);
assert.deepEqual(request.tools, [
  {
    type: 'function',
    name: 'lookup_artist',
    description: 'Lookup artist',
    parameters: { type: 'object', properties: { name: { type: 'string' } } },
  },
]);

const response = translateResponsesAPIResponse({
  id: 'resp_test',
  usage: { input_tokens: 12, output_tokens: 34 },
  output: [
    {
      type: 'message',
      content: [{ type: 'output_text', text: 'hello from chatgpt backend' }],
    },
    {
      type: 'function_call',
      call_id: 'toolu_2',
      name: 'lookup_artist',
      arguments: JSON.stringify({ name: 'Adele' }),
    },
  ],
}, 'gpt-5.4');

assert.equal(response.role, 'assistant');
assert.equal(response.model, 'gpt-5.4');
assert.equal(response.stop_reason, 'tool_use');
assert.equal(response.usage.model, 'gpt-5.4');
assert.equal(response.usage.input_tokens, 12);
assert.equal(response.usage.output_tokens, 34);
assert.equal(response.usage.total_input_tokens, 12);
assert.equal(response.usage.total_output_tokens, 34);
assert.equal(response.usage.context_window, 1000000);
assert.equal(response.usage.context_window_size, 1000000);
assert.equal(response.usage.used_percentage, 12 / 1000000 * 100);
assert.deepEqual(response.usage.current_usage, {
  input_tokens: 12,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
});
assert.deepEqual(response.content, [
  { type: 'text', text: 'hello from chatgpt backend' },
  { type: 'tool_use', id: 'toolu_2', name: 'lookup_artist', input: { name: 'Adele' } },
]);

console.log('codex proxy test passed');
