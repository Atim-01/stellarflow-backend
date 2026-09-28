import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterAll,
} from "@jest/globals";
import { cacheService } from "../src/cache/CacheService";
import {
  CacheInvalidationManager,
  getCacheInvalidationManager,
  resetCacheInvalidationManager,
  publishDatabaseChange,
  publishCacheInvalidation,
} from "../src/cache/CacheInvalidationManager";

describe("CacheInvalidationManager (Issue #789)", () => {
  beforeEach(async () => {
    await cacheService.clear();
    cacheService.resetMetrics();
  });

  afterAll(async () => {
    await cacheService.clear();
  });

  describe("rules", () => {
    it("should register default rules", () => {
      const manager = new CacheInvalidationManager();
      expect(manager.getDomains()).toContain("ledger");
      expect(manager.getDomains()).toContain("OnChainPrice");
      expect(manager.getDomains()).toContain("PriceHistory");
      expect(manager.getDomains()).toContain("pool-reserve-alerts");
    });

    it("should register a new rule at runtime", () => {
      const manager = new CacheInvalidationManager({});
      manager.registerRule("pools", ["pools:*"]);
      expect(manager.getRule("pools")).toEqual(["pools:*"]);
    });
  });

  describe("onLedgerEvent", () => {
    it("should purge ledger-derived caches on a new ledger", async () => {
      const manager = new CacheInvalidationManager();
      await cacheService.set("market-rates:all", { data: [] }, 60);
      await cacheService.set("market-rates:NGN", { rate: 1500 }, 60);
      await cacheService.set("history:NGN:7d", { data: [] }, 60);
      await cacheService.set("stats:volume:2026-08-01", { data: [] }, 60);
      await cacheService.set("derived:NGN:GHS", { rate: 100 }, 60);

      await manager.onLedgerEvent(12345, { currency: "NGN" });

      expect(await cacheService.get("market-rates:all")).toBeNull();
      expect(await cacheService.get("market-rates:NGN")).toBeNull();
      expect(await cacheService.get("history:NGN:7d")).toBeNull();
      expect(await cacheService.get("stats:volume:2026-08-01")).toBeNull();
      expect(await cacheService.get("derived:NGN:GHS")).toBeNull();

      const metrics = manager.getMetrics();
      expect(metrics.ledgerInvalidations).toBe(1);
      expect(metrics.patternPurges).toBeGreaterThan(0);
      expect(metrics.lastInvalidationAt).toBeDefined();
    });

    it("should coalesce duplicate calls for the same ledger", async () => {
      const manager = new CacheInvalidationManager();
      await cacheService.set("market-rates:NGN", { rate: 1500 }, 60);

      await manager.onLedgerEvent(100);
      await manager.onLedgerEvent(100);
      await manager.onLedgerEvent(99);

      expect(await cacheService.get("market-rates:NGN")).toBeNull();
      expect(manager.getMetrics().ledgerInvalidations).toBe(1);
    });
  });

  describe("notifyDatabaseChange", () => {
    it("should purge patterns mapped to the modified model", async () => {
      const manager = new CacheInvalidationManager();
      await cacheService.set("history:NGN:7d", { data: [] }, 60);

      await manager.notifyDatabaseChange({
        model: "PriceHistory",
        operation: "create",
      });

      // deletePattern clears the L1 LRU wholesale (documented tradeoff), so the
      // history key is gone after the targeted pattern purge.
      expect(await cacheService.get("history:NGN:7d")).toBeNull();
      expect(manager.getMetrics().databaseInvalidations).toBe(1);
    });

    it("should do nothing for unknown models", async () => {
      const manager = new CacheInvalidationManager();
      await cacheService.set("market-rates:all", { data: [] }, 60);

      await manager.notifyDatabaseChange({
        model: "UnknownModel",
        operation: "update",
      });

      expect(await cacheService.get("market-rates:all")).not.toBeNull();
    });

    it("should emit db:change events to subscribers", async () => {
      const manager = new CacheInvalidationManager();
      const listener = jest.fn();
      manager.onDatabaseChange(listener);

      await manager.notifyDatabaseChange({
        model: "OnChainPrice",
        operation: "create",
      });

      expect(listener).toHaveBeenCalledWith({
        model: "OnChainPrice",
        operation: "create",
      });
    });
  });

  describe("onStreamEvent", () => {
    it("should purge explicit patterns from the invalidation stream", async () => {
      const manager = new CacheInvalidationManager();
      await cacheService.set("pools:123:reserves", { data: [] }, 60);

      await manager.onStreamEvent("events:cache-invalidation", {
        payload: JSON.stringify({ patterns: ["pools:123:*"] }),
      });

      expect(await cacheService.get("pools:123:reserves")).toBeNull();
      expect(manager.getMetrics().streamInvalidations).toBe(1);
    });

    it("should purge route patterns from the invalidation stream", async () => {
      const manager = new CacheInvalidationManager();
      await cacheService.set("pools:123:reserves", { data: [] }, 60);

      await manager.onStreamEvent("events:cache-invalidation", {
        payload: JSON.stringify({ routePatterns: ["/api/v1/pools/123/*"] }),
      });

      expect(await cacheService.get("pools:123:reserves")).toBeNull();
    });

    it("should forward dbChange payloads from the invalidation stream", async () => {
      const manager = new CacheInvalidationManager();
      await cacheService.set("governance:voter:GAAA", { data: [] }, 60);

      await manager.onStreamEvent("events:cache-invalidation", {
        payload: JSON.stringify({
          dbChange: { model: "GovernanceVote", operation: "create" },
        }),
      });

      expect(await cacheService.get("governance:voter:GAAA")).toBeNull();
    });

    it("should purge domain stream patterns by suffix", async () => {
      const manager = new CacheInvalidationManager();
      await cacheService.set("pools:abc:reserves", { data: [] }, 60);

      await manager.onStreamEvent("events:pool-reserve-alerts", {
        payload: JSON.stringify({ poolId: "abc" }),
      });

      expect(await cacheService.get("pools:abc:reserves")).toBeNull();
      expect(manager.getMetrics().streamInvalidations).toBe(1);
    });

    it("should ignore unknown streams", async () => {
      const manager = new CacheInvalidationManager();
      await cacheService.set("market-rates:all", { data: [] }, 60);

      await manager.onStreamEvent("events:unknown-domain", { payload: "{}" });

      expect(await cacheService.get("market-rates:all")).not.toBeNull();
    });
  });

  describe("purgeRoutePattern", () => {
    it("should translate route patterns to cache globs", async () => {
      const manager = new CacheInvalidationManager();
      await cacheService.set("pools:123:reserves", { data: [] }, 60);
      await cacheService.set("market-rates:NGN", { rate: 1500 }, 60);

      await manager.purgeRoutePattern("/api/v1/pools/123/*");
      await manager.purgeRoutePattern("/api/v1/market-rates/NGN");

      expect(await cacheService.get("pools:123:reserves")).toBeNull();
      expect(await cacheService.get("market-rates:NGN")).toBeNull();
    });

    it("should pass through raw cache-key globs", async () => {
      const manager = new CacheInvalidationManager();
      await cacheService.set("pools:123:reserves", { data: [] }, 60);

      await manager.purgeRoutePattern("pools:123:*");

      expect(await cacheService.get("pools:123:reserves")).toBeNull();
    });

    it("should not purge when the route has no cache mapping", async () => {
      const manager = new CacheInvalidationManager();
      await cacheService.set("market-rates:all", { data: [] }, 60);

      await manager.purgeRoutePattern("/api/v1/unknown/route/*");

      expect(await cacheService.get("market-rates:all")).not.toBeNull();
    });

    it("should map route prefixes to cache prefixes", () => {
      const manager = new CacheInvalidationManager();
      expect(manager.toCacheGlob("/api/v1/pools/123/*")).toBe("pools:123:*");
      expect(manager.toCacheGlob("/api/v1/market-rates/latest")).toBe(
        "market-rates:latest",
      );
      expect(manager.toCacheGlob("/api/v1/history/GHS")).toBe("history:GHS");
      expect(manager.toCacheGlob("pools:123:*")).toBe("pools:123:*");
      expect(manager.toCacheGlob("/api/v1/unknown/route/*")).toBeNull();
    });
  });

  describe("invalidate", () => {
    it("should purge domain, patterns and routePatterns", async () => {
      const manager = new CacheInvalidationManager();
      await cacheService.set("market-rates:all", { data: [] }, 60);
      await cacheService.set("pools:1:reserves", { data: [] }, 60);
      await cacheService.set("extra:key", { data: [] }, 60);

      await manager.invalidate({
        domain: "ledger",
        patterns: ["extra:*"],
        routePatterns: ["/api/v1/pools/1/*"],
      });

      expect(await cacheService.get("market-rates:all")).toBeNull();
      expect(await cacheService.get("pools:1:reserves")).toBeNull();
      expect(await cacheService.get("extra:key")).toBeNull();
    });
  });

  describe("publish helpers", () => {
    it("should purge locally when Redis is unavailable", async () => {
      await cacheService.set("pools:9:reserves", { data: [] }, 60);

      await publishCacheInvalidation({ patterns: ["pools:9:*"] });

      expect(await cacheService.get("pools:9:reserves")).toBeNull();
    });

    it("should publish db change and purge locally", async () => {
      await cacheService.set("market-rates:all", { data: [] }, 60);
      await cacheService.set("assets:all", { data: [] }, 60);

      await publishDatabaseChange({ model: "Currency", operation: "update" });

      expect(await cacheService.get("market-rates:all")).toBeNull();
      expect(await cacheService.get("assets:all")).toBeNull();
    });
  });

  describe("lifecycle", () => {
    it("should track active state", () => {
      const manager = new CacheInvalidationManager();
      expect(manager.isActive()).toBe(false);

      manager.start();
      expect(manager.isActive()).toBe(true);

      void manager.stop();
      expect(manager.isActive()).toBe(false);
    });

    it("should not start twice", () => {
      const manager = new CacheInvalidationManager();
      manager.start();
      manager.start();
      expect(manager.isActive()).toBe(true);
      void manager.stop();
    });
  });

  describe("metrics", () => {
    it("should expose counters", async () => {
      const manager = new CacheInvalidationManager();
      expect(manager.getMetrics()).toEqual({
        ledgerInvalidations: 0,
        databaseInvalidations: 0,
        streamInvalidations: 0,
        manualInvalidations: 0,
        patternPurges: 0,
        errors: 0,
        lastInvalidationAt: null,
      });

      await manager.invalidate({ patterns: ["x:*"] });
      expect(manager.getMetrics().manualInvalidations).toBe(1);
      expect(manager.getMetrics().patternPurges).toBe(1);
    });
  });

  describe("singleton", () => {
    it("should return the same instance from getCacheInvalidationManager", () => {
      const manager1 = getCacheInvalidationManager();
      const manager2 = getCacheInvalidationManager();
      expect(manager1).toBe(manager2);
      resetCacheInvalidationManager();
    });
  });
});
