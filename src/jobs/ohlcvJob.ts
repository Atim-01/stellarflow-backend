// src/jobs/ohlcvJob.ts
import cron from "node-cron";
import prisma from "../lib/prisma";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

interface AggregationWindow {
  start: Date;
  end: Date;
}

export class OhlcvAggregator {
  constructor() {}

  private getWindow(timeframe: string): AggregationWindow {
    const now = new Date();
    switch (timeframe) {
      case "1m":
        return { start: new Date(now.getTime() - MINUTE_MS), end: now };
      case "15m":
        return { start: new Date(now.getTime() - 15 * MINUTE_MS), end: now };
      case "1h":
        return { start: new Date(now.getTime() - HOUR_MS), end: now };
      case "1d":
        return { start: new Date(now.getTime() - DAY_MS), end: now };
      default:
        throw new Error(`Unsupported timeframe ${timeframe}`);
    }
  }

  /**
   * Aggregates raw PriceHistory rows into OHLCV candles for each active currency.
   * Saves results to the OhlcvCandle table.
   */
  async runAggregation(timeframe: string): Promise<void> {
    const { start, end } = this.getWindow(timeframe);
    const activeCurrencies = await prisma.currency.findMany({ where: { isActive: true } });
    for (const cur of activeCurrencies) {
      const rows = await prisma.priceHistory.findMany({
        where: { currency: cur.code, timestamp: { gte: start, lt: end } },
        orderBy: { timestamp: "asc" },
        select: { rate: true, timestamp: true },
      });
      if (rows.length === 0) continue;
      const firstRate = rows[0]!.rate;
      const open = firstRate;
      const close = rows[rows.length - 1]!.rate;
      const high = rows.reduce((max, r) => (r.rate > max ? r.rate : max), firstRate);
      const low = rows.reduce((min, r) => (r.rate < min ? r.rate : min), firstRate);
      const volume = rows.length; // Simple count as volume placeholder

      const timestamp = start;
      await prisma.ohlcvCandle.upsert({
        where: {
          pair_timeframe_timestamp: {
            pair: cur.code,
            timeframe,
            timestamp,
          },
        },
        create: {
          pair: cur.code,
          timeframe,
          open,
          high,
          low,
          close,
          volume: volume as any,
          timestamp,
        },
        update: {
          open,
          high,
          low,
          close,
          volume: volume as any,
        },
      });
    }
    console.info(`[OhlcvAggregator] Completed ${timeframe} aggregation from ${start.toISOString()} to ${end.toISOString()}`);
  }

  /**
   * Placeholder for pool liquidity aggregation.
   */
  async aggregatePoolLiquidity(): Promise<void> {
    // TODO: Implement actual pool liquidity calculation based on appropriate tables.
    console.info(`[OhlcvAggregator] Pool liquidity aggregation executed (placeholder).`);
  }

  /**
   * Purge raw transaction logs older than 90 days.
   */
  async purgeOldLogs(): Promise<void> {
    const cutoff = new Date(Date.now() - 90 * DAY_MS);
    const deleted = await prisma.priceHistory.deleteMany({ where: { timestamp: { lt: cutoff } } });
    console.info(`[OhlcvAggregator] Purged ${deleted.count} PriceHistory rows older than ${cutoff.toISOString()}`);
  }

  /**
   * Register cron jobs for each timeframe and maintenance tasks.
   */
  start(): void {
    // 1‑minute candles – every minute at second 0
    cron.schedule("0 * * * * *", () => this.runAggregation("1m"));
    // 15‑minute candles – every 15 min
    cron.schedule("0 */15 * * * *", () => this.runAggregation("15m"));
    // Hourly candles – at minute 0
    cron.schedule("0 0 * * * *", () => this.runAggregation("1h"));
    // Daily candles – at hour 0 minute 0
    cron.schedule("0 0 0 * * *", () => this.runAggregation("1d"));
    // Pool liquidity – every 5 minutes
    cron.schedule("0 */5 * * * *", () => this.aggregatePoolLiquidity());
    // Purge old logs – daily at 02:00
    cron.schedule("0 0 2 * * *", () => this.purgeOldLogs());
    console.info("[OhlcvAggregator] Scheduler started.");
  }
}

export const ohlcvAggregator = new OhlcvAggregator();
