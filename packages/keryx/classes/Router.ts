import type { Action, HTTP_METHOD } from "./Action";

/**
 * Result of a successful route match.
 */
export type RouterMatch = {
  actionName: string;
  pathParams?: Record<string, string>;
};

type DynamicRoute = {
  matcher: RegExp;
  paramNames: string[];
  actionName: string;
};

/**
 * Fast path-to-action lookup.
 *
 * `compile()` builds two lookup structures from a list of actions:
 *   - a static index keyed by method + exact path for plain-string routes with no `:param` segments
 *   - a dynamic list (per method) of pre-compiled regexes for `:param` and `RegExp` routes
 *
 * `match()` performs an O(1) static lookup first, then falls back to an O(k) scan of
 * dynamic routes for that method (where k is the number of dynamic routes per method).
 *
 * The router preserves the registration order of dynamic routes, so when two dynamic
 * patterns can both match a path, the first one registered wins — matching the
 * behavior of the pre-router iteration loop.
 *
 * The router reads the action list through a source function supplied to
 * `compile()`. On each `match()` call it checks whether the returned array
 * reference or length has changed since the last build, and rebuilds on drift.
 * This preserves the live-iteration semantics of the previous loop-based matcher
 * — including tolerating tests that both push new actions onto
 * `api.actions.actions` and that swap the array wholesale via
 * `api.actions.actions = api.actions.actions.filter(...)`.
 */
export class Router {
  private staticIndex: Map<HTTP_METHOD, Map<string, string>> = new Map();
  private dynamicList: Map<HTTP_METHOD, DynamicRoute[]> = new Map();
  private source: () => Action[] = () => [];
  private lastSeen: Action[] | null = null;
  private lastLength = -1;

  /**
   * Bind the router to an action source and eagerly build the lookup structures.
   *
   * The `source` argument may be the action array directly, or a getter function
   * that returns the current array. A getter is the recommended form for
   * long-lived routers (e.g. the one on `api.actions`) because some callers
   * swap the underlying array reference rather than mutating in place.
   *
   * Safe to call multiple times — each call fully replaces the previous state.
   * When in-process hot-reload for actions is added, callers must re-invoke this
   * method; the currently relied-on dev restart via `bun --watch` is a full
   * process restart, so `initialize()` naturally re-runs this.
   *
   * @param source - Either the actions array or a function returning it. Actions without a `web.route` are skipped.
   */
  compile(source: Action[] | (() => Action[])): void {
    this.source =
      typeof source === "function" ? source : () => source as Action[];

    // Eagerly build if the source is ready. If the getter throws (e.g. called
    // inside `initialize()` before `api.actions` is assigned), defer to the
    // first `match()` call.
    try {
      const actions = this.source();
      this.rebuild(actions);
    } catch {
      this.lastSeen = null;
      this.lastLength = -1;
    }
  }

  private rebuild(actions: Action[]): void {
    this.staticIndex = new Map();
    this.dynamicList = new Map();

    for (const action of actions) {
      if (!action?.web?.route) continue;
      const { route, method } = action.web;

      const isRegExp = route instanceof RegExp;
      const hasParams = !isRegExp && /:\w+/.test(route as string);

      if (!isRegExp && !hasParams) {
        let byPath = this.staticIndex.get(method);
        if (!byPath) {
          byPath = new Map();
          this.staticIndex.set(method, byPath);
        }
        if (!byPath.has(route as string)) {
          byPath.set(route as string, action.name);
        }
        continue;
      }

      const matcher = isRegExp
        ? (route as RegExp)
        : new RegExp(`^${(route as string).replace(/:\w+/g, "([^/]+)")}$`);
      const paramNames = isRegExp
        ? []
        : ((route as string).match(/:\w+/g) ?? []).map((n) => n.slice(1));

      let list = this.dynamicList.get(method);
      if (!list) {
        list = [];
        this.dynamicList.set(method, list);
      }
      list.push({ matcher, paramNames, actionName: action.name });
    }

    this.lastSeen = actions;
    this.lastLength = actions.length;
  }

  /**
   * Match a path + method against the compiled routes.
   *
   * @param path - The request path (already stripped of any API prefix).
   * @param method - Uppercase HTTP method.
   * @returns The matched action name plus any extracted path parameters, or `null` if no route matched.
   */
  match(path: string, method: HTTP_METHOD): RouterMatch | null {
    const actions = this.source();
    if (actions !== this.lastSeen || actions.length !== this.lastLength) {
      this.rebuild(actions);
    }

    const staticHit = this.staticIndex.get(method)?.get(path);
    if (staticHit) return { actionName: staticHit };

    const candidates = this.dynamicList.get(method);
    if (!candidates) return null;

    for (const { matcher, paramNames, actionName } of candidates) {
      const result = matcher.exec(path);
      if (!result) continue;

      if (paramNames.length === 0) return { actionName };

      const pathParams: Record<string, string> = {};
      for (let i = 0; i < paramNames.length; i++) {
        const value = result[i + 1];
        if (value !== undefined) pathParams[paramNames[i]] = value;
      }
      return {
        actionName,
        pathParams: Object.keys(pathParams).length > 0 ? pathParams : undefined,
      };
    }

    return null;
  }
}
