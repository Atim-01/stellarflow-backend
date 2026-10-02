import { EventEmitter } from "events";
import { getRedisClient } from "../lib/redis";
import { cacheService } from "./CacheService";
import { logger } from "../utils/logger";

/**
 * Off-Chain Cache Invalidation Manager (Issue #789)
 *
 * Automatically purges stale Redis response caches the moment the underlying
 * data changes off-chain, so Fast APIs never serve data older than the latest
 * confirmed ledger or database write.
 *
 * Trigger sources:
 * 1. Ledger events        – `onLedgerEvent()` is invoked by SorobanEventListener
 *                           every time new on-chain prices are confirmed.
 * 2. DB modification      – a Prisma query extension (see src/lib/prisma.ts)
 *                           reports every create/update/delete on cache-relevant
 *                           models through `notifyDatabaseChange()`. Services can
 *                           also publish changes directly via `publishDatabaseChange()`.
 * 3. Stream publications  – the manager consumes `events:*` Redis streams
 *                           (e.g. `events:pool-reserve-alerts`, `events:cache-invalidation`)
 *                           so any process (or service) can request a purge
 *                           through Redis pub/sub.
 *
 * Selective purging:
 *   Rules map a domain / DB model / stream name to a set of Redis key glob
 *   patterns (e.g. `market-rates:*`, `history:*`). `purgeRoutePattern()` also
 *   translates API route patterns such as `/api/v1/pools/123/*` into the
 *   matching cache-key globs so route-scoped caches can be invalidated without
 *   flushing the entire Redis keyspace.
 */

export type DatabaseOperation =
  | "create"
  | "createMany"
  | "update"
  | "updateMany"
  | "delete"
  | "deleteMany"
  | "upsert";

export interface DatabaseChangeEvent {
  /** Prisma model name, e.g. "OnChainPrice" or "PriceHistory". */
  model: string;
  operation: DatabaseOperation;
}

export interface CacheInvalidationEvent {
  /** Domain name looked up in the rule registry, e.g. "ledger". */
  domain?: string;
  /** Explicit Redis key glob patterns to purge (e.g. `["pools:123:*"]`). */
  patterns?: string[];
  /** Route path patterns to purge (e.g. `["/api/v1/pools/123/*"]`). */
  routePatterns?: string[];
}

interface InvalidationMetrics {
  ledgerInvalidations: number;
  databaseInvalidations: number;
  streamInvalidations: number;
  manualInvalidations: number;
  patternPurges: number;
  errors: number;
  lastInvalidationAt: Date | null;
}

/** Reserved Redis stream that carries explicit invalidation requests. */
export const CACHE_INVALIDATION_STREAM = "events:cache-invalidation";

/**
 * Maps API route prefixes to the cache-key prefix they are cached under.
 * Route patterns such as `/api/v1/pools/123/*` are translated to cache-key
 * globs through this table before purging.
 */
const ROUTE_TO_CACHE_PREFIX: Record<string, string> = {
  "/api/v1/market-rates": "market-rates:",
  "/api/v1/history": "history:",
  "/api/v1/stats": "stats:",
  "/api/v1/intelligence": "intelligence:",
  "/api/v1/assets": "assets:",
  "/api/v1/derived-assets": "derived:",
  "/api/v1/governance": "governance:",
  "/api/v1/status": "status:",
  "/api/v1/fee-estimate": "fee-estimate:",
  // Forward-looking example from the issue: /api/v1/pools/123/*
  "/api/v1/pools": "pools:",
  "/api/v1/pool": "pools:",
};

/**
 * Default invalidation rules: domain / DB model / stream name → cache key
 * glob patterns. Rules can be added or overridden at runtime with
 * `registerRule()`.
 */
