# Testing Requirements

## Minimum Test Coverage: 80%

Test Types (ALL required):
1. **Unit Tests** — Individual functions, utilities, components
2. **Integration Tests** — API endpoints, database operations
3. **E2E Tests** — Test through the real interface of the component under change

## Universal E2E Principle

**Test the real interface. Never mock the system under test.**

E2E does not mean "Playwright only." It means: whatever you built, exercise it through its actual boundary — the same way a real caller would invoke it — using real inputs and asserting on real outputs.

### Component Type → Test Strategy

| Component | Real Interface | How to Test |
|-----------|---------------|-------------|
| CLI / shell script | stdin, argv, exit code | `echo "input" \| ./script`, assert stdout/stderr/exit |
| Hook script (Node.js) | stdin JSON → stdout JSON | `cat payload.json \| node hook.mjs`, assert JSON output |
| HTTP API | HTTP endpoints | Spin up real server, `curl` or test client against actual port |
| Library / module | Public API surface | Call exported functions with real dependencies, no mocks |
| UI / frontend | Browser | Playwright against real dev/test server |
| Background service | Process lifecycle, signals, file I/O | Spawn process, send signals, check output files |
| Database layer | Real DB queries | Run against real or in-process test DB — no query mocks |
| Message queue consumer | Queue messages | Publish to real queue, assert side effects |
| Config / settings file | CLI or env-driven behavior | Change actual env/file, run real process, assert behavior |

### What "No Mock" Means

- OK to mock: **external third-party services** (payment APIs, email providers, external OAuth)
- NOT OK to mock: **the component you just changed** or any internal layer below it
- Integration seam: the test must cross at least one real process/network/file boundary

### Examples

**CLI script (Node.js hook):**
```bash
# Wrong — unit testing internal function
node -e "require('./hook').parseInput({...})"

# Right — test the full script as a process
echo '{"session_id":"abc","cwd":"/tmp","stop_reason":"end_turn"}' \
  | node scripts/auto-confirm.mjs
# Assert: stdout is valid JSON with expected decision field
```

**HTTP API (Express/FastAPI):**
```bash
# Wrong — call handler function directly with mock req/res
handler(mockReq, mockRes)

# Right — spin up server, hit real endpoint
npx ts-node server.ts &
curl -s http://localhost:3000/api/health | jq '.status == "ok"'
```

**Python CLI tool:**
```bash
# Wrong — import and call function
from myapp import process; process(data)

# Right — run as subprocess
echo "test input" | python -m myapp --mode process
assert returncode == 0
```

**Library / module:**
```typescript
// Wrong — mock internal dependencies
jest.mock('./db'); myLib.doThing();

// Right — use real in-memory or test DB
const db = createTestDb();
const result = await myLib.doThing(db, realInput);
expect(result).toMatchSnapshot();
```

## Test-Driven Development

MANDATORY workflow:
1. Write test first (RED) — test MUST fail
2. Run test — it MUST fail
3. Write minimal implementation (GREEN)
4. Run test — it MUST pass
5. Refactor (IMPROVE)
6. Verify coverage 80%+

## Choosing the Right Test Level

Use this decision tree:
1. Does the change touch a user-visible interface? → **E2E test required**
2. Does the change touch a module boundary (exported API)? → **Integration test required**
3. Is it an internal helper with no external callers? → Unit test is sufficient

When in doubt: write the test at the highest level that is still fast enough to run in CI.

## Troubleshooting Test Failures

1. Use **tdd-guide** agent
2. Check test isolation (not test interference)
3. Verify real dependencies are available (DB, file system, network)
4. Fix implementation, not tests (unless tests are wrong)

## Agent Support

- **tdd-guide** — Use PROACTIVELY for new features, enforces write-tests-first
- **qa-tester** — E2E test execution via real interface (not Playwright-only)
