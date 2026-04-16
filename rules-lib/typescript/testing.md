---
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
  - "**/*.mjs"
  - "**/*.cjs"
---
# TypeScript/JavaScript Testing

> This file extends [common/testing.md](../common/testing.md) with TypeScript/JavaScript specific content.

## E2E by Component Type

Apply the universal E2E principle from [common/testing.md](../common/testing.md). Choose the strategy matching what you built:

### Frontend / UI
Use **Playwright** against a real dev or test server:
```bash
npx playwright test e2e/my-feature.spec.ts
```

### CLI / bin scripts
Run as a real process with real args:
```bash
node bin/cli.js --flag value
# Assert: exit code, stdout, stderr
```

### Hook scripts (stdin → stdout)
Pipe realistic JSON payloads, assert JSON output:
```bash
echo '{"session_id":"abc","cwd":"/tmp","stop_reason":"end_turn"}' \
  | node scripts/my-hook.mjs
# Assert: output is valid JSON with expected fields
```

### HTTP API (Express / Fastify / Hono)
Spin up the real server, hit real endpoints:
```typescript
// Use supertest or native fetch against real server
import request from 'supertest';
import { app } from '../src/app';

test('POST /api/items creates item', async () => {
  const res = await request(app).post('/api/items').send({ name: 'test' });
  expect(res.status).toBe(201);
  expect(res.body.id).toBeDefined();
});
```

### Library / utility module
Call the real exported API with real dependencies:
```typescript
// Wrong: mock the module under test
// Right: use real in-memory or test dependencies
import { processData } from '../src/lib/processor';
import { createTestDb } from './helpers/db';

test('processData writes result to db', async () => {
  const db = createTestDb();
  await processData(realInput, db);
  expect(await db.query('SELECT * FROM results')).toHaveLength(1);
});
```

## Test Frameworks

- **Unit / Integration**: Jest or Vitest
- **E2E (frontend)**: Playwright
- **E2E (API/CLI/hooks)**: Node.js child_process + assert, or supertest

## Coverage

```bash
# Jest
npx jest --coverage

# Vitest
npx vitest run --coverage
```

Minimum: **80% coverage**

## Agent Support

- **tdd-guide** — Enforces write-tests-first for all component types
- **qa-tester** — E2E execution across all interfaces (not Playwright-only)