const DEFAULT_INVALIDATION_RULES: Record<string, string[]> = {
  // New on-chain prices confirmed in a ledger touch every price-derived surface.
  ledger: [
    "market-rates:*",
    "history:*",
    "stats:*",
    "intelligence:*",
    "derived:*",
    "assets:*",
  ],
  price: [
    "market-rates:*",
    "history:*",
    "stats:*",
    "intelligence:*",
    "derived:*",
  ],
  // Database modification triggers (Prisma models).
  OnChainPrice: ["market-rates:*", "history:*", "stats:*", "intelligence:*"],
  PriceHistory: ["history:*", "stats:*", "intelligence:*"],
  MultiSigPrice: ["market-rates:*", "stats:*"],
  MultiSigSignature: ["stats:*"],
  ProviderReputation: ["stats:*"],
  Currency: ["market-rates:*", "assets:*", "history:*"],
  DerivedAsset: ["derived:*"],
  GovernanceVote: ["governance:*"],
  // Stream publications (events:* streams).
  "pool-reserve-alerts": ["pools:*", "pool:*"],
  "pool-reserves": ["pools:*", "pool:*"],
  governance: ["governance:*"],
};

const STREAM_READ_BLOCK_MS = 5000;
const STREAM_READ_COUNT = 20;

export class CacheInvalidationManager {
  private rules: Map<string, string[]>;
  private emitter = new EventEmitter();
  private streamLoopRunning = false;
  private streamLoopPromise: Promise<void> | null = null;
  /** IDs of the last message consumed per stream (used for XREAD cursors). */
  private lastStreamIds = new Map<string, string>();
  private lastLedgerInvalidated = 0;
  private metrics: InvalidationMetrics = {
    ledgerInvalidations: 0,
    databaseInvalidations: 0,
    streamInvalidations: 0,
    manualInvalidations: 0,
    patternPurges: 0,
    errors: 0,
    lastInvalidationAt: null,
  };

  constructor(rules?: Record<string, string[]>) {
    this.rules = new Map(
      Object.entries(rules ?? DEFAULT_INVALIDATION_RULES).map(
        ([domain, patterns]) => [domain, [...patterns]],
      ),
    );
  }

  /** Register (or override) the purge patterns for a domain/model/stream. */
  registerRule(domain: string, patterns: string[]): void {
    this.rules.set(domain, [...patterns]);
    logger.info(
      `[CacheInvalidationManager] Registered rule '${domain}' -> ${patterns.join(", ")}`,
    );
  }

  getRule(domain: string): string[] | undefined {
    return this.rules.get(domain);
  }

  getDomains(): string[] {
    return [...this.rules.keys()];
  }

  // ---------------------------------------------------------------------------
  // Trigger handlers
  // ---------------------------------------------------------------------------

  /**
   * Purge stale caches when a new ledger event arrives. Called by
   * SorobanEventListener for every confirmed on-chain price. Duplicate calls
   * for the same ledger are coalesced into a single purge.
   */
  async onLedgerEvent(ledgerSeq: number, data?: unknown): Promise<void> {
    if (ledgerSeq > 0 && ledgerSeq <= this.lastLedgerInvalidated) {
      return;
    }
    if (ledgerSeq > 0) {
      this.lastLedgerInvalidated = ledgerSeq;
    }

    const patterns = this.rules.get("ledger") ?? this.rules.get("price") ?? [];
    if (patterns.length === 0) return;

    this.metrics.ledgerInvalidations++;
    this.metrics.lastInvalidationAt = new Date();
    logger.debug(
      `[CacheInvalidationManager] Ledger ${ledgerSeq} invalidating ${patterns.length} pattern(s)`,
      { data },
    );
    await this.purgePatterns(patterns);
  }

  /**
   * Handle a database modification trigger (create/update/delete) reported by
   * the Prisma query extension or by services via publishDatabaseChange().
   */
  async notifyDatabaseChange(event: DatabaseChangeEvent): Promise<void> {
    this.emitter.emit("db:change", event);

    const patterns = this.rules.get(event.model);
    if (!patterns || patterns.length === 0) return;

    this.metrics.databaseInvalidations++;
    this.metrics.lastInvalidationAt = new Date();
    logger.debug(
      `[CacheInvalidationManager] DB change ${event.model}.${event.operation} invalidating ${patterns.length} pattern(s)`,
    );
    await this.purgePatterns(patterns);
  }

