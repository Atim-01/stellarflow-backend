import { Router, Request, Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { circuitBreakerWebhookService } from "../services/circuitBreakerWebhook.js";
import { requireAdmin } from "../middleware/roleMatrixMiddleware.js";
import { logger } from "../utils/logger.js";

const router = Router();

const webhookEndpointSchema = z.object({
  name: z.string().min(1).max(100),
  url: z.string().url(),
  hmacSecret: z.string().min(32).max(256),
  events: z.array(z.enum(["Pause", "CircuitBreakerTriggered", "*"])).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().min(100).max(10000).default(1000),
  maxRetries: z.number().int().min(0).max(10).default(3),
  isActive: z.boolean().default(true),
});

const updateWebhookEndpointSchema = webhookEndpointSchema.partial();

router.get("/", requireAdmin, async (req: Request, res: Response) => {
  try {
    const endpoints = await prisma.webhookEndpoint.findMany({
      orderBy: { createdAt: "desc" },
    });

    const sanitized = endpoints.map((ep: typeof endpoints[0]) => ({
      ...ep,
      hmacSecret: "***",
    }));

    res.json(sanitized);
  } catch (error) {
    logger.error("Failed to fetch webhook endpoints:", error);
    res.status(500).json({ error: "Failed to fetch webhook endpoints" });
  }
});

router.get("/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const endpoint = await prisma.webhookEndpoint.findUnique({
      where: { id: req.params.id },
    });

    if (!endpoint) {
      return res.status(404).json({ error: "Webhook endpoint not found" });
    }

    const sanitized = {
      ...endpoint,
      hmacSecret: "***",
    };

    res.json(sanitized);
  } catch (error) {
    logger.error("Failed to fetch webhook endpoint:", error);
    res.status(500).json({ error: "Failed to fetch webhook endpoint" });
  }
});

router.post("/", requireAdmin, async (req: Request, res: Response) => {
  try {
    const parsed = webhookEndpointSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { headers, events, ...data } = parsed.data;

    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        ...data,
        events: events ?? ["Pause", "CircuitBreakerTriggered"],
        headers: headers ? JSON.stringify(headers) : null,
      },
    });

    circuitBreakerWebhookService.invalidateCache();

    const sanitized = { ...endpoint, hmacSecret: "***" };
    res.status(201).json(sanitized);
  } catch (error) {
    logger.error("Failed to create webhook endpoint:", error);
    res.status(500).json({ error: "Failed to create webhook endpoint" });
  }
});

router.patch("/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const parsed = updateWebhookEndpointSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { headers, ...data } = parsed.data;

    const endpoint = await prisma.webhookEndpoint.update({
      where: { id: req.params.id },
      data: {
        ...data,
        headers: headers ? JSON.stringify(headers) : undefined,
      },
    });

    circuitBreakerWebhookService.invalidateCache();

    const sanitized = { ...endpoint, hmacSecret: "***" };
    res.json(sanitized);
  } catch (error) {
    logger.error("Failed to update webhook endpoint:", error);
    res.status(500).json({ error: "Failed to update webhook endpoint" });
  }
});

router.delete("/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    await prisma.webhookEndpoint.delete({
      where: { id: req.params.id },
    });

    circuitBreakerWebhookService.invalidateCache();

    res.status(204).send();
  } catch (error) {
    logger.error("Failed to delete webhook endpoint:", error);
    res.status(500).json({ error: "Failed to delete webhook endpoint" });
  }
});

router.post("/:id/test", requireAdmin, async (req: Request, res: Response) => {
  try {
    const endpoint = await prisma.webhookEndpoint.findUnique({
      where: { id: req.params.id },
    });

    if (!endpoint) {
      return res.status(404).json({ error: "Webhook endpoint not found" });
    }

    const testEvent = {
      eventType: "Pause" as const,
      contractId: endpoint.url.includes("test") ? "test-contract" : process.env.CONTRACT_ID ?? "unknown",
      transactionHash: "test-tx-hash",
      ledger: 123456,
      timestamp: new Date(),
      details: { test: true, message: "This is a test webhook from StellarFlow" },
    };

    await circuitBreakerWebhookService.dispatchEvent(testEvent);

    res.json({ success: true, message: "Test webhook dispatched" });
  } catch (error) {
    logger.error("Failed to send test webhook:", error);
    res.status(500).json({ error: "Failed to send test webhook" });
  }
});

export default router;