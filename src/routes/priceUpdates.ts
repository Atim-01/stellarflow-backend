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
 * -----------------------------------------------------------------------------
 * A single WebSocket endpoint that multiplex price, volume, and order-book
 * updates for one or more market pairs into a single JSON or MsgPack event
 * stream. Designed to hold 10,000+ active sockets with minimal per-client
 * memory overhead.
 *
 * Route: ws://.../v1/market-stream?pairs=USD-XLM,BTC-USD&format=json|msgpack
 */

export type MarketStreamChannel = "price" | "volume" | "orderbook";

export interface MarketStreamEvent {
  /** Monotonically increasing sequence number for client reordering. */
  seq: number;
  /** Event type discriminator. */
  type: "snapshot" | "update" | "heartbeat" | "error";
  /** Market pair, e.g. "USDC-XLM". */
  pair: string;
  /** Sub-channel the event belongs to. */
  channel?: MarketStreamChannel;
  /** Event payload. */
  data?: unknown;
  /** Event timestamp in milliseconds. */
  ts: number;
  /** Optional error message. */
  message?: string;
}

export interface MarketStreamSubscriber {
  id: string;
  socket: WebSocket;
  pairs: Set<string>;
  channels: Set<MarketStreamChannel>;
  format: "json" | "msgpack";
  /** Buffered bytes waiting to be flushed; used for backpressure control. */
  queued: number;
  /** Whether the socket is already draining its queue. */
  flushing: boolean;
  /** Last activity timestamp for stale connection cleanup. */
  lastSeen: number;
  /** Per-connection byte counter for metrics. */
  bytesSent: number;
}

/**
 * Minimal in-memory broadcast hub for market updates.
 *
 * The hub is deliberately single-instance and keeps only the minimum per-client
 * state (Set of pairs + Set of channels + a few numeric counters). This keeps
 * per-socket memory overhead low enough to support 10,000+ concurrent clients.
 */
export class MarketStreamHub {
  private subscribers = new Map<string, MarketStreamSubscriber>();
  private seq = 0;
  private heartbeatInterval: NodeJS.Timer | null = null;
  private staleTimeoutMs = 60 _ 000;
  private maxQueuedBytes = 256 * 1024;

  constructor() {
    this.heartbeatInterval = setInterval(() => this.heartbeat(), 30 _000);
    // Do not keep the Node process alive solely for heartbeats.
    if (typeof this.heartbeatInterval.unref === "function") {
      this.heartbeatInterval.unref();
    }
  }

  /** Number of currently connected subscribers. */
  get size(): number {
    return this.subscribers.size;
  }

  /**
   * Register a new WebSocket client and attach its subscription state.
   */
  addClient(
    socket: WebSocket,
    pairs: string[],
    channels: MarketStreamChannel[],
    format: "json" | "msgpack",
  ): MarketStreamSubscriber {
    const id = createHash("sha1").update(`${Date.now()}:${Math.random()}`).digest("hex");
    const subscriber: MarketStreamSubscriber = {
      id,
      socket,
      pairs: new Set(pairs),
      channels: new Set(channels),
      format,
      queued: 0,
      flushing: false,
      lastSeen: Date.now(),
      bytesSent: 0,
    };
    this.subscribers.set(id, subscriber);
    return subscriber;
  }

  /** Remove a client and free its per-connection state. */
  removeClient(id: string): void {
    const subscriber = this.subscribers.get(id);
    if (!subscriber) return;
    this.subscribers.delete(id);
    try {
      if (
        subscriber.socket.readyState === WebSocket.OPEN ||
        subscriber.socket.readyState === WebSocket.CONNECTING
      ) {
        subscriber.socket.close(1000, "client removed");
      }
    } catch {
      // ignore close errors
    }
  }

  /** Update the pairs a subscriber is interested in. */
  setPairs(id: string, pairs: string[]): boolean {
    const subscriber = this.subscribers.get(id);
    if (!subscriber) return false;
    subscriber.pairs = new Set(pairs);
    subscriber.lastSeen = Date.now();
    return true;
  }

  /** Update the channels a subscriber is interested in. */
  setChannels(id: string, channels: MarketStreamChannel[]): boolean {
    const subscriber = this.subscribers.get(id);
    if (!subscriber) return false;
    subscriber.channels = new Set(channels);
    subscriber.lastSeen = Date.now();
    return true;
  }

