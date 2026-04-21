import { describe, expect, test } from "bun:test";
import {
  ErrorStatusCodes,
  ErrorType,
  TypedError,
} from "../../classes/TypedError";

describe("TypedError", () => {
  test("construction preserves message, type, key, and value", () => {
    const err = new TypedError({
      message: "bad input",
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      key: "email",
      value: "not-an-email",
    });

    expect(err.message).toBe("bad input");
    expect(err.type).toBe(ErrorType.CONNECTION_ACTION_PARAM_VALIDATION);
    expect(err.key).toBe("email");
    expect(err.value).toBe("not-an-email");
  });

  test("extends Error", () => {
    const err = new TypedError({
      message: "test",
      type: ErrorType.CONNECTION_SERVER_ERROR,
    });
    expect(err).toBeInstanceOf(Error);
  });

  test("key and value are undefined when omitted", () => {
    const err = new TypedError({
      message: "test",
      type: ErrorType.CONNECTION_SERVER_ERROR,
    });
    expect(err.key).toBeUndefined();
    expect(err.value).toBeUndefined();
  });

  test("cause as Error is exposed on the native ES2022 cause field", () => {
    const original = new Error("root cause");
    const err = new TypedError({
      message: "wrapped",
      type: ErrorType.CONNECTION_ACTION_RUN,
      cause: original,
    });
    expect(err.cause).toBe(original);
    // the wrapper keeps its own stack so the wrap site is not hidden
    expect(err.stack).not.toBe(original.stack);
  });

  test("cause as non-Error value is passed through unchanged", () => {
    const err = new TypedError({
      message: "wrapped",
      type: ErrorType.CONNECTION_ACTION_RUN,
      cause: "something went wrong",
    });
    expect(err.cause).toBe("something went wrong");
  });

  test("cause is undefined when not provided", () => {
    const err = new TypedError({
      message: "no cause here",
      type: ErrorType.CONNECTION_SERVER_ERROR,
    });
    expect(err.cause).toBeUndefined();
  });

  test("ErrorStatusCodes maps each ErrorType to the expected HTTP status", () => {
    // Spot-check critical mappings
    expect(ErrorStatusCodes[ErrorType.SERVER_INITIALIZATION]).toBe(500);
    expect(ErrorStatusCodes[ErrorType.CONNECTION_SESSION_NOT_FOUND]).toBe(401);
    expect(ErrorStatusCodes[ErrorType.CONNECTION_ACTION_NOT_FOUND]).toBe(404);
    expect(ErrorStatusCodes[ErrorType.CONNECTION_ACTION_PARAM_VALIDATION]).toBe(
      406,
    );
    expect(ErrorStatusCodes[ErrorType.CONNECTION_ACTION_TIMEOUT]).toBe(408);
    expect(ErrorStatusCodes[ErrorType.CONNECTION_RATE_LIMITED]).toBe(429);
    expect(ErrorStatusCodes[ErrorType.CONNECTION_CHANNEL_AUTHORIZATION]).toBe(
      403,
    );
    expect(ErrorStatusCodes[ErrorType.CONNECTION_CHANNEL_VALIDATION]).toBe(400);

    // Every ErrorType has a mapping
    for (const type of Object.values(ErrorType)) {
      expect(ErrorStatusCodes[type]).toBeDefined();
    }
  });
});
