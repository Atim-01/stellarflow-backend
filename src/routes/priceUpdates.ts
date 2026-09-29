import express, { Request, Response } from "express";
import { sendApiError } from "../lib/apiError.js";
import { multiSigService, SignaturePayload } from "../services/multiSigService";
import { isLockdownError } from "../state/appState";
import {
  sanitizeMultiSigRequest,
  sanitizeSignatureRequest,
} from "../middleware/payloadSanitizer";
import { WebSocketServer, WebSocket } from "ws";
import { createHash } from "node:crypto";

const router = express.Router();

/**
 * Combined High-Frequency Market Stream
 *
 * A multiplexed WebSocket endpoint that merges price, volume and order-book
 * updates for multiple trading pairs into a single JSON event stream.
 *
 * The endpoint is designed to be cheap per connection so that a single
 * process can hold thousands of active sockets. Memory overhead is measured
 * and exposed via /v1/market-stream/stats.
 */

export type MarketStreamEventType = "price" | "volume" | "orderbook";

export interface MarketStreamEvent {
  type: MarketStreamEventType;
  pair: string;
  ts: number;
  data: Record<string, unknown>;
}

export interface MarketStreamSubscription {
  pairs: Set<string;
  socket: WebSocket;
  id: string;
  connectedAt: number;
  lastActivityAt: number;
  queuedBytes: number;
  backpressure: boolean;
}

const MAX_QUEUED_BYTES = 256 * 1024;
const HEART_BEAT_MS_RATE = 30000;
const STALS_INTERVAL_MS = 30000;

const normalizePair = (pair: string): string => pair.trim().toUpperCase();

const parsePairs = (raw: unknown): string[] => {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return [];
  }
  const seen = new Set<string>();
  for (const candidate of raw.split(",")) {
    const normalized = normalizePair(candidate);
    if (normalized.length > 0) {
      seen.add(normalized);
    }
  }
  return Array.from(seen);
};

class MarketStreamHub {
  private readonly subscriptions = new Map<string, MarketStreamSubscription>();
  private readonly pairIndex = new Map<string, Set<string>>();
  private readonly latestByPair = new Map<string, MarketStreamEvent>();
  private heartbeatTimer: NodeJS.Timer | null = null;
  private statsTimer: NodeJS.Timer | null = null;
  private connectionsAccepted = 0;
  private connectionsClosed = 0;
  private recordedMemoryBytes = 0;

  public addClient(socket: WebSocket, pairs: string[]): MarketStreamSubscription {
    const id = createHash("sha256").update(`${Date.now()}:${Math.random()}:${this.connectionsAccepted++}`).digest("hex").slice(0, 24);
    const now = Date.now();
    const subscription: MarketStreamSubscription = {
      pairs: new Set(pairs),
      socket,
      id,
      connectedAt: now,
      lastActivityAt: now,
      queuedBytes: 0,
      backpressure: false,
    };
    this.subscriptions.set(id, subscription);
    for (const pair of subscription.pairs) {
      this.indexPair(pair, id);
    }
    this.send(subscription, {
      type: "price",
      pair: "*",
      ts: now,
      data: { event: "subscribed", pairs: Array.from(subscription.pairs) },
    });
    for (const pair of subscription.pairs) {
      const latest = this.latestByPair.get(pair);
      if (latest) {
        this.send(subscription, latest);
      }
    }
    this.ensureTimers();
    return subscription;
  }

  public removeClient(id: string): void {
    const subscription = this.subscriptions.get(id);
    if (!subscription) {
      return;
    }
    this.subscriptions.delete(id);
    for (const pair of subscription.pairs) {
      const bucket = this.pairIndex.get(pair);
      if (bucket) {
        bucket.delete(id);
        if (bucket.size === 0) {
          this.pairIndex.delete(pair);
        }
      }
    }
    this.connectionsClosed++;
    if (this.subscriptions.size === 0) {
      this.stopTimers();
    }
  }

