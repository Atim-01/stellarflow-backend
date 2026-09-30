import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import { circuitBreakerWebhookService, CircuitBreakerEvent } from "../src/services/circuitBreakerWebhook.js";

vi.mock("../lib/httpClient.js", () => ({
  httpClient: {
    post: vi.fn(),
  },
}));

vi.mock("../lib/prisma.js", () => ({
  default: {
    webhookEndpoint: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("../utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    networkError: vi.fn(),
  },
}));

import { httpClient } from "../lib/httpClient.js";
import prisma from "../lib/prisma.js";

describe("CircuitBreakerWebhookService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    circuitBreakerWebhookService.invalidateCache();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  const mockEndpoints = [
    {
      id: "endpoint-1",
      name: "Test Endpoint 1",
      url: "https://webhook.example.com/1",
      hmacSecret: "test-secret-key-123456789012345678901234",
      events: ["Pause", "CircuitBreakerTriggered"],
      headers: {},
      timeoutMs: 1000,
      maxRetries: 3,
    },
    {
      id: "endpoint-2",
      name: "Test Endpoint 2",
      url: "https://webhook.example.com/2",
      hmacSecret: "another-secret-key-123456789012345678901234",
      events: ["CircuitBreakerTriggered"],
      headers: { "X-Custom-Header": "custom-value" },
      timeoutMs: 500,
      maxRetries: 2,
    },
  ];

  const mockEvent: CircuitBreakerEvent = {
    eventType: "CircuitBreakerTriggered",
    contractId: "CABC123",
    transactionHash: "tx-hash-123",
    ledger: 123456,
    timestamp: new Date("2024-01-01T12:00:00Z"),
    details: {
      reason: "Price deviation exceeded threshold",
      triggerPrice: 1.234,
      threshold: 1.0,
    },
  };

  it("should generate correct HMAC signature", () => {
    const payload = JSON.stringify({
      event: "CircuitBreakerTriggered",
      contractId: "CABC123",
      transactionHash: "tx-hash-123",
      ledger: 123456,
      timestamp: "2024-01-01T12:00:00.000Z",
      details: { reason: "Price deviation exceeded threshold" },
    });
    const secret = "test-secret-key-123456789012345678901234";
    const expectedSignature = crypto.createHmac("sha256", secret).update(payload).digest("hex");

    const signature = (circuitBreakerWebhookService as any).generateSignature(payload, secret);

    expect(signature).toBe(expectedSignature);
  });

  it("should create correct payload structure", () => {
    const payload = (circuitBreakerWebhookService as any).createPayload(mockEvent);

    expect(payload).toEqual({
      event: "CircuitBreakerTriggered",
      contractId: "CABC123",
      transactionHash: "tx-hash-123",
      ledger: 123456,
      timestamp: "2024-01-01T12:00:00.000Z",
      details: {
        reason: "Price deviation exceeded threshold",
        triggerPrice: 1.234,
        threshold: 1.0,
      },
    });
  });

  it("should filter endpoints by event type", async () => {
    (prisma.webhookEndpoint.findMany as vi.Mock).mockResolvedValue(mockEndpoints);

    const endpoints = await circuitBreakerWebhookService.getActiveEndpoints("Pause");

    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].id).toBe("endpoint-1");
  });

  it("should include endpoints with wildcard event subscription", async () => {
    const endpointsWithWildcard = [
      {
        ...mockEndpoints[0],
        events: ["*"],
      },
    ];
    (prisma.webhookEndpoint.findMany as vi.Mock).mockResolvedValue(endpointsWithWildcard);

    const endpoints = await circuitBreakerWebhookService.getActiveEndpoints("CircuitBreakerTriggered");

    expect(endpoints).toHaveLength(1);
  });

  it("should dispatch event to matching endpoints", async () => {
    (prisma.webhookEndpoint.findMany as vi.Mock).mockResolvedValue(mockEndpoints);
    (httpClient.post as vi.Mock).mockResolvedValue({ status: 200 });

    await circuitBreakerWebhookService.dispatchEvent(mockEvent);

    expect(httpClient.post).toHaveBeenCalledTimes(1);
    expect(httpClient.post).toHaveBeenCalledWith(
      "https://webhook.example.com/1",
      expect.objectContaining({
        event: "CircuitBreakerTriggered",
        contractId: "CABC123",
        signature: expect.any(String),
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-StellarFlow-Signature": expect.any(String),
          "X-StellarFlow-Event": "CircuitBreakerTriggered",
        }),
        timeout: 1000,
      }),
    );
  });

  it("should not dispatch to endpoints not subscribed to event type", async () => {
    (prisma.webhookEndpoint.findMany as vi.Mock).mockResolvedValue(mockEndpoints);
    (httpClient.post as vi.Mock).mockResolvedValue({ status: 200 });

    const pauseEvent: CircuitBreakerEvent = {
      ...mockEvent,
      eventType: "Pause",
      details: { pausedBy: "admin", reason: "Maintenance" },
    };

    await circuitBreakerWebhookService.dispatchEvent(pauseEvent);

    expect(httpClient.post).toHaveBeenCalledTimes(1);
    expect(httpClient.post).toHaveBeenCalledWith(
      "https://webhook.example.com/1",
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("should include custom headers in webhook request", async () => {
    (prisma.webhookEndpoint.findMany as vi.Mock).mockResolvedValue([mockEndpoints[1]]);
    (httpClient.post as vi.Mock).mockResolvedValue({ status: 200 });

    const cbEvent: CircuitBreakerEvent = {
      ...mockEvent,
      eventType: "CircuitBreakerTriggered",
    };

    await circuitBreakerWebhookService.dispatchEvent(cbEvent);

    expect(httpClient.post).toHaveBeenCalledWith(
      "https://webhook.example.com/2",
      expect.any(Object),
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Custom-Header": "custom-value",
        }),
      }),
    );
  });

  it("should retry on failure with exponential backoff", async () => {
    (prisma.webhookEndpoint.findMany as vi.Mock).mockResolvedValue([mockEndpoints[0]]);
    (httpClient.post as vi.Mock)
      .mockRejectedValueOnce(new Error("Network error"))
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({ status: 200 });

    await circuitBreakerWebhookService.dispatchEvent(mockEvent);

    expect(httpClient.post).toHaveBeenCalledTimes(3);
  });

  it("should handle empty endpoints list gracefully", async () => {
    (prisma.webhookEndpoint.findMany as vi.Mock).mockResolvedValue([]);

    await expect(circuitBreakerWebhookService.dispatchEvent(mockEvent)).resolves.not.toThrow();

    expect(httpClient.post).not.toHaveBeenCalled();
  });

  it("should cache endpoints and refresh after TTL", async () => {
    (prisma.webhookEndpoint.findMany as vi.Mock).mockResolvedValue(mockEndpoints);

    await circuitBreakerWebhookService.getActiveEndpoints("Pause");
    await circuitBreakerWebhookService.getActiveEndpoints("Pause");

    expect(prisma.webhookEndpoint.findMany).toHaveBeenCalledTimes(1);
  });

  it("should invalidate cache when requested", async () => {
    (prisma.webhookEndpoint.findMany as vi.Mock).mockResolvedValue(mockEndpoints);

    await circuitBreakerWebhookService.getActiveEndpoints("Pause");
    circuitBreakerWebhookService.invalidateCache();
    await circuitBreakerWebhookService.getActiveEndpoints("Pause");

    expect(prisma.webhookEndpoint.findMany).toHaveBeenCalledTimes(2);
  });
});