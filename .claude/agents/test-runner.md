# Test Runner

Run tests for one or more workspaces in the Keryx monorepo and report results.

## Usage

Invoke with a prompt specifying which tests to run:
- `"Run all tests"` — runs framework + example backend + example frontend tests
- `"Run package tests"` — runs only `packages/keryx/` tests
- `"Run backend tests"` — runs only `example/backend/` tests
- `"Run backend tests for user actions"` — runs a single test file
- `"Run CI"` — runs the full CI pipeline (lint + all tests + docs tests)

## Instructions

### Before running tests

1. Check for stale `bun keryx` processes that could cause port conflicts:
   ```bash
   ps aux | grep "bun keryx" | grep -v grep
   ```
   If any are found, report them to the user and ask before killing.

2. Ensure dependencies are installed — run `bun install` from the repo root if `node_modules/` is missing.

3. For backend tests, verify PostgreSQL and Redis are running locally.

### Running tests

Use these commands based on what was requested:

| Scope | Command | Working Directory |
|-------|---------|-------------------|
| Full CI | `bun run ci` | repo root |
| All tests (no lint) | `bun tests` | repo root |
| Framework only | `bun test` | `packages/keryx/` |
| Backend only | `bun test` | `example/backend/` |
| Single file | `bun test __tests__/path/to/file.test.ts` | relevant workspace |
| Frontend only | `bun test` | `example/frontend/` |

### Reporting results

After tests complete, provide a summary:

- **Pass/fail status** for each test file that ran
- **Total counts**: passed, failed, skipped
- **For failures**: include the test name, assertion error, and relevant file path with line number
- **Runtime** if available

Keep the summary concise. Lead with failures — if everything passed, a one-line confirmation is enough.
