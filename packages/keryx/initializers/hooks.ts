import type { AfterActHook, BeforeActHook } from "../classes/Connection";
import { Initializer } from "../classes/Initializer";
import type {
  AfterRequestHook,
  BeforeRequestHook,
  OnConnectHook,
  OnDisconnectHook,
  OnMessageHook,
} from "../servers/web";
import type { OnEnqueueHook } from "./actionts";
import type {
  OnMcpConnectHook,
  OnMcpDisconnectHook,
  OnMcpMessageHook,
} from "./mcp";
import type { AfterJobHook, BeforeJobHook } from "./resque";

const namespace = "hooks";

declare module "keryx" {
  export interface API {
    [namespace]: Awaited<ReturnType<Hooks["initialize"]>>;
  }
}

/**
 * A small generic registry that stores hooks in an array and exposes a
 * read-only view. Eliminates per-hook-type boilerplate in {@link Hooks}.
 */
class HookRegistry<T extends (...args: never[]) => unknown> {
  private hooks: T[] = [];

  /** Append a hook to the registry. */
  register(hook: T): void {
    this.hooks.push(hook);
  }

  /** Remove all registered hooks (used by test teardown). */
  clear(): void {
    this.hooks.length = 0;
  }

  /** Live read-only view of registered hooks. */
  get all(): ReadonlyArray<T> {
    return this.hooks;
  }
}

/**
 * Central registry for framework lifecycle hooks. Plugins register hooks here
 * from their initializer's `initialize()`; the framework iterates the registered
 * hooks at runtime.
 *
 * Public surface: `api.hooks.web`, `api.hooks.ws`, `api.hooks.mcp`,
 * `api.hooks.actions`, `api.hooks.resque`. See the respective hook type
 * definitions for semantics (in `servers/web.ts`, `initializers/mcp.ts`,
 * `initializers/actionts.ts`, `initializers/resque.ts`).
 */
export class Hooks extends Initializer {
  private webBeforeRequest = new HookRegistry<BeforeRequestHook>();
  private webAfterRequest = new HookRegistry<AfterRequestHook>();
  private wsOnConnect = new HookRegistry<OnConnectHook>();
  private wsOnMessage = new HookRegistry<OnMessageHook>();
  private wsOnDisconnect = new HookRegistry<OnDisconnectHook>();
  private mcpOnConnect = new HookRegistry<OnMcpConnectHook>();
  private mcpOnMessage = new HookRegistry<OnMcpMessageHook>();
  private mcpOnDisconnect = new HookRegistry<OnMcpDisconnectHook>();
  private actionsOnEnqueue = new HookRegistry<OnEnqueueHook>();
  private actionsBeforeAct = new HookRegistry<BeforeActHook>();
  private actionsAfterAct = new HookRegistry<AfterActHook>();
  private resqueBeforeJob = new HookRegistry<BeforeJobHook>();
  private resqueAfterJob = new HookRegistry<AfterJobHook>();

  constructor() {
    super(namespace);
  }

  async stop() {
    this.webBeforeRequest.clear();
    this.webAfterRequest.clear();
    this.wsOnConnect.clear();
    this.wsOnMessage.clear();
    this.wsOnDisconnect.clear();
    this.mcpOnConnect.clear();
    this.mcpOnMessage.clear();
    this.mcpOnDisconnect.clear();
    this.actionsOnEnqueue.clear();
    this.actionsBeforeAct.clear();
    this.actionsAfterAct.clear();
    this.resqueBeforeJob.clear();
    this.resqueAfterJob.clear();
  }

