import { httpClient } from "../lib/httpClient.js";
import { withRetry } from "../utils/retryUtil.js";
import prisma from "../lib/prisma.js";
import crypto from "crypto";
import { logger } from "../utils/logger.js";

export interface CircuitBreakerEvent {
  eventType: "Pause" | "CircuitBreakerTriggered";
  contractId: string;
  transactionHash: string;
  ledger: number;
  timestamp: Date;
  details: Record<string, unknown>;
}

export interface WebhookPayload {
  event: string;
  contractId: string;
  transactionHash: string;
  ledger: number;
  timestamp: string;
  details: Record<string, unknown>;
  signature: string;
}

interface WebhookEndpointConfig {
  id: string;
  name: string;
  url: string;
  hmacSecret: string;
  events: string[];
  headers?: Record<string, string>;
  timeoutMs: number;
  maxRetries: number;
}

export class CircuitBreakerWebhookService {
  private endpointsCache: Map<string, WebhookEndpointConfig> = new Map();
  private cacheExpiry: number = 0;
  private readonly cacheTtlMs = 60000; // 1 minute cache

  async getActiveEndpoints(eventType: string): Promise<WebhookEndpointConfig[]> {
    const now = Date.now();

    if (now > this.cacheExpiry || this.endpointsCache.size === 0) {
      await this.refreshEndpointsCache();
    }

    const endpoints: WebhookEndpointConfig[] = [];
    for (const [, endpoint] of this.endpointsCache) {
      if (endpoint.events.includes(eventType) || endpoint.events.includes("*")) {
        endpoints.push(endpoint);
      }
    }

    return endpoints;
  }

  private async refreshEndpointsCache(): Promise<void> {
    try {
      const endpoints = await prisma.webhookEndpoint.findMany({
        where: { isActive: true },
        select: {
          id: true,
          name: true,
          url: true,
          hmacSecret: true,
          events: true,
          headers: true,
          timeoutMs: true,
          maxRetries: true,
        },
      });

      this.endpointsCache.clear();
      for (const ep of endpoints) {
        let customHeaders: Record<string, string> = {};
        if (ep.headers) {
          try {
            customHeaders = JSON.parse(ep.headers);
          } catch {
            logger.warn(`Invalid headers JSON for webhook endpoint ${ep.id}`);
          }
        }

        this.endpointsCache.set(ep.id, {
          id: ep.id,
          name: ep.name,
          url: ep.url,
          hmacSecret: ep.hmacSecret,
          events: ep.events,
          headers: customHeaders,
          timeoutMs: ep.timeoutMs,
          maxRetries: ep.maxRetries,
        });
      }

      this.cacheExpiry = Date.now() + this.cacheTtlMs;
      logger.info(`Refreshed webhook endpoints cache: ${this.endpointsCache.size} active endpoints`);
    } catch (error) {
      logger.error("Failed to refresh webhook endpoints cache:", error);
    }
  }

  private generateSignature(payload: string, secret: string): string {
    return crypto.createHmac("sha256", secret).update(payload).digest("hex");
  }

  private createPayload(event: CircuitBreakerEvent): Omit<WebhookPayload, "signature"> {
    return {
      event: event.eventType,
      contractId: event.contractId,
      transactionHash: event.transactionHash,
      ledger: event.ledger,
      timestamp: event.timestamp.toISOString(),
      details: event.details,
    };
  }

  private async sendToEndpoint(
    endpoint: WebhookEndpointConfig,
    payload: Omit<WebhookPayload, "signature">,
  ): Promise<boolean> {
    const payloadString = JSON.stringify(payload);
    const signature = this.generateSignature(payloadString, endpoint.hmacSecret);

    const signedPayload: WebhookPayload = {
      ...payload,
      signature,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-StellarFlow-Signature": signature,
      "X-StellarFlow-Event": payload.event,
      "X-StellarFlow-Timestamp": payload.timestamp,
      ...endpoint.headers,
    };

    try {
      await withRetry(
        () =>
          httpClient.post(endpoint.url, signedPayload, {
            headers,
            timeout: endpoint.timeoutMs,
          }),
        {
          maxRetries: endpoint.maxRetries,
          retryDelay: 1000,
          exponentialBackoff: true,
          retryableStatusCodes: [408, 429, 500, 502, 503, 504],
          onRetry: (attempt, error, delay) => {
            logger.warn(
              `Webhook retry attempt ${attempt}/${endpoint.maxRetries} for endpoint ${endpoint.name} (${endpoint.url}) after ${delay}ms. Error: ${error.message}`,
            );
          },
        },
      );

      logger.info(
        `Successfully sent ${payload.event} webhook to ${endpoint.name} (${endpoint.url})`,
      );
      return true;
    } catch (error) {
      logger.error(
        `Failed to send ${payload.event} webhook to ${endpoint.name} (${endpoint.url}) after ${endpoint.maxRetries} retries:`,
        error,
      );
      return false;
    }
  }

  async dispatchEvent(event: CircuitBreakerEvent): Promise<void> {
    const startTime = Date.now();

    try {
      const endpoints = await this.getActiveEndpoints(event.eventType);

      if (endpoints.length === 0) {
        logger.debug(`No active webhook endpoints registered for event type: ${event.eventType}`);
        return;
      }

      const payload = this.createPayload(event);

      const sendPromises = endpoints.map((endpoint) =>
        this.sendToEndpoint(endpoint, payload),
      );

      const results = await Promise.allSettled(sendPromises);

      const successful = results.filter((r) => r.status === "fulfilled" && r.value === true).length;
      const failed = results.length - successful;

      const duration = Date.now() - startTime;
      logger.info(
        `Dispatched ${event.eventType} webhook to ${endpoints.length} endpoints in ${duration}ms: ${successful} successful, ${failed} failed`,
      );

      if (duration > 1000) {
        logger.warn(
          `Webhook dispatch took ${duration}ms, exceeding 1000ms target for event ${event.eventType}`,
        );
      }
    } catch (error) {
      logger.error(`Error dispatching ${event.eventType} webhook:`, error);
    }
  }

  invalidateCache(): void {
    this.cacheExpiry = 0;
    this.endpointsCache.clear();
  }
}

export const circuitBreakerWebhookService = new CircuitBreakerWebhookService();