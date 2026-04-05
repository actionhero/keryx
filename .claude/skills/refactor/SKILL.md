---
name: refactor
description: |
  Refactor keryx framework or example app code while preserving behavior. Use this skill whenever the user asks to clean up, simplify, extract, inline, rename, reorganize, DRY up, decompose, or refactor code — even if they don't use the word "refactor" explicitly. Also use when moving logic between files, extracting helpers or utilities, splitting large files, or consolidating duplicated patterns.
keywords: [refactor, extract, inline, rename, move, simplify, clean up, decompose, DRY, reorganize, split, consolidate]
---

# Refactoring Workflow

Refactoring means changing code structure without changing behavior. Every step must preserve the existing test suite and public API contracts.

## Phase 1: Understand Before Touching

1. **Read the target code** — understand what it does, who calls it, and what depends on it
2. **Check for tests** — find existing test coverage for the code being refactored
   - Search in `packages/keryx/__tests__/` for framework code
   - Search in `example/backend/__tests__/` for app code
3. **Run the existing tests** to establish a green baseline before making changes:
   ```bash
   cd packages/keryx && bun test        # framework code
   cd example/backend && bun test       # app code
   ```
4. **Check for stale processes** if tests behave unexpectedly:
   ```bash
   ps aux | grep "bun keryx" | grep -v grep
   ```

## Phase 2: Plan the Refactoring

Before writing code, state the plan concisely:
- What structural change you're making and why it improves the code
- Which files will be created, modified, or deleted
- Any import paths that will change
- Whether the public API surface changes (it shouldn't)

If the refactoring is large (touches more than 5 files), break it into incremental steps where tests pass after each step.

## Phase 3: Make Changes

Apply changes incrementally. After each logical step, verify nothing broke.

### Import Conventions (must follow)

- **In `packages/keryx/`** — use relative imports:
  ```typescript
  import { api } from "../api";
  import { Action } from "../classes/Action";
  ```
- **In `example/backend/`** — use `"keryx"` for framework, relative for app-local:
  ```typescript
  import { api, Action, type ActionParams, HTTP_METHOD } from "keryx";
  import { SessionMiddleware } from "../middleware/session";
  ```

### Code Quality Rules

- No `as any` — use `@ts-expect-error` with a comment if the type system can't express something
- JSDoc annotations on any new or modified public APIs in `packages/keryx/`
- Don't add unnecessary abstractions — three similar lines are better than a premature helper
- Don't add comments, docstrings, or type annotations to code you didn't change
- If something is unused after the refactor, delete it completely — no `_unused` renames or `// removed` comments

### When Extracting to New Files

- Follow existing naming conventions in the target directory
- Update any barrel exports (`.index.ts` files) if the directory uses them
- App actions must be re-exported from `example/backend/actions/.index.ts`

### When Renaming

- Use grep to find ALL references before renaming — including tests, config, docs, and string literals
- Update imports across the entire monorepo, not just the immediate directory

## Phase 4: Verify

1. **Run lint**:
   ```bash
   bun lint
   ```
   Fix any issues with `bun format` if needed.

2. **Run tests**:
   ```bash
   cd packages/keryx && bun test        # if framework code changed
   cd example/backend && bun test       # if app code changed
   ```

3. **Sanity check** — review the diff to confirm:
   - No behavior changes snuck in
   - No files were accidentally left behind
   - Import paths are all correct
   - No `as any` was introduced

## Phase 5: Summarize

After completing the refactoring, briefly state:
- What changed structurally
- How many files were modified/created/deleted
- That tests pass

Do NOT provide a lengthy recap of every line changed — the user can read the diff.