  /**
   * Handle a message consumed from an `events:*` Redis stream.
   * `events:cache-invalidation` carries explicit invalidation requests; any
   * other stream is resolved through the rule registry by its suffix.
   */
  async onStreamEvent(
    stream: string,
    payload: Record<string, string>,
  ): Promise<void> {
    if (stream === CACHE_INVALIDATION_STREAM) {
      await this.handleInvalidationStreamPayload(payload);
      return;
    }

    const suffix = stream.replace(/^events:/, "");
    const patterns = this.rules.get(suffix);
    if (!patterns || patterns.length === 0) return;

    this.metrics.streamInvalidations++;
    this.metrics.lastInvalidationAt = new Date();
    logger.debug(
      `[CacheInvalidationManager] Stream '${stream}' invalidating ${patterns.length} pattern(s)`,
    );
    await this.purgePatterns(patterns);
  }

  /**
   * Subscribe to DB change events in-process. Useful for services that want
   * to react (e.g. websocket broadcast) without touching Redis.
   */
  onDatabaseChange(listener: (event: DatabaseChangeEvent) => void): void {
    this.emitter.on("db:change", listener);
  }

  // ---------------------------------------------------------------------------
  // Selective purging
  // ---------------------------------------------------------------------------

  /**
   * Purge Redis keys matching explicit glob patterns (e.g. `pools:123:*`).
   */
  async purgePatterns(patterns: string[]): Promise<void> {
    for (const pattern of patterns) {
      try {
        await cacheService.deletePattern(pattern);
        this.metrics.patternPurges++;
      } catch (error) {
        this.metrics.errors++;
        logger.error(
          `[CacheInvalidationManager] Failed to purge pattern '${pattern}':`,
          error,
        );
      }
    }
  }

  /**
   * Purge caches for a route key pattern such as `/api/v1/pools/123/*`.
   * Route patterns are translated to cache-key globs via ROUTE_TO_CACHE_PREFIX;
   * raw cache-key globs (containing `*`) are purged as-is.
   */
  async purgeRoutePattern(routePattern: string): Promise<void> {
    const glob = this.toCacheGlob(routePattern);
    if (!glob) {
      logger.warn(
        `[CacheInvalidationManager] No cache prefix mapping for route pattern '${routePattern}'`,
      );
      return;
    }
    this.metrics.manualInvalidations++;
    this.metrics.lastInvalidationAt = new Date();
    await this.purgePatterns([glob]);
  }

  /** Manually invalidate an explicit event (domain, patterns or route patterns). */
  async invalidate(event: CacheInvalidationEvent): Promise<void> {
    this.metrics.manualInvalidations++;
    this.metrics.lastInvalidationAt = new Date();

    if (event.domain) {
      const patterns = this.rules.get(event.domain);
      if (patterns) await this.purgePatterns(patterns);
    }
    if (event.patterns?.length) await this.purgePatterns(event.patterns);
    for (const routePattern of event.routePatterns ?? []) {
      await this.purgeRoutePattern(routePattern);
    }
  }

  // ---------------------------------------------------------------------------
  // Stream publication
  // ---------------------------------------------------------------------------

  /**
   * Publish an explicit invalidation request to the
   * `events:cache-invalidation` Redis stream so every API instance purges,
   * and purge locally as well.
   */
  async publishCacheInvalidation(event: CacheInvalidationEvent): Promise<void> {
    await this.invalidate(event);

    const redis = getRedisClient();
    if (!redis?.isOpen) return;
    try {
      await redis.xAdd(CACHE_INVALIDATION_STREAM, "*", {
        payload: JSON.stringify(event),
        publishedAt: new Date().toISOString(),
      });
    } catch (error) {
      this.metrics.errors++;
      logger.error(
        `[CacheInvalidationManager] Failed to publish to '${CACHE_INVALIDATION_STREAM}':`,
        error,
      );
    }
  }

