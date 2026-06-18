import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api, CONNECTION_TYPE, Connection } from "../../api";
import { HOOK_TIMEOUT } from "./../setup";

beforeAll(async () => {
  await api.initialize();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

describe("connections initializer", () => {
  test("connections namespace is initialized", () => {
    expect(api.connections).toBeDefined();
    expect(api.connections.connections).toBeInstanceOf(Map);
    expect(typeof api.connections.find).toBe("function");
    expect(typeof api.connections.destroy).toBe("function");
  });

  test("connections Map starts empty", () => {
    expect(api.connections.connections.size).toBe(0);
  });

  test("find returns undefined connection when not found", () => {
    const result = api.connections.find("web", "127.0.0.1", "nonexistent");
    expect(result.connection).toBeUndefined();
  });

  test("can add and find a connection", () => {
    const connection = new Connection(CONNECTION_TYPE.WEB, "127.0.0.1");
    api.connections.connections.set(connection.id, connection);

    const result = api.connections.find("web", "127.0.0.1", connection.id);
    expect(result.connection).toBe(connection);
  });

  test("find matches on type, identifier, and id", () => {
    const connection = new Connection(CONNECTION_TYPE.WEB, "127.0.0.1");
    api.connections.connections.set(connection.id, connection);

    // Wrong type
    expect(
      api.connections.find("ws", "127.0.0.1", connection.id).connection,
    ).toBeUndefined();
    // Wrong identifier
    expect(
      api.connections.find("web", "192.168.1.1", connection.id).connection,
    ).toBeUndefined();
    // Wrong id
    expect(
      api.connections.find("web", "127.0.0.1", "wrong-id").connection,
    ).toBeUndefined();
    // All correct
    expect(
      api.connections.find("web", "127.0.0.1", connection.id).connection,
    ).toBe(connection);
  });

  test("destroy removes a connection and returns it", () => {
    const connection = new Connection(CONNECTION_TYPE.WEB, "10.0.0.1");
    api.connections.connections.set(connection.id, connection);

    const destroyed = api.connections.destroy("web", "10.0.0.1", connection.id);
    expect(destroyed).toHaveLength(1);
    expect(destroyed[0]).toBe(connection);
    expect(api.connections.connections.has(connection.id)).toBe(false);
  });

  test("destroy returns empty array for non-existent connection", () => {
    const destroyed = api.connections.destroy("web", "0.0.0.0", "nonexistent");
    expect(destroyed).toHaveLength(0);
  });

  test("multiple connections can coexist", () => {
    // Clean up from previous tests
    api.connections.connections.clear();

    const conn1 = new Connection(CONNECTION_TYPE.WEB, "10.0.0.1");
    const conn2 = new Connection(CONNECTION_TYPE.WEBSOCKET, "10.0.0.2");
    const conn3 = new Connection(CONNECTION_TYPE.WEB, "10.0.0.3");

    api.connections.connections.set(conn1.id, conn1);
    api.connections.connections.set(conn2.id, conn2);
    api.connections.connections.set(conn3.id, conn3);

    expect(api.connections.connections.size).toBe(3);
    expect(api.connections.find("web", "10.0.0.1", conn1.id).connection).toBe(
      conn1,
    );
    expect(
      api.connections.find("websocket", "10.0.0.2", conn2.id).connection,
    ).toBe(conn2);
    expect(api.connections.find("web", "10.0.0.3", conn3.id).connection).toBe(
      conn3,
    );

    // Clean up
    api.connections.connections.clear();
  });
});
