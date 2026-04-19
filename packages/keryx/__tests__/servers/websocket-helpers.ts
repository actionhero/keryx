import { expect } from "bun:test";
import { api } from "../../api";
import type { WebServer } from "../../servers/web";

const wsUrl = () => {
  const web = api.servers.servers.find(
    (s: { name: string }) => s.name === "web",
  ) as WebServer | undefined;
  return (web?.url || "")
    .replace("https://", "wss://")
    .replace("http://", "ws://");
};

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

export const subscribeToChannel = async (
  socket: WebSocket,
  messages: MessageEvent[],
  channel: string,
) => {
  socket.send(JSON.stringify({ messageType: "subscribe", channel }));

  // Find the subscribe confirmation by content rather than index, because
  // presence broadcast events (join/leave) delivered via Redis pub/sub can
  // arrive before the subscribe confirmation, shifting message indices.
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

export const waitForBroadcastMessages = async (
  messages: MessageEvent[],
  expectedCount: number,
) => {
  await Bun.sleep(100); // Give time for messages to be broadcast

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
