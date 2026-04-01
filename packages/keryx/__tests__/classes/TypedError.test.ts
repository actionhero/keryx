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

  test("originalError as Error preserves its stack trace", () => {
    const original = new Error("root cause");
    const err = new TypedError({
      message: "wrapped",
      type: ErrorType.CONNECTION_ACTION_RUN,
      originalError: original,
    });
    expect(err.stack).toBe(original.stack);
  });

  test("originalError as non-Error formats as OriginalStringError", () => {
    const err = new TypedError({
      message: "wrapped",
      type: ErrorType.CONNECTION_ACTION_RUN,
      originalError: "something went wrong",
    });
    expect(err.stack).toBe("OriginalStringError: something went wrong");
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
