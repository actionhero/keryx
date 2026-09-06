import { AsyncLocalStorage } from "node:async_hooks";
import type * as Sentry from "@sentry/bun";
import type { SentrySpan } from "./spanHelpers";

/**
 * Per-request identity buffer. `api.sentry.setUser` / `setTag` write here
 * instead of a process-global scope so that identity set while handling one
 * request never bleeds onto a concurrent or subsequent request's events. The
 * buffer is applied to a forked scope at capture time.
 */
export type RequestScopeData = {
  user?: Sentry.User | null;
  tags: Record<string, string>;
};

/**
 * Shared, per-request span and identity state for the plugin. Holds the async
 * context stores and the transport span bookkeeping that the tracing hooks,
 * Redis / Postgres instrumentation, and `api.sentry` capture methods all read
 * and write. A single instance is created per plugin start.
 */
export class SentryRequestState {
  /**
   * Active Sentry span for the current async task. Set via `enterWith` from
   * transport / action hooks so Redis and Postgres spans created later
   * inherit the right parent without wrapping the rest of the request in
   * `Sentry.startSpan(...)`.
   */
  spanALS = new AsyncLocalStorage<SentrySpan | undefined>();
  /**
   * Per-request identity buffer keyed by async context. Established in
   * `beforeAct` (and transport hooks) so `setUser` / `setTag` isolate to the
   * current request instead of leaking through a shared global scope.
   */
  requestScopeALS = new AsyncLocalStorage<RequestScopeData | undefined>();
  /**
   * When true, Redis / Postgres instrumentation skips creating spans. Set at
   * the request or job boundary for `tracing = false` and restored when that
   * request / job finishes so the next traced work on the same async
   * context is not left suppressed.
   */
  tracingSuppressedALS = new AsyncLocalStorage<boolean>();
  wsConnections = new WeakMap<object, SentrySpan>();
  wsMessageSpans = new WeakMap<object, SentrySpan>();
  mcpSessions = new Map<string, SentrySpan>();
  mcpMessageSpans = new Map<string, SentrySpan>();

  /**
   * Copy the current request's buffered identity (user + tags) onto a forked
   * Sentry scope. Called from a `withScope` callback right before a capture so
   * the identity applies only to that event, never to the shared global scope.
   */
  applyRequestScope(scope: Sentry.Scope): void {
    const data = this.requestScopeALS.getStore();
    if (!data) return;
    if (data.user !== undefined) scope.setUser(data.user);
    for (const [key, value] of Object.entries(data.tags)) {
      scope.setTag(key, value);
    }
  }
}
