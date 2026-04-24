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

class ThrowingInitializer extends Initializer {
  phase: "initialize" | "start" | "stop";
  thrown: unknown;

  constructor(
    name: string,
    phase: "initialize" | "start" | "stop",
    thrown: unknown,
  ) {
    super(name);
    this.declaresAPIProperty = false;
    this.phase = phase;
    this.thrown = thrown;
  }

  async initialize() {
    if (this.phase === "initialize") throw this.thrown;
  }

  async start() {
    if (this.phase === "start") throw this.thrown;
  }

  async stop() {
    if (this.phase === "stop") throw this.thrown;
  }
}

describe("API lifecycle error wrapping", () => {
  test("initialize wraps thrown error with initializer name and preserves cause", async () => {
    const inner = new Error("boom");
    const testApi = buildTestAPI([
      new ThrowingInitializer("bad-init", "initialize", inner),
    ]);

    let caught: unknown;
    try {
      await testApi.initialize();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TypedError);
    const err = caught as TypedError;
    expect(err.type).toBe(ErrorType.SERVER_INITIALIZATION);
    expect(err.message).toContain(
      'Failed to initialize initializer "bad-init"',
    );
    expect(err.message).toContain("boom");
    expect(err.cause).toBe(inner);
  });

  test("start wraps thrown error with initializer name and preserves cause", async () => {
    const inner = new Error("start failed");
    const testApi = buildTestAPI([
      new ThrowingInitializer("bad-start", "start", inner),
    ]);
    testApi.initialized = true;

    let caught: unknown;
    try {
      await testApi.start();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TypedError);
    const err = caught as TypedError;
    expect(err.type).toBe(ErrorType.SERVER_START);
    expect(err.message).toContain('Failed to start initializer "bad-start"');
    expect(err.message).toContain("start failed");
    expect(err.cause).toBe(inner);
  });

  test("stop wraps thrown error with initializer name and preserves cause", async () => {
    const inner = new Error("stop failed");
    const testApi = buildTestAPI([
      new ThrowingInitializer("bad-stop", "stop", inner),
    ]);
    testApi.started = true;
    testApi.stopped = false;

    let caught: unknown;
    try {
      await testApi.stop();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TypedError);
    const err = caught as TypedError;
    expect(err.type).toBe(ErrorType.SERVER_STOP);
    expect(err.message).toContain('"bad-stop"');
    expect(err.message).toContain("stop failed");
    expect(err.cause).toBe(inner);
  });

  test("non-Error thrown values are preserved on cause without stringification loss", async () => {
    const inner = { code: "EWEIRD", detail: "not an Error" };
    const testApi = buildTestAPI([
      new ThrowingInitializer("weird", "initialize", inner),
    ]);

    let caught: unknown;
    try {
      await testApi.initialize();
    } catch (e) {
      caught = e;
    }

    const err = caught as TypedError;
    expect(err.cause).toBe(inner);
  });
});

describe("API.restart flap preventer", () => {
  test("is isolated per instance", async () => {
    const a = buildTestAPI();
    const b = buildTestAPI();

    // Simulate a restart already in-flight on `a`.
    (a as unknown as { flapPreventer: boolean }).flapPreventer = true;

    let bStopped = 0;
    let bStarted = 0;
    (b as unknown as { stop: () => Promise<void> }).stop = async () => {
      bStopped++;
    };
    (b as unknown as { start: () => Promise<void> }).start = async () => {
      bStarted++;
    };

    // `a`'s flag must not block `b`.
    await b.restart();

    expect(bStopped).toBe(1);
    expect(bStarted).toBe(1);
    expect((a as unknown as { flapPreventer: boolean }).flapPreventer).toBe(
      true,
    );
    expect((b as unknown as { flapPreventer: boolean }).flapPreventer).toBe(
      false,
    );
  });

  test("short-circuits a concurrent restart on the same instance", async () => {
    const testApi = buildTestAPI();

    let stops = 0;
    let starts = 0;
    (testApi as unknown as { stop: () => Promise<void> }).stop = async () => {
      stops++;
    };
    (testApi as unknown as { start: () => Promise<void> }).start = async () => {
      starts++;
    };

    (testApi as unknown as { flapPreventer: boolean }).flapPreventer = true;
    await testApi.restart();

    expect(stops).toBe(0);
    expect(starts).toBe(0);
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
