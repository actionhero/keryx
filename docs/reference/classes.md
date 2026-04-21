---
description: API singleton, Connection, Channel, Server, TypedError, and Logger class definitions.
---

# Other Classes

The remaining framework classes — the API singleton, connections, channels, servers, errors, and logging.

## API

Source: `packages/keryx/classes/API.ts`

The global singleton that manages the full server lifecycle. Stored on `globalThis` so it's accessible everywhere. Initializers attach their namespaces to it during boot.

```ts
class API {
  rootDir: string;
  initialized: boolean;
  started: boolean;
  stopped: boolean;
  bootTime: number;
  logger: Logger;
  runMode: RUN_MODE;
  initializers: Initializer[];

  /** Run all initializers in topological order (dependencies first) */
  async initialize(): Promise<void>;

  /** Start all initializers in topological order (dependencies first) */
  async start(runMode?: RUN_MODE): Promise<void>;

  /** Stop all initializers in reverse topological order (dependents first) */
  async stop(): Promise<void>;

  /** Stop then start */
  async restart(): Promise<void>;

  // Initializer namespaces are added dynamically:
  // api.db, api.redis, api.actions, api.session, etc.
  [key: string]: any;
}
```

The lifecycle is `initialize() → start() → [running] → stop()`. Calling `start()` automatically calls `initialize()` first if it hasn't been called yet.

## Connection

Source: `packages/keryx/classes/Connection.ts`

Represents a client connection — HTTP request, WebSocket, or CLI invocation. The connection handles action execution, session management, and channel subscriptions.

```ts
class Connection<
  T extends Record<string, any> = Record<string, any>,
  TMeta extends Record<string, any> = Record<string, any>,
> {
  /** Connection type: "web", "websocket", "cli" */
  type: string;

  /** Client identifier (IP, socket ID, etc.) */
  identifier: string;

  /** Unique connection ID (UUID) */
  id: string;

  /** Session ID for Redis lookup (defaults to `id`) */
  sessionId: string;

  /** Session data, typed with your session shape */
  session?: SessionData<T>;

  /** Channels this connection is subscribed to */
  subscriptions: Set<string>;

  /** The underlying transport object (Bun Request, WebSocket, etc.) */
  rawConnection?: any;

  /** Request correlation ID for distributed tracing */
  correlationId?: string;

  /** App-defined request-scoped metadata. Reset on each act() call. */
  metadata: Partial<TMeta>;

  /** Execute an action with the given params */
  async act(
    actionName: string | undefined,
    params: Record<string, unknown>,
    method?: string,
    url?: string,
  ): Promise<{ response: Object; error?: TypedError }>;

  /** Update session data (merges with existing) */
  async updateSession(data: Partial<T>): Promise<void>;

  /** Subscribe to a PubSub channel */
  subscribe(channel: string): void;

  /** Unsubscribe from a PubSub channel */
  unsubscribe(channel: string): void;

  /** Broadcast a message to a subscribed channel */
  async broadcast(channel: string, message: string): Promise<void>;

  /** Remove this connection from the connection pool */
  destroy(): void;
}
```

The generic `T` parameter types your session data. For example, `Connection<{ userId: number }>` gives you typed access to `connection.session.data.userId`.

