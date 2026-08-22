---
title: About Keryx
description: What Keryx is, who makes it, and why it exists — the fullstack TypeScript framework for MCP and APIs, built on Bun.
---

# About Keryx

**Keryx** is an open-source, MIT-licensed fullstack TypeScript framework for building MCP servers and APIs, built on [Bun](https://bun.sh) and powered by [Zod](https://zod.dev). Its core idea is that an **action** is the universal controller: you write your business logic once as an action class, and Keryx serves it across five transports simultaneously — HTTP endpoints, WebSocket handlers, CLI commands, background tasks, and [Model Context Protocol](https://modelcontextprotocol.io) (MCP) tools for AI agents. The same validation, middleware, authentication, and response shape apply everywhere, so you never maintain five implementations of the same logic.

Keryx is the spiritual successor to [ActionHero](https://www.actionherojs.com), carrying forward the same "actions everywhere" philosophy with a modern, type-safe, Bun-native foundation. It is designed for teams that need their backend to be reachable by both humans and machines: a browser, a terminal, a background worker, and an AI agent can all call the same endpoint, authenticate the same way, and receive the same typed, structured responses and errors.

The name comes from the ancient Greek κῆρυξ ("KEH-rüks"), meaning "herald" or "messenger" — the person who carried proclamations between gods and mortals. It fits: your actions are the message, and Keryx heralds them to every client. Read the [full etymology and brand assets](/guide/about) for more.

## Why it exists

Most backends start as an HTTP framework and then bolt on a WebSocket server, a CLI, a job queue, and — increasingly — an MCP layer. Each addition brings its own handler, validation, and auth. Keryx flips that model: write the controller once and let the framework deliver it everywhere. It is the only TypeScript framework where your API is automatically an MCP server, with built-in OAuth 2.1 + PKCE so AI agents authenticate exactly like browser clients do.

## Who makes Keryx

Keryx is created and maintained by **Evan Tahler** and a community of open-source contributors. It is developed in the open on GitHub and shares its community with ActionHero.

- **Source** — [github.com/actionhero/keryx](https://github.com/actionhero/keryx)
- **Discussions** — [github.com/actionhero/keryx/discussions](https://github.com/actionhero/keryx/discussions)
- **Community Slack** — [actionherojs.slack.com](https://slack.actionherojs.com)
- **npm** — [keryx](https://www.npmjs.com/package/keryx)

## Learn more

- [Getting Started](/guide/) — install Keryx and build your first action
- [About Keryx (name, philosophy, brand assets)](/guide/about)
- [Building for AI Agents](/guide/agents) — the MCP-native workflow
- [Developer Portal](/developers) — API reference, sandbox, and auth
- [Contact](/contact) · [Privacy](/privacy)
