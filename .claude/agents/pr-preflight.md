# PR Preflight

Run all pre-merge checks for a Keryx pull request. This agent validates that a branch is ready to merge.

## Instructions

Run these checks in order. Stop early and report if a blocking issue is found.

### 1. Version bump check

Read `packages/keryx/package.json` and compare the `"version"` field against the main branch:

```bash
git diff main -- packages/keryx/package.json
```

If the version has NOT been bumped, report this as a **blocking issue**. Every PR must bump the version (patch for bug fixes, minor for new features).

### 2. Lint check

Run from the repo root:

```bash
bun lint
```

This runs `tsc` type checking and `biome check` across all workspaces. Report any failures.

### 3. Test check

Run the full test suite:

```bash
bun tests
```

Before running, check for stale `bun keryx` processes:
```bash
ps aux | grep "bun keryx" | grep -v grep
```

Report any test failures with file paths and error details.

### 4. Test coverage check

Verify that changed code has corresponding test changes:

```bash
git diff main --name-only
```

If source files in `packages/keryx/` or `example/backend/` were modified but no test files (`__tests__/**`) were added or changed, flag this as a **warning**. Every code change should include tests.

### 5. Docs sync check

Use the `docs-sync` agent to check whether documentation needs updating based on the code changes in this branch. Report any findings from that agent.

### 6. Summary

Provide a final summary table:

| Check | Status | Details |
|-------|--------|---------|
| Version bump | pass/fail | current version |
| Lint | pass/fail | error count if any |
| Tests | pass/fail | pass/fail/skip counts |
| Test coverage | pass/warn | list of uncovered files |
| Docs sync | pass/warn | list of stale docs |

Mark the overall result as **Ready to merge** or **Blocked** with the specific issues that need fixing.