The generic `TMeta` parameter types request-scoped metadata that middleware and actions share within a single `act()` call. It's reset to `{}` at the start of each invocation, so long-lived connections (like WebSockets) don't leak state between actions. See the [Middleware guide](/guide/middleware#passing-data-between-middleware-and-actions) for usage examples.

## Channel

Source: `packages/keryx/classes/Channel.ts`

Defines a PubSub topic for WebSocket real-time messaging. Channels support exact-match names or RegExp patterns.

```ts
abstract class Channel {
  /** String for exact match, RegExp for pattern matching */
  name: string | RegExp;

  description?: string;

  /** Middleware for subscribe/unsubscribe lifecycle */
  middleware: ChannelMiddleware[];

  /** Check if this channel definition matches a requested channel name */
  matches(channelName: string): boolean;

  /** Override for custom authorization logic. Throw TypedError to deny. */
  async authorize(channelName: string, connection: Connection): Promise<void>;

  /** Returns the presence identifier for a connection. Override to use e.g. user ID. Defaults to connection.id. */
  async presenceKey(connection: Connection): Promise<string>;
}
```

### ChannelMiddleware

```ts
type ChannelMiddleware = {
  /** Runs before subscribe — throw TypedError to deny */
  runBefore?: (channel: string, connection: Connection) => Promise<void>;

  /** Runs after unsubscribe — cleanup, presence tracking, etc. */
  runAfter?: (channel: string, connection: Connection) => Promise<void>;
};
```

## Server

Source: `packages/keryx/classes/Server.ts`

Base class for transport servers. The framework ships with a web server (`Bun.serve` for HTTP + WebSocket), a CLI entry point, and an MCP server for AI agents. You could add others (gRPC, raw TCP, etc.) by extending the `Server` base class.

```ts
abstract class Server<T> {
  name: string;

  /** The underlying server object (e.g., Bun.Server) */
  server?: T;

  constructor(name: string);

  abstract initialize(): Promise<void>;
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
}
```

## TypedError

Source: `packages/keryx/classes/TypedError.ts`

All action errors should use `TypedError` instead of generic `Error`. Each error type maps to an HTTP status code, so the framework knows what status to return to the client.

```ts
class TypedError extends Error {
  type: ErrorType;
  key?: string; // which param caused the error
  value?: any; // what value was invalid

  constructor(args: {
    message: string;
    type: ErrorType;
    cause?: unknown; // underlying error being wrapped (ES2022 Error.cause)
    key?: string;
    value?: any;
  });
}
```

When wrapping a caught error, pass it via `cause` so the native ES2022 `Error.cause` chain is preserved. `console.error(err)` will walk the chain and print the inner error's stack under "Caused by:", which is invaluable when debugging initializer boot failures.

```ts
try {
  await redis.connect();
} catch (e) {
  throw new TypedError({
    message: `Failed to connect to Redis`,
    type: ErrorType.SERVER_INITIALIZATION,
    cause: e,
  });
}
```

References:

- [MDN — `Error.prototype.cause`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error/cause)
- [MDN — `Error()` constructor](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error/Error) (see the `options.cause` parameter)
- [TC39 — `proposal-error-cause`](https://github.com/tc39/proposal-error-cause) (stage 4, shipped in ES2022)
- [Node.js — `util.inspect`](https://nodejs.org/api/util.html#utilinspectobject-options) walks `.cause` by default

### ErrorType → HTTP Status Mapping

| ErrorType                            | Status | When                                       |
| ------------------------------------ | ------ | ------------------------------------------ |
| `SERVER_INITIALIZATION`              | 500    | Initializer failed to boot                 |
| `SERVER_START`                       | 500    | Initializer failed to start                |
| `SERVER_STOP`                        | 500    | Initializer failed to stop                 |
| `CONFIG_ERROR`                       | 500    | Invalid configuration                      |
| `INITIALIZER_VALIDATION`             | 500    | Initializer definition is invalid          |
| `ACTION_VALIDATION`                  | 500    | Action class definition is invalid         |
| `TASK_VALIDATION`                    | 500    | Task definition is invalid                 |
| `SERVER_VALIDATION`                  | 500    | Server definition is invalid               |
| `CONNECTION_SESSION_NOT_FOUND`       | 401    | No session / not authenticated             |
| `CONNECTION_SERVER_ERROR`            | 500    | Internal server error                      |
| `CONNECTION_ACTION_NOT_FOUND`        | 404    | Unknown action name                        |
| `CONNECTION_ACTION_PARAM_REQUIRED`   | 406    | Missing required input                     |
| `CONNECTION_ACTION_PARAM_DEFAULT`    | 406    | Default value failed to apply              |
| `CONNECTION_ACTION_PARAM_VALIDATION` | 406    | Input failed Zod validation                |
| `CONNECTION_ACTION_PARAM_FORMATTING` | 406    | Input formatting error                     |
| `CONNECTION_ACTION_RUN`              | 500    | Action threw during `run()`                |
| `CONNECTION_TYPE_NOT_FOUND`          | 406    | Unknown connection type                    |
| `CONNECTION_NOT_SUBSCRIBED`          | 406    | Tried to broadcast to unsubscribed channel |
| `CONNECTION_CHANNEL_AUTHORIZATION`   | 403    | Channel subscription denied                |
| `CONNECTION_CHANNEL_VALIDATION`      | 400    | Invalid channel name                       |
| `CONNECTION_ACTION_TIMEOUT`          | 408    | Action exceeded its timeout                |
| `CONNECTION_RATE_LIMITED`            | 429    | Client exceeded rate limit                 |
| `CONNECTION_TASK_DEFINITION`         | 500    | Task definition error                      |

## Logger

Source: `packages/keryx/classes/Logger.ts`

Simple logger that writes to stdout. No Winston, no Pino — just STDOUT and STDERR with optional colors and timestamps.

```ts
class Logger {
  level: LogLevel;
  colorize: boolean;
  includeTimestamps: boolean;

  trace(message: string, data?: any): void;
  debug(message: string, data?: any): void;
  info(message: string, data?: any): void;
  warn(message: string, data?: any): void;
  error(message: string, data?: any): void;
  fatal(message: string, data?: any): void;
}

enum LogLevel {
  trace = "trace",
  debug = "debug",
  info = "info",
  warn = "warn",
  error = "error",
  fatal = "fatal",
}
```