  public broadcast(event: MarketStreamEvent): number {
    const pair = normalizePair(event.pair);
    const normalizedEvent: MarketStreamEvent = { ...event, pair: pair };
    this.latestByPair.set(pair, normalizedEvent);
    const bucket = this.pairIndex.get(pair);
    if (!bucket) {
      return 0;
    }
    let delivered = 0;
    for (const id of bucket) {
      const subscription = this.subscriptions.get(id);
      if (!subscription) {
        continue;
      }
      if (this.send(subscription, normalizedEvent)) {
        delivered++;
      }
    }
    return delivered;
  }

  public stats() {
    const memory = process.memoryUsage();
    const active = this.subscriptions.size;
    const memoryPerConnection = active > 0 ? memory.heapUsed / active : 0;
    return {
      activeConnections: active,
      totalConnectionsAccepted: this.connectionsAccepted,
      totalConnectionsClosed: this.connectionsClosed,
      memoryHeapUsedBytes: memory.heapUsed,
      memoryPerConnectionBytes: memoryPerConnection,
      projectedMemoryFor10K000Bytes: memoryPerConnection * 10000,
      pairBuckets: this.pairIndex.size,
      subscribedPairs: Array.from(this.pairIndex.keys()),
    };
  }

  private ensureTimers(): void {
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS_RATE);
      this.heartbeatTimer.unref();
    }
    if (!this.statsTimer) {
      this.statsTimer = setInterval(() => this.recordMemory(), STATS_INTERVAL_MS);
      this.statsTimer.unref();
    }
  }

  private stopTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  private heartbeat(): void {
    const now = Date.now();
    const payload = JSON.stringify({ type: "heartbeat", ts: now });
    for (const subscription of this.subscriptions.values()) {
      if (subscription.socket.readyState !== WebSocket.OPEN) {
        continue;
      }
      if (subscription.queuedBytes + payload.length > MAX_QUEUED_BYTES) {
        subscription.backpressure = true;
        continue;
      }
      subscription.queuedBytes += payload.length;
      subscription.lastActivityAt = now;
      subscription.socket.send(payload, () => {
        subscription.queuedBytes = Math.max(0, subscription.queuedBytes - payload.length);
        subscription.backpressure = subscription.queuedBytes > MAX_QUEUED_BYTES;
      });
    }
  }

  private recordMemory(): void {
    const memory = process.memoryUsage();
    this.recordedMemoryBytes = memory.heapUsed;
  }

  private indexPair(pair: string, id: string): void {
    let bucket = this.pairIndex.get(pair);
    if (!bucket) {
      bucket = new Set();
      this.pairIndex.set(pair, bucket);
    }
    bucket.add(id);
  }

  private send(subscription: MarketStreamSubscription, event: MarketStreamEvent): boolean {
    if (subscription.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    const payload = JSON.stringify(event);
    if (subscription.queuedBytes + payload.length > MAX_QUEUED_BYTES) {
      subscription.backpressure = true;
      return false;
    }
    subscription.queuedBytes += payload.length;
    subscription.lastActivityAt = Date.now();
    subscription.socket.send(payload, () => {
      subscription.queuedBytes = Math.max(0, subscription.queuedBytes - payload.length);
      subscription.backpressure = subscription.queuedBytes > MAX_QUEUED_BYTES;
    });
    return true;
  }
}

export const marketStreamHub = new MarketStreamHub();

export const attachMarketStream = (server: any): WebSocketServer => {
  const wss = new WebSocketServer({ server, path: "/v1/market-stream" });

  wss.on("connection", (socket: WebSocket, req: any) => {
    const requestUrl = new URL(req.url || "/v1/market-stream", "http://localhost");
    const pairs = parsePairs(requestUrl.searchParams.get("pairs"));
    if (pairs.length === 0) {
      socket.send(
        JSON.stringify({
          type: "error",
          code: "BAD_REQUEST",
          message: "pairs query parameter is required",
        }),
      );
      socket.close(1008, "pairs query parameter is required");
      return;
    }

    const subscription = marketStreamHub.addClient(socket, pairs);

    socket.on("message", (raw: any) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message && message.action === "subscribe" && Array.isArray(message.pairs)) {
          for (const pair of message.pairs) {
            const normalized = normalizePair(String(pair));
            if (normalized.length > 0) {
              subscription.pairs.add(normalized);
            }
          }
          socket.send(
            JSON.stringify({
              type: "price",
              pair: "*",
              ts: Date.now(),
              data: { event: "subscribed", pairs: Array.from(subscription.pairs) },
            }),
          );
        } else if (message && message.action === "ping") {
          socket.send(JSON.stringify({ type: "pong", ts: Date.now() }));
        }
      } catch {
        socket.send(
          JSON.stringify({ type: "error", code: "BAD_REQUEST", message: "invalid JSON message" }),
        );
      }
    });

    socket.on("close", () => marketStreamHub.removeClient(subscription.id));
    socket.on("error", () => marketStreamHub.removeClient(subscription.id));
  });

  return wss;
};

