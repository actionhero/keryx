---
description: Type-safe API clients for Keryx — from zero-tooling type imports to generated OpenAPI clients.
---

# Typed Clients

Keryx gives you type-safe API responses out of the box. Every [action](/guide/actions) defines its inputs as a Zod schema and its outputs as the return type of `run()`. The framework exposes `ActionParams<A>` and `ActionResponse<A>` to infer both sides at compile time — and the built-in [Swagger action](/reference/actions) generates a complete OpenAPI 3.0.0 spec from that same metadata.

This page covers three approaches to consuming your API from a TypeScript frontend, from simplest to most powerful.

## Direct Type Imports (Zero Tooling)

If your frontend lives in the same monorepo as your backend, you can import action classes directly and use `ActionResponse<A>` to type your fetch calls. This is what the example app does — no codegen, no build step, no extra dependencies.

Set up a path alias so the frontend can reach backend types:

```json
// frontend/tsconfig.json
{
  "compilerOptions": {
    "paths": {
      "@backend/*": ["../backend/*"]
    }
  }
}
```

Then import the action types and use them with a generic fetch wrapper:

```ts
import type { SessionCreate } from "@backend/actions/session";
import type { UserView } from "@backend/actions/user";
import type { ActionResponse } from "keryx";

const API_URL = "http://localhost:8080";

async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${API_URL}/api${path}`, {
    credentials: "include",
    ...options,
  });
  const payload = await res.json();
  if (payload.error) throw new Error(payload.error.message);
  return payload as T;
}

// Fully typed — hover over `user` and you'll see the exact shape
const { user } = await apiFetch<ActionResponse<UserView>>(`/user/${userId}`);

const { user, session } = await apiFetch<ActionResponse<SessionCreate>>(
  "/session",
  {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  },
);
```

You still construct URLs and pick HTTP methods manually, but the response types are inferred from your action classes. Change a field in the action's `run()` return type and the frontend lights up with type errors immediately.

**When this works well:** Monorepo setups where the frontend and backend share a TypeScript project. Small-to-medium APIs where manually typing a few paths isn't a burden.

**When it doesn't:** Separate repos, non-TypeScript frontends, or large APIs where you want route construction handled for you.

## openapi-typescript + openapi-fetch (Recommended)

For a fully type-safe client that also handles routes, methods, and parameters, use [openapi-typescript](https://openapi-ts.dev/) to generate types from your Swagger spec, then [openapi-fetch](https://openapi-ts.dev/openapi-fetch/) to make typed requests.

Install both:

```bash
bun add -d openapi-typescript
bun add openapi-fetch
```

Generate types from your running server's Swagger endpoint:

```bash
bunx openapi-typescript http://localhost:8080/api/swagger -o src/api-types.d.ts
```

Create a typed client:

```ts
import createClient from "openapi-fetch";
import type { paths } from "./api-types";

const client = createClient<paths>({ baseUrl: "http://localhost:8080/api" });

// Fully typed — route, method, params, and response
const { data, error } = await client.PUT("/user", {
  body: { name: "Evan", email: "evan@example.com", password: "hunter2hunter2" },
});
// data is typed as { user: { id: number, name: string, email: string, ... } }

// Path parameters are type-checked too
const { data: userData } = await client.GET("/user/{user}", {
  params: { path: { user: 42 } },
});

// Query parameters on GET actions
const { data: messages } = await client.GET("/messages/list", {
  params: { query: { limit: 10, offset: 0 } },
});
```

Keryx's Swagger action uses `z.toJSONSchema()` with `io: "input"` to generate request schemas (the pre-transform Zod input, which is what clients actually send) and [ts-morph](https://ts-morph.com/) to generate response schemas from your action's return types. The generated OpenAPI spec includes path parameters, query parameters, request bodies, and response shapes — `openapi-typescript` picks all of this up.

::: tip Automate type generation
Add a script to your `package.json` so types stay fresh:

```json
{
  "scripts": {
    "api:types": "openapi-typescript http://localhost:8080/api/swagger -o src/api-types.d.ts"
  }
}
```

Run it after schema changes, or wire it into your dev server startup.
:::

**When this works well:** Any frontend (same repo or not), any framework (React, Vue, Svelte, vanilla). The generated types are standalone `.d.ts` files with no runtime dependency on your backend code.

## orval (Generated React Query / SWR Hooks)

If your frontend uses React Query or SWR, [orval](https://orval.dev/) generates typed hooks directly from the OpenAPI spec:

```bash
bun add -d orval
```

```ts
// orval.config.ts
export default {
  api: {
    input: "http://localhost:8080/api/swagger",
    output: {
      target: "src/api/generated.ts",
      client: "react-query",
    },
  },
};
```

This generates hooks like `useUserView()`, `useSessionCreate()`, etc., with typed params and responses. See the [orval docs](https://orval.dev/overview) for configuration options.

## Choosing an Approach

| Approach                           | Codegen?      | Route safety? | Best for                |
| ---------------------------------- | ------------- | ------------- | ----------------------- |
| Direct type imports                | None          | Manual        | Monorepo, small API     |
| openapi-typescript + openapi-fetch | Types only    | Yes           | Most projects           |
| orval                              | Types + hooks | Yes           | React Query / SWR users |

All three approaches benefit from Keryx's Swagger output — the more complete your action `inputs` schemas and `run()` return types are, the better the generated types will be.