  /** 
   * Broadcast an event to all subscribers that match the pair and channel.
   * Returns the number of clients the event was queued for.
   */
  broadcast(
    pair: string,
    channel: MarketStreamChannel,
    data: unknown,
    type: "snapshot" | "update" = "update",
  ): number {
    const now = Date.now();
    const event: MarketStreamEvent = {
      seq: ++this.seq,
      type,
      pair,
      channel,
      data,
      ts: now,
    };
    let delivered = 0;
    for (const subscriber of this.subscribers.values()) {
      if (!subscriber.pairs.has(pair)) continue;
      if (!subscriber.channels.has(channel)) continue;
      if (subscriber.socket.readyState !== WebSocket.OPEN) continue;
      this.sendTo(subscriber, event);
      delivered++;
    }
    return delivered;
  }

  /** Broadcast a heartbeat to all connected clients. */
  private heartbeat(): void {
    const now = Date.now();
    const event: MarketStreamEvent = {
      seq: ++this.seq,
      type: "heartbeat",
      pair: "*",
      ts: now,
    };
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.socket.readyState === WebSocket.OPEN ||
          subscriber.socket.readyState === WebSocket.CONNECTING) {
        this.sendTo(subscriber, event);
      }
    }
    // Clean up stale connections that never completed the handshake.
    for (const [id, subscriber] of this.subscribers) {
      if (now - subscriber.lastSeen > this.staleTimeoutMs) {
        this.removeClient(id);
      }
    }
  }

  /** Encode and queue an event for a single subscriber. */
  private sendTo(subscriber: MarketStreamSubscriber, event: MarketStreamEvent): void {
    if (subscriber.queued > this.maxQueuedBytes) {
      // Backpressure: drop the client rather than growing memory unbounded.
      this.removeClient(subscriber.id);
      return;
    }
    const payload = this.encode(event, subscriber.format);
    subscriber.queued += payload.length;
    subscriber.bytesSent += payload.length;
    subscriber.lastSeen = Date.now();
    try {
      subscriber.socket.send(payload, (err?: Error) => {
        subscriber.queued -= payload.length;
        if (subscriber.queued < 0) subscriber.queued = 0;
        if (err) {
          this.removeClient(subscriber.id);
        }
      });
    } catch {
      this.removeClient(subscriber.id);
    }
  }

  /** Encode an event as JSON or MsgPack. */
  private encode(event: MarketStreamEvent, format: "json" | "msgpack"): Buffer {
    if (format === "msgpack") {
      return Buffer.from(encodeMsgPack(event));
    }
    return Buffer.from(JSON.stringify(event));
  }

  /** Stop the heartbeat timer and close all clients. */
  async close(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    for (const id of Array.from(this.subscribers.keys())) {
      this.removeClient(id);
    }
  }

  /** Return a snapshot of per-client memory usage for monitoring. */
  memoryStats(): { clients: number; estimatedBytes: number } {
    // Estimate based on the size of the per-client state object plus a fixed
    // allowance for the underlying socket buffers.
    const perClient = 512 + 64 * 4;
    return {
      clients: this.subscribers.size,
      estimatedBytes: this.subscribers.size * perClient,
    };
  }
}

/** Minimal MsgPack encoder for the flat MarketStreamEvent shape. */
function encodeMsgPack(event: MarketStreamEvent): Uint8Array {
  const chunks: number[] = [];
  const push = (...bytes: number[]) => chunks.push(...bytes);
  // Fix map of 6 entries.
  push(0x80);
  // seq
  push(0x01);
  pushUint32(chunks, event.seq);
  // type
  push(0x02);
  pushString(chunks, event.type);
  // pair
  push(0x03);
  pushString(chunks, event.pair);
  // channel
  if (event.channel) {
    push(0x04);
    pushString(chunks, event.channel);
  }
  // data
  if (event.data !== undefined) {
    push(0x05);
    pushString(chunks, JSON.stringify(event.data));
  }
  // ts
  push(0x06);
  pushUint64(chunks, event.ts);
  return new Uint8Array(chunks);
}

function pushUint32(chunks: number[], value: number): void {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setUint32(0, value, false);
  chunks.push(...new Uint8Array(buf));
}

function pushUint64(chunks: number[], value: number): void {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigUint64(0, BigInt(value), false);
  chunks.push(...new Uint8Array(buf));
}

function pushString(chunks: number[], value: string): void {
  const encoded = Buffer.from(value, "utf-8");
  pushUint32(chunks, encoded.length);
  chunks.push(...encoded);
}

/** Shared hub used by the WebSocket route and the REST metrics endpoint. */
export const marketStreamHub = new MarketStreamHub();

