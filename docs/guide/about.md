---
description: Etymology of the name, why Keryx treats MCP as a first-class transport, brand assets, and community links.
---

# About Keryx

## The Name

**Keryx** (κῆρυξ, pronounced "KEH-rüks") is ancient Greek for "herald" or "messenger" — the person who carried proclamations between gods and mortals, announced the start of games, and ensured safe passage for diplomats. In Athenian democracy, the keryx was essential: no assembly could begin without one.

It fits: your [actions](/guide/actions) are the message, and Keryx delivers them across every transport — HTTP, WebSocket, CLI, background tasks, and MCP. Write your controller once, and Keryx heralds it to every client — whether that's a browser, a terminal, a background worker, or an AI agent.

Read more on [Britannica](https://www.britannica.com/topic/keryx) or [Wikipedia (Kerykes)](https://en.wikipedia.org/wiki/Kerykes).

## Why MCP?

The [Model Context Protocol](https://modelcontextprotocol.io) (MCP) is the open standard for connecting AI agents to tools and data. Anthropic, OpenAI, and Google have all adopted it — it's becoming the universal interface between LLMs and backend services.

Most frameworks treat MCP as an afterthought: bolt on a separate MCP server, duplicate your route handlers as tool definitions, manage a second auth layer. Keryx treats MCP as a first-class transport. Every action you write is automatically available as an MCP tool — same validation, same [middleware](/guide/middleware), same auth — with built-in OAuth 2.1 so AI agents authenticate the same way browser clients do.

What that means in practice:

- **Zero-config tool registration** — write an action, it's an MCP tool. No separate definitions.
- **OAuth 2.1 + PKCE** — agents authenticate like browser clients. One auth layer.
- **Per-session MCP servers** — each agent gets isolated state.
- **Typed errors** — agents get structured `ErrorType` values, not generic failures.
- **Real-time notifications** — PubSub events forwarded as MCP logging messages.
- **Dynamic OAuth forms** — login pages generated from your Zod schemas.

Claude Desktop, VS Code Copilot, Cursor, Windsurf, and any other MCP client can discover and call your actions out of the box. See the [Building for AI Agents](/guide/agents) guide for a walkthrough.

## Brand Assets

### Images

All images are SVGs and can be used at any size.

| Asset              | Preview                                            | Download                                       |
| ------------------ | -------------------------------------------------- | ---------------------------------------------- |
| Herald (full logo) | <img src="/images/hearald.svg" width="80" />       | [hearald.svg](/images/hearald.svg)             |
| Horn (icon)        | <img src="/images/horn.svg" width="80" />          | [horn.svg](/images/horn.svg)                   |
| Lion standing      | <img src="/images/lion-standing.svg" width="80" /> | [lion-standing.svg](/images/lion-standing.svg) |
| Lion sitting       | <img src="/images/lion-sitting.svg" width="80" />  | [lion-sitting.svg](/images/lion-sitting.svg)   |

### Color Palette

```css
/* Brand colors */
--keryx-gold: #b8701e;
--keryx-gold-light: #cf8128;
--keryx-gold-dark: #9a5e18;
--keryx-rust: #bb5533;

/* Dark mode variants */
--keryx-gold-dm: #e0a04a;
--keryx-gold-light-dm: #eab56e;
--keryx-rust-dm: #d4795e;

/* Soft / background accent */
--keryx-gold-soft: rgba(207, 129, 40, 0.14);
--keryx-gold-soft-dm: rgba(224, 160, 74, 0.14);
```

## Author

Keryx is a project by **Evan Tahler** ([@evantahler](https://twitter.com/evantahler) on Twitter, [@evantahler](https://github.com/evantahler) on GitHub).

## Community

Keryx is the spiritual successor to [ActionHero](https://www.actionherojs.com), and we share the same community. Join us on Slack to ask questions, share what you're building, or just say hello.

- **Discussions** — [github.com/actionhero/keryx/discussions](https://github.com/actionhero/keryx/discussions)
- **Slack** — [actionherojs.slack.com](https://slack.actionherojs.com)
- **GitHub** — [github.com/actionhero/keryx](https://github.com/actionhero/keryx)
