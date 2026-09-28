import { httpClient } from "../lib/httpClient";
import { withRetry } from "../utils/retryUtil";
import { createFetcherLogger } from "../utils/logger";

export type ExternalPriceSource = "binance" | "coingecko";

export interface PriceObservation {
  asset: string;
  source: ExternalPriceSource;
  price: number;
  volume: number;
  timestamp: number;
}

export interface SourceFeed {
  source: ExternalPriceSource;
  price: number;
  volume: number;
}

export interface AggregatedAssetFeed {
  symbol: string;
  spot: number;
  median: number;
  twap: number;
  volume: number;
  sources: SourceFeed[];
  updatedAt: string;
}

export interface AggregatedFeed {
  generatedAt: string;
  intervalMs: number;
  assets: Record<string, AggregatedAssetFeed>;
  sanityChecks: Record<
    string,
    {
      spot: number;
      twap: number;
      spreadPercent: number;
    }
  >;
}

const DEFAULT_ASSETS = ["XLM", "BTC", "ETH", "SOL", "ADA"] as const;
const DEFAULT_TWAP_WINDOW_MS = 5 * 60 * 1000;

function normalizeAsset(raw: string): string {
  const upper = raw.toUpperCase();
  return upper.replace(/^USD$/, "");
}

export class OffChainPriceAggregatorService {
  public static readonly pollIntervalMs = 10_000;

  private readonly logger = createFetcherLogger("OffChainPriceAggregator");
  private readonly assetAliases: Record<string, { binance: string; coingecko: string }> = {
    XLM: { binance: "XLMUSDT", coingecko: "stellar" },
    BTC: { binance: "BTCUSDT", coingecko: "bitcoin" },
    ETH: { binance: "ETHUSDT", coingecko: "ethereum" },
    SOL: { binance: "SOLUSDT", coingecko: "solana" },
    ADA: { binance: "ADAUSDT", coingecko: "cardano" },
  };

  private readonly history = new Map<
    string,
    Array<{ timestamp: number; price: number; volume: number }>
  >();

  private timer: ReturnType<typeof setInterval> | undefined;
  private latestFeed: AggregatedFeed = {
    generatedAt: new Date(0).toISOString(),
    intervalMs: OffChainPriceAggregatorService.pollIntervalMs,
    assets: {},
    sanityChecks: {},
  };
  private running = false;

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    await this.refresh();

