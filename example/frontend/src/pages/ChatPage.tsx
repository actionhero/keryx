import type { ChannelMembers } from "@backend/actions/channel";
import type { MessagesList } from "@backend/actions/message";
import type { ActionResponse } from "keryx";
import { useEffect, useRef, useState } from "react";
import { Badge, Button, Card, Col, Form, Row, Table } from "react-bootstrap";

import { useAuth } from "../hooks/useAuth";
import { API_URL, apiFetch } from "../utils/client";

type Message = ActionResponse<MessagesList>["messages"][number];

let messageCounter = 0;

export default function ChatPage() {
  const { user } = useAuth();
  const [messages, setMessages] = useState<Message[]>([]);
  const [connected, setConnected] = useState(false);
  const [membersOnline, setMembersOnline] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    connect();
    loadMessages();

    return () => {
      wsRef.current?.close();
    };
  }, []);

  function connect() {
    const ws = new WebSocket(API_URL + "/api", "keryx-frontend");
    wsRef.current = ws;

    ws.addEventListener("open", async () => {
      ws.send(
        JSON.stringify({ messageType: "subscribe", channel: "messages" }),
      );
      setConnected(true);

      try {
        const res = await apiFetch<ActionResponse<ChannelMembers>>(
          "/channel/messages/members",
        );
        setMembersOnline(res.members.length);
      } catch {
        // channel members fetch is non-critical
      }
    });

    ws.addEventListener("message", (event) => {
      const response = JSON.parse(event.data);

      if (response.error) {
        setError(response.error.message);
        return;
      }

      if (response.message?.channel === "messages") {
        // Presence events (join/leave)
        try {
          const parsed =
            typeof response.message.message === "string"
              ? JSON.parse(response.message.message)
              : response.message.message;
          if (parsed.event === "join") {
            setMembersOnline((prev) => prev + 1);
            return;
          }
          if (parsed.event === "leave") {
            setMembersOnline((prev) => Math.max(0, prev - 1));
            return;
          }
        } catch {
          // not a presence event
        }

        // Chat message
        const msg = response.message.message.message as Message;
        if (msg) {
          setMessages((prev) =>
            [msg, ...prev]
              .sort((a, b) => b.createdAt - a.createdAt)
              .slice(0, 50),
          );
        }
      }
    });

    ws.addEventListener("close", () => {
      setConnected(false);
    });
  }

  async function loadMessages() {
    try {
      const res =
        await apiFetch<ActionResponse<MessagesList>>("/messages/list");
      setMessages(res.messages);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load messages");
    }
  }

  function sendMessage(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!wsRef.current || !connected) return;

    const form = e.currentTarget;
    const input = form.elements.namedItem("body") as HTMLInputElement;
    const body = input.value.trim();
    if (!body) return;

    messageCounter++;
    wsRef.current.send(
      JSON.stringify({
        messageType: "action",
        action: "message:create",
        messageId: messageCounter,
        params: { body },
      }),
    );

    input.value = "";
  }

  function formatDate(t: number): string {
    return new Date(t).toLocaleString();
  }

  return (
    <>
      <Row className="mb-3">
        <Col>
          <Card>
            <Card.Header className="d-flex justify-content-between align-items-center">
              <h4 className="mb-0">Chat</h4>
              <div>
                <Badge bg={connected ? "success" : "danger"} className="me-2">
                  {connected ? "Connected" : "Disconnected"}
                </Badge>
                <Badge bg="info">{membersOnline} online</Badge>
              </div>
            </Card.Header>
            <Card.Body>
              {error && <div className="text-danger mb-3">{error}</div>}
              <Form onSubmit={sendMessage} className="mb-3">
                <Row>
                  <Col>
                    <Form.Control
                      type="text"
                      name="body"
                      placeholder={`Message as ${user?.name}...`}
                      disabled={!connected}
                      autoComplete="off"
                    />
                  </Col>
                  <Col xs="auto">
                    <Button
                      variant="primary"
                      type="submit"
                      disabled={!connected}
                    >
                      Send
                    </Button>
                  </Col>
                </Row>
              </Form>

              <Table striped bordered hover responsive>
                <thead>
                  <tr>
                    <th style={{ width: "15%" }}>Who</th>
                    <th style={{ width: "20%" }}>When</th>
                    <th>Message</th>
                  </tr>
                </thead>
                <tbody>
                  {messages.map((msg) => (
                    <tr key={msg.id}>
                      <td>
                        <strong>{msg.user_name}</strong>
                      </td>
                      <td className="text-muted">
                        {formatDate(msg.createdAt)}
                      </td>
                      <td>{msg.body}</td>
                    </tr>
                  ))}
                  {messages.length === 0 && (
                    <tr>
                      <td colSpan={3} className="text-center text-muted">
                        No messages yet. Say hello!
                      </td>
                    </tr>
                  )}
                </tbody>
              </Table>
            </Card.Body>
          </Card>
        </Col>
      </Row>
    </>
  );
}