  /** Publish a database change event (in-process + Redis stream). */
  async publishDatabaseChange(event: DatabaseChangeEvent): Promise<void> {
    await this.notifyDatabaseChange(event);

    const redis = getRedisClient();
    if (!redis?.isOpen) return;
    try {
      await redis.xAdd(CACHE_INVALIDATION_STREAM, "*", {
        payload: JSON.stringify({ dbChange: event }),
        publishedAt: new Date().toISOString(),
      });
    } catch (error) {
      this.metrics.errors++;
      logger.error(
        `[CacheInvalidationManager] Failed to publish DB change for '${event.model}':`,
        error,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Stream listener lifecycle
  // ---------------------------------------------------------------------------

  /** Start consuming `events:*` streams for invalidation requests. */
  start(): void {
    if (this.streamLoopRunning) return;
    this.streamLoopRunning = true;
    this.streamLoopPromise = this.streamLoop().catch((error) => {
      this.streamLoopRunning = false;
      logger.error("[CacheInvalidationManager] Stream loop exited:", error);
    });
    logger.info("[CacheInvalidationManager] Started stream listener");
  }

  async stop(): Promise<void> {
    this.streamLoopRunning = false;
    if (this.streamLoopPromise) {
      await this.streamLoopPromise.catch(() => undefined);
      this.streamLoopPromise = null;
    }
    logger.info("[CacheInvalidationManager] Stopped stream listener");
  }

  isActive(): boolean {
    return this.streamLoopRunning;
  }

  private async streamLoop(): Promise<void> {
    const redis = getRedisClient();
    if (!redis) {
      // REDIS_URL not configured – there is no shared stream to consume.
      logger.debug(
        "[CacheInvalidationManager] Stream listener disabled: Redis not configured",
      );
      return;
    }

    while (this.streamLoopRunning) {
      if (!redis.isOpen) {
        // Redis not connected yet – retry until it connects.
        await new Promise((resolve) =>
          setTimeout(resolve, STREAM_READ_BLOCK_MS),
        );
        continue;
      }

      try {
        // If the reserved stream does not exist yet, create it so XREAD BLOCK
        // can block on it instead of returning immediately.
        await this.ensureStream(redis, CACHE_INVALIDATION_STREAM);

        const streams = this.getSubscribedStreams();
        if (streams.length === 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, STREAM_READ_BLOCK_MS),
          );
          continue;
        }

        const response = await redis.xRead(
          streams.map((stream) => ({
            key: stream,
            id: this.lastStreamIds.get(stream) ?? "$",
          })),
          { COUNT: STREAM_READ_COUNT, BLOCK: STREAM_READ_BLOCK_MS },
        );

        if (!response) continue;

        for (const { name: stream, messages } of response) {
          for (const message of messages) {
            this.lastStreamIds.set(stream, message.id);
            try {
              await this.onStreamEvent(stream, message.message);
            } catch (error) {
              this.metrics.errors++;
              logger.error(
                `[CacheInvalidationManager] Failed to process stream message ${stream}/${message.id}:`,
                error,
              );
            }
          }
        }
      } catch (error) {
        // Redis may be temporarily unavailable; keep the loop alive.
        this.metrics.errors++;
        logger.warn("[CacheInvalidationManager] Stream read failed:", error);
        await new Promise((resolve) =>
          setTimeout(resolve, STREAM_READ_BLOCK_MS),
        );
      }
    }
  }

  /** Streams the manager currently listens to: the reserved stream + rule domains that are event streams. */
  private getSubscribedStreams(): string[] {
    const streams = new Set<string>([CACHE_INVALIDATION_STREAM]);
    for (const domain of this.rules.keys()) {
      if (domain.startsWith("events:")) streams.add(domain);
    }
    // Rule keys may be stream suffixes (e.g. "pool-reserve-alerts").
    for (const domain of this.rules.keys()) {
      if (domain.includes("-") && !domain.startsWith("events:")) {
        streams.add(`events:${domain}`);
      }
    }
    return [...streams].sort();
  }

  private async ensureStream(
    redis: NonNullable<ReturnType<typeof getRedisClient>>,
    stream: string,
  ): Promise<void> {
    try {
      const exists = await redis.exists(stream);
      if (!exists) {
        await redis.xAdd(stream, "*", { initialized: "1" });
        // Skip the initialization marker on first read.
        this.lastStreamIds.set(stream, "$");
      }
    } catch (error) {
      logger.debug(
        `[CacheInvalidationManager] Could not ensure stream '${stream}':`,
        error,
      );
    }
  }

  private async handleInvalidationStreamPayload(
    payload: Record<string, string>,
  ): Promise<void> {
    const raw = payload.payload ?? payload.message;
    if (!raw) return;

    let parsed:
      | CacheInvalidationEvent
      | { dbChange?: DatabaseChangeEvent }
      | null = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn(
        `[CacheInvalidationManager] Ignoring non-JSON stream payload: ${String(raw).slice(0, 120)}`,
      );
      return;
    }

    if (!parsed) return;

    if ("dbChange" in parsed && parsed.dbChange) {
      await this.notifyDatabaseChange(parsed.dbChange);
      return;
    }

    const event = parsed as CacheInvalidationEvent;
    this.metrics.streamInvalidations++;
    this.metrics.lastInvalidationAt = new Date();
    await this.invalidate(event);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Translate an API route pattern to a Redis key glob.
   * e.g. `/api/v1/pools/123/*` -> `pools:123:*`
   * Raw cache-key globs (containing `*`) pass through unchanged.
   */
  toCacheGlob(routePattern: string): string | null {
    if (routePattern.includes("*")) {
      // Already a cache-key glob (e.g. "pools:123:*") or a wildcard route.
      if (!routePattern.startsWith("/")) return routePattern;
    }

    const prefix = Object.keys(ROUTE_TO_CACHE_PREFIX)
      .sort((a, b) => b.length - a.length)
      .find((route) => routePattern.startsWith(route));

    if (!prefix) return null;

    const suffix = routePattern
      .slice(prefix.length)
      .replace(/^\//, "")
      // Route path separators map to cache-key separators:
      // /api/v1/pools/123/* -> pools:123:*
      .replace(/\//g, ":");
    return `${ROUTE_TO_CACHE_PREFIX[prefix]}${suffix}`;
  }

  getMetrics(): InvalidationMetrics {
    return { ...this.metrics };
  }
}

// ---------------------------------------------------------------------------
// Module-level convenience helpers (delegate to the singleton)
// ---------------------------------------------------------------------------

/** Publish a database change event so caches are invalidated (Issue #789). */
export function publishDatabaseChange(
  event: DatabaseChangeEvent,
): Promise<void> {
  return cacheInvalidationManager.publishDatabaseChange(event);
}

/** Publish an explicit cache invalidation request to all API instances. */
export function publishCacheInvalidation(
  event: CacheInvalidationEvent,
): Promise<void> {
  return cacheInvalidationManager.publishCacheInvalidation(event);
}

// Singleton instance
let managerInstance: CacheInvalidationManager | null = null;

export function getCacheInvalidationManager(
  rules?: Record<string, string[]>,
): CacheInvalidationManager {
  if (!managerInstance) {
    managerInstance = new CacheInvalidationManager(rules);
  }
  return managerInstance;
}

export function resetCacheInvalidationManager(): void {
  if (managerInstance) {
    void managerInstance.stop();
    managerInstance = null;
  }
}

export const cacheInvalidationManager = getCacheInvalidationManager();
