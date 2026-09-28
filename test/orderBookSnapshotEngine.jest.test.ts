import {
  OrderBookSnapshotEngine,
  getOrderBookSnapshotEngine,
  resetOrderBookSnapshotEngine,
} from "../src/services/orderBookSnapshotEngine";

// In-memory fake Redis to verify persistence, recovery, and purge behaviour
const fakeStore = new Map<string, string>();

jest.mock("../src/lib/redis", () => ({
  getRedisClient: jest.fn().mockReturnValue({
    isOpen: true,
    get: jest.fn(async (key: string) => fakeStore.get(key) ?? null),
    setEx: jest.fn(async (key: string, ttl: number, value: string) => {
      fakeStore.set(key, value);
    }),
    del: jest.fn(async (...args: unknown[]) => {
      const keys = args.flat() as string[];
      for (const key of keys) fakeStore.delete(key);
      return keys.length;
    }),
    scanIterator: jest.fn(async function* (options: { MATCH: string }) {
      const pattern = options.MATCH;
      const regex = new RegExp(`^${pattern.replaceAll("*", ".*")}$`);
      for (const key of fakeStore.keys()) {
        if (regex.test(key)) yield [key];
      }
    }),
  }),
}));

jest.mock("../src/utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

describe("OrderBookSnapshotEngine", () => {
  beforeEach(() => {
    fakeStore.clear();
    resetOrderBookSnapshotEngine();
    jest.clearAllMocks();
  });

  afterEach(() => {
    resetOrderBookSnapshotEngine();
  });

  describe("in-memory order book", () => {
    it("should apply depth updates and aggregate amounts per level", () => {
      const engine = new OrderBookSnapshotEngine();
      engine.applyDepthUpdate("bid", 100, 5);
      engine.applyDepthUpdate("bid", 100, 3);
      engine.applyDepthUpdate("ask", 110, 7);

      const depth = engine.getDepth();
      expect(depth.bids).toEqual([{ price: 100, amount: 8 }]);
      expect(depth.asks).toEqual([{ price: 110, amount: 7 }]);
    });

    it("should remove a level when amount is set to zero", () => {
      const engine = new OrderBookSnapshotEngine();
      engine.setLevel("ask", 120, 4);
      engine.setLevel("ask", 120, 0);

      expect(engine.getDepth().asks).toEqual([]);
      expect(engine.levelCount).toBe(0);
    });

    it("should sort bids descending and asks ascending", () => {
      const engine = new OrderBookSnapshotEngine();
      engine.setLevel("bid", 100, 1);
      engine.setLevel("bid", 105, 2);
      engine.setLevel("bid", 102, 3);
      engine.setLevel("ask", 110, 1);
      engine.setLevel("ask", 108, 2);

      const depth = engine.getDepth();
      expect(depth.bids.map((l) => l.price)).toEqual([105, 102, 100]);
      expect(depth.asks.map((l) => l.price)).toEqual([108, 110]);
    });

    it("should reject invalid price levels", () => {
      const engine = new OrderBookSnapshotEngine();
      engine.setLevel("bid", NaN, 5);
      engine.setLevel("bid", -1, 5);
      expect(engine.levelCount).toBe(0);
    });
  });

  describe("captureSnapshot", () => {
    it("should persist a snapshot to Redis with retention TTL", async () => {
      const engine = new OrderBookSnapshotEngine({
        snapshotIntervalLedgers: 100,
        retentionDays: 7,
      });
      engine.setLevel("bid", 100, 5);
      engine.setLevel("ask", 110, 5);

      const snapshot = await engine.captureSnapshot(1234);

      expect(snapshot?.ledgerSeq).toBe(1234);
      expect(snapshot?.bids).toEqual([{ price: 100, amount: 5 }]);
      expect(snapshot?.asks).toEqual([{ price: 110, amount: 5 }]);

      const stored = fakeStore.get("stellarflow:orderbook:snapshot:1234");
      expect(stored).toBeDefined();
      expect(JSON.parse(stored!).version).toBe(1);

      const latest = fakeStore.get("stellarflow:orderbook:snapshot:latest");
      expect(latest).toBe("1234");
    });

    it("should not run two captures concurrently", async () => {
      const engine = new OrderBookSnapshotEngine();
      const first = engine.captureSnapshot(1000);
      const second = engine.captureSnapshot(1100);

      const [result1, result2] = await Promise.all([first, second]);
      expect(result1).not.toBeNull();
      expect(result2).toBeNull();
    });

    it("should update last snapshot ledger for interval tracking", async () => {
      const engine = new OrderBookSnapshotEngine({
        snapshotIntervalLedgers: 100,
      });
      await engine.captureSnapshot(500);
      expect(engine.getMetrics().lastSnapshotLedger).toBe(500);
    });
  });

  describe("onNewLedger", () => {
    it("should snapshot only every 100 ledgers", async () => {
      const engine = new OrderBookSnapshotEngine({
        snapshotIntervalLedgers: 100,
      });
      await engine.start();
      engine.setLevel("bid", 100, 5);

      // Ledgers before the interval are skipped
      await engine.onNewLedger(50);
      expect(engine.getMetrics().snapshotsCaptured).toBe(0);

      // Exactly at the interval boundary a snapshot is captured
      await engine.onNewLedger(100);
      expect(engine.getMetrics().snapshotsCaptured).toBe(1);
      expect(engine.getMetrics().lastSnapshotLedger).toBe(100);

      // 99 more ledgers -> no snapshot
      await engine.onNewLedger(199);
      expect(engine.getMetrics().snapshotsCaptured).toBe(1);

      // Next boundary -> snapshot
      await engine.onNewLedger(200);
      expect(engine.getMetrics().snapshotsCaptured).toBe(2);

      engine.stop();
    });

    it("should not snapshot when engine is not running", async () => {
      const engine = new OrderBookSnapshotEngine();
      await engine.onNewLedger(100);
      expect(engine.getMetrics().snapshotsCaptured).toBe(0);
    });
  });

  describe("recoverFromLatestSnapshot", () => {
    it("should restore in-memory order book from the latest Redis snapshot", async () => {
      const engine = new OrderBookSnapshotEngine();
      engine.setLevel("bid", 99, 3);
      engine.setLevel("ask", 101, 4);
      await engine.captureSnapshot(2000);

      // New engine instance (simulating a worker restart)
      const recovered = new OrderBookSnapshotEngine();
      const snapshot = await recovered.recoverFromLatestSnapshot();

      expect(snapshot?.ledgerSeq).toBe(2000);
      const depth = recovered.getDepth();
      expect(depth.bids).toEqual([{ price: 99, amount: 3 }]);
      expect(depth.asks).toEqual([{ price: 101, amount: 4 }]);
      expect(recovered.getMetrics().snapshotsRecovered).toBe(1);
    });

    it("should return null when no snapshot exists", async () => {
      const engine = new OrderBookSnapshotEngine();
      const snapshot = await engine.recoverFromLatestSnapshot();
      expect(snapshot).toBeNull();
      expect(engine.getDepth().bids).toEqual([]);
    });

    it("should update lastSnapshotLedger after recovery", async () => {
      const engine = new OrderBookSnapshotEngine();
      await engine.captureSnapshot(3000);

      const recovered = new OrderBookSnapshotEngine();
      await recovered.recoverFromLatestSnapshot();
      expect(recovered.getMetrics().lastSnapshotLedger).toBe(3000);
    });
  });

  describe("purgeExpiredSnapshots", () => {
    it("should delete snapshots older than the retention window", async () => {
      const engine = new OrderBookSnapshotEngine({ retentionDays: 7 });
      await engine.captureSnapshot(1);

      // Manually backdate the stored snapshot beyond retention
      const key = "stellarflow:orderbook:snapshot:1";
      const stored = JSON.parse(fakeStore.get(key)!);
      stored.capturedAt = new Date(
        Date.now() - 8 * 24 * 60 * 60 * 1000,
      ).toISOString();
      fakeStore.set(key, JSON.stringify(stored));

      const purged = await engine.purgeExpiredSnapshots();
      expect(purged).toBe(1);
      expect(fakeStore.has(key)).toBe(false);
    });

    it("should keep fresh snapshots", async () => {
      const engine = new OrderBookSnapshotEngine({ retentionDays: 7 });
      await engine.captureSnapshot(1);

      const purged = await engine.purgeExpiredSnapshots();
      expect(purged).toBe(0);
      expect(fakeStore.has("stellarflow:orderbook:snapshot:1")).toBe(true);
    });

    it("should always preserve the latest pointer key", async () => {
      const engine = new OrderBookSnapshotEngine({ retentionDays: 7 });
      await engine.captureSnapshot(1);

      const purged = await engine.purgeExpiredSnapshots();
      expect(purged).toBe(0);
      expect(fakeStore.has("stellarflow:orderbook:snapshot:latest")).toBe(true);
    });
  });

  describe("lifecycle and singleton", () => {
    it("should start and stop the engine", async () => {
      const engine = new OrderBookSnapshotEngine();
      await engine.start();
      expect(engine.isActive()).toBe(true);
      engine.stop();
      expect(engine.isActive()).toBe(false);
    });

    it("should not start twice", async () => {
      const engine = new OrderBookSnapshotEngine();
      await engine.start();
      await engine.start();
      expect(engine.isActive()).toBe(true);
      engine.stop();
    });

    it("should return the same singleton instance", () => {
      const a = getOrderBookSnapshotEngine();
      const b = getOrderBookSnapshotEngine();
      expect(a).toBe(b);
      resetOrderBookSnapshotEngine();
      const c = getOrderBookSnapshotEngine();
      expect(c).not.toBe(a);
    });
  });
});