const VALID_CHANNELS: MarketStreamChannel[] = ["price", "volume", "orderbook"];

function parsePairs(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((p) => p.trim().toUpperCase())
    .filter((p) => /^[A-Z0-9]+5-[A-Z0-9]+$/.test(p));
}

function parseChannels(raw: unknown): MarketStreamChannel[] {
  if (typeof raw !== "string" || raw.trim() === "") return [...VALID_CHANNELS];
  const requested = raw
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter((c): c is MarketStreamChannel =>
      (VALID_CHANNELS as string[]).includes(c));
  return requested.length > 0 ? requested : [...VALID_CHANNELS];
}

function parseFormat(raw: unknown): "json" | "msgpack" {
  if (typeof raw === "string" && raw.toLowerCase() === "msgpack") return "msgpack";
  return "json";
}

/**
 * Attach the combined market stream WebSocket handler to an HTTP server.
 *
 * This is exported so the application bootstrap can attach it to the
 * shared HTTP server used by the Express app. The route is mounted at
 * /v1/market-stream.
 */
export function attachMarketStreamWebsocket(server: any): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/v1/market-stream" });

  wss.on("connection", (socket: WebSocket, req: any) => {
    const url = new URL(req.url || "/", "http://localhost");
    const pairs = parsePairs(url.searchParams.get("pairs"));
    const channels = parseChannels(url.searchParams.get("channels"));
    const format = parseFormat(url.searchParams.get("format"));

    if (pairs.length === 0) {
      socket.send(
        JSON.stringify({
          seq: 0,
          type: "error",
          pair: "*",
          message: "Missing or invalid 'pairs' query parameter",
          ts: Date.now(),
        }),
      );
      socket.close(1008, "invalid pairs");
      return;
    }

    const subscriber = marketStreamHub.addClient(socket, pairs, channels, format);

    // Send an initial snapshot acknowledging the subscription.
    const ack = {
      seq: 0,
      type: "snapshot" as const,
      pair: "*",
      data: { pairs, channels, format },
      ts: Date.now(),
    };
    socket.send(
      format === "msgpack"
        ? Buffer.from(encodeMsgPack(ack))
        : Buffer.from(JSON.stringify(ack)),
    );

    socket.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg && typeof msg === "object") {
          if (Array.isArray(msg.pairs)) {
            marketStreamHub.setPairs(subscriber.id, parsePairs(msg.pairs.join(",")));
          }
          if (Array.isArray(msg.channels)) {
            marketStreamHub.setChannels(subscriber.id, parseChannels(msg.channels.join(",")));
          }
        }
      } catch {
        // Ignore malformed client messages; the connection remains open.
      }
    });

    socket.on("close", () => marketStreamHub.removeClient(subscriber.id));
    socket.on("error", () => marketStreamHub.removeClient(subscriber.id));
  });

  return wss;
}

/**
 * GET -> /api/v1/price-updates/market-stream/metrics
 * Returns current connection and memory overhead metrics for the market stream.
 */
router.get("/market-stream/metrics", (_req: Request, res: Response) => {
  const stats = marketStreamHub.memoryStats();
  res.json({
    success: true,
    data: {
      clients: stats.clients,
      estimatedBytes: stats.estimatedBytes,
      estimatedKiB: Number((stats.estimatedBytes / 1024).toFixed(2)),
    },
  });
});

/**
 * POST -> /api/v1/price-updates/market-stream/publish
 * Publish a market update to all subscribed WebSocket clients.
 * Used by the internal feed ingestors.
 */
router.post("/market-stream/publish", (req: Request, res: Response) => {
  const { pair, channel, data, type } = req.body || {};
  if (
    typeof pair !== "string" ||
    typeof channel !== "string" ||
    !(VALID_CHANNELS as string[]).includes(channel)
  ) {
    return sendApiError(res, 400, "BAD_REQUEST", "pair and valid channel are required");
  }
  const delivered = marketStreamHub.broadcast(
    pair.toUpperCase(),
    channel as MarketStreamChannel,
    data,
    type === "snapshot" ? "snapshot" : "update",
  );
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
        return res.status(404).json( {
          success: false,
          error: `MultiSigPrice ${multiSigPriceId} not found`,
        });
      }

      if (multiSigPrice.status !== "APPROVED") {
        return res.status(400).json( {
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
      const { memoId, stellarTxHash } = req.body;

      if (
        !multiSigPriceId ||
        typeof multiSigPriceId !== "string" ||
        !memoId ||
        !stellarTxHash
      ) {
        return res.status(400).json( {
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
