import { beforeEach, describe, expect, test } from "bun:test";
import { API, RUN_MODE } from "../../classes/API";
import { Initializer } from "../../classes/Initializer";
import { ErrorType, TypedError } from "../../classes/TypedError";

class FakeInitializer extends Initializer {
  returnValue: unknown;
  startFn?: (api: API) => void | Promise<void>;

  constructor(
    name: string,
    opts: {
      returnValue?: unknown;
      startFn?: (api: API) => void | Promise<void>;
      declaresAPIProperty?: boolean;
      runModes?: RUN_MODE[];
    } = {},
  ) {
    super(name);
    this.returnValue = opts.returnValue;
    this.startFn = opts.startFn;
    if (opts.declaresAPIProperty !== undefined) {
      this.declaresAPIProperty = opts.declaresAPIProperty;
    }
    if (opts.runModes) this.runModes = opts.runModes;
  }

  async initialize() {
    return this.returnValue;
  }

  async start() {
    if (this.startFn) await this.startFn(api);
  }
}

let api: API;

/**
 * Build an API instance whose `findInitializers` is replaced with a no-op, so
 * tests have full control over which initializers participate in the lifecycle.
 */
function buildTestAPI(initializers: Initializer[] = []): API {
  const testApi = new API();
  (
    testApi as unknown as { findInitializers: () => Promise<void> }
  ).findInitializers = async () => {};
  testApi.initializers = initializers;
  return testApi;
}

describe("API.initialize validation", () => {
  beforeEach(() => {
    api = buildTestAPI();
  });

  test("passes when every initializer attaches its namespace", async () => {
    api = buildTestAPI([
      new FakeInitializer("alpha", { returnValue: { ok: true } }),
      new FakeInitializer("beta", { returnValue: { ok: true } }),
    ]);

    await api.initialize();

    expect(api.initialized).toBe(true);
    expect(api.alpha).toEqual({ ok: true });
    expect(api.beta).toEqual({ ok: true });
  });

  test("fails when an initializer returns undefined", async () => {
    api = buildTestAPI([
      new FakeInitializer("alpha", { returnValue: { ok: true } }),
      new FakeInitializer("broken", { returnValue: undefined }),
    ]);

    let caught: unknown;
    try {
      await api.initialize();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TypedError);
    const err = caught as TypedError;
    expect(err.type).toBe(ErrorType.INITIALIZER_VALIDATION);
    expect(err.message).toContain("broken");
    expect(err.message).toContain("initialize phase");
    expect(api.initialized).toBe(false);
  });

  test("fails when an initializer returns null", async () => {
    api = buildTestAPI([new FakeInitializer("nully", { returnValue: null })]);

    let caught: unknown;
    try {
      await api.initialize();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TypedError);
    expect((caught as TypedError).type).toBe(ErrorType.INITIALIZER_VALIDATION);
    expect((caught as TypedError).message).toContain("nully");
  });

  test("lists every missing initializer in a single error", async () => {
    api = buildTestAPI([
      new FakeInitializer("ok", { returnValue: { v: 1 } }),
      new FakeInitializer("miss-a", { returnValue: undefined }),
      new FakeInitializer("miss-b", { returnValue: undefined }),
    ]);

    let caught: unknown;
    try {
      await api.initialize();
    } catch (e) {
      caught = e;
    }

    const err = caught as TypedError;
    expect(err.type).toBe(ErrorType.INITIALIZER_VALIDATION);
    expect(err.message).toContain("miss-a");
    expect(err.message).toContain("miss-b");
  });

  test("declaresAPIProperty = false skips validation", async () => {
    api = buildTestAPI([
      new FakeInitializer("skip-me", {
        returnValue: undefined,
        declaresAPIProperty: false,
      }),
    ]);

    await api.initialize();

    expect(api.initialized).toBe(true);
    expect(api["skip-me"]).toBeUndefined();
  });
});

describe("API.start validation", () => {
  test("fails when start() leaves the namespace null", async () => {
    api = buildTestAPI([
      new FakeInitializer("late", {
        returnValue: { placeholder: true },
        startFn: (a) => {
          a.late = null;
        },
      }),
    ]);

    let caught: unknown;
    try {
      await api.start();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TypedError);
    const err = caught as TypedError;
    expect(err.type).toBe(ErrorType.INITIALIZER_VALIDATION);
    expect(err.message).toContain("late");
    expect(err.message).toContain("start phase");
    expect(api.started).toBe(false);
  });

  test("passes when start() populates a previously-empty container", async () => {
    api = buildTestAPI([
      new FakeInitializer("late", {
        returnValue: {},
        startFn: (a) => {
          a.late = { connected: true };
        },
      }),
    ]);

    await api.start();

    expect(api.started).toBe(true);
    expect(api.late).toEqual({ connected: true });
  });
});

describe("API.validateInitializerProperties (direct)", () => {
  test("start phase skips initializers excluded from the active runMode", () => {
    const testApi = buildTestAPI([
      new FakeInitializer("cli-only", {
        returnValue: undefined,
        runModes: [RUN_MODE.CLI],
      }),
    ]);
    testApi.runMode = RUN_MODE.SERVER;

    // `api["cli-only"]` is undefined; without the runMode skip this would throw.
    expect(() =>
      // @ts-expect-error - accessing private method for unit testing
      testApi.validateInitializerProperties("start"),
    ).not.toThrow();
  });

  test("initialize phase validates ALL initializers regardless of runMode", () => {
    const testApi = buildTestAPI([
      new FakeInitializer("cli-only", {
        returnValue: undefined,
        runModes: [RUN_MODE.CLI],
      }),
    ]);
    testApi.runMode = RUN_MODE.SERVER;

    expect(() =>
      // @ts-expect-error - accessing private method for unit testing
      testApi.validateInitializerProperties("initialize"),
    ).toThrowError(TypedError);
  });
});
