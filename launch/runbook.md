# Launch-day runbook

Pre-launch + launch-day playbook for the Keryx Product Hunt launch.

## Pick the launch day

- **Best days:** Tuesday, Wednesday, Thursday. Avoid Mondays (overcrowded PH feed) and Fridays (low traffic).
- **Avoid:** US holidays, the week of a major OpenAI / Anthropic announcement (the "MCP" hook gets buried in their news cycle), the week before / after major dev conferences.
- **Launch time:** 12:01 AM Pacific. The PH day starts at midnight PT and the algorithm front-loads — being live for the full 24 hours is the difference between top 5 and top 20.

## T-7 days: pre-launch page

- Set up the [PH "coming soon" page](https://www.producthunt.com/posts/new) at least a week ahead.
- Fill in: name, tagline, gallery thumbnail (`producthunt-thumbnail.png`), short description, link to keryxjs.com.
- The "coming soon" page collects email signups that auto-fire a notification the moment the listing goes live. Free upvote multiplier.
- Share the coming-soon link in: personal Slack, Bun discord (if you participate), a tweet, LinkedIn post. Don't ask for upvotes — ask for "notify me when it's live."

## T-3 days: warm the network

- Personal DMs / texts to 20–30 people in your dev-tools network. Specific people, not a blast list. Script: *"I'm launching Keryx on Product Hunt Tuesday. Would mean a lot if you took a look and left a comment if you have a take. No need to upvote unless you actually like it."*
- Why a comment, not just an upvote: PH's algorithm weighs comment engagement more than raw upvotes, and a real comment about *what's interesting* signals organic discussion to subsequent visitors.
- People to prioritize: framework / runtime maintainers (Bun, Drizzle, Zod authors), MCP early adopters, ActionHero alumni, anyone who's publicly shipped an MCP server in the last 6 months.

## T-1 day: final checks

- [ ] All 4 gallery PNGs render correctly when uploaded to PH preview
- [ ] Tagline pasted into PH form (`launch/tagline.md`)
- [ ] Description pasted (`launch/description.md`)
- [ ] Topics selected (`launch/topics.md`)
- [ ] Maker comment ready to paste the moment the listing goes live (`launch/maker-comment.md`)
- [ ] Keryx repo: `main` is green, latest published version on npm matches what the docs claim
- [ ] keryxjs.com: working, no broken links, the OpenGraph image renders (PH sometimes hot-links it for previews)
- [ ] `bunx keryx new test-app` from a fresh shell works (the quickstart MUST work — first thing visitors will try)
- [ ] Twitter / LinkedIn drafts staged in Buffer or similar (see *Cross-posts* below)

## Launch morning

### 12:01 AM PT — go live

- Hit "Submit" on PH.
- Within 60 seconds: paste the maker comment from `launch/maker-comment.md` as the first comment.
- Tweet from `@evantahler`: *"Keryx is live on Product Hunt. [link]"* — short, no marketing language. The thread can have more detail if you want.

### First hour (12:01 – 1:00 AM PT)

This hour decides where you finish on the day. PH's algorithm weighs the first hour's engagement disproportionately.

- Send a personal DM to your warmed list — *"Live now: [link]"*. Three lines max. No "would love your support" pleading. Just the link.
- Reply to every comment within 5 minutes. Even short comments. Engagement signals matter.
- Pin the maker comment if PH lets you.
- DO NOT post in any public channel asking for upvotes. PH actively deboosts listings caught doing this.

### Rest of the day

- Stay on the listing page in a browser tab. Refresh every 15 min for new comments.
- Reply to every comment, no exceptions.
- Around 9 AM PT: post on LinkedIn (US dev audience is at desks).
- Around 12 PM PT: a second tweet — usually a screenshot of a specific gallery slot with a one-line explanation. Different angle than the morning post.
- Around 3 PM PT: if a specific gallery slot is getting comments (e.g. Claude Desktop screenshot drawing questions), tweet that screenshot directly with context.
- Around 6 PM PT: a final tweet thanking commenters by handle.

### Don't

- Don't post in Slack or Discord asking for upvotes (PH deboosts).
- Don't reply to negative comments defensively. Acknowledge the point, link to docs or repo if relevant, move on.
- Don't post on Hacker News the same day. Two top-of-page launches split your attention and your audience. Save HN for the following Tuesday (see *Cross-posts* below).
- Don't refresh PH's leaderboard obsessively — it spikes your blood pressure for no useful information.

## Comment-response templates

Real responses from you will outperform any template, but here are scaffolds for common patterns.

### "How is this different from [X]?" (Elysia, Hono, NestJS, tRPC, etc.)

> Good question. The short version: most TypeScript frameworks today either focus on HTTP (Elysia, Hono) or on RPC-style type sharing (tRPC). Keryx's pitch is that the *same* action class also serves WebSocket, CLI, background tasks, and MCP tools — without rewriting the validation, middleware, or response shape for each transport.
>
> If you only need HTTP, [X] is probably the lighter pick. If you're shipping an MCP server, the duplication-vs-Keryx tradeoff is the whole point.

### "Why Bun and not Node?"

> Two reasons. (1) Native TypeScript with no build step — the dev loop is faster, and there's no transpiler config to maintain. (2) Bun ships `fetch`, a fast test runner, and a packager out of the box — half the framework code you'd otherwise write is just there.
>
> Keryx could theoretically run on Node, but starting from Bun let me delete a lot of code that exists in older frameworks just to paper over Node's gaps.

### "Where do I host this in production?"

> Anywhere that runs a Bun process. We ship a `Dockerfile` for the example app and a `docker-compose.yml` showing how the pieces (backend + Postgres + Redis + frontend) fit together. Beyond that: Fly.io, Railway, Render, your own VM — all work. The framework doesn't require a specific host.

### "Is this production-ready?"

> v0.30, so pre-1.0 — but I'm running it in production myself. The example app is a working Slack-like chat (channels, files, sessions, real-time PubSub). The API surface is stable; what's changing pre-1.0 is mostly internals and ergonomics.

### Generic enthusiasm ("nice work", "looks cool")

Short, specific, in-your-voice. *"Thanks! What part of the API are you most likely to hit first?"* Asking a question keeps the thread alive, which the algorithm weighs.

### Negative ("yet another framework", "MCP is overhyped")

Acknowledge, redirect to the duplication argument, don't argue.

> Fair — the framework space is crowded. The duplication problem with MCP servers isn't unique to me, though; if you've shipped one alongside an existing REST API, the divergence between schemas / auth / errors is real. Keryx is one answer to that, not the only one.

## Cross-posts

### X / Twitter — morning thread (12:01 AM PT)

Three posts in a thread:

1. *"Keryx is live on Product Hunt. [link]"*
2. Code screenshot of the `UserCreate` action with the caption: *"One class. HTTP, WebSocket, CLI, background tasks, MCP tool. Same Zod schema, same middleware."*
3. *"The thing I actually built this for: MCP and OAuth 2.1 are built in. Your API is automatically an MCP server — Claude Desktop discovers and calls every action. No bridge, no second server."* + the slot 3 Claude Desktop screenshot.

### LinkedIn — 9 AM PT

One post, ~200 words. Same hook as the maker comment but tuned for the LinkedIn dev-tools audience (which skews older, more conservative, more impressed by "production-grade").

> If you've shipped an MCP server next to an existing REST API in the last year, you've probably noticed you're writing the same controller twice. Different schemas, different auth, different error shapes. They drift.
>
> Keryx is a TypeScript framework I've been building on Bun where one action class is your HTTP endpoint, your WebSocket handler, your CLI command, your background task, and your MCP tool. Same Zod inputs. Same middleware. Same response type. The transport just changes.
>
> Going live on Product Hunt today — would love thoughts from anyone who's hit the MCP-duplication wall: [link]

### Hacker News — *the following Tuesday* (T+7), 9 AM ET as a "Show HN"

> Show HN: Keryx — a TypeScript framework where every API action is also an MCP tool
>
> [link to keryxjs.com]

Body of the post: a tighter version of the maker comment, but adjusted for HN's voice — less marketing, more "here's what I built and why."

> Hi HN. I've been building Keryx for the last several months, and it just went live on Product Hunt last week. It's a TypeScript framework on Bun where one action class becomes your HTTP endpoint, your WebSocket handler, your CLI command, your background task, and your MCP tool — all from the same Zod schema and middleware chain.
>
> The thing I actually wanted from this was: if you've shipped an MCP server alongside an existing REST API, you've noticed you're writing the controller twice. Keryx is one answer to that. The "your API is automatically an MCP server" part is the differentiator — agents authenticate via built-in OAuth 2.1, get typed errors, and call the same validated endpoints your HTTP clients use.
>
> Spiritual successor to ActionHero (which I started in 2013), ground-up rewrite on Bun, Zod, Drizzle. v0.30, pre-1.0 but real — I'm running it in production.
>
> Happy to answer questions.

Why HN on T+7 instead of launch day: launching simultaneously splits your attention and your audience. HN engagement will be different (more skeptical, more technical questions) and you want a clean day for it.

## Post-launch (T+1)

- Reply to any comments that came in overnight.
- Screenshot the final PH ranking for the day. Tweet it: *"Made it to #X today on PH. Thanks to everyone who tried it and left feedback."*
- Compile commenter handles for a thank-you list (helps future launches).
- If a critique surfaced twice in comments, file it as a GitHub issue with the `launch-feedback` label.

## Useful links

- Product Hunt: https://www.producthunt.com
- PH submission form: https://www.producthunt.com/posts/new
- Keryx docs: https://keryxjs.com
- Keryx repo: https://github.com/actionhero/keryx
