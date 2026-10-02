import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import webhookEndpointsRouter from "../src/routes/webhookEndpoints.js";
import { circuitBreakerWebhookService } from "../src/services/circuitBreakerWebhook.js";

vi.mock("../lib/prisma.js", () => ({
  default: {
    webhookEndpoint: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock("../middleware/adminMiddleware.js", () => ({
  requireAdmin: (req: any, res: any, next: any) => next(),
}));

vi.mock("../middleware/adminRateLimitMiddleware.js", () => ({
  adminRateLimitMiddleware: (req: any, res: any, next: any) => next(),
}));

vi.mock("../services/circuitBreakerWebhook.js", () => ({
  circuitBreakerWebhookService: {
    invalidateCache: vi.fn(),
    dispatchEvent: vi.fn(),
  },
}));

import prisma from "../lib/prisma.js";

const app = express();
app.use(express.json());
app.use("/api/admin/webhook-endpoints", webhookEndpointsRouter);

describe("Webhook Endpoints API Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockEndpoint = {
    id: "test-id-123",
    name: "Test Endpoint",
    url: "https://webhook.example.com/test",
    hmacSecret: "test-secret-key-123456789012345678901234",
    events: ["Pause", "CircuitBreakerTriggered"],
    headers: JSON.stringify({ "X-Custom": "value" }),
    timeoutMs: 1000,
    maxRetries: 3,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  describe("GET /api/admin/webhook-endpoints", () => {
    it("should return list of webhook endpoints with sanitized secrets", async () => {
      (prisma.webhookEndpoint.findMany as vi.Mock).mockResolvedValue([mockEndpoint]);

      const response = await request(app)
        .get("/api/admin/webhook-endpoints")
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0].hmacSecret).toBe("***");
      expect(response.body[0].name).toBe("Test Endpoint");
    });
  });

  describe("GET /api/admin/webhook-endpoints/:id", () => {
    it("should return single webhook endpoint", async () => {
      (prisma.webhookEndpoint.findUnique as vi.Mock).mockResolvedValue(mockEndpoint);

      const response = await request(app)
        .get("/api/admin/webhook-endpoints/test-id-123")
        .expect(200);

      expect(response.body.hmacSecret).toBe("***");
      expect(response.body.id).toBe("test-id-123");
    });

    it("should return 404 for non-existent endpoint", async () => {
      (prisma.webhookEndpoint.findUnique as vi.Mock).mockResolvedValue(null);

      await request(app)
        .get("/api/admin/webhook-endpoints/non-existent")
        .expect(404);
    });
  });

  describe("POST /api/admin/webhook-endpoints", () => {
    it("should create new webhook endpoint", async () => {
      (prisma.webhookEndpoint.create as vi.Mock).mockResolvedValue(mockEndpoint);

      const response = await request(app)
        .post("/api/admin/webhook-endpoints")
        .send({
          name: "Test Endpoint",
          url: "https://webhook.example.com/test",
          hmacSecret: "test-secret-key-123456789012345678901234",
          events: ["Pause", "CircuitBreakerTriggered"],
          timeoutMs: 1000,
          maxRetries: 3,
        })
        .expect(201);

      expect(response.body.hmacSecret).toBe("***");
      expect(prisma.webhookEndpoint.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: "Test Endpoint",
            url: "https://webhook.example.com/test",
          }),
        }),
      );
    });

    it("should validate required fields", async () => {
      await request(app)
        .post("/api/admin/webhook-endpoints")
        .send({})
        .expect(400);
    });

    it("should validate URL format", async () => {
      await request(app)
        .post("/api/admin/webhook-endpoints")
        .send({
          name: "Test",
          url: "not-a-url",
          hmacSecret: "test-secret-key-123456789012345678901234",
        })
        .expect(400);
    });

    it("should validate HMAC secret minimum length", async () => {
      await request(app)
        .post("/api/admin/webhook-endpoints")
        .send({
          name: "Test",
          url: "https://webhook.example.com/test",
          hmacSecret: "short",
        })
        .expect(400);
    });
  });

  describe("PATCH /api/admin/webhook-endpoints/:id", () => {
    it("should update webhook endpoint", async () => {
      const updatedEndpoint = { ...mockEndpoint, name: "Updated Name" };
      (prisma.webhookEndpoint.update as vi.Mock).mockResolvedValue(updatedEndpoint);

      const response = await request(app)
        .patch("/api/admin/webhook-endpoints/test-id-123")
        .send({ name: "Updated Name" })
        .expect(200);

      expect(response.body.name).toBe("Updated Name");
      expect(prisma.webhookEndpoint.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "test-id-123" },
        }),
      );
    });
  });

  describe("DELETE /api/admin/webhook-endpoints/:id", () => {
    it("should delete webhook endpoint", async () => {
      (prisma.webhookEndpoint.delete as vi.Mock).mockResolvedValue({});

      await request(app)
        .delete("/api/admin/webhook-endpoints/test-id-123")
        .expect(204);

      expect(prisma.webhookEndpoint.delete).toHaveBeenCalledWith({
        where: { id: "test-id-123" },
      });
    });
  });

  describe("POST /api/admin/webhook-endpoints/:id/test", () => {
    it("should send test webhook", async () => {
      (prisma.webhookEndpoint.findUnique as vi.Mock).mockResolvedValue(mockEndpoint);
      (circuitBreakerWebhookService.dispatchEvent as vi.Mock).mockResolvedValue(undefined);

      const response = await request(app)
        .post("/api/admin/webhook-endpoints/test-id-123/test")
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(circuitBreakerWebhookService.dispatchEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "Pause",
          details: expect.objectContaining({ test: true }),
        }),
      );
    });

    it("should return 404 for non-existent endpoint", async () => {
      (prisma.webhookEndpoint.findUnique as vi.Mock).mockResolvedValue(null);

      await request(app)
        .post("/api/admin/webhook-endpoints/non-existent/test")
        .expect(404);
    });
  });
});