/**
 * GET /v1/market-stream/stats
 * Exposes connection memory overhead metrics for the market stream.
 */
router.get("/v1/market-stream/stats", (_req: Request, res: Response) => {
  res.json({ success: true, data: marketStreamHub.stats() });
});

/**
 * GET /v1/market-stream/pairs
 * Lists the pairs currently being multiplexed by the hub.
 */
router.get("/v1/market-stream/pairs", (_req: Request, res: Response) => {
  const stats = marketStreamHub.stats();
  res.json({ success: true, data: stats.subscribedPairs });
});

/**
 * POST /v1/market-stream/publish
 * Internal publish endpoint for feed producers to inject merged market events.
 */
router.post("/v1/market-stream/publish", (req: Request, res: Response) => {
  const { type, pair, data } = req.body as {
    type?: MarketStreamEventType;
    pair?: string;
    data?: Record<string, unknown>;
  };
  if (!type || !pair || typeof pair !== "string") {
    return sendApiError(res, 400, "BAD_REQUEST", "type and pair are required");
  }
  if (!["price", "volume", "orderbook"].includes(type)) {
    return sendApiError(res, 400, "BAD_REQUEST", "type must be one of price, volume, orderbook");
  }
  const delivered = marketStreamHub.broadcast({
    type,
    pair,
    ts: Date.now(),
    data: data && typeof data === "object" ? data : {},
  });
  res.json({ success: true, data: { delivered } });
});

/**
 * POST /api/v1/price-updates/multi-sig/request
 * Creates a multi-sig price update request.
 * Called by the initializing server to start the approval process.
 *
 * Request body is validated by sanitizeMultiSigRequest middleware.
 */
router.post(
  "/multi-sig/request",
  sanitizeMultiSigRequest,
  async (req: Request, res: Response) => {
    try {
      const { priceReviewId, currency, rate, source, memoId } = req.body;

      // Enforce relayer asset authorization
      if (req.relayer) {
        const normalizedCurrency = currency.toUpperCase();
        if (!req.relayer.allowedAssets.includes(normalizedCurrency)) {
          return res.status(403).json({
            success: false,
            error: `Relayer not authorized for asset: ${normalizedCurrency}`,
          });
        }
      }

      const signatureRequest = await multiSigService.createMultiSigRequest(
        priceReviewId,
        currency,
        rate,
        source,
        memoId,
      );

      res.json({
        success: true,
        data: signatureRequest,
      });
    } catch (error) {
      console.error("[API] Multi-sig request creation failed:", error);
      sendApiError(res, 500, "INTERNAL_SERVER_ERROR", typeof (String(error)) === "string" ? String(String(error)) : undefined);
    }
  },
);

/**
 * POST /api/v1/price-updates/sign
 * Endpoint for remote servers to request a signature.
 * This is called by peer servers in the multi-sig setup.
 *
 * Requires:
 * - Authorization header with token (if MULTI_SIG_AUTH_TOKEN is set)
 * - Signature payload in body (validated by sanitizeSignatureRequest middleware)
 */