    this.timer = setInterval(() => {
      void this.refresh().catch((error: unknown) => {
        this.logger.error("Off-chain price refresh failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, OffChainPriceAggregatorService.pollIntervalMs);

    this.logger.info("Off-chain price aggregator polling started", {
      intervalMs: OffChainPriceAggregatorService.pollIntervalMs,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.running = false;
    this.logger.info("Off-chain price aggregator polling stopped");
  }

  getAggregatedFeed(): AggregatedFeed {
    return {
      ...this.latestFeed,
      assets: { ...this.latestFeed.assets },
      sanityChecks: { ...this.latestFeed.sanityChecks },
    };
  }

  getAssetFeed(asset: string): AggregatedAssetFeed | null {
    const symbol = normalizeAsset(asset);
    return this.latestFeed.assets[symbol] ?? null;
  }

  getLatestPrice(asset: string): number | null {
    const feed = this.getAssetFeed(asset);
    return feed ? feed.spot : null;
  }

  getContractSanityFeed(): AggregatedFeed {
    return this.getAggregatedFeed();
  }

  async refresh(): Promise<AggregatedFeed> {
    const observationsByAsset = await this.collectObservations();
    const assetFeed: Record<string, AggregatedAssetFeed> = {};

    for (const asset of DEFAULT_ASSETS) {
      const observations = observationsByAsset[asset] ?? [];
      const sourceRows = observations.map((obs) => ({
        source: obs.source,
        price: obs.price,
        volume: obs.volume,
      }));

      const spot = this.calculateVolumeWeightedMedian(observations);
      const totalVolume = observations.reduce((sum, obs) => sum + obs.volume, 0);
      const recentHistory = this.getRecentHistory(asset, DEFAULT_TWAP_WINDOW_MS);
      const twap = this.calculateTwap(recentHistory, spot);

      this.history.set(asset, [
        ...(this.history.get(asset) ?? []),
        {
          timestamp: Date.now(),
          price: spot,
          volume: totalVolume,
        },
      ].slice(-120));

      assetFeed[asset] = {
        symbol: asset,
        spot,
        median: this.calculateMedian(observations.map((obs) => obs.price)),
        twap,
        volume: totalVolume,
        sources: sourceRows,
        updatedAt: new Date().toISOString(),
      };
    }

    const sanityChecks: AggregatedFeed["sanityChecks"] = {};
    for (const [symbol, feed] of Object.entries(assetFeed)) {
      const spreadPercent =
        feed.twap === 0
          ? 0
          : (Math.abs(feed.spot - feed.twap) / feed.twap) * 100;

      sanityChecks[symbol] = {
        spot: feed.spot,
        twap: feed.twap,
        spreadPercent,
      };
    }

    this.latestFeed = {
      generatedAt: new Date().toISOString(),
      intervalMs: OffChainPriceAggregatorService.pollIntervalMs,
      assets: assetFeed,
      sanityChecks,
    };

    return this.getAggregatedFeed();
  }

  private async collectObservations(): Promise<Record<string, PriceObservation[]>> {
    const [binanceResult, coingeckoResult] = await Promise.allSettled([
      this.fetchBinancePrices(),
      this.fetchCoinGeckoPrices(),
    ]);

    const merged: Record<string, PriceObservation[]> = {
      XLM: [],
      BTC: [],
      ETH: [],
      SOL: [],
      ADA: [],
    };

    if (binanceResult.status === "fulfilled") {
      for (const observation of binanceResult.value) {
        const bucket = merged[observation.asset] ?? [];
        merged[observation.asset] = bucket;
        bucket.push(observation);
      }
    }

    if (coingeckoResult.status === "fulfilled") {
      for (const observation of coingeckoResult.value) {
        const bucket = merged[observation.asset] ?? [];
        merged[observation.asset] = bucket;
        bucket.push(observation);
      }
    }

    return merged;
  }

  private async fetchBinancePrices(): Promise<PriceObservation[]> {
    const results: PriceObservation[] = [];

    for (const asset of DEFAULT_ASSETS) {
      const alias = this.assetAliases[asset]?.binance;
      if (!alias) {
        continue;
      }

      try {
        const response = await withRetry(
          () =>
            httpClient.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${alias}`),
          { maxRetries: 2, retryDelay: 250 },
        );

        const price = Number(response.data?.lastPrice);
        const volume = Number(response.data?.quoteVolume ?? response.data?.volume ?? 0);

        if (!Number.isFinite(price) || price <= 0) {
          continue;
        }

        results.push({
          asset,
          source: "binance",
          price,
          volume: Number.isFinite(volume) && volume > 0 ? volume : 1,
          timestamp: Date.now(),
        });
      } catch (error) {
        this.logger.debug(`Binance price fetch failed for ${asset}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  }

  private async fetchCoinGeckoPrices(): Promise<PriceObservation[]> {
    const ids = DEFAULT_ASSETS.map((asset) => this.assetAliases[asset]?.coingecko)
      .filter((value): value is string => Boolean(value))
      .join(",");

    if (!ids) {
      return [];
    }

    try {
      const response = await withRetry(
        () =>
          httpClient.get(
            `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_vol=true`,
          ),
        { maxRetries: 2, retryDelay: 250 },
      );

      const payload = response.data ?? {};
      const results: PriceObservation[] = [];

      for (const asset of DEFAULT_ASSETS) {
        const id = this.assetAliases[asset]?.coingecko;
        if (!id) {
          continue;
        }

        const data = payload[id];
        if (!data || typeof data.usd !== "number" || data.usd <= 0) {
          continue;
        }

        const volume = Number(data.usd_24h_vol ?? 1);
        results.push({
          asset,
          source: "coingecko",
          price: data.usd,
          volume: Number.isFinite(volume) && volume > 0 ? volume : 1,
          timestamp: Date.now(),
        });
      }

      return results;
    } catch (error) {
      this.logger.debug("CoinGecko price fetch failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private calculateVolumeWeightedMedian(observations: PriceObservation[]): number {
    if (!observations.length) {
      return 0;
    }

    const weighted = observations
      .map((observation) => ({
        price: observation.price,
        volume: observation.volume > 0 ? observation.volume : 1,
      }))
      .sort((left, right) => left.price - right.price);

    const totalVolume = weighted.reduce((sum, item) => sum + item.volume, 0);
    if (totalVolume <= 0) {
      return this.calculateMedian(weighted.map((item) => item.price));
    }

    let cumulative = 0;
    for (const sample of weighted) {
      cumulative += sample.volume;
      if (cumulative >= totalVolume / 2) {
        return sample.price;
      }
    }

    return weighted[weighted.length - 1]?.price ?? 0;
  }

  private calculateMedian(values: number[]): number {
    if (!values.length) {
      return 0;
    }

    const sorted = [...values].sort((left, right) => left - right);
    const midpoint = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 0) {
      const left = sorted[midpoint - 1] ?? sorted[midpoint] ?? 0;
      const right = sorted[midpoint] ?? sorted[midpoint - 1] ?? 0;
      return (left + right) / 2;
    }

    return sorted[midpoint] ?? 0;
  }

  private getRecentHistory(
    asset: string,
    windowMs: number,
  ): Array<{ timestamp: number; price: number; volume: number }> {
    const cutoff = Date.now() - windowMs;
    const entries = this.history.get(asset) ?? [];
    return entries.filter((entry) => entry.timestamp >= cutoff);
  }

  private calculateTwap(
    history: Array<{ timestamp: number; price: number; volume: number }>,
    fallbackPrice: number,
  ): number {
    if (!history.length) {
      return fallbackPrice;
    }

    const totalVolume = history.reduce((sum, entry) => sum + entry.volume, 0);
    if (totalVolume <= 0) {
      return history[history.length - 1]?.price ?? fallbackPrice;
    }

    const weightedSum = history.reduce(
      (sum, entry) => sum + entry.price * entry.volume,
      0,
    );

    return weightedSum / totalVolume;
  }
}

export class TWAPOracleWorker extends OffChainPriceAggregatorService {}

export const offChainPriceAggregator = new OffChainPriceAggregatorService();
export const twapOracleWorker = offChainPriceAggregator;
export const twapOracleWorkerInstance = new TWAPOracleWorker();

export default offChainPriceAggregator;
