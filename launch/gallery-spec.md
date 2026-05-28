# Gallery spec

PH supports up to 5 media items in the gallery. First slot is the thumbnail; it does ~80% of the work.

All slots are 1270×760 PNG, dark background, matching visual language (Inter + JetBrains Mono, horn logo top-left, "keryxjs.com" top-right, footer stack line).

## Slot 1 — Thumbnail: One action. Every transport.

**Status:** Done.
**Files:** `producthunt-thumbnail.svg`, `producthunt-thumbnail.png`

Headline: *One action. Every transport.*
Subhead: *The TypeScript framework where your API is also your MCP server.*

Code block on the left showing a single `UserCreate` action class. Five arrows fanning out to five transport pills on the right: HTTP / WebSocket / CLI / Task / MCP tool. The MCP pill is visually emphasized (blue border, blue accent text on "+ OAuth 2.1") since that's the differentiator.

## Slot 2 — Quickstart: From zero to MCP server in 248ms.

**Status:** Done.
**Files:** `producthunt-slot2-quickstart.svg`, `producthunt-slot2-quickstart.png`

Headline: *From zero to MCP server in 248ms.*
Subhead: *Five commands. HTTP, WebSocket, MCP, background tasks, and a Postgres-backed API.*

Single full-width terminal mockup showing `bunx keryx new my-app` → `cd && cp .env` → `bun install` → `bun dev` → the dev-server output listing all the URLs (HTTP, WebSocket, MCP, OpenAPI, Workers, Database). URLs render in blue to look clickable.

## Slot 3 — Claude Desktop calling MCP

**Status:** Done.
**Files:** `producthunt-slot3-claude.svg`, `producthunt-slot3-claude.png`, `screenshot-claude-desktop.png` (source)

Headline: *Claude calls your API directly.*
Subhead: *Add Keryx to Claude Desktop. Every action becomes an MCP tool with OAuth 2.1.*

Real Claude Desktop screenshot on the left showing two tool calls in one turn (status check + message creation, with "Loaded tools, used keryx-local integration" badges visible). Four annotation bullets on the right: Discovered, OAuth 2.1, Read AND write, No second server.

## Slot 4 — Typed frontend

**Status:** Done.
**Files:** `producthunt-slot4-types.svg`, `producthunt-slot4-types.png`, `screenshot-frontend-types.png` (source)

Headline: *Typed end-to-end. No codegen.*
Subhead: *Your backend action becomes the frontend type. Hover any response — the shape is there.*

Side-by-side screenshot of `message.ts` (backend `MessagesList` action) and `ChatPage.tsx` (frontend), with a VS Code tooltip showing the inferred `Message` type via `ActionResponse<MessagesList>["messages"][number]`. Four annotation bullets on the right: Backend is the source, No generated client, ActionResponse&lt;T&gt;, Refactor-safe.

## Slot 5 — Demo gif (optional)

**Status:** Open. Skip for first launch if pressed for time.

Idea: 20–30 second loop showing the full quickstart — `bunx keryx new` → `bun dev` → `curl` hitting the new action → same action being called from Claude Desktop. Loom or gif format. If gif, keep under 5MB.

PH supports MP4 / Loom embeds, which look better than gifs in the gallery.
