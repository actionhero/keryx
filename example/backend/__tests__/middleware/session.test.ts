import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api, CONNECTION_TYPE, Connection, ErrorType, TypedError } from "keryx";
import { SessionMiddleware } from "../../middleware/session";
import { HOOK_TIMEOUT } from "./../setup";

beforeAll(async () => {
  await api.start();
  await api.db.clearDatabase();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

describe("SessionMiddleware", () => {
  describe("runBefore", () => {
    test("throws TypedError when connection.session is undefined", async () => {
      const connection = new Connection(CONNECTION_TYPE.WEB, "test-identifier");
      connection.session = undefined;

      try {
        await SessionMiddleware.runBefore!({}, connection);
        expect(true).toBe(false); // Should not reach here
      } catch (e) {
        expect(e).toBeInstanceOf(TypedError);
        expect((e as TypedError).message).toBe("Session not found");
        expect((e as TypedError).type).toBe(
          ErrorType.CONNECTION_SESSION_NOT_FOUND,
        );
      }
    });

    test("throws TypedError when connection.session.data is empty", async () => {
      const connection = new Connection(CONNECTION_TYPE.WEB, "test-identifier");
      connection.session = {
        id: "test-session-id",
        cookieName: "sessionId",
        createdAt: Date.now(),
        data: {},
      };

      try {
        await SessionMiddleware.runBefore!({}, connection);
        expect(true).toBe(false); // Should not reach here
      } catch (e) {
        expect(e).toBeInstanceOf(TypedError);
        expect((e as TypedError).message).toBe("Session not found");
        expect((e as TypedError).type).toBe(
          ErrorType.CONNECTION_SESSION_NOT_FOUND,
        );
      }
    });

    test("throws TypedError when connection.session.data.userId is undefined", async () => {
      const connection = new Connection(CONNECTION_TYPE.WEB, "test-identifier");
      connection.session = {
        id: "test-session-id",
        cookieName: "sessionId",
        createdAt: Date.now(),
        data: { someOtherField: "value" },
      };

      try {
        await SessionMiddleware.runBefore!({}, connection);
        expect(true).toBe(false); // Should not reach here
      } catch (e) {
        expect(e).toBeInstanceOf(TypedError);
        expect((e as TypedError).message).toBe("Session not found");
        expect((e as TypedError).type).toBe(
          ErrorType.CONNECTION_SESSION_NOT_FOUND,
        );
      }
    });

    test("throws TypedError when connection.session.data.userId is null", async () => {
      const connection = new Connection(CONNECTION_TYPE.WEB, "test-identifier");
      connection.session = {
        id: "test-session-id",
        cookieName: "sessionId",
        createdAt: Date.now(),
        data: { userId: null },
      };

      try {
        await SessionMiddleware.runBefore!({}, connection);
        expect(true).toBe(false); // Should not reach here
      } catch (e) {
        expect(e).toBeInstanceOf(TypedError);
        expect((e as TypedError).message).toBe("Session not found");
        expect((e as TypedError).type).toBe(
          ErrorType.CONNECTION_SESSION_NOT_FOUND,
        );
      }
    });

    test("allows request when valid session exists", async () => {
      const connection = new Connection(CONNECTION_TYPE.WEB, "test-identifier");
      connection.session = {
        id: "test-session-id",
        cookieName: "sessionId",
        createdAt: Date.now(),
        data: { userId: 1 },
      };

      // Should not throw
      const result = await SessionMiddleware.runBefore!({}, connection);
      expect(result).toBeUndefined();
    });

    test("allows request with valid userId as string", async () => {
      const connection = new Connection(CONNECTION_TYPE.WEB, "test-identifier");
      connection.session = {
        id: "test-session-id",
        cookieName: "sessionId",
        createdAt: Date.now(),
        data: { userId: "123" },
      };

      // Should not throw
      const result = await SessionMiddleware.runBefore!({}, connection);
      expect(result).toBeUndefined();
    });

    test("error has correct type", async () => {
      const connection = new Connection(CONNECTION_TYPE.WEB, "test-identifier");
      connection.session = undefined;

      try {
        await SessionMiddleware.runBefore!({}, connection);
        expect(true).toBe(false); // Should not reach here
      } catch (e) {
        expect(e).toBeInstanceOf(TypedError);
        const typedError = e as TypedError;
        expect(typedError.type).toBe(ErrorType.CONNECTION_SESSION_NOT_FOUND);
        expect(typedError.message).toBe("Session not found");
      }
    });

    test("error message is exactly 'Session not found'", async () => {
      const connection = new Connection(CONNECTION_TYPE.WEB, "test-identifier");
      connection.session = {
        id: "test-id",
        cookieName: "sessionId",
        createdAt: Date.now(),
        data: {},
      };

      try {
        await SessionMiddleware.runBefore!({}, connection);
        expect(true).toBe(false);
      } catch (e) {
        expect((e as TypedError).message).toBe("Session not found");
      }
    });
  });
});
