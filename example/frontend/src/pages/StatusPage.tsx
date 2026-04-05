import type { Status } from "@backend/actions/status";
import type { ActionResponse } from "keryx";
import { useEffect, useState } from "react";
import { Badge, Button, Card, Col, Row, Spinner, Table } from "react-bootstrap";

import { apiFetch } from "../utils/client";

export default function StatusPage() {
  const [status, setStatus] = useState<ActionResponse<Status> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadStatus() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<ActionResponse<Status>>("/status");
      setStatus(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load status");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadStatus();
  }, []);

  function formatUptime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  return (
    <Row className="justify-content-center mt-4">
      <Col md={8} lg={6}>
        <Card>
          <Card.Header className="d-flex justify-content-between align-items-center">
            <h4 className="mb-0">Server Status</h4>
            <Button
              variant="outline-primary"
              size="sm"
              onClick={loadStatus}
              disabled={loading}
            >
              Refresh
            </Button>
          </Card.Header>
          <Card.Body>
            {loading && !status && (
              <div className="text-center py-4">
                <Spinner animation="border" variant="light" />
              </div>
            )}
            {error && (
              <div className="text-center py-4">
                <Badge bg="danger" className="fs-6">
                  {error}
                </Badge>
              </div>
            )}
            {status && (
              <Table striped bordered>
                <tbody>
                  <tr>
                    <td className="fw-bold">Name</td>
                    <td>{status.name}</td>
                  </tr>
                  <tr>
                    <td className="fw-bold">Version</td>
                    <td>
                      <Badge bg="info">{status.version}</Badge>
                    </td>
                  </tr>
                  <tr>
                    <td className="fw-bold">PID</td>
                    <td>
                      <code>{status.pid}</code>
                    </td>
                  </tr>
                  <tr>
                    <td className="fw-bold">Uptime</td>
                    <td>{formatUptime(status.uptime)}</td>
                  </tr>
                  <tr>
                    <td className="fw-bold">Memory</td>
                    <td>{status.consumedMemoryMB.toFixed(1)} MB</td>
                  </tr>
                </tbody>
              </Table>
            )}
          </Card.Body>
        </Card>
      </Col>
    </Row>
  );
}
