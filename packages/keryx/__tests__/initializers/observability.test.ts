import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api } from "../../api";
import { Action, HTTP_METHOD } from "../../classes/Action";
import type { Connection } from "../../classes/Connection";
import { config } from "../../config";
import { HOOK_TIMEOUT } from "../setup";

beforeAll(async () => {
  config.observability.enabled = true;
  await api.initialize();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
  config.observability.enabled = false;
}, HOOK_TIMEOUT);

describe("observability route validation", () => {
  test("start() throws when an action route conflicts with the metrics route", async () => {
    // Temporarily set metricsRoute under apiRoute so the conflict can occur
    const originalMetricsRoute = config.observability.metricsRoute;
    config.observability.metricsRoute =
      config.server.web.apiRoute + "/test-metrics-conflict";

    class ConflictingAction extends Action {
      constructor() {
        super({
          name: "test:metrics-conflict",
          web: {
            route: "/test-metrics-conflict",
            method: HTTP_METHOD.GET,
          },
        });
      }
      async run(_params: unknown, _connection: Connection) {
        return {};
      }
    }

    const fakeAction = new ConflictingAction();
    api.actions.actions.push(fakeAction);

    try {
      await expect(api.start()).rejects.toThrow(/conflicts with action/);
    } finally {
      const idx = api.actions.actions.indexOf(fakeAction);
      if (idx !== -1) api.actions.actions.splice(idx, 1);
      config.observability.metricsRoute = originalMetricsRoute;
    }
  });

  test("start() throws when a regex action route matches the metrics route", async () => {
    const originalMetricsRoute = config.observability.metricsRoute;
    config.observability.metricsRoute =
      config.server.web.apiRoute + "/regex-conflict";

    class RegexConflictAction extends Action {
      constructor() {
        super({
          name: "test:regex-metrics-conflict",
          web: {
            route: new RegExp("^/regex-conflict$"),
            method: HTTP_METHOD.GET,
          },
        });
      }
      async run(_params: unknown, _connection: Connection) {
        return {};
      }
    }

    const fakeAction = new RegexConflictAction();
    api.actions.actions.push(fakeAction);

    try {
      await expect(api.start()).rejects.toThrow(/conflicts with action/);
    } finally {
      const idx = api.actions.actions.indexOf(fakeAction);
      if (idx !== -1) api.actions.actions.splice(idx, 1);
      config.observability.metricsRoute = originalMetricsRoute;
    }
  });

  test("start() succeeds when no action routes conflict with the metrics route", async () => {
    await api.start();
  });
});
