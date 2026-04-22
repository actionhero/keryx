import { describe, expect, test } from "bun:test";
import { type Action, HTTP_METHOD } from "../../classes/Action";
import { Router } from "../../classes/Router";

// Minimal shape the Router actually reads. Casting avoids standing up full Action
// instances (and their abstract `run()`) for data-structure tests.
function action(
  name: string,
  route: string | RegExp,
  method: HTTP_METHOD = HTTP_METHOD.GET,
): Action {
  return { name, web: { route, method } } as unknown as Action;
}

describe("Router", () => {
  describe("static routes", () => {
    test("matches an exact string path", () => {
      const router = new Router();
      router.compile([action("status", "/status")]);

      expect(router.match("/status", HTTP_METHOD.GET)).toEqual({
        actionName: "status",
      });
    });

    test("returns null on method mismatch", () => {
      const router = new Router();
      router.compile([action("status", "/status", HTTP_METHOD.GET)]);

      expect(router.match("/status", HTTP_METHOD.POST)).toBeNull();
    });

    test("different methods on the same path route independently", () => {
      const router = new Router();
      router.compile([
        action("user:list", "/users", HTTP_METHOD.GET),
        action("user:create", "/users", HTTP_METHOD.POST),
      ]);

      expect(router.match("/users", HTTP_METHOD.GET)).toEqual({
        actionName: "user:list",
      });
      expect(router.match("/users", HTTP_METHOD.POST)).toEqual({
        actionName: "user:create",
      });
      expect(router.match("/users", HTTP_METHOD.DELETE)).toBeNull();
    });

    test("treats regex metacharacters as literal", () => {
      const router = new Router();
      router.compile([action("version", "/v1.0/status")]);

      expect(router.match("/v1.0/status", HTTP_METHOD.GET)).toEqual({
        actionName: "version",
      });
      // The `.` must not match an arbitrary character.
      expect(router.match("/v1X0/status", HTTP_METHOD.GET)).toBeNull();
    });

    test("trailing slash is strict (no implicit normalization)", () => {
      const router = new Router();
      router.compile([action("status", "/status")]);

      expect(router.match("/status", HTTP_METHOD.GET)).toEqual({
        actionName: "status",
      });
      expect(router.match("/status/", HTTP_METHOD.GET)).toBeNull();
    });

    test("root path matches", () => {
      const router = new Router();
      router.compile([action("home", "/")]);

      expect(router.match("/", HTTP_METHOD.GET)).toEqual({
        actionName: "home",
      });
    });
  });

  describe("parameterized routes", () => {
    test("extracts a single :param", () => {
      const router = new Router();
      router.compile([action("user:get", "/users/:id")]);

      expect(router.match("/users/42", HTTP_METHOD.GET)).toEqual({
        actionName: "user:get",
        pathParams: { id: "42" },
      });
    });

    test("extracts multiple :params in order", () => {
      const router = new Router();
      router.compile([action("msg:get", "/channels/:channelId/messages/:id")]);

      expect(
        router.match("/channels/general/messages/99", HTTP_METHOD.GET),
      ).toEqual({
        actionName: "msg:get",
        pathParams: { channelId: "general", id: "99" },
      });
    });

    test(":param accepts URL-safe characters (dashes, dots, alphanumeric)", () => {
      const router = new Router();
      router.compile([action("user:get", "/users/:id")]);

      const match = router.match(
        "/users/7f9c3b2e-1d5a-4f8b-9e7c-0a1b2c3d4e5f.v2",
        HTTP_METHOD.GET,
      );
      expect(match?.pathParams?.id).toBe(
        "7f9c3b2e-1d5a-4f8b-9e7c-0a1b2c3d4e5f.v2",
      );
    });

    test(":param is bounded by slashes — does not cross segments", () => {
      const router = new Router();
      router.compile([action("user:get", "/users/:id")]);

      // An extra segment after :id must not match.
      expect(router.match("/users/42/extra", HTTP_METHOD.GET)).toBeNull();
    });

    test("empty param value does not match", () => {
      const router = new Router();
      router.compile([action("user:get", "/users/:id")]);

      expect(router.match("/users/", HTTP_METHOD.GET)).toBeNull();
    });

    test("param on the same path routes differently per method", () => {
      const router = new Router();
      router.compile([
        action("user:get", "/users/:id", HTTP_METHOD.GET),
        action("user:update", "/users/:id", HTTP_METHOD.PATCH),
      ]);

      expect(router.match("/users/1", HTTP_METHOD.GET)?.actionName).toBe(
        "user:get",
      );
      expect(router.match("/users/1", HTTP_METHOD.PATCH)?.actionName).toBe(
        "user:update",
      );
      expect(router.match("/users/1", HTTP_METHOD.DELETE)).toBeNull();
    });
  });

  describe("RegExp routes", () => {
    test("matches without returning pathParams", () => {
      const router = new Router();
      router.compile([action("admin:any", /^\/admin\/.+$/)]);

      expect(router.match("/admin/settings", HTTP_METHOD.GET)).toEqual({
        actionName: "admin:any",
      });
    });

    test("honors the RegExp's own boundaries", () => {
      const router = new Router();
      router.compile([action("admin:any", /^\/admin\/.+$/)]);

      expect(router.match("/admin/", HTTP_METHOD.GET)).toBeNull();
      expect(router.match("/admins/x", HTTP_METHOD.GET)).toBeNull();
    });
  });

  describe("precedence and tie-breaks", () => {
    test("static route beats a dynamic route that could also match (regardless of registration order)", () => {
      // Dynamic registered first — the old live-loop would have matched it.
      // The router deliberately prefers the static index.
      const routerDynamicFirst = new Router();
      routerDynamicFirst.compile([
        action("user:get", "/users/:id"),
        action("user:all", "/users/all"),
      ]);
      expect(routerDynamicFirst.match("/users/all", HTTP_METHOD.GET)).toEqual({
        actionName: "user:all",
      });

      // And the reverse order.
      const routerStaticFirst = new Router();
      routerStaticFirst.compile([
        action("user:all", "/users/all"),
        action("user:get", "/users/:id"),
      ]);
      expect(routerStaticFirst.match("/users/all", HTTP_METHOD.GET)).toEqual({
        actionName: "user:all",
      });
    });

    test("first-registered wins among dynamic routes that both match", () => {
      const router = new Router();
      router.compile([
        action("first", "/things/:id"),
        action("second", "/things/:slug"),
      ]);

      expect(router.match("/things/abc", HTTP_METHOD.GET)).toEqual({
        actionName: "first",
        pathParams: { id: "abc" },
      });
    });

    test("duplicate static route keeps the first registration", () => {
      const router = new Router();
      router.compile([action("first", "/ping"), action("second", "/ping")]);

      expect(router.match("/ping", HTTP_METHOD.GET)?.actionName).toBe("first");
    });
  });

  describe("empty / missing input", () => {
    test("empty action list yields no matches", () => {
      const router = new Router();
      router.compile([]);

      expect(router.match("/anything", HTTP_METHOD.GET)).toBeNull();
    });

    test("ignores actions with no web.route", () => {
      const taskOnly = { name: "bg:work" } as unknown as Action;
      const router = new Router();
      router.compile([taskOnly, action("status", "/status")]);

      expect(router.match("/status", HTTP_METHOD.GET)).toEqual({
        actionName: "status",
      });
    });

    test("unknown path returns null", () => {
      const router = new Router();
      router.compile([action("status", "/status")]);

      expect(router.match("/nope", HTTP_METHOD.GET)).toBeNull();
    });
  });

  describe("rebuild correctness", () => {
    test("compile() replaces prior state — no leftover static or dynamic routes", () => {
      const router = new Router();
      router.compile([
        action("old:static", "/old"),
        action("old:dynamic", "/old/:id"),
      ]);
      router.compile([action("new:static", "/new")]);

      expect(router.match("/old", HTTP_METHOD.GET)).toBeNull();
      expect(router.match("/old/1", HTTP_METHOD.GET)).toBeNull();
      expect(router.match("/new", HTTP_METHOD.GET)?.actionName).toBe(
        "new:static",
      );
    });

    test("rebuilds on in-place mutation (push/splice)", () => {
      const actions: Action[] = [action("status", "/status")];
      const router = new Router();
      router.compile(actions);

      expect(router.match("/late", HTTP_METHOD.GET)).toBeNull();

      actions.push(action("late:get", "/late"));
      expect(router.match("/late", HTTP_METHOD.GET)?.actionName).toBe(
        "late:get",
      );

      actions.splice(0, actions.length);
      expect(router.match("/status", HTTP_METHOD.GET)).toBeNull();
      expect(router.match("/late", HTTP_METHOD.GET)).toBeNull();
    });

    test("rebuilds when the source getter returns a fresh array reference", () => {
      const container = { actions: [action("status", "/status")] as Action[] };
      const router = new Router();
      router.compile(() => container.actions);

      expect(router.match("/status", HTTP_METHOD.GET)?.actionName).toBe(
        "status",
      );

      // Wholesale swap — mirrors `api.actions.actions = api.actions.actions.filter(...)`.
      container.actions = [action("swapped", "/swapped")];

      expect(router.match("/status", HTTP_METHOD.GET)).toBeNull();
      expect(router.match("/swapped", HTTP_METHOD.GET)?.actionName).toBe(
        "swapped",
      );
    });

    test("rebuilds on same-length reference swap (identity, not length, drives drift detection)", () => {
      const container = {
        actions: [
          action("alpha", "/alpha"),
          action("beta", "/beta"),
        ] as Action[],
      };
      const router = new Router();
      router.compile(() => container.actions);

      expect(router.match("/alpha", HTTP_METHOD.GET)?.actionName).toBe("alpha");

      // Replace with a new array of the SAME length. Length-only drift checks
      // would miss this; the router must also compare references.
      container.actions = [
        action("gamma", "/gamma"),
        action("delta", "/delta"),
      ];

      expect(router.match("/alpha", HTTP_METHOD.GET)).toBeNull();
      expect(router.match("/beta", HTTP_METHOD.GET)).toBeNull();
      expect(router.match("/gamma", HTTP_METHOD.GET)?.actionName).toBe("gamma");
      expect(router.match("/delta", HTTP_METHOD.GET)?.actionName).toBe("delta");
    });

    test("defers rebuild when the getter is not yet ready", () => {
      const container: { actions?: Action[] } = {};
      const router = new Router();

      // Mirrors the initializer-time case where `api.actions` isn't assigned yet.
      router.compile(() => {
        if (!container.actions) throw new Error("not ready");
        return container.actions;
      });

      container.actions = [action("late:status", "/status")];

      expect(router.match("/status", HTTP_METHOD.GET)?.actionName).toBe(
        "late:status",
      );
    });

    test("does not rebuild when neither reference nor length changed", () => {
      // Arrange a getter that counts invocations. After the first rebuild,
      // subsequent matches must only call the getter (to check drift), not
      // walk all actions again. We verify this indirectly by mutating an
      // action's `name` after compile — if we were rebuilding every time, the
      // new name would show up; since we cache, it should not.
      const a = action("original", "/thing");
      const actions: Action[] = [a];
      const router = new Router();
      router.compile(actions);

      expect(router.match("/thing", HTTP_METHOD.GET)?.actionName).toBe(
        "original",
      );

      (a as { name: string }).name = "mutated-in-place";

      // No length change, no reference change — cached index still returns
      // the pre-mutation value.
      expect(router.match("/thing", HTTP_METHOD.GET)?.actionName).toBe(
        "original",
      );
    });
  });

  describe("scale smoke test", () => {
    test("routes correctly with many mixed static and dynamic actions", () => {
      const many: Action[] = [];
      for (let i = 0; i < 500; i++) many.push(action(`s:${i}`, `/static/${i}`));
      for (let i = 0; i < 500; i++) {
        many.push(action(`d:${i}`, `/dynamic/${i}/:id`));
      }

      const router = new Router();
      router.compile(many);

      expect(router.match("/static/0", HTTP_METHOD.GET)?.actionName).toBe(
        "s:0",
      );
      expect(router.match("/static/499", HTTP_METHOD.GET)?.actionName).toBe(
        "s:499",
      );
      expect(router.match("/static/500", HTTP_METHOD.GET)).toBeNull();

      expect(router.match("/dynamic/42/abc", HTTP_METHOD.GET)).toEqual({
        actionName: "d:42",
        pathParams: { id: "abc" },
      });
    });
  });
});
