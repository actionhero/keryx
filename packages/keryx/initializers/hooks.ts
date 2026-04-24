import type { AfterActHook, BeforeActHook } from "../classes/Connection";
import { Initializer } from "../classes/Initializer";
import type { AfterRequestHook, BeforeRequestHook } from "../servers/web";
import type { OnEnqueueHook } from "./actionts";
import type { AfterJobHook, BeforeJobHook } from "./resque";

const namespace = "hooks";

declare module "keryx" {
  export interface API {
    [namespace]: Awaited<ReturnType<Hooks["initialize"]>>;
  }
}

/**
 * Central registry for framework lifecycle hooks. Plugins register hooks here
 * from their initializer's `initialize()`; the framework iterates the registered
 * hooks at runtime.
 *
 * Public surface: `api.hooks.web`, `api.hooks.actions`, `api.hooks.resque`. See
 * the respective hook type definitions for semantics (in `servers/web.ts`,
 * `initializers/actionts.ts`, `initializers/resque.ts`).
 */
export class Hooks extends Initializer {
  private webBeforeRequest: BeforeRequestHook[] = [];
  private webAfterRequest: AfterRequestHook[] = [];
  private actionsOnEnqueue: OnEnqueueHook[] = [];
  private actionsBeforeAct: BeforeActHook[] = [];
  private actionsAfterAct: AfterActHook[] = [];
  private resqueBeforeJob: BeforeJobHook[] = [];
  private resqueAfterJob: AfterJobHook[] = [];

  constructor() {
    super(namespace);
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
          self.webBeforeRequest.push(hook);
        },
        /**
         * Register a hook to run after the `Response` is built, before
         * compression. Receives the same `ctx` object passed to `beforeRequest`,
         * so state stashed in `ctx.metadata` flows through.
         */
        afterRequest(hook: AfterRequestHook): void {
          self.webAfterRequest.push(hook);
        },
        /** @internal Iterated by `WebServer.handleIncomingConnection`. */
        beforeRequestHooks:
          self.webBeforeRequest as ReadonlyArray<BeforeRequestHook>,
        /** @internal Iterated by `WebServer.handleIncomingConnection`. */
        afterRequestHooks:
          self.webAfterRequest as ReadonlyArray<AfterRequestHook>,
      },
      actions: {
        /**
         * Register a hook to run on every enqueue. Fires for `enqueue`,
         * `enqueueAt`, `enqueueIn`, and per-job inside `fanOut`. Hooks may
         * mutate inputs by returning a replacement object.
         */
        onEnqueue(hook: OnEnqueueHook): void {
          self.actionsOnEnqueue.push(hook);
        },
        /**
         * Register a hook to run inside `Connection.act()` after params are
         * validated and before the action's `runBefore` middleware. Fires for
         * every action invocation across all transports (web, websocket, task,
         * cli, mcp, …) — inspect `connection.type` to discriminate.
         */
        beforeAct(hook: BeforeActHook): void {
          self.actionsBeforeAct.push(hook);
        },
        /**
         * Register a hook to run inside `Connection.act()` in a `finally` block
         * after the action completes (success or failure). Receives the same
         * `ctx` as `beforeAct` plus a unified {@link ActOutcome}. Fires across
         * all transports.
         */
        afterAct(hook: AfterActHook): void {
          self.actionsAfterAct.push(hook);
        },
        /** @internal Iterated by `Actions.enqueue`, `enqueueAt`, `enqueueIn`. */
        onEnqueueHooks: self.actionsOnEnqueue as ReadonlyArray<OnEnqueueHook>,
        /** @internal Iterated inside `Connection.act`. */
        beforeActHooks: self.actionsBeforeAct as ReadonlyArray<BeforeActHook>,
        /** @internal Iterated inside `Connection.act`. */
        afterActHooks: self.actionsAfterAct as ReadonlyArray<AfterActHook>,
      },
      resque: {
        /** Register a hook to run before each job's action executes. */
        beforeJob(hook: BeforeJobHook): void {
          self.resqueBeforeJob.push(hook);
        },
        /** Register a hook to run after each job's action executes (success or failure). */
        afterJob(hook: AfterJobHook): void {
          self.resqueAfterJob.push(hook);
        },
        /** @internal Iterated inside `wrapActionAsJob.perform`. */
        beforeJobHooks: self.resqueBeforeJob as ReadonlyArray<BeforeJobHook>,
        /** @internal Iterated inside `wrapActionAsJob.perform`. */
        afterJobHooks: self.resqueAfterJob as ReadonlyArray<AfterJobHook>,
      },
    };
  }
}
