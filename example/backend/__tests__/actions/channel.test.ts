import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type ActionResponse, api, Channel } from "keryx";
import type { ChannelMembers } from "../../actions/channel";
import type { SessionCreate } from "../../actions/session";
import {
  buildWebSocket,
  createSession,
  createTestSession,
  createTestUser,
  createUser,
  subscribeToChannel,
  useTestServer,
} from "./../setup";

const getUrl = useTestServer({ clearDatabase: true, clearRedis: true });

describe("channel:members", () => {
  let session: ActionResponse<SessionCreate>["session"];

  beforeAll(async () => {
    await createTestUser(getUrl());
    const sessionRes = await createTestSession(getUrl());
    const sessionResponse =
      (await sessionRes.json()) as ActionResponse<SessionCreate>;
    session = sessionResponse.session;
  });

  beforeEach(async () => {
    // Clear any leftover presence data
    await api.channels.clearPresence();
  });

  test("rejects invalid channel name", async () => {
    const res = await fetch(
      getUrl() +
        "/api/channel/" +
        encodeURIComponent("bad channel!@#") +
        "/members",
      {
        method: "GET",
        headers: {
          Cookie: `${session.cookieName}=${session.id}`,
        },
      },
    );
    expect(res.status).toBe(406);
    const response = (await res.json()) as ActionResponse<ChannelMembers>;
    expect(response.error).toBeDefined();
  });

  test("fails without a session", async () => {
    const res = await fetch(getUrl() + "/api/channel/messages/members", {
      method: "GET",
    });
    expect(res.status).toBe(401);
    const response = (await res.json()) as ActionResponse<ChannelMembers>;
    expect(response.error?.message).toEqual("Session not found");
  });

  test("returns empty members for a channel with no subscribers", async () => {
    const res = await fetch(
      getUrl() + "/api/channel/some-empty-channel/members",
      {
        method: "GET",
        headers: {
          Cookie: `${session.cookieName}=${session.id}`,
        },
      },
    );
    expect(res.status).toBe(200);
    const response = (await res.json()) as ActionResponse<ChannelMembers>;
    expect(response.members).toEqual([]);
  });

  test("returns members after a WebSocket client subscribes", async () => {
    const { socket, messages } = await buildWebSocket();

    await createUser(
      socket,
      messages,
      "Luigi",
      "luigi@example.com",
      "mushroom1",
    );
    await createSession(socket, messages, "luigi@example.com", "mushroom1");
    await subscribeToChannel(socket, messages, "messages");

    const res = await fetch(getUrl() + "/api/channel/messages/members", {
      method: "GET",
      headers: {
        Cookie: `${session.cookieName}=${session.id}`,
      },
    });
    expect(res.status).toBe(200);
    const response = (await res.json()) as ActionResponse<ChannelMembers>;
    expect(response.members.length).toBeGreaterThanOrEqual(1);

    socket.close();
    await Bun.sleep(100);
  });

  test("member is removed after disconnect", async () => {
    // Register a temporary open channel for this test
    class TestChannel extends Channel {
      constructor() {
        super({ name: "test-channel" });
      }
    }
    const testChannel = new TestChannel();
    api.channels.channels.push(testChannel);

    try {
      const { socket, messages } = await buildWebSocket();

      await createUser(
        socket,
        messages,
        "Toad",
        "toad@example.com",
        "mushroom1",
      );
      await createSession(socket, messages, "toad@example.com", "mushroom1");
      await subscribeToChannel(socket, messages, "test-channel");

      // Verify member is present
      let res = await fetch(getUrl() + "/api/channel/test-channel/members", {
        method: "GET",
        headers: {
          Cookie: `${session.cookieName}=${session.id}`,
        },
      });
      let response = (await res.json()) as ActionResponse<ChannelMembers>;
      expect(response.members.length).toBe(1);

      // Disconnect
      socket.close();
      await Bun.sleep(100);

      // Verify member is removed
      res = await fetch(getUrl() + "/api/channel/test-channel/members", {
        method: "GET",
        headers: {
          Cookie: `${session.cookieName}=${session.id}`,
        },
      });
      response = (await res.json()) as ActionResponse<ChannelMembers>;
      expect(response.members).toEqual([]);
    } finally {
      const idx = api.channels.channels.indexOf(testChannel);
      if (idx !== -1) api.channels.channels.splice(idx, 1);
    }
  });
});