  async initialize() {
    const self = this;
    return {
      web: {
        /**
         * Register a hook to run at the start of every HTTP request, before
         * routing. Covers static files, OAuth, MCP, metrics, and actions.
         * Does not fire for WebSocket upgrades.
         */
        beforeRequest(hook: BeforeRequestHook): void {
          self.webBeforeRequest.register(hook);
        },
        /**
         * Register a hook to run after the `Response` is built, before
         * compression. Receives the same `ctx` object passed to `beforeRequest`,
         * so state stashed in `ctx.metadata` flows through.
         */
        afterRequest(hook: AfterRequestHook): void {
          self.webAfterRequest.register(hook);
        },
        /** @internal Iterated by `WebServer.handleIncomingConnection`. */
        beforeRequestHooks: self.webBeforeRequest.all,
        /** @internal Iterated by `WebServer.handleIncomingConnection`. */
        afterRequestHooks: self.webAfterRequest.all,
      },
      ws: {
        /**
         * Register a hook to run when a new WebSocket connection is accepted,
         * after the `Connection` has been constructed and registered.
         */
        onConnect(hook: OnConnectHook): void {
          self.wsOnConnect.register(hook);
        },
        /**
         * Register a hook to run for each inbound WebSocket message, after
         * rate-limiting but before message parsing / dispatch.
         */
        onMessage(hook: OnMessageHook): void {
          self.wsOnMessage.register(hook);
        },
        /**
         * Register a hook to run when a WebSocket connection closes, before
         * channel presence is cleaned up and the connection is destroyed.
         */
        onDisconnect(hook: OnDisconnectHook): void {
          self.wsOnDisconnect.register(hook);
        },
        /** @internal Iterated by `WebServer.handleWebSocketConnectionOpen`. */
        onConnectHooks: self.wsOnConnect.all,
        /** @internal Iterated by `WebServer.handleWebSocketConnectionMessage`. */
        onMessageHooks: self.wsOnMessage.all,
        /** @internal Iterated by `WebServer.handleWebSocketConnectionClose`. */
        onDisconnectHooks: self.wsOnDisconnect.all,
      },
      mcp: {
        /**
         * Register a hook to run when a new MCP session is initialized (after
         * the MCP initialize handshake completes).
         */
        onConnect(hook: OnMcpConnectHook): void {
          self.mcpOnConnect.register(hook);
        },
        /**
         * Register a hook to run for each inbound MCP request (POST/GET/DELETE
         * to the MCP route). Fires before the transport dispatches the request.
         * `sessionId` is `undefined` for the very first POST that creates a
         * session.
         */
        onMessage(hook: OnMcpMessageHook): void {
          self.mcpOnMessage.register(hook);
        },
        /**
         * Register a hook to run when an MCP session's transport closes.
         */
        onDisconnect(hook: OnMcpDisconnectHook): void {
          self.mcpOnDisconnect.register(hook);
        },
        /** @internal Iterated by the MCP handler on session init. */
        onConnectHooks: self.mcpOnConnect.all,
        /** @internal Iterated by the MCP handler before dispatching a request. */
        onMessageHooks: self.mcpOnMessage.all,
        /** @internal Iterated by the MCP handler on transport close. */
        onDisconnectHooks: self.mcpOnDisconnect.all,
      },
      actions: {
        /**
         * Register a hook to run on every enqueue. Fires for `enqueue`,
         * `enqueueAt`, `enqueueIn`, and per-job inside `fanOut`. Hooks may
         * mutate inputs by returning a replacement object.
         */
        onEnqueue(hook: OnEnqueueHook): void {
          self.actionsOnEnqueue.register(hook);
        },
        /**
         * Register a hook to run inside `Connection.act()` after params are
         * validated and before the action's `runBefore` middleware. Fires for
         * every action invocation across all transports (web, websocket, task,
         * cli, mcp, …) — inspect `connection.type` to discriminate.
         */
        beforeAct(hook: BeforeActHook): void {
          self.actionsBeforeAct.register(hook);
        },
        /**
         * Register a hook to run inside `Connection.act()` in a `finally` block
         * after the action completes (success or failure). Receives the same
         * `ctx` as `beforeAct` plus a unified {@link ActOutcome}. Fires across
         * all transports.
         */
        afterAct(hook: AfterActHook): void {
          self.actionsAfterAct.register(hook);
        },
        /** @internal Iterated by `Actions.enqueue`, `enqueueAt`, `enqueueIn`. */
        onEnqueueHooks: self.actionsOnEnqueue.all,
        /** @internal Iterated inside `Connection.act`. */
        beforeActHooks: self.actionsBeforeAct.all,
        /** @internal Iterated inside `Connection.act`. */
        afterActHooks: self.actionsAfterAct.all,
      },
      resque: {
        /** Register a hook to run before each job's action executes. */
        beforeJob(hook: BeforeJobHook): void {
          self.resqueBeforeJob.register(hook);
        },
        /** Register a hook to run after each job's action executes (success or failure). */
        afterJob(hook: AfterJobHook): void {
          self.resqueAfterJob.register(hook);
        },
        /** @internal Iterated inside `wrapActionAsJob.perform`. */
        beforeJobHooks: self.resqueBeforeJob.all,
        /** @internal Iterated inside `wrapActionAsJob.perform`. */
        afterJobHooks: self.resqueAfterJob.all,
      },
    };
  }
}