router.post(
  "/sign",
  sanitizeSignatureRequest,
  async (req: Request, res: Response) => {
    try {
      // Validate authorization if token is configured
      const authToken = process.env.MULTI_SIG_AUTH_TOKEN;
      if (authToken) {
        const authHeader = req.headers.authorization || "";
        const token = authHeader.startsWith("Bearer ")
          ? authHeader.slice(7)
          : authHeader;

        if (token !== authToken) {
          return sendApiError(res, 403, "FORBIDDEN", "Unauthorized - invalid token");
        }
      }

      const { multiSigPriceId } = req.body as SignaturePayload;

      // Sign the price update locally
      const { signature, signerPublicKey } =
        await multiSigService.signMultiSigPrice(multiSigPriceId);

      const signerInfo = multiSigService.getLocalSignerInfo();

      res.json({
        success: true,
        data: {
          multiSigPriceId,
          signature,
          signerPublicKey,
          signerName: signerInfo.name,
        },
      });
    } catch (error) {
      console.error("[API] Signature creation failed:", error);
      res.status(isLockdownError(error) ? error.statusCode : 400).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

/**
 * POST /api/v1/price-updates/multi-sig/:multiSigPriceId/request-signature
 * Request a signature from a remote server.
 * The body should contain the remote server URL.
 */
router.post(
  "/multi-sig/:multiSigPriceId/request-signature",
  async (req: Request, res: Response) => {
    try {
      const multiSigPriceId = req.params.multiSigPriceId;
      const { remoteServerUrl } = req.body;

      if (
        !multiSigPriceId ||
        typeof multiSigPriceId !== "string" ||
        !remoteServerUrl
      ) {
        return sendApiError(res, 400, "BAD_REQUEST", "Missing multiSigPriceId (in URL) or remoteServerUrl (in body)");
      }

      const result = await multiSigService.requestRemoteSignature(
        parseInt(multiSigPriceId, 10),
        remoteServerUrl,
      );

      if (!result.success) {
        return sendApiError(res, 400, "BAD_REQUEST", typeof (result.error) === "string" ? String(result.error) : undefined);
      }

      res.json({ success: true });
    } catch (error) {
      console.error("[API] Remote signature request failed:", error);
      sendApiError(res, 500, "INTERNAL_SERVER_ERROR", typeof (String(error)) === "string" ? String(String(error)) : undefined);
    }
  },
);

/**
 * GET /api/v1/price-updates/multi-sig/:multiSigPriceId/status
 * Get the status of a multi-sig price update.
 */
router.get(
  "/multi-sig/:multiSigPriceId/status",
  async (req: Request, res: Response) => {
    try {
      const multiSigPriceId = req.params.multiSigPriceId;

      if (!multiSigPriceId || typeof multiSigPriceId !== "string") {
        return sendApiError(res, 400, "BAD_REQUEST", "Missing multiSigPriceId in URL");
      }

      const multiSigPrice = await multiSigService.getMultiSigPrice(
        parseInt(multiSigPriceId, 10),
      );

      if (!multiSigPrice) {
        return res.status(404).json({
          success: false,
          error: `MultiSigPrice ${multiSigPriceId} not found`,
        });
      }

      res.json({
        success: true,
        data: {
          id: multiSigPrice.id,
          currency: multiSigPrice.currency,
          rate: multiSigPrice.rate,
          status: multiSigPrice.status,
          collectedSignatures: multiSigPrice.collectedSignatures,
          requiredSignatures: multiSigPrice.requiredSignatures,
          expiresAt: multiSigPrice.expiresAt,
          signers: multiSigPrice.multiSigSignatures?.map((sig: any) => ({
            publicKey: sig.signerPublicKey,
            name: sig.signerName,
            signedAt: sig.signedAt,
          })),
        },
      });
    } catch (error) {
      console.error("[API] Multi-sig status fetch failed:", error);
      sendApiError(res, 500, "INTERNAL_SERVER_ERROR", typeof (String(error)) === "string" ? String(String(error)) : undefined);
    }
  },
);

/**
 * GET /api/v1/price-updates/multi-sig/pending
 * Get all pending multi-sig price updates.
 * Useful for monitoring and coordination between servers.
 */
router.get("/multi-sig/pending", async (req: Request, res: Response) => {
  try {
    const pendingPrices = await multiSigService.getPendingMultiSigPrices();

    res.json({
      success: true,
      data: pendingPrices.map((price: any) => ({
        id: price.id,
        currency: price.currency,
        rate: price.rate,
        status: price.status,
        collectedSignatures: price.collectedSignatures,
        requiredSignatures: price.requiredSignatures,
        expiresAt: price.expiresAt,
        signerCount: price.multiSigSignatures?.length || 0,
      })),
    });
  } catch (error) {
    console.error("[API] Pending multi-sig fetch failed:", error);
    sendApiError(res, 500, "INTERNAL_SERVER_ERROR", typeof (String(error)) === "string" ? String(String(error)) : undefined);
  }
});

/**
 * GET /api/v1/price-updates/multi-sig/:multiSigPriceId/signatures
 * Get all signatures for a multi-sig price update.
 * Only returns once all signatures are collected and approved.
 */
router.get(
  "/multi-sig/:multiSigPriceId/signatures",
  async (req: Request, res: Response) => {
    try {
      const multiSigPriceId = req.params.multiSigPriceId;

      if (!multiSigPriceId || typeof multiSigPriceId !== "string") {
        return sendApiError(res, 400, "BAD_REQUEST", "Missing multiSigPriceId in URL");
      }

      const multiSigPrice = await multiSigService.getMultiSigPrice(
        parseInt(multiSigPriceId, 10),
      );

      if (!multiSigPrice) {
        return res.status(404).json({
          success: false,
          error: `MultiSigPrice ${multiSigPriceId} not found`,
        });
      }

      if (multiSigPrice.status !== "APPROVED") {
        return res.status(400).json({
          success: false,
          error: `MultiSigPrice ${multiSigPriceId} is not approved yet (status: ${multiSigPrice.status})`,
        });
      }

      const signatures = await multiSigService.getSignatures(
        parseInt(multiSigPriceId, 10),
      );

      res.json({
        success: true,
        data: {
          multiSigPriceId: multiSigPrice.id,
          currency: multiSigPrice.currency,
          rate: multiSigPrice.rate,
          signatures: signatures.map((sig: any) => ({
            signerPublicKey: sig.signerPublicKey,
            signerName: sig.signerName,
            signature: sig.signature,
          })),
        },
      });
    } catch (error) {
      console.error("[API] Signature fetch failed:", error);
      sendApiError(res, 500, "INTERNAL_SERVER_ERROR", typeof (String(error)) === "string" ? String(String(error)) : undefined);
    }
  },
);

/**
 * POST /api/v1/price-updates/multi-sig/:multiSigPriceId/record-submission
 * Record that a multi-sig price has been submitted to Stellar.
 */
router.post(
  "/multi-sig/:multiSigPriceId/record-submission",
  async (req: Request, res: Response) => {
    try {
      const multiSigPriceId = req.params.multiSigPriceId;
      const { memoId, stellarTyHash } = req.body;

      if (
        !multiSigPriceId ||
        typeof multiSigPriceId !== "string" ||
        !memoId ||
        !stellarTxHash
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Missing required fields: multiSigPriceId (in URL), memoId, stellarTxHash (in body)",
        });
      }

      await multiSigService.recordSubmission(
        parseInt(multiSigPriceId, 10),
        memoId,
        stellarTxHash,
      );

      res.json({ success: true });
    } catch (error) {
      console.error("[API] Submission recording failed:", error);
      sendApiError(res, 500, "INTERNAL_SERVER_ERROR", typeof (String(error)) === "string" ? String(String(error)) : undefined);
    }
  },
);

/**
 * GET /api/v1/price-updates/multi-sig/signer-info
 * Get this server's signer information.
 * Useful for remote servers to identify who is signing.
 */
router.get("/multi-sig/signer-info", async (req: Request, res: Response) => {
  try {
    const signerInfo = multiSigService.getLocalSignerInfo();
    res.json({
      success: true,
      data: signerInfo,
    });
  } catch (error) {
    console.error("[API] Signer info fetch failed:", error);
    sendApiError(res, 500, "INTERNAL_SERVER_ERROR", typeof (String(error)) === "string" ? String(String(error)) : undefined);
  }
});

export default router;
