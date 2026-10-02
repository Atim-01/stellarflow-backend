import prisma from "../lib/prisma";
import { httpClient } from "../lib/httpClient";
import { createFetcherLogger } from "../utils/logger";
import { OUTGOING_HTTP_TIMEOUT_MS } from "../utils/httpTimeout";

export type AnchorWebhookDeliveryStatus =
  | "queued"
  | "sending"
  | "succeeded"
  | "retrying"
  | "failed";

export interface AnchorWebhookDeliveryRequest {
  id?: string;
  eventType: string;
  endpoint: string;
  payload: Record<string, unknown> | unknown[] | string | number | boolean | null;
  headers?: Record<string, string>;
  maxAttempts?: number;
  createdAt?: Date;
}

export interface AnchorWebhookDeliveryReceipt {
  id: number;
  eventType: string;
  endpoint: string;
  payload: unknown;
  status: AnchorWebhookDeliveryStatus;
  attempts: number;
  maxAttempts: number;
  responseStatus: number | null;
  responseBody: unknown;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface QueuedDelivery extends AnchorWebhookDeliveryRequest {
  attempts: number;
  status: AnchorWebhookDeliveryStatus;
  nextAttemptAt: number;
  id: string;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_INITIAL_RETRY_MS = 1_000;
const DEFAULT_MAX_RETRY_MS = 30_000;

function getRetryDelay(attemptNumber: number): number {
  return Math.min(
    DEFAULT_INITIAL_RETRY_MS * 2 ** Math.max(0, attemptNumber - 1),
    DEFAULT_MAX_RETRY_MS,
  );
}

export class AnchorWebhookRelayerService {
  private readonly logger = createFetcherLogger("AnchorWebhookRelayer");
  private readonly queue: QueuedDelivery[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  constructor(private readonly pollIntervalMs = 1_000) {}

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    await this.ensureDeliveryTable();

    this.timer = setInterval(() => {
      void this.processQueue().catch((error: unknown) => {
        this.logger.error("Anchor webhook worker loop failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.pollIntervalMs);

    this.logger.info("Anchor webhook relayer started", {
      pollIntervalMs: this.pollIntervalMs,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    this.logger.info("Anchor webhook relayer stopped");
  }

  async enqueueDelivery(request: AnchorWebhookDeliveryRequest): Promise<string> {
    const delivery: QueuedDelivery = {
      id: request.id ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      eventType: request.eventType,
      endpoint: request.endpoint,
      payload: request.payload,
      headers: request.headers ?? {},
      maxAttempts: request.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      attempts: 0,
      status: "queued",
      nextAttemptAt: Date.now(),
      createdAt: request.createdAt ?? new Date(),
    };

    this.queue.push(delivery);
    await this.persistReceipt(delivery, "queued", null, null, null);
    return delivery.id;
  }

  private async processQueue(): Promise<void> {
    if (!this.isRunning || this.queue.length === 0) {
      return;
    }

    const now = Date.now();
    const ready = this.queue
      .filter((delivery) => delivery.nextAttemptAt <= now)
      .sort((left, right) => left.nextAttemptAt - right.nextAttemptAt);

    for (const delivery of ready) {
      await this.dispatchDelivery(delivery);
    }
  }

  private async dispatchDelivery(delivery: QueuedDelivery): Promise<void> {
    const attemptNumber = delivery.attempts + 1;
    const maxAttempts = Math.max(1, delivery.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);

    if (attemptNumber > maxAttempts) {
      await this.persistReceipt(
        delivery,
        "failed",
        null,
        null,
        "Max attempts exceeded",
      );
      return;
    }

    delivery.status = "sending";
    delivery.attempts = attemptNumber;
    await this.persistReceipt(
      delivery,
      "sending",
      null,
      null,
      null,
    );

    try {
      const response = await httpClient.post(delivery.endpoint, delivery.payload, {
        headers: {
          "Content-Type": "application/json",
          ...(delivery.headers ?? {}),
        },
        timeout: OUTGOING_HTTP_TIMEOUT_MS,
      });

      const statusCode = response?.status ?? 0;
      const responseBody = response?.data ?? null;

      if (statusCode >= 200 && statusCode < 300) {
        delivery.status = "succeeded";
        delivery.nextAttemptAt = Date.now();
        await this.persistReceipt(
          delivery,
          "succeeded",
          statusCode,
          responseBody,
          null,
        );
        this.removeQueuedDelivery(delivery.id);
        return;
      }

      if (statusCode >= 500 && attemptNumber < maxAttempts) {
        delivery.status = "retrying";
        delivery.nextAttemptAt =
          Date.now() + getRetryDelay(attemptNumber);
        await this.persistReceipt(
          delivery,
          "retrying",
          statusCode,
          responseBody,
          `HTTP ${statusCode}`,
        );
        return;
      }

      delivery.status = "failed";
      delivery.nextAttemptAt = Date.now();
      await this.persistReceipt(
        delivery,
        "failed",
        statusCode,
        responseBody,
        `HTTP ${statusCode}`,
      );
      this.removeQueuedDelivery(delivery.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (attemptNumber < maxAttempts) {
        delivery.status = "retrying";
        delivery.nextAttemptAt =
          Date.now() + getRetryDelay(attemptNumber);
        await this.persistReceipt(
          delivery,
          "retrying",
          null,
          null,
          message,
        );
        return;
      }

      delivery.status = "failed";
      delivery.nextAttemptAt = Date.now();
      await this.persistReceipt(
        delivery,
        "failed",
        null,
        null,
        message,
      );
      this.removeQueuedDelivery(delivery.id);
    }
  }

  private removeQueuedDelivery(id: string): void {
    const index = this.queue.findIndex((delivery) => delivery.id === id);
    if (index >= 0) {
      this.queue.splice(index, 1);
    }
  }

  private async ensureDeliveryTable(): Promise<void> {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS anchor_webhook_delivery_receipts (
        id SERIAL PRIMARY KEY,
        event_type TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        status TEXT NOT NULL DEFAULT 'queued',
        attempts INT NOT NULL DEFAULT 0,
        max_attempts INT NOT NULL DEFAULT 5,
        response_status INT,
        response_body JSONB,
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  private async persistReceipt(
    delivery: QueuedDelivery,
    status: AnchorWebhookDeliveryStatus,
    responseStatus: number | null,
    responseBody: unknown,
    errorMessage: string | null,
  ): Promise<void> {
    try {
      await prisma.$executeRawUnsafe(
        `
          INSERT INTO anchor_webhook_delivery_receipts (
            event_type,
            endpoint,
            payload,
            status,
            attempts,
            max_attempts,
            response_status,
            response_body,
            error_message,
            created_at,
            updated_at
          ) VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            NOW(),
            NOW()
          )
          ON CONFLICT DO NOTHING;
        `,
        delivery.eventType,
        delivery.endpoint,
        JSON.stringify(delivery.payload ?? null),
        status,
        delivery.attempts,
        delivery.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        responseStatus,
        responseBody ? JSON.stringify(responseBody) : null,
        errorMessage,
      );

      await prisma.$executeRawUnsafe(
        `
          UPDATE anchor_webhook_delivery_receipts
          SET status = $1,
              attempts = $2,
              max_attempts = $3,
              response_status = $4,
              response_body = $5,
              error_message = $6,
              updated_at = NOW()
          WHERE event_type = $7
            AND endpoint = $8
            AND created_at = (
              SELECT MIN(created_at)
              FROM anchor_webhook_delivery_receipts
              WHERE event_type = $7
                AND endpoint = $8
                AND status IN ('queued', 'sending', 'retrying', 'succeeded', 'failed')
            );
        `,
        status,
        delivery.attempts,
        delivery.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        responseStatus,
        responseBody ? JSON.stringify(responseBody) : null,
        errorMessage,
        delivery.eventType,
        delivery.endpoint,
      );
    } catch (error) {
      this.logger.warn("Receipt persistence failed", {
        eventType: delivery.eventType,
        endpoint: delivery.endpoint,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export const anchorWebhookRelayerService = new AnchorWebhookRelayerService();
export default anchorWebhookRelayerService;
