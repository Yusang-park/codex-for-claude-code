#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempHome = mkdtempSync(join(tmpdir(), 'codex-adapter-home-'));
mkdirSync(join(tempHome, '.codex'), { recursive: true });
writeFileSync(
  join(tempHome, '.codex', 'auth.json'),
  JSON.stringify({
    tokens: {
      access_token: 'oauth-token',
      account_id: 'acct-456',
    },
  }),
);

process.env.HOME = tempHome;
process.env.CHATGPT_API_BASE = 'https://chatgpt.example/backend-api/codex';

const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({
    url,
    headers: init?.headers,
    body: JSON.parse(String(init?.body ?? '{}')),
  });
  return {
    ok: true,
    async json() {
      return {
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'adapter ok' }],
          },
        ],
      };
    },
  };
};

const { runCodex } = await import('../src/adapters/codex.ts');
const result = await runCodex('say hi', process.cwd(), 'gpt-5.4');

assert.equal(result, 'adapter ok');
assert.equal(calls.length, 1);
assert.equal(calls[0].url, 'https://chatgpt.example/backend-api/codex/responses');
assert.equal(calls[0].headers.Authorization, 'Bearer oauth-token');
assert.equal(calls[0].headers['ChatGPT-Account-ID'], 'acct-456');
assert.deepEqual(calls[0].body, {
  model: 'gpt-5.4',
  input: [{ role: 'user', content: 'say hi' }],
  store: false,
});

console.log('codex adapter test passed');
