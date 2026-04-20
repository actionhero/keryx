import { expect } from "bun:test";
import { api } from "../api";
import type { WebServer } from "../servers/web";

const wsUrl = () => {
  const web = api.servers.servers.find(
    (s: { name: string }) => s.name === "web",
  ) as WebServer | undefined;
  return (web?.url || "")
    .replace("https://", "wss://")
    .replace("http://", "ws://");
};

/**
 * Open a WebSocket against the running test server and return the socket along
 * with a mutable array that accumulates every `message` event as it arrives.
 *
 * The promise resolves once the socket's `open` event fires, so callers can
 * immediately send actions without an additional readiness check.
 *
 * @param options.headers - Request headers to include in the WebSocket upgrade
 *   (for example a session cookie). Optional.
 * @returns An object with the open `socket` and the live `messages` array that
 *   every subsequent handler populates.
 */
export const buildWebSocket = async (
  options: { headers?: Record<string, string> } = {},
) => {
  const socket = new WebSocket(wsUrl(), { headers: options.headers });
  const messages: MessageEvent[] = [];
  socket.addEventListener("message", (event) => {
    messages.push(event);
  });
  socket.addEventListener("error", (event) => {
    console.error(event);
  });
  await new Promise((resolve) => {
    socket.addEventListener("open", resolve);
  });
  return { socket, messages };
};

/**
 * Send a `user:create` action over the given WebSocket and return the created
 * user from the server's response.
 *
 * Assumes this is the first action sent on the socket — it reads `messages[0]`.
 *
 * @throws {Error} If the server responds with an error payload.
 */
export const createUser = async (
  socket: WebSocket,
  messages: MessageEvent[],
  name: string,
  email: string,
  password: string,
) => {
  socket.send(
    JSON.stringify({
      messageType: "action",
      action: "user:create",
      messageId: 1,
      params: { name, email, password },
    }),
  );

  while (messages.length === 0) await Bun.sleep(10);
  const response = JSON.parse(messages[0].data);

  if (response.error) {
    throw new Error(`User creation failed: ${response.error.message}`);
  }

  return response.response.user;
};

/**
 * Send a `session:create` action over the given WebSocket and return the
 * response payload (user + session).
 *
 * Assumes `createUser` was invoked first — it reads `messages[1]`.
 *
 * @throws {Error} If the server responds with an error payload.
 */
export const createSession = async (
  socket: WebSocket,
  messages: MessageEvent[],
  email: string,
  password: string,
) => {
  socket.send(
    JSON.stringify({
      messageType: "action",
      action: "session:create",
      messageId: 2,
      params: { email, password },
    }),
  );

  while (messages.length < 2) await Bun.sleep(10);
  const response = JSON.parse(messages[1].data);

  if (response.error) {
    throw new Error(`Session creation failed: ${response.error.message}`);
  }

  return response.response;
};

/**
 * Subscribe the socket to a channel and wait for the server's subscribe
 * confirmation.
 *
 * Matches the confirmation by content rather than index, because presence
 * broadcast events (join/leave) delivered via Redis pub/sub can arrive before
 * the subscribe confirmation and shift message indices.
 */
export const subscribeToChannel = async (
  socket: WebSocket,
  messages: MessageEvent[],
  channel: string,
) => {
  socket.send(JSON.stringify({ messageType: "subscribe", channel }));

  let response: Record<string, any> | undefined;
  while (!response) {
    for (const m of messages) {
      const parsed = JSON.parse(m.data);
      if (parsed.subscribed?.channel === channel) {
        response = parsed;
        break;
      }
    }
    if (!response) await Bun.sleep(10);
  }
  return response;
};

/**
 * Wait briefly and return all broadcast (non-action-reply) messages received on
 * the socket so far, asserting the expected count.
 *
 * Broadcasts are distinguished from action replies by the absence of a
 * `messageId` field. Uses `expect()` internally so callers see a readable
 * failure with the raw broadcast payload dumped to stderr on mismatch.
 *
 * @throws {Error} When the observed broadcast count does not equal
 *   `expectedCount`.
 */
export const waitForBroadcastMessages = async (
  messages: MessageEvent[],
  expectedCount: number,
) => {
  await Bun.sleep(100);

  const broadcastMessages: Record<string, any>[] = [];
  for (const message of messages) {
    const parsedMessage = JSON.parse(message.data);
    if (!parsedMessage.messageId) {
      broadcastMessages.push(parsedMessage);
    }
  }

  try {
    expect(broadcastMessages.length).toBe(expectedCount);
  } catch (e) {
    console.error(JSON.stringify(broadcastMessages, null, 2));
    throw e;
  }
  return broadcastMessages;
};
