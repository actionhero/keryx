---
description: Action class definition, transport behavior across HTTP/WebSocket/CLI/tasks, type helpers, and middleware.
---

# Action

Source: `packages/keryx/classes/Action.ts`

The `Action` class is the foundation of Keryx. Every controller — whether it handles HTTP, WebSocket, CLI, or background tasks — is an action. You write the logic once, and the framework handles the transport plumbing.

## Class Definition

```ts
abstract class Action {
  /** Unique identifier, e.g. "user:create" */
  name: string;

  /** Human-readable description — shows up in CLI --help and Swagger */
  description?: string;

  /** Zod schema for input validation */
  inputs?: z.ZodType<any>;

  /** Middleware to run before/after this action */
  middleware?: ActionMiddleware[];

  /** MCP exposure config — tool, resource, and/or prompt (default: { tool: true }) */
  mcp?: McpActionConfig;

  /** HTTP routing — route can be a string with :params or a RegExp */
  web?: {
    route: RegExp | string;
    method: HTTP_METHOD;
    streaming?: boolean;
  };

  /** Per-action timeout in ms (overrides config.actions.timeout; 0 disables) */
  timeout?: number;

  /** Background task config — queue is required, frequency makes it recurring */
  task?: {
    frequency?: number;
    queue: string;
  };

  /**
   * The handler. Return data to send to the client.
   * Return a Response object for raw HTTP passthrough (skips JSON serialization).
   * Throw TypedError for error responses.
   * abortSignal is fired when the action timeout elapses.
   */
  abstract run(
    params: ActionParams<Action>,
    connection?: Connection,
    abortSignal?: AbortSignal,
  ): Promise<any>;
}
```

## How Actions Work Across Transports

This is the core idea. You define an action once — its name, inputs, and `run()` method — and the framework routes it through every transport automatically. The same Zod validation, the same middleware chain, the same `run()` method, the same response shape. The only thing that changes is how the request arrives and how the response is delivered.

Here's what a single action looks like from each transport:

### HTTP

Add a `web` property to expose an action as an HTTP endpoint. The web server matches incoming requests by route and method, extracts params from the URL path, query string, and request body, validates them against the Zod schema, and calls `run()`.

```ts
export class UserCreate implements Action {
  name = "user:create";
  web = { route: "/user", method: HTTP_METHOD.PUT };
  inputs = z.object({
    name: z.string().min(3),
    email: z.string().email(),
    password: secret(z.string().min(8)),
  });

  async run(params: ActionParams<UserCreate>) {
    // ...
    return { user: serializeUser(user) };
  }
}
```

```bash
curl -X PUT http://localhost:8080/api/user \
  -H "Content-Type: application/json" \
  -d '{"name":"Evan","email":"evan@example.com","password":"secret123"}'
# → { "user": { "id": 1, "name": "Evan", ... } }
```

Params are loaded in this order (later sources override earlier ones): path params → URL query params → request body. Routes support `:param` path parameters (`/user/:id`) and RegExp patterns.

If `run()` returns a `Response` object, the framework passes it through directly — no JSON serialization, no Keryx headers. See [Raw Response Passthrough](/guide/actions#raw-response-passthrough) for details and examples.

### WebSocket

WebSocket clients send JSON messages with `messageType: "action"`, the action name, and params. The server finds the matching action, validates params through the same Zod schema, and sends the response back over the socket.

```json
// Client sends:
{
  "messageType": "action",
  "action": "user:create",
  "messageId": "abc-123",
  "params": {
    "name": "Evan",
    "email": "evan@example.com",
    "password": "secret123"
  }
}

// Server responds:
{
  "messageId": "abc-123",
  "response": { "user": { "id": 1, "name": "Evan" } }
}
```

The `messageId` is echoed back so the client can match responses to requests. WebSocket connections are long-lived — they maintain session state and can subscribe to [channels](/guide/channels) for real-time PubSub.

### CLI

Every action is automatically registered as a CLI command via [Commander](https://github.com/tj/commander.js). The Zod schema's field names become `--flags`, descriptions become help text, and required vs optional fields are enforced.

```bash
./keryx.ts "user:create" \
  --name Evan \
  --email evan@example.com \
  --password secret123 \
  -q | jq

# → { "response": { "user": { "id": 1, "name": "Evan", ... } } }
```

The `-q` flag suppresses server logs so you get clean JSON output. Use `--help` on any action to see its params:

```bash
./keryx.ts "user:create" --help
```

The server boots in `CLI` mode — initializers that don't apply (like the web server) are skipped based on their `runModes` setting.

### Background Tasks

Add a `task` property to schedule an action as a background job. The Resque worker calls `run()` with the same params and validation — the action doesn't know or care whether it was triggered by HTTP, a cron schedule, or a fan-out parent.

```ts
export class MessagesCleanup implements Action {
  name = "messages:cleanup";
  task = { queue: "default", frequency: 1000 * 60 * 60 }; // hourly
  inputs = z.object({
    age: z.coerce.number().default(1000 * 60 * 60 * 24),
  });

  async run(params: ActionParams<MessagesCleanup>) {
    // same run() — called by the task worker, not by HTTP
    return { messagesDeleted: deleted.length };
  }
}
```

See [Tasks](/guide/tasks) for fan-out patterns and queue configuration.

## HTTP_METHOD

```ts
enum HTTP_METHOD {
  GET = "GET",
  POST = "POST",
  PUT = "PUT",
  DELETE = "DELETE",
  PATCH = "PATCH",
  OPTIONS = "OPTIONS",
}
```

## Type Helpers

These two types are used throughout the codebase — in actions, tests, ops, and on the frontend:

```ts
/** Infers the validated input type from an action's Zod schema */
type ActionParams<A extends Action> =
  A["inputs"] extends z.ZodType<any>
    ? z.infer<A["inputs"]>
    : Record<string, unknown>;

/** Infers the return type of an action's run() method */
type ActionResponse<A extends Action> = Awaited<ReturnType<A["run"]>> &
  Partial<{ error?: TypedError }>;
```

`ActionResponse` includes an optional `error` field because the framework catches `TypedError` throws and adds them to the response automatically. The frontend imports `ActionResponse<MyAction>` to get type-safe API responses without any code generation step.

## ActionMiddleware

Middleware intercepts action execution. Both methods are optional — you can have auth-only middleware (just `runBefore`) or logging-only middleware (just `runAfter`):

```ts
type ActionMiddleware = {
  runBefore?: (
    params: ActionParams<Action>,
    connection: Connection,
  ) => Promise<ActionMiddlewareResponse | void>;
  runAfter?: (
    params: ActionParams<Action>,
    connection: Connection,
    error?: TypedError,
  ) => Promise<ActionMiddlewareResponse | void>;
};

type ActionMiddlewareResponse = {
  /** Replace the params before the action runs */
  updatedParams?: ActionParams<Action>;
  /** Replace the response after the action runs */
  updatedResponse?: any;
};
```

Throw from `runBefore` to halt execution — the action's `run()` method won't be called. `runAfter` always executes (even when the action throws) and receives the error as an optional third parameter — useful for cleanup like rolling back a transaction. Return `updatedParams` or `updatedResponse` to modify the data flowing through the pipeline.

Middleware runs in the same order regardless of transport. HTTP, WebSocket, CLI, tasks — same middleware chain, same behavior.